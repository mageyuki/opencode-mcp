import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeClient } from "../src/client.js";
import { JobService, observeSession } from "../src/jobs.js";
import { backend, operate } from "../src/backends/adapter.js";
import { withRequestOptions } from "../src/async.js";

// Protocol fixture, not a claim of live native inference. The real published
// SDK parses these HTTP envelopes and SSE frames; no SDK/adapter methods mock.
let root: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "opencode-v2-http-jobs-")); });
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); await rm(root, { recursive: true, force: true }); });
async function fixture(connectedFrame = true) {
  const sessionID = "ses_http_fixture";
  const session = { id: sessionID, title: "HTTP fixture", projectID: "prj_fixture", location: { directory: "/remote/project" },
    model: { providerID: "fixture", id: "model" }, agent: "build", time: { created: 1, updated: 1 } };
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: any }> = [];
  const events: any[] = [];
  const inbox = new Map<string, any>();
  const messages = new Map<string, any>();
  const liveStreams = new Set<ServerResponse>();
  let loseReceipt = false;
  const evidence = { active: { [sessionID]: { type: "running" } } as unknown, page: { data: [], cursor: {} } as any,
    hold: undefined as "active" | "list" | "session" | undefined, body: false, entered: 0, closed: 0 };
  const event = (type: string, data: any = {}) => events.push({ id: `evt_${events.length + 1}`, type: `session.${type}`, created: 1,
    durable: { aggregateID: sessionID, seq: events.length + 1, version: 1 }, data: { sessionID, ...data } });
  const json = (res: ServerResponse, data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data })); };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from("fixture:local-only").toString("base64")}`) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url!, "http://fixture"); const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString(); const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
    if (req.method === "GET" && ["/api/session/active", "/api/session"].includes(url.pathname)) {
      const phase = url.pathname.endsWith("/active") ? "active" : "list";
      if (phase === evidence.hold) {
        evidence.entered++;
        res.on("close", () => evidence.closed++);
        if (evidence.body) { res.setHeader("content-type", "application/json"); res.flushHeaders(); res.write('{"data":'); }
        return;
      }
      if (phase === "active") return json(res, evidence.active);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(evidence.page)); return;
    }
    if (req.method === "GET" && url.pathname === "/api/event") {
      liveStreams.add(res);
      res.on("close", () => liveStreams.delete(res));
      res.setHeader("content-type", "text/event-stream");
      res.flushHeaders();
      if (connectedFrame) res.write('data: {"type":"server.connected","id":"evt_connected","created":1}\n\n');
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") return json(res, session);
    if (req.method === "GET" && url.pathname === "/api/location") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ directory: "/remote/project", project: { id: "prj_fixture", directory: "/remote/project" } })); return; }
    if (req.method === "GET" && url.pathname === `/api/session/${sessionID}`) {
      if (evidence.hold === "session") {
        evidence.entered++;
        res.on("close", () => evidence.closed++);
        if (evidence.body) { res.setHeader("content-type", "application/json"); res.flushHeaders(); res.write('{"data":'); }
        return;
      }
      return json(res, session);
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && req.method === "POST") {
      const receipt = { id: body.id, sessionID, time: { created: 1 }, type: "user", delivery: body.delivery, payload: { text: body.text } };
      inbox.set(body.id, receipt); event("inbox.enqueued", { inboxID: body.id, item: { type: "user", delivery: body.delivery, payload: { text: body.text } } });
      if (loseReceipt) { res.destroy(); return; }
      return json(res, receipt);
    }
    if (url.pathname === `/api/experimental/session/${sessionID}/log`) {
      const after = Number(url.searchParams.get("after") ?? 0);
      res.setHeader("content-type", "text/event-stream");
      const replay = [...events.filter(value => value.durable.seq > after), { type: "log.synced", aggregateID: sessionID, seq: events.length }];
      // CRLF and split writes exercise the real SDK's framing, not a direct iterator.
      const frames = replay.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join("");
      res.write(frames.slice(0, 37)); res.end(frames.slice(37)); return;
    }
    if (url.pathname === `/api/session/${sessionID}/inbox` && req.method === "GET") return json(res, [...inbox.values()]);
    if ([`/api/session/${sessionID}/form`, `/api/session/${sessionID}/permission`].includes(url.pathname)) return json(res, []);
    if (url.pathname.startsWith(`/api/session/${sessionID}/message/`)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (!messages.has(id)) { res.statusCode = 404; return json(res, { message: "Projection absent" }); }
      return json(res, messages.get(id));
    }
    res.statusCode = 404; json(res, { message: "Unexpected fixture route" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = () => new OpenCodeClient({ baseUrl, backend: "v2", username: "fixture", password: "local-only" });
  return { client, sessionID, calls, events, evidence, loseReceipt: () => { loseReceipt = true; },
    closeEvents: () => { for (const stream of liveStreams) stream.end(); },
    deliver(id: string) {
      const receipt = inbox.get(id); expect(receipt).toBeDefined(); inbox.delete(id);
      event("execution.started"); event("inbox.delivered", { inboxID: id });
      messages.set(id, { id, type: "user", text: receipt.payload.text, time: { created: 2 } });
      event("step.started", { assistantMessageID: "msg_assistant_http" });
      messages.set("msg_assistant_http", { id: "msg_assistant_http", type: "assistant", content: [{ type: "text", text: "Partial response" }], time: { created: 3 } });
    },
    finish() {
      messages.set("msg_assistant_http", { id: "msg_assistant_http", type: "assistant", content: [{ type: "reasoning", text: "private chain of thought" }, { type: "text", text: "Completed response" }], time: { created: 3, completed: 4 }, finish: "stop" });
      event("step.ended", { assistantMessageID: "msg_assistant_http", finish: "stop", cost: 0, tokens: {} }); event("execution.succeeded");
    },
    interrupt(reason?: "user") {
      const interrupted = { type: "session.execution.interrupted", durable: { aggregateID: sessionID, seq: events.length + 1, version: 1 }, data: { sessionID, reason } };
      for (const stream of liveStreams) for (const item of [...events.slice(-3), interrupted]) {
        stream.write(`data: ${JSON.stringify(item)}\n\n`);
      }
    },
  };
}
async function record(jobId: string) {
  const namespace = join(root, (await readdir(root))[0]);
  return JSON.parse(await readFile(join(namespace, "v2", `${jobId}.json`), "utf8"));
}

describe("V2 jobs through the actual SDK HTTP transport", () => {
  it("preserves a delivered user's interruption as cancelled, not ExecutionInterrupted", async () => {
    const f = await fixture(); const service = new JobService(f.client(), { storeRoot: root });
    const job = await service.start({ prompt: "User cancelled fixture", sessionId: f.sessionID });
    expect(job.status).toBe("accepted");
    f.deliver(job.messageId!); f.interrupt("user");
    let snapshot = await service.get(job.jobId!);
    for (let n = 0; n < 100 && snapshot.status !== "cancelled" && snapshot.error?.name !== "ExecutionInterrupted"; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      snapshot = await service.get(job.jobId!);
    }
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.error).toBeUndefined();
    expect(f.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompt"))).toHaveLength(1);
  });
  it("reports a live reasonless interruption as unknown with a non-resend diagnostic", async () => {
    const f = await fixture(); const service = new JobService(f.client(), { storeRoot: root });
    const job = await service.start({ prompt: "Interrupted fixture", sessionId: f.sessionID });
    expect(job.status).toBe("accepted");
    f.deliver(job.messageId!); f.interrupt();
    let snapshot = await service.get(job.jobId!);
    for (let n = 0; n < 100 && snapshot.error?.name !== "ExecutionInterrupted"; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      snapshot = await service.get(job.jobId!);
    }
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.error?.name).toBe("ExecutionInterrupted");
    expect(snapshot.text).toBeUndefined();
    expect(f.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompt"))).toHaveLength(1);
    f.closeEvents();
    for (let n = 0; n < 100 && (await service.get(job.jobId!)).liveCoverage !== "lost"; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((await service.get(job.jobId!)).error?.name).toBe("ExecutionInterrupted");
  });
  it("retires transport readiness synchronously when its SSE subscription aborts", async () => {
    const f = await fixture(false);
    const adapter = backend(f.client());
    const subscription = new AbortController();
    const iterator = adapter.api.event.subscribe({ signal: subscription.signal })[Symbol.asyncIterator]();
    const next = iterator.next().catch(() => {});
    await adapter.eventStreamReady().ready;
    let wasReady = false;
    void adapter.eventStreamReady().ready.then(() => { wasReady = true; });
    await Promise.resolve();
    expect(wasReady).toBe(true);
    subscription.abort();
    const probe = adapter.eventStreamReady();
    let retiredReady = false;
    void probe.ready.then(() => { retiredReady = true; });
    await Promise.resolve();
    expect(retiredReady).toBe(false);
    probe.dispose();
    await next;
  });
  it("refuses dispatch when the caller deadline expires on a header-only SSE reader without server.connected", async () => {
    const f = await fixture(false);
    const service = new JobService(f.client(), { storeRoot: root });
    const started = await withRequestOptions({ timeout: 750 }, () => service.start({ prompt: "Quiet fixture", sessionId: f.sessionID }));
    expect(started.status).toBe("failed");
    expect(started.error).toMatchObject({ name: "LiveSubscriptionNotReady", message: expect.stringContaining("prompt was not sent") });
    const order = f.calls.map(call => call.path);
    expect(order).toContain("/api/event");
    expect(f.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(0);
    f.closeEvents();
    expect((await service.get(started.jobId!)).status).toBe("failed");
  });
  it("persists the admission receipt and preserves assigned message identity through user projection and restart", async () => {
    const f = await fixture(); const firstClient = f.client(); const first = new JobService(firstClient, { storeRoot: root });
    const job = await first.start({ prompt: "A fixture task", title: "HTTP fixture" });
    expect(job.status).toBe("accepted");
    const prompt = f.calls.find(call => call.path.endsWith("/prompt"))!;
    expect(prompt.body).toEqual({ id: job.messageId, text: "A fixture task", delivery: "queue" });
    expect(await record(job.jobId!)).toMatchObject({ receipt: { id: job.messageId, sessionID: f.sessionID } });
    // The queued entry is not a projected user message yet. This is not job failure.
    await expect(operate(firstClient, "messages.get", { sessionId: f.sessionID, messageId: job.messageId })).rejects.toMatchObject({ status: 404 });
    expect((await first.get(job.jobId!)).status).toBe("accepted");
    f.deliver(job.messageId!);
    const user = await operate(firstClient, "messages.get", { sessionId: f.sessionID, messageId: job.messageId });
    expect(user.info).toMatchObject({ id: job.messageId, role: "user" });
    expect((await first.get(job.jobId!)).status).toBe("running");
    const checkpoint = await record(job.jobId!); expect(checkpoint.observation.delivered).toBe(true); expect(checkpoint.observation.userProjectionValidated).toBe(true);
    f.finish();
    const restarted = new JobService(f.client(), { storeRoot: root }); const result = await restarted.get(job.jobId!);
    expect(result).toMatchObject({ backend: "v2", status: "completed", result: { info: { id: "msg_assistant_http", parentID: job.messageId } } });
    expect(JSON.stringify(await record(job.jobId!))).not.toContain("private chain of thought");
    expect(f.calls.filter(call => call.path.endsWith("/log")).at(-1)!.query.get("after")).toBe(String(checkpoint.observation.cursor));
    expect(f.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompt"))).toHaveLength(1);
  });
  it("recovers a server-admitted prompt after socket loss without resending the mutation", async () => {
    const f = await fixture(); f.loseReceipt(); const first = new JobService(f.client(), { storeRoot: root });
    const job = await first.start({ prompt: "Lost receipt fixture", sessionId: f.sessionID });
    expect(job.status).toBe("unknown"); expect((await record(job.jobId!)).receipt).toBeUndefined();
    const restarted = new JobService(f.client(), { storeRoot: root }); expect((await restarted.get(job.jobId!)).status).toBe("accepted");
    f.deliver(job.messageId!); f.finish();
    const result = await new JobService(f.client(), { storeRoot: root }).get(job.jobId!);
    expect(result).toMatchObject({ status: "completed", messageId: job.messageId });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
});

async function lostHttpJob() {
  const f = await fixture(); const client = f.client(); const service = new JobService(client, { storeRoot: root });
  const job = await service.start({ prompt: "Evidence fixture", sessionId: f.sessionID, directory: "/remote/project" });
  expect(job.status).toBe("accepted");
  f.deliver(job.messageId!); expect((await service.get(job.jobId!)).status).toBe("running");
  f.closeEvents();
  for (let n = 0; n < 100; n++) {
    const current = await service.get(job.jobId!);
    if (current.status === "unknown" && current.liveCoverage === "lost") return { f, client, service, job };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Fixture did not reach lost unknown");
}
const evidenceCalls = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => ["/api/session/active", "/api/session"].includes(c.path) && c.method === "GET");
async function waitUntil(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

it("uses real SDK active/list envelopes and pinned query positions without any control calls", async () => {
  const { f, service, job } = await lostHttpJob();
  f.evidence.active = { child: { type: "running" }, unrelated: { type: "running" } };
  f.evidence.page = { data: [], cursor: {} };
  const current = await service.get(job.jobId!, { includeExecutionEvidence: true });
  expect(current.executionEvidence).toMatchObject({ root: "indeterminate", subtree: "indeterminate", observedAt: expect.any(Number), discovery: "scan_exhausted", issues: [] });
  const calls = evidenceCalls(f); expect(calls.map(c => c.path)).toEqual(["/api/session/active", "/api/session"]);
  expect(Object.fromEntries(calls[1].query)).toEqual({ parentID: f.sessionID, directory: "/remote/project", limit: "50", order: "asc" });
  expect(f.calls.filter(c => c.method !== "GET")).toHaveLength(1);
  expect(await record(job.jobId!)).not.toHaveProperty("executionEvidence");
});

it.each([false, true])("aborts stalled active HTTP headers/body (body=%s), then permits independent discovery", async body => {
  const { f, service, job } = await lostHttpJob(); f.evidence.hold = "active"; f.evidence.body = body;
  const started = Date.now(); const current = await service.get(job.jobId!, { includeExecutionEvidence: true });
  expect(Date.now() - started).toBeLessThan(1800);
  expect(current.executionEvidence).toMatchObject({ root: "indeterminate", subtree: "indeterminate", observedAt: null, discovery: "scan_exhausted", issues: [{ source: "active", code: "timeout" }] });
  await waitUntil(() => f.evidence.closed === 1);
  expect(evidenceCalls(f)).toHaveLength(2);
});

it.each([false, true])("aborts stalled discovery HTTP headers/body (body=%s) preserving root evidence and releasing the job lock", async body => {
  const { f, service, job } = await lostHttpJob(); f.evidence.hold = "list"; f.evidence.body = body;
  const started = Date.now(); const reading = service.get(job.jobId!, { includeExecutionEvidence: true });
  await waitUntil(() => f.evidence.entered === 1);
  const plain = await service.get(job.jobId!, { timeout: 300 });
  expect(plain.status).toBe("unknown"); expect(plain.executionEvidence).toBeUndefined();
  const current = await reading;
  expect(Date.now() - started).toBeLessThan(2800);
  expect(current.executionEvidence).toMatchObject({ root: "active_observed", subtree: "active_observed", activeSessionIDs: [f.sessionID], discovery: "unavailable", issues: [{ source: "discovery", code: "timeout" }] });
  await waitUntil(() => f.evidence.closed === 1);
  const calls = evidenceCalls(f).length;
  await new Promise(resolve => setTimeout(resolve, 30)); expect(evidenceCalls(f)).toHaveLength(calls);
});

it.each(["deadline", "abort"])("propagates caller %s via its own signal, stops actual HTTP I/O and never probes another endpoint", async mode => {
  const { f, service, job } = await lostHttpJob(); f.evidence.hold = "active"; f.evidence.body = true;
  const controller = new AbortController(); const reason = new Error("caller stopped");
  const pending = withRequestOptions({ signal: controller.signal, deadline: Date.now() + 250 }, () => service.get(job.jobId!, { includeExecutionEvidence: true }));
  const outcome = pending.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  await waitUntil(() => f.evidence.entered === 1); if (mode === "abort") controller.abort(reason);
  expect((await outcome).error).toMatchObject(mode === "deadline" ? { name: "TimeoutError" } : { message: "caller stopped" });
  await waitUntil(() => f.evidence.closed === 1);
  expect(evidenceCalls(f)).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 30)); expect(evidenceCalls(f)).toHaveLength(1);
});

it.each([
  ["deadline", false], ["deadline", true], ["abort", false], ["abort", true],
] as const)("bounds saved-turn session lookup on caller %s (body=%s) before any log or evidence read", async (mode, body) => {
  const { f, client, job } = await lostHttpJob();
  f.evidence.hold = "session"; f.evidence.body = body;
  const before = f.calls.length;
  const controller = new AbortController(); const reason = new Error("saved-turn caller stopped");
  const outcome = withRequestOptions({ deadline: Date.now() + 250 }, () =>
    observeSession(client, f.sessionID, "/remote/project", job.messageId!, {
      signal: controller.signal, includeExecutionEvidence: true,
    })).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  await waitUntil(() => f.evidence.entered === 1);
  if (mode === "abort") controller.abort(reason);
  let timer: ReturnType<typeof setTimeout>;
  const bounded = await Promise.race([outcome, new Promise<{ error: undefined }>(resolve => {
    timer = setTimeout(() => resolve({ error: undefined }), 600);
  })]);
  clearTimeout(timer!);
  expect(bounded.error).toMatchObject(mode === "deadline" ? { name: "TimeoutError" } : { message: reason.message });
  await waitUntil(() => f.evidence.closed === 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.calls.slice(before).map(call => call.path)).toEqual([`/api/session/${f.sessionID}`]);
  expect(f.calls.filter(call => call.path.endsWith("/prompt"))).toHaveLength(1);
});

it("keeps exact saved-turn evidence, refuses directory mismatch and avoids lookup for an already-aborted caller", async () => {
  const { f, client, service, job } = await lostHttpJob();
  const current = await observeSession(client, f.sessionID, "/remote/project", job.messageId!, { includeExecutionEvidence: true });
  expect(current).toMatchObject({ jobId: job.jobId, messageId: job.messageId, status: "unknown",
    executionEvidence: { root: "active_observed", subtree: "active_observed" } });
  const before = f.calls.length;
  await expect(service.findTurn(f.sessionID, job.messageId!, "/other/project", { includeExecutionEvidence: true }))
    .rejects.toThrow("Session belongs to a different server directory");
  const controller = new AbortController(); controller.abort(new Error("already stopped"));
  await expect(service.findTurn(f.sessionID, job.messageId!, "/remote/project", { signal: controller.signal, includeExecutionEvidence: true }))
    .rejects.toThrow("already stopped");
  expect(f.calls).toHaveLength(before);
});
