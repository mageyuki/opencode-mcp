import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "../src/jobs.js";
import { backend } from "../src/backends/adapter.js";
import type { OpenCodeClient } from "../src/client.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import type { McpServer } from "../src/mcp-server.js";

let root: string;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });

it("does not enqueue until the SSE reader has produced its connection-ready frame", async () => {
  root = await mkdtemp(join(tmpdir(), "v2-ready-"));
  const pending: Array<(event: unknown) => void> = [];
  const client = { getBaseUrl: () => "http://fixture:4096", connectionHeaders: {}, getBackendIdentity: () => ({ kind: "v2", version: "2.0.18" }) } as unknown as OpenCodeClient;
  const api = {
    event: { subscribe: vi.fn(() => (async function* () {
      while (true) yield await new Promise<unknown>(resolve => pending.push(resolve));
    })()) },
  };
  Object.defineProperty(backend(client), "api", { value: api });
  const enqueue = vi.spyOn(backend(client), "execute").mockImplementation(async (operation, args) => {
    if (operation !== "messages.enqueue") throw new Error(`unexpected ${operation}`);
    return { id: (args.body as { messageID: string }).messageID, sessionID: "session" } as never;
  });
  const service = new JobService(client, { storeRoot: root });
  const started = service.start({ sessionId: "session", prompt: "answer quickly" });
  for (let n = 0; n < 100 && !pending.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(pending).toHaveLength(1);
  expect(enqueue).not.toHaveBeenCalled();
  pending.shift()!({ type: "server.connected", data: {} });
  const result = await started;
  expect(result).toMatchObject({ status: "accepted", sessionId: "session", messageId: expect.stringMatching(/^msg_/) });
  expect(enqueue).toHaveBeenCalledTimes(1);
});

async function liveFixture(emitOnEnqueue = true) {
  root = await mkdtemp(join(tmpdir(), "v2-ready-buffer-"));
  const sessionID = "session";
  const queued: unknown[] = [];
  let wake: (() => void) | undefined;
  let consumed = 0;
  const push = (event: unknown) => { queued.push(event); wake?.(); };
  const emit = (type: string, seq: number, data: Record<string, unknown> = {}, sid = sessionID) =>
    push({ type, durable: { aggregateID: sid, seq, version: 1 }, data: { sessionID: sid, ...data } });
  const client = { getBaseUrl: () => "http://fixture:4096", connectionHeaders: {}, getBackendIdentity: () => ({ kind: "v2", version: "2.0.18" }) } as unknown as OpenCodeClient;
  const api = {
    event: { subscribe: vi.fn(() => (async function* () {
      while (true) {
        if (!queued.length) await new Promise<void>(resolve => { wake = resolve; });
        const next = queued.shift(); if (next === null) return;
        consumed++; yield next;
      }
    })()) },
    session: { get: vi.fn(async () => ({ id: sessionID, location: { directory: "/fixture" }, projectID: "project", time: { created: 1, updated: 2 } })),
      log: vi.fn(() => { throw new Error("no log replay available"); }),
      message: { get: vi.fn(async ({ messageID }: { messageID: string }) => messageID === "answer"
        ? { id: "answer", type: "assistant", content: [{ type: "text", text: "Quick result" }], time: { created: 2, completed: 3 }, finish: "stop" }
        : { id: messageID, type: "user", text: "prompt", time: { created: 1 } }) },
      form: { list: vi.fn(async () => []) }, inbox: { list: vi.fn(async () => []) } },
    permission: { list: vi.fn(async () => []) },
  };
  Object.defineProperty(backend(client), "api", { value: api });
  const receipt = Promise.withResolvers<void>();
  const enqueue = vi.spyOn(backend(client), "execute").mockImplementation(async (operation, args) => {
    if (operation === "sessions.create") return { id: sessionID } as never;
    if (operation !== "messages.enqueue") throw new Error(`unexpected ${operation}`);
    const id = (args.body as { messageID: string }).messageID;
    if (emitOnEnqueue) {
      emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
      emit("session.execution.started", 2);
      emit("session.inbox.delivered", 3, { inboxID: id });
      emit("session.step.started", 4, { assistantMessageID: "answer" });
      emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" });
      emit("session.execution.succeeded", 6);
    }
    await receipt.promise;
    return { id, sessionID } as never;
  });
  const service = new JobService(client, { storeRoot: root });
  const completed = async (jobId: string) => {
    for (let n = 0; n < 100; n++) {
      const job = await service.get(jobId);
      if (job.status === "completed") return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return service.get(jobId);
  };
  return { client, api, service, enqueue, emit, push, receipt, completed, getConsumed: () => consumed };
}

it.each([{ newSession: false, name: "existing" }, { newSession: true, name: "new" }])("buffers a fast $name-session execution until its receipt is registered", async ({ newSession }) => {
  const f = await liveFixture();
  const started = f.service.start({ prompt: "fast", ...(newSession ? {} : { sessionId: "session" }) });
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(0);
  f.push({ type: "server.connected", data: {} });
  for (let n = 0; n < 100 && !f.enqueue.mock.calls.some(([operation]) => operation === "messages.enqueue"); n++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(1);
  f.emit("session.step.started", 4, { assistantMessageID: "unrelated" }, "another-session");
  f.emit("session.step.ended", 5, { assistantMessageID: "unrelated", finish: "stop" }, "another-session");
  f.emit("session.execution.succeeded", 6, {}, "another-session");
  f.emit("session.step.started", 4, { assistantMessageID: "wrong-duplicate" });
  for (let n = 0; n < 100 && f.getConsumed() < 11; n++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.getConsumed()).toBeGreaterThanOrEqual(11);
  f.receipt.resolve();
  const accepted = await started;
  expect(accepted).toMatchObject({ status: "accepted", sessionId: "session", messageId: expect.stringMatching(/^msg_/) });
  expect((await f.completed(accepted.jobId!))).toMatchObject({ status: "completed", text: "Quick result", result: { info: { id: "answer", parentID: accepted.messageId } } });
  expect(f.api.session.message.get.mock.calls.every(([arg]) => [accepted.messageId, "answer"].includes(arg.messageID))).toBe(true);
  expect(f.api.session.log).not.toHaveBeenCalled();
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(1);
});

it("refuses a prompt when the subscription closes before its connection-ready frame", async () => {
  const f = await liveFixture();
  const started = f.service.start({ sessionId: "session", prompt: "must not send" });
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
  f.push(null);
  const result = await started;
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({ name: "LiveSubscriptionNotReady", message: expect.stringContaining("prompt was not sent") });
  expect(result).not.toHaveProperty("liveCoverage", "active");
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(0);
});

it("bounds a quiet stream without a connection-ready frame and never sends its prompt", async () => {
  const f = await liveFixture();
  const subscribe = f.api.event.subscribe.getMockImplementation()!;
  f.api.event.subscribe.mockImplementation((...args: unknown[]) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    return subscribe(...args);
  });
  const started = f.service.start({ sessionId: "session", prompt: "must not send" });
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.api.event.subscribe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  const result = await started;
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({ name: "LiveSubscriptionNotReady", message: expect.stringContaining("prompt was not sent") });
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(0);
});

it("returns fire IDs after enqueue while its independent subscription stays alive", async () => {
  const f = await liveFixture(false);
  const handlers = new Map<string, Function>();
  registerWorkflowTools({ tool: (...args: unknown[]) => { handlers.set(args[0] as string, args.at(-1) as Function); } } as McpServer, f.client, f.service);
  const toolSignal = new AbortController();
  const tool = handlers.get("opencode_fire")!({ prompt: "fast", sessionId: "session" }, { signal: toolSignal.signal });
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
  f.push({ type: "server.connected", data: {} });
  for (let n = 0; n < 100 && !f.enqueue.mock.calls.some(([operation]) => operation === "messages.enqueue"); n++) await new Promise(resolve => setTimeout(resolve, 1));
  f.receipt.resolve();
  const returned = await tool;
  expect(returned.structuredContent).toMatchObject({ status: "accepted", sessionId: "session", jobId: expect.stringMatching(/^job_/), messageId: expect.stringMatching(/^msg_/) });
  toolSignal.abort();
  expect(f.api.event.subscribe.mock.calls[0][0].signal.aborted).toBe(false);
  const id = returned.structuredContent.messageId;
  f.emit("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } });
  f.emit("session.execution.started", 2);
  f.emit("session.inbox.delivered", 3, { inboxID: id });
  f.emit("session.step.started", 4, { assistantMessageID: "answer" });
  f.emit("session.step.ended", 5, { assistantMessageID: "answer", finish: "stop" });
  f.emit("session.execution.succeeded", 6);
  expect((await f.completed(returned.structuredContent.jobId)).text).toBe("Quick result");
});

it("does not claim buffered completion when the stream drops before the receipt arrives", async () => {
  const f = await liveFixture();
  const started = f.service.start({ sessionId: "session", prompt: "fast" });
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
  f.push({ type: "server.connected", data: {} });
  for (let n = 0; n < 100 && !f.enqueue.mock.calls.some(([operation]) => operation === "messages.enqueue"); n++) await new Promise(resolve => setTimeout(resolve, 1));
  f.push(null);
  for (let n = 0; n < 100 && !f.api.event.subscribe.mock.calls[0][0].signal.aborted; n++) await new Promise(resolve => setTimeout(resolve, 1));
  f.receipt.resolve();
  const dispatched = await started;
  expect(dispatched.status).toBe("unknown");
  expect((await f.service.get(dispatched.jobId!)).status).toBe("unknown");
  expect(f.enqueue.mock.calls.filter(([operation]) => operation === "messages.enqueue")).toHaveLength(1);
});
