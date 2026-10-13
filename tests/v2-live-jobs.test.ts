import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService, observeSession } from "../src/jobs.js";
import { backend } from "../src/backends/adapter.js";
import { OpenCodeClient, OpenCodeError } from "../src/client.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerInputTools } from "../src/tools/input.js";
import { withRequestOptions } from "../src/async.js";
import type { McpServer } from "../src/mcp-server.js";

let root: string;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });

it("saves a captured live answer without log replay and retrieves it by both identities after restart", async () => {
  root = await mkdtemp(join(tmpdir(), "v2-live-job-"));
  const sessionID = "ses_f17f7940cfferDLekaUEZHayKH";
  const assistantID = "msg_0e808764d001oGKUHwEtqU7gj3";
  const incoming: unknown[] = [];
  let wake: (() => void) | undefined;
  const emit = (type: string, seq: number, data: Record<string, unknown>) => {
    incoming.push({ type, durable: { aggregateID: sessionID, seq }, data: { sessionID, ...data } }); wake?.();
  };
  const client = { getBaseUrl: () => "http://fixture:4096", connectionHeaders: {}, getBackendIdentity: () => ({ kind: "v2", version: "2.0.18" }) } as unknown as OpenCodeClient;
  const api = {
    event: { subscribe: vi.fn(() => (async function* () { yield { type: "server.connected", data: {} }; while (true) { if (!incoming.length) await new Promise<void>(resolve => { wake = resolve; }); yield incoming.shift(); } })()) },
    session: {
      get: vi.fn(async () => ({ id: sessionID, location: { directory: "/remote/project" }, time: { created: 1, updated: 2 }, projectID: "project" })),
      log: vi.fn(() => (async function* () { yield { type: "log.synced", aggregateID: sessionID, seq: 12 }; })()),
      inbox: { list: vi.fn(async () => []) },
      message: { get: vi.fn(async ({ messageID }: { messageID: string }) => {
        if (messageID === assistantID) return { id: assistantID, type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "reasoning", text: "private chain of thought" }, { type: "text", text: "Captured answer" }], finish: "stop" };
        return { id: messageID, type: "user", time: { created: 1 }, text: "private prompt" };
      }) }, form: { list: vi.fn(async () => []) },
    }, permission: { list: vi.fn(async () => []) },
  };
  Object.defineProperty(backend(client), "api", { value: api });
  vi.spyOn(backend(client), "execute").mockImplementation(async (operation, args) => {
    if (operation !== "messages.enqueue") throw new Error(`unexpected ${operation}`);
    const id = (args.body as { messageID: string }).messageID;
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2, {});
    emit("session.inbox.delivered", 4, { inboxID: id });
    emit("session.step.started", 5, { assistantMessageID: assistantID });
    emit("session.step.ended", 11, { assistantMessageID: assistantID, finish: "stop" });
    emit("session.execution.succeeded", 12, {});
    return { id, sessionID } as never;
  });
  const service = new JobService(client, { storeRoot: root });
  const started = await service.start({ prompt: "private prompt", sessionId: sessionID });
  expect(api.event.subscribe).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) {
    const current = await service.get(started.jobId!);
    if (current.status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const completed = await service.get(started.jobId!);
  expect(completed).toMatchObject({ status: "completed", text: "Captured answer", messageId: started.messageId });
  expect((await observeSession(client, sessionID, undefined, started.messageId)).text).toBe("Captured answer");
  expect((await new JobService(client, { storeRoot: root }).get(started.jobId!)).text).toBe("Captured answer");
  const namespace = join(root, (await readdir(root))[0], "v2", `${started.jobId}.json`);
  expect(await readFile(namespace, "utf8")).not.toContain("private chain of thought");
  expect(api.session.log).not.toHaveBeenCalled();
});

it("routes V2 ask and reply through the durable live job instead of the log-waiting send", async () => {
  const client = { getBaseUrl: () => "http://fixture:4096", connectionHeaders: {}, getBackendIdentity: () => ({ kind: "v2", version: "2.0.18" }) } as unknown as OpenCodeClient;
  const adapter = backend(client);
  vi.spyOn(adapter, "execute").mockImplementation(async operation => {
    if (operation === "sessions.create") return { id: "session" } as never;
    throw new Error("Legacy message send was called");
  });
  const service = new JobService(client, { storeRoot: null });
  vi.spyOn(service, "start").mockResolvedValue({ status: "accepted", jobId: "job_" + "a".repeat(32), sessionId: "session", messageId: "target" });
  vi.spyOn(service, "get").mockResolvedValue({ status: "completed", jobId: "job_" + "a".repeat(32), sessionId: "session", messageId: "target", text: "Correct answer" });
  const handlers = new Map<string, Function>();
  registerWorkflowTools({ tool: (...args: unknown[]) => { handlers.set(args[0] as string, args.at(-1) as Function); } } as McpServer, client, service);
  for (const [name, args] of [["opencode_ask", { prompt: "initial" }], ["opencode_reply", { prompt: "follow up", sessionId: "session" }]] as const) {
    const output = await handlers.get(name)!(args);
    expect(output.structuredContent).toMatchObject({ status: "completed", text: "Correct answer" });
  }
});

async function streamingFixture(dispatch: (emit: (type: string, seq: number, data?: Record<string, unknown>) => void, id: string) => void, directory?: string) {
  root = await mkdtemp(join(tmpdir(), "v2-live-stream-"));
  const sessionID = "session";
  const incoming: unknown[] = [];
  let wake: (() => void) | undefined;
  let answerReady = true;
  const emit = (type: string, seq: number, data: Record<string, unknown> = {}) => {
    incoming.push(type === "disconnect" ? null : { type, durable: { seq, aggregateID: sessionID }, data: { sessionID, ...data } });
    wake?.();
  };
  const client = { getBaseUrl: () => "http://fixture:4096", connectionHeaders: {}, getBackendIdentity: () => ({ kind: "v2", version: "2.0.18" }) } as unknown as OpenCodeClient;
  const api = {
    event: { subscribe: vi.fn(() => (async function* () {
      yield { type: "server.connected", data: {} };
      while (true) {
        if (!incoming.length) await new Promise<void>(resolve => { wake = resolve; });
        const next = incoming.shift(); if (next === null) return; yield next;
      }
    })()) },
    session: { active: vi.fn(async () => ({ session: { type: "running" } })),
      list: vi.fn(async () => ({ data: [], cursor: {} })),
      get: vi.fn(async () => ({ id: sessionID, title: "Fixture", location: { directory: "/remote/project" }, time: { created: 1, updated: 2 }, projectID: "project" })),
      log: vi.fn(() => (async function* () { yield { type: "log.synced", aggregateID: sessionID, seq: 9 }; })()),
      message: { get: vi.fn(async ({ messageID }: { messageID: string }) => {
        if (messageID === "answer" || messageID === "answer2") {
          if (!answerReady) throw new OpenCodeError("Not ready", 404, "GET", "/message", "");
          return { id: messageID, type: "assistant", time: { created: 2, completed: 3 }, finish: "stop", content: [{ type: "text", text: messageID === "answer" ? "Only this answer" : "Follow-up answer" }] };
        }
        return { id: messageID, type: "user", time: { created: 1 }, text: "prompt" };
      }) }, form: { list: vi.fn(async () => []) }, inbox: { list: vi.fn(async () => []), cancel: vi.fn(async () => ({})) }, interrupt: vi.fn(async () => ({ interrupted: true })) },
    permission: { list: vi.fn(async () => []) },
  };
  Object.defineProperty(backend(client), "api", { value: api });
  const enqueue = vi.spyOn(backend(client), "execute").mockImplementation(async (operation, args) => {
    if (operation !== "messages.enqueue") throw new Error(`unexpected ${operation}`);
    const id = (args.body as { messageID: string }).messageID;
    dispatch(emit, id);
    return { id, sessionID } as never;
  });
  const service = new JobService(client, { storeRoot: root });
  const started = await service.start({ prompt: "private", sessionId: sessionID, directory });
  const status = async (wanted: string) => {
    let last;
    for (let n = 0; n < 100; n++) {
      last = await service.get(started.jobId!);
      if (last.status === wanted) return last;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Expected ${wanted}, got ${last?.status}`);
  };
  return { api, client, service, started, emit, enqueue, status, setAnswerReady: (value: boolean) => { answerReady = value; } };
}

it("retries a late exact assistant ID without replaying the prompt", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
    emit("session.step.started", 4, { assistantMessageID: "answer" });
    emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" });
    emit("session.execution.succeeded", 6);
  });
  f.setAnswerReady(false);
  for (let n = 0; n < 100; n++) {
    if ((await f.service.get(f.started.jobId!)).error && f.api.session.message.get.mock.calls.some(([arg]) => arg.messageID === "answer")) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  f.setAnswerReady(true);
  expect((await f.status("completed")).text).toBe("Only this answer");
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
  expect(f.api.session.message.get.mock.calls.every(([arg]) => [f.started.messageId, "answer"].includes(arg.messageID))).toBe(true);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.api.session.log).not.toHaveBeenCalled();
});

it("does not infer a completion after an in-flight subscription disconnect or reconnect", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
    emit("session.step.started", 4, { assistantMessageID: "answer" });
    emit("disconnect", 5);
  });
  let lost;
  for (let n = 0; n < 100; n++) {
    lost = await f.service.get(f.started.jobId!);
    if ((lost.error as { name?: string })?.name === "LiveObservationLost") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(lost.error).toMatchObject({ name: "LiveObservationLost" });
  expect(lost.result).toBeUndefined();
  const enriched = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(enriched).toMatchObject({ status: "unknown", liveCoverage: "lost", error: { name: "LiveObservationLost" }, executionEvidence: {
    scope: "current-process-foreground", attribution: "session-only", root: "active_observed", subtree: "active_observed",
    activeSessionIDs: ["session"], observedAt: expect.any(Number), discovery: "scan_exhausted", issues: [],
  } });
  expect(enriched.result).toBeUndefined(); expect(enriched.text).toBeUndefined();
  const namespace = join(root, (await readdir(root))[0], "v2", `${f.started.jobId}.json`);
  expect(await readFile(namespace, "utf8")).not.toContain("executionEvidence");
  const otherClient = { getBaseUrl: f.client.getBaseUrl, connectionHeaders: {}, getBackendIdentity: f.client.getBackendIdentity } as OpenCodeClient;
  Object.defineProperty(backend(otherClient), "api", { value: f.api });
  f.api.session.active.mockResolvedValue({});
  const reloaded = await new JobService(otherClient, { storeRoot: root }).get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(reloaded).toMatchObject({ status: "unknown", executionEvidence: { root: "indeterminate", subtree: "indeterminate", activeSessionIDs: [] } });
  expect((await new JobService(f.client, { storeRoot: root }).get(f.started.jobId!)).error).toMatchObject({ name: "LiveObservationLost" });
  expect(f.api.session.log).toHaveBeenCalled();
  await expect(f.service.cancel(f.started.jobId!)).rejects.toThrow("ownership is not established");
  expect(f.api.session.interrupt).not.toHaveBeenCalled();
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});

async function lostFixture(directory?: string) {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2); emit("session.inbox.delivered", 3, { inboxID: id }); emit("disconnect", 4);
  }, directory);
  await f.status("unknown");
  return f;
}
const childRow = (id: string, parentID: string, directory = "/remote/project") => ({ id, parentID, location: { directory }, title: "HOSTILE_METADATA", time: { created: 1, updated: 2 }, projectID: "project" });

it("keeps repeated unknown default/false reads free of evidence probes and newer answers", async () => {
  const f = await lostFixture();
  for (let n = 0; n < 3; n++) {
    for (const options of [{}, { includeExecutionEvidence: false }]) {
      const job = await f.service.get(f.started.jobId!, options);
      expect(job.status).toBe("unknown"); expect(job.executionEvidence).toBeUndefined(); expect(job.result).toBeUndefined(); expect(job.text).toBeUndefined();
    }
  }
  expect(f.api.session.active).not.toHaveBeenCalled(); expect(f.api.session.list).not.toHaveBeenCalled();
  expect(f.api.session.message.get.mock.calls.every(([arg]) => arg.messageID !== "answer2")).toBe(true);
});

it("discovers only proven descendants with parent-filtered FIFO continuation and no content leaks", async () => {
  const f = await lostFixture("/remote/project");
  f.api.session.active.mockResolvedValue({ child: { type: "running" }, grandchild: { type: "running" }, unrelated: { type: "running" } });
  f.api.session.list.mockImplementation(async ({ parentID, cursor }: any) => {
    if (parentID === "session" && !cursor) return { data: [childRow("child", "session"), childRow("wrong", "elsewhere"), childRow("outside", "session", "/other")], cursor: { next: "page2" } };
    if (parentID === "child") return { data: [childRow("grandchild", "child")], cursor: {} };
    return { data: [], cursor: {} };
  });
  const job = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job).toMatchObject({ status: "unknown", executionEvidence: { root: "indeterminate", subtree: "active_observed", activeSessionIDs: ["child", "grandchild"], discovery: "partial", issues: [{ source: "discovery", code: "invalid_ancestry" }] } });
  const calls = f.api.session.list.mock.calls;
  expect(calls.map(([q]: any) => [q.parentID, q.cursor])).toEqual([["session", undefined], ["child", undefined], ["session", "page2"], ["grandchild", undefined]]);
  expect(calls[0][0]).toEqual({ parentID: "session", directory: "/remote/project", limit: 50, order: "asc" });
  expect(calls[2][0]).toEqual({ parentID: "session", directory: "/remote/project", limit: 50, cursor: "page2" });
  expect(JSON.stringify(job.executionEvidence)).not.toMatch(/HOSTILE_METADATA|unrelated|wrong|outside|page2|remote/);
  expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.api.event.subscribe).toHaveBeenCalledTimes(1);
});

it("invalidates conflicting ancestry and its dependents without losing root activity", async () => {
  const f = await lostFixture();
  f.api.session.active.mockResolvedValue({ session: { type: "running" }, a: { type: "running" }, b: { type: "running" }, descendant: { type: "running" } });
  f.api.session.list.mockImplementation(async ({ parentID }: any) => ({ data: parentID === "session" ? [childRow("a", "session"), childRow("b", "session")] : parentID === "a" ? [childRow("descendant", "a"), childRow("b", "a"), childRow("session", "a")] : [childRow("a", "b")], cursor: {} }));
  const job = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job.executionEvidence).toMatchObject({ root: "active_observed", subtree: "active_observed", activeSessionIDs: ["session"], discovery: "partial", issues: [{ source: "discovery", code: "invalid_ancestry" }] });
});

it.each(["failure", "missing", "sync", "denied"])("uses static issues for %s active reads without widening permission denial", async mode => {
  const f = await lostFixture();
  if (mode === "missing") (f.api.session as any).active = undefined;
  else f.api.session.active.mockImplementation(mode === "sync" ? () => { throw new Error("HOSTILE_EXCEPTION"); } : async () => {
    if (mode === "denied") throw new Error("SDK", { cause: new OpenCodeError("HOSTILE_EXCEPTION", 403, "GET", "/active", "PRIVATE_BODY") });
    throw new Error("HOSTILE_EXCEPTION");
  });
  const job = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job.status).toBe("unknown");
  expect(job.executionEvidence).toMatchObject({ root: "indeterminate", subtree: "indeterminate", observedAt: null, activeSessionIDs: [],
    discovery: mode === "denied" ? "unavailable" : "scan_exhausted", issues: [{ source: "active", code: ["missing", "sync"].includes(mode) ? "unavailable" : "request_failed" }] });
  expect(f.api.session.list).toHaveBeenCalledTimes(mode === "denied" ? 0 : 1);
  expect(JSON.stringify(job.executionEvidence)).not.toMatch(/HOSTILE|PRIVATE_BODY|SDK/);
});

it.each([[undefined], [[]], [null], [{ session: { type: "idle" } }], [{ session: "running" }]])("does not manufacture activity from malformed active evidence %j", async value => {
  const f = await lostFixture(); f.api.session.active.mockResolvedValue(value as any);
  const job = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job.executionEvidence).toMatchObject({ root: "indeterminate", subtree: "indeterminate", activeSessionIDs: [], issues: [{ source: "active", code: "malformed_response" }] });
});

it.each(["failure", "missing", "sync", "denied"])("preserves positives when discovery is %s", async mode => {
  const f = await lostFixture();
  if (mode === "missing") (f.api.session as any).list = undefined;
  else f.api.session.list.mockImplementation(mode === "sync" ? () => { throw new Error("HOSTILE_EXCEPTION"); } : async () => {
    if (mode === "denied") throw new Error("SDK", { cause: new OpenCodeError("HOSTILE_EXCEPTION", 401, "GET", "/list", "PRIVATE_BODY") });
    throw new Error("HOSTILE_EXCEPTION");
  });
  const job = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job.executionEvidence).toMatchObject({ root: "active_observed", subtree: "active_observed", activeSessionIDs: ["session"], discovery: "unavailable", issues: [{ source: "discovery", code: ["missing", "sync"].includes(mode) ? "unavailable" : "request_failed" }] });
  expect(JSON.stringify(job.executionEvidence)).not.toMatch(/HOSTILE|PRIVATE_BODY|SDK/);
});

it.each(["repeated", "malformed", "oversized", "budget"])("bounds %s pagination without false exhaustion", async mode => {
  const f = await lostFixture();
  f.api.session.list.mockImplementation(async ({ parentID }: any) => {
    if (mode === "repeated") return { data: [], cursor: { next: "repeat" } };
    if (mode === "malformed") return { data: [childRow("child", "session")], cursor: { next: 123 } };
    if (mode === "oversized") return { data: Array.from({ length: 250 }, (_, n) => childRow(`child${n}`, "session")), cursor: {} };
    return { data: Array.from({ length: 50 }, (_, n) => childRow(`${parentID}_${n}`, parentID)), cursor: {} };
  });
  const job = await f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job.executionEvidence.discovery).toBe("partial");
  expect(job.executionEvidence.issues).toContainEqual({ source: "discovery", code: ["repeated", "malformed"].includes(mode) ? "malformed_response" : "limit_reached" });
  expect(f.api.session.list.mock.calls.length).toBeLessThanOrEqual(4);
  if (mode === "repeated") expect(f.api.session.list).toHaveBeenCalledTimes(2);
  if (mode === "budget") expect(f.api.session.list).toHaveBeenCalledTimes(4);
});

it("retains verified child positives after an independent queued branch fails", async () => {
  const f = await lostFixture(); f.api.session.active.mockResolvedValue({ child: { type: "running" } });
  f.api.session.list.mockImplementation(async ({ parentID }: any) => {
    if (parentID === "session") return { data: [childRow("child", "session")], cursor: {} };
    throw new Error("HOSTILE_EXCEPTION");
  });
  expect((await f.service.get(f.started.jobId!, { includeExecutionEvidence: true })).executionEvidence).toMatchObject({ root: "indeterminate", subtree: "active_observed", activeSessionIDs: ["child"], discovery: "partial", issues: [{ source: "discovery", code: "request_failed" }] });
});

it("bounds uncooperative late discovery at two seconds without launching queued reads or saving evidence", async () => {
  const f = await lostFixture();
  let entered!: () => void, late!: (value: any) => void, heldSignal!: AbortSignal;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  f.api.session.list.mockImplementation(({ parentID }: any, options: any) => {
    if (parentID === "session") return Promise.resolve({ data: [childRow("child", "session")], cursor: { next: "later" } });
    heldSignal = options.signal; entered(); return new Promise(resolve => { late = resolve; });
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const pending = f.service.get(f.started.jobId!, { includeExecutionEvidence: true });
  await holding; await vi.advanceTimersByTimeAsync(2000);
  const job = await pending;
  expect(heldSignal.aborted).toBe(true);
  expect(job.executionEvidence).toMatchObject({ root: "active_observed", discovery: "partial", issues: [{ source: "discovery", code: "timeout" }] });
  late({ data: [childRow("late", "child")], cursor: {} }); await vi.advanceTimersByTimeAsync(100);
  expect(f.api.session.list).toHaveBeenCalledTimes(2);
  expect(job.executionEvidence.activeSessionIDs).toEqual(["session"]);
  vi.useRealTimers();
  const namespace = join(root, (await readdir(root))[0], "v2", `${f.started.jobId}.json`);
  expect(await readFile(namespace, "utf8")).not.toContain("executionEvidence");
});

it("does not turn an ambient caller timeout into successful evidence when child expiry callbacks run first", async () => {
  const f = await lostFixture();
  let entered!: () => void, activeSignal!: AbortSignal;
  const holding = new Promise<void>(resolve => { entered = resolve; });
  f.api.session.active.mockImplementation((options: any) => {
    activeSignal = options.signal; entered(); return new Promise(() => {});
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const schedule = globalThis.setTimeout;
  let callerTimerDelayed = false;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, milliseconds: number, ...args: any[]) => {
    // The first timer belongs to get's enclosing caller context. A small
    // scheduling lag lets equal-deadline child callbacks win deterministically.
    if (!callerTimerDelayed && milliseconds === 100) {
      callerTimerDelayed = true; return schedule(callback, milliseconds + 1, ...args);
    }
    return schedule(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  let settled = false;
  const outcome = withRequestOptions({ timeout: 100 }, () => f.service.get(f.started.jobId!, { includeExecutionEvidence: true }))
    .then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { value: undefined, error }; });
  try {
    await holding; expect(callerTimerDelayed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const early = settled ? await outcome : undefined;
    expect(early?.value).toBeUndefined();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ value: undefined, error: { name: "TimeoutError" } });
    expect(activeSignal.aborted).toBe(true);
    expect(f.api.session.list).not.toHaveBeenCalled();
  } finally {
    await vi.advanceTimersByTimeAsync(1); await outcome;
    vi.restoreAllMocks(); vi.useRealTimers();
  }
});

it("does not enrich accepted or completed jobs even when opted in", async () => {
  const f = await streamingFixture(() => {});
  expect((await f.service.get(f.started.jobId!, { includeExecutionEvidence: true })).status).toBe("accepted");
  f.emit("session.inbox.enqueued", 1, { inboxID: f.started.messageId, item: { type: "user", delivery: "queue" } });
  f.emit("session.execution.started", 2); f.emit("session.inbox.delivered", 3, { inboxID: f.started.messageId });
  f.emit("session.step.started", 4, { assistantMessageID: "answer" }); f.emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" }); f.emit("session.execution.succeeded", 6);
  await f.status("completed");
  expect((await f.service.get(f.started.jobId!, { includeExecutionEvidence: true })).executionEvidence).toBeUndefined();
  expect(f.api.session.active).not.toHaveBeenCalled(); expect(f.api.session.list).not.toHaveBeenCalled();
});

it("a distinct client reload of a saved active record loses coverage but reads fresh positive session evidence", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2); emit("session.inbox.delivered", 3, { inboxID: id });
  });
  expect((await f.status("running")).liveCoverage).toBe("active");
  const distinct = { getBaseUrl: f.client.getBaseUrl, connectionHeaders: {}, getBackendIdentity: f.client.getBackendIdentity } as OpenCodeClient;
  Object.defineProperty(backend(distinct), "api", { value: f.api });
  const job = await new JobService(distinct, { storeRoot: root }).get(f.started.jobId!, { includeExecutionEvidence: true });
  expect(job).toMatchObject({ status: "unknown", liveCoverage: "lost", error: { name: "LiveObservationLost" }, executionEvidence: { root: "active_observed", subtree: "active_observed" } });
  expect(job.result).toBeUndefined(); expect(job.text).toBeUndefined();
  f.emit("disconnect", 4);
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls[0][0].signal.aborted; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
});

it("leaves an unknown V1 turn unchanged under the internal V2 evidence opt-in", async () => {
  const client = { getBaseUrl: () => "http://fixture:4096", connectionHeaders: {}, getBackendIdentity: () => ({ kind: "v1" }),
    post: vi.fn(async () => ({})), get: vi.fn(async (path: string) => path.endsWith("/message")
      ? [{ info: { id: "newer-user", role: "user", time: { created: 10 } }, parts: [] }]
      : path === "/session/status" ? { session: { type: "busy" } } : { id: "session" }),
  } as unknown as OpenCodeClient;
  const service = new JobService(client, { storeRoot: null });
  const started = await service.start({ prompt: "private", sessionId: "session" });
  for (let n = 0; n < 2; n++) {
    const job = await service.get(started.jobId!, { includeExecutionEvidence: true });
    expect(job).toMatchObject({ backend: "v1", status: "unknown", inputs: [] });
    expect(job.executionEvidence).toBeUndefined(); expect(job.result).toBeUndefined();
  }
  expect(client.get).not.toHaveBeenCalledWith(expect.stringMatching(/active/), expect.anything(), expect.anything(), expect.anything());
});

function handlersFor(f: Awaited<ReturnType<typeof lostFixture>>) {
  const handlers = new Map<string, Function>();
  const server = { tool: (...args: unknown[]) => { handlers.set(args[0] as string, args.at(-1) as Function); } } as McpServer;
  registerInputTools(server, f.client, f.service); registerWorkflowTools(server, f.client, f.service);
  return handlers;
}

it("get/check enrich the original durable turn by both identities in compact/detailed modes without replacing diagnostics", async () => {
  const f = await lostFixture(); const handlers = handlersFor(f);
  for (const [name, args] of [
    ["opencode_job_get", { jobId: f.started.jobId }],
    ["opencode_check", { jobId: f.started.jobId }],
    ["opencode_check", { sessionId: "session", messageId: f.started.messageId, detailed: true }],
  ] as const) {
    const output = await handlers.get(name)!(args);
    expect(output.structuredContent).toMatchObject({ status: "unknown", error: { name: "LiveObservationLost" }, executionEvidence: { root: "active_observed", subtree: "active_observed", activeSessionIDs: ["session"] } });
    expect(output.structuredContent.result).toBeUndefined();
    expect(output.content[0].text).toContain("Job observation lost; original turn outcome is unknown. Session execution may continue. Do not resend automatically.");
  }
  expect(f.api.session.active).toHaveBeenCalledTimes(3); expect(f.api.session.list).toHaveBeenCalledTimes(3);
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(1); expect(f.api.session.interrupt).not.toHaveBeenCalled();
});

it("unknown wait/run/ask/reply/input polling remains default-off while cancel retains its uncertainty guard", async () => {
  const f = await lostFixture(); const handlers = handlersFor(f);
  const realGet = f.service.get.bind(f.service); let reads = 0; let onRead: (() => void) | undefined;
  // Every real get is tracked: an observation that expires or is cancelled returns without awaiting its read, so
  // the read (and its record-lock release) is awaited explicitly before the next handler starts.
  const gets: Promise<unknown>[] = [];
  vi.spyOn(f.service, "get").mockImplementation((...args) => {
    const run = (async () => { const job = await realGet(...args); expect(job.status).toBe("unknown"); reads++; onRead?.(); return job; })();
    gets.push(run); return run;
  });
  vi.spyOn(f.service, "start").mockResolvedValue(f.started);
  f.enqueue.mockImplementation(async operation => { if (operation === "sessions.create") return { id: "session" } as never; throw new Error("Unexpected operation"); });
  // The deadlines/abort below are driven by a controlled clock: time advances only after the first real
  // (file-backed) unknown read has completed, so slow I/O cannot expire the observation before that read.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    for (let n = 0; n < 2; n++) {
      for (const [name, args] of [
        ["opencode_wait", { jobId: f.started.jobId, timeoutSeconds: 0.06, pollIntervalMs: 10 }],
        ["opencode_run", { sessionId: "session", prompt: "unused", maxDurationSeconds: 0.06 }],
        ["opencode_ask", { prompt: "unused" }], ["opencode_reply", { sessionId: "session", prompt: "unused" }],
        ["opencode_job_input", { jobId: f.started.jobId }],
      ] as const) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 70);
        const before = reads; const firstRead = new Promise<void>(resolve => { onRead = resolve; });
        try {
          const pending = handlers.get(name)!(args, { signal: controller.signal });
          await Promise.race([firstRead, pending]); await new Promise<void>(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(70);
          const output = await pending; expect(output.structuredContent.status).toBe("unknown"); expect(reads).toBeGreaterThan(before);
        } finally { clearTimeout(timer); controller.abort(); await Promise.allSettled(gets.splice(0)); onRead = undefined; }
      }
    }
  } finally { await Promise.allSettled(gets.splice(0)); vi.useRealTimers(); onRead = undefined; }
  const cancelled = await handlers.get("opencode_job_cancel")!({ jobId: f.started.jobId });
  expect(cancelled.isError).toBe(true); expect(cancelled.content[0].text).toContain("ownership is not established");
  expect(cancelled.content[0].text).not.toContain("Job observation lost");
  expect(f.api.session.active).not.toHaveBeenCalled(); expect(f.api.session.list).not.toHaveBeenCalled();
  expect(f.api.session.interrupt).not.toHaveBeenCalled();
});

it("recovers only the saved final assistant ID when the stream drops after its correlation was persisted", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
    emit("session.step.started", 4, { assistantMessageID: "answer" });
    emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" });
    emit("session.execution.succeeded", 6);
  });
  f.setAnswerReady(false);
  for (let n = 0; n < 100; n++) {
    const record = (await f.service.get(f.started.jobId!));
    if ((record.error as { name?: string })?.name === "MissingCorrelatedResult") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  f.emit("disconnect", 7);
  await new Promise(resolve => setTimeout(resolve, 20));
  f.setAnswerReady(true);
  expect((await f.service.get(f.started.jobId!)).text).toBe("Only this answer");
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});

it("a second job service on the same active connection does not invent a disconnect", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
  });
  await f.status("running");
  const second = new JobService(f.client, { storeRoot: root });
  const observed = await second.get(f.started.jobId!);
  expect(observed.status).toBe("running");
  expect(observed.error).toBeUndefined();
  f.emit("disconnect", 4);
  for (let n = 0; n < 100; n++) {
    if ((await f.service.get(f.started.jobId!)).error && f.api.event.subscribe.mock.calls[0][0].signal.aborted) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
});

it("refuses another user's answer and control operations after a competing delivery", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
    emit("session.inbox.enqueued", 4, { inboxID: "other", item: { type: "user", delivery: "queue" } });
    emit("session.inbox.delivered", 5, { inboxID: "other" });
    emit("session.step.started", 6, { assistantMessageID: "answer" });
    emit("session.step.ended", 7, { assistantMessageID: "answer", finish: "stop" });
    emit("session.execution.succeeded", 8);
  });
  let observed;
  for (let n = 0; n < 100; n++) {
    observed = await f.service.get(f.started.jobId!);
    if ((observed.error as { name?: string })?.name === "TurnOwnershipLost") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(observed).toMatchObject({ status: "unknown", error: { name: "TurnOwnershipLost" }, inputs: [] });
  expect(observed!.text).toBeUndefined();
  await expect(f.service.cancel(f.started.jobId!)).rejects.toThrow("ownership is not established");
  await expect(f.service.update(f.started.jobId!, [{ id: "other", kind: "question", values: {} }])).rejects.toThrow("does not belong");
  await expect(f.service.update(f.started.jobId!, [{ id: "other", kind: "permission", reply: "once" }])).rejects.toThrow("does not belong");
  expect(f.api.session.interrupt).not.toHaveBeenCalled();
  expect(f.api.session.message.get.mock.calls.every(([arg]) => arg.messageID !== "answer")).toBe(true);
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
});

it("does not complete from another assistant when saving competing delivery fails once", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
  });
  await f.status("running");
  const service = f.service as unknown as { save: (job: { observation?: { ownershipLost?: boolean } }) => Promise<void> };
  const save = service.save.bind(service);
  let failed = false;
  vi.spyOn(service, "save").mockImplementation(async job => {
    if (job.observation?.ownershipLost && !failed) { failed = true; throw new Error("one failed save"); }
    await save(job);
  });
  f.emit("session.inbox.enqueued", 4, { inboxID: "other", item: { type: "user", delivery: "queue" } });
  f.emit("session.inbox.delivered", 5, { inboxID: "other" });
  f.emit("session.step.started", 6, { assistantMessageID: "answer2" });
  f.emit("session.step.ended", 7, { assistantMessageID: "answer2", finish: "stop" });
  f.emit("session.execution.succeeded", 8);
  for (let n = 0; n < 100; n++) {
    if (failed && f.api.session.message.get.mock.calls.some(([arg]) => arg.messageID === "answer2")) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(failed).toBe(true);
  const observed = await f.service.get(f.started.jobId!);
  expect(observed.status).toBe("unknown");
  expect(observed.text).not.toBe("Follow-up answer");
  expect((await new JobService(f.client, { storeRoot: root }).get(f.started.jobId!)).status).toBe("unknown");
});

it("retires a live job when saving its own succeeded execution fails", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
  });
  await f.status("running");
  const service = f.service as unknown as { save: (job: { status: string; observation?: { outcome?: string } }) => Promise<void> };
  const save = service.save.bind(service);
  let failed = false;
  vi.spyOn(service, "save").mockImplementation(async job => {
    if (job.status === "completed" && job.observation?.outcome === "completed" && !failed) {
      failed = true;
      throw new Error("failed to persist succeeded execution");
    }
    await save(job);
  });
  f.emit("session.step.started", 4, { assistantMessageID: "answer" });
  f.emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" });
  f.emit("session.execution.succeeded", 6);
  for (let n = 0; n < 100 && !failed; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(failed).toBe(true);
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls[0][0].signal.aborted; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const observed = await f.service.get(f.started.jobId!);
  expect(observed.status).toBe("unknown");
  expect(observed.text).not.toBe("Only this answer");
  expect((await new JobService(f.client, { storeRoot: root }).get(f.started.jobId!)).status).toBe("unknown");
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});

it("shares a single subscription across two in-flight targets until both finish", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
  });
  const second = await f.service.start({ prompt: "follow up", sessionId: "session" });
  expect(f.api.event.subscribe).toHaveBeenCalledTimes(1);
  f.emit("session.execution.started", 2);
  f.emit("session.inbox.delivered", 3, { inboxID: f.started.messageId });
  f.emit("session.step.started", 4, { assistantMessageID: "answer" });
  f.emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" });
  f.emit("session.execution.succeeded", 6);
  expect((await f.status("completed")).text).toBe("Only this answer");
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(false);
  f.emit("session.execution.started", 7);
  f.emit("session.inbox.delivered", 8, { inboxID: second.messageId });
  f.emit("session.step.started", 9, { assistantMessageID: "answer2" });
  f.emit("session.step.ended", 10, { assistantMessageID: "answer2", finish: "stop" });
  f.emit("session.execution.succeeded", 11);
  for (let n = 0; n < 100; n++) {
    if ((await f.service.get(second.jobId!)).status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect((await f.service.get(second.jobId!))).toMatchObject({ status: "completed", text: "Follow-up answer" });
  expect((await f.service.get(f.started.jobId!)).text).toBe("Only this answer");
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
});

it("combines saved live prefix with missing durable log rows after disconnect", async () => {
  const f = await streamingFixture((emit, id) => {
    emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
    emit("session.execution.started", 2);
    emit("session.inbox.delivered", 3, { inboxID: id });
    emit("session.step.started", 4, { assistantMessageID: "answer" });
  });
  await f.status("running");
  f.api.session.log.mockImplementation(({ after }: { after: number }) => (async function* () {
    for (const event of [
      { type: "session.step.ended", durable: { aggregateID: "session", seq: 5, version: 1 }, data: { sessionID: "session", assistantMessageID: "answer", finish: "stop" } },
      { type: "session.execution.succeeded", durable: { aggregateID: "session", seq: 6, version: 1 }, data: { sessionID: "session" } },
    ]) if (event.durable.seq > after) yield event;
    yield { type: "log.synced", aggregateID: "session", seq: 6 };
  })());
  f.emit("disconnect", 5);
  const finished = await f.status("completed");
  expect(finished.text).toBe("Only this answer");
  expect(f.api.session.log).toHaveBeenCalled();
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});

it("a durable completion read by another service releases the original in-flight subscriber", async () => {
  const f = await streamingFixture(() => {});
  const otherClient = { getBaseUrl: f.client.getBaseUrl, connectionHeaders: {}, getBackendIdentity: f.client.getBackendIdentity } as OpenCodeClient;
  Object.defineProperty(backend(otherClient), "api", { value: f.api });
  f.api.session.log.mockImplementation(() => (async function* () {
    for (const [seq, type, data] of [
      [1, "session.inbox.enqueued", { inboxID: f.started.messageId, item: { type: "user", delivery: "queue" } }],
      [2, "session.execution.started", {}],
      [3, "session.inbox.delivered", { inboxID: f.started.messageId }],
      [4, "session.step.started", { assistantMessageID: "answer" }],
      [5, "session.step.ended", { assistantMessageID: "answer", finish: "stop" }],
      [6, "session.execution.succeeded", {}],
    ] as const) yield { type, durable: { aggregateID: "session", seq, version: 1 }, data: { sessionID: "session", ...data } };
    yield { type: "log.synced", aggregateID: "session", seq: 6 };
  })());
  const recovered = await new JobService(otherClient, { storeRoot: root }).get(f.started.jobId!);
  expect(recovered.status).toBe("completed");
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
});
