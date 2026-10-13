import { afterEach, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeClient } from "../src/client.js";
import { backend, operate } from "../src/backends/adapter.js";
import type { V2Adapter } from "../src/backends/v2.js";
import { JobService } from "../src/jobs.js";
import { initialV2Observation, applyObservedEvent } from "../src/backends/v2-observation.js";
import { projectLiveTurn } from "../src/backends/v2-live.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerInputTools } from "../src/tools/input.js";
import { registerMiscTools } from "../src/tools/misc.js";
import { registerSessionTools } from "../src/tools/session.js";
import { registerMessageTools } from "../src/tools/message.js";
import { taskFromJob } from "../src/task-transport.js";
import type { McpServer } from "../src/mcp-server.js";

const warning = "Execution failed before prompt delivery. The admitted input may still be queued and may execute later. Inspect this job/session before taking further action; do not resend automatically.";
const cause = { type: "AgentNotFoundError", message: "Agent unavailable", status: 404 };
const expectedError = { name: "ExecutionStartFailed", message: warning, cause };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map(fn => fn())); });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await tick(); }
  throw new Error("Synthetic stream did not reach checkpoint");
}
const row = (type: string, seq: number, data: Record<string, unknown> = {}) => ({
  id: `evt_${seq}`, created: 1, type, durable: { aggregateID: "ses_startup", seq, version: 1 }, data: { sessionID: "ses_startup", ...data },
});
const prefix = (id = "target") => [
  row("session.inbox.enqueued", 1, { inboxID: id, item: { type: "user", delivery: "queue" } }),
  row("session.execution.started", 2), row("session.execution.failed", 3, { error: { ...cause } }),
];
function eligible() {
  return { ...initialV2Observation("target"), startupFailureEligible: true as const, admitted: true, queued: true };
}

// Real pinned SDK request envelopes, SSE decoding, live filtering and job storage.
async function fixture(opts: { dispatch?: boolean; delivered?: boolean; connected?: boolean; receipt?: "lost" | "id" | "session"; error?: unknown; agentStatus?: number; agentID?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "issue-105-fixture-"));
  const session = { id: "ses_startup", title: "Synthetic", projectID: "prj_fixture", location: { directory: "/remote/project" },
    model: { providerID: "fixture", id: "model" }, agent: "plan", time: { created: 1, updated: 2 } };
  const calls: Array<{ method: string; url: URL; body: any }> = [];
  const streams = new Set<ServerResponse>();
  const emit = (value: unknown) => { for (const stream of streams) stream.write(`data: ${JSON.stringify(value)}\r\n\r\n`); };
  const json = (res: ServerResponse, data: unknown) => res.end(JSON.stringify({ data }));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const call = { method: req.method!, url: new URL(req.url!, "http://fixture"), body: text ? JSON.parse(text) : undefined };
    calls.push(call); res.setHeader("content-type", "application/json");
    const path = call.url.pathname;
    if (path === "/api/event") {
      res.setHeader("content-type", "text/event-stream"); res.flushHeaders(); streams.add(res);
      res.on("close", () => streams.delete(res));
      if (opts.connected !== false) res.write('data: {"type":"server.connected","id":"evt_ready","created":1}\n\n');
      return;
    }
    if (path.startsWith("/api/agent/")) {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      if (opts.agentStatus || id !== "plan") {
        if (opts.agentStatus === 599) { res.destroy(); return; }
        res.statusCode = opts.agentStatus ?? 404;
        return res.end(JSON.stringify({ _tag: "AgentNotFoundError", agentID: id }));
      }
      return json(res, { id: opts.agentID ?? "plan", name: "Plan", mode: "primary", description: "Planning" });
    }
    if (path === "/api/agent") return json(res, [{ id: "plan", name: "Plan", mode: "primary", description: "Planning" }]);
    if (path === "/api/location") return res.end(JSON.stringify({ directory: "/remote/project", project: { id: "prj_fixture", directory: "/remote/project", canonical: "/remote/project" } }));
    if (path === "/api/session" || path === "/api/session/ses_startup") return json(res, session);
    if (opts.delivered && path.includes("/message/")) return json(res, { id: decodeURIComponent(path.split("/").at(-1)!), type: "user", time: { created: 1 }, content: [] });
    if (path.endsWith("/prompt")) {
      const events = prefix(call.body.id);
      if (opts.delivered) events.splice(2, 0, row("session.inbox.delivered", 3, { inboxID: call.body.id }));
      if (opts.delivered) events.at(-1)!.durable.seq = 4;
      if (opts.dispatch !== false) for (const event of events) {
        if (event.type === "session.execution.failed") event.data.error = opts.error ?? cause;
        emit(event);
      }
      if (opts.receipt === "lost") { res.destroy(); return; }
      return json(res, { id: opts.receipt === "id" ? "wrong" : call.body.id, sessionID: opts.receipt === "session" ? "ses_other" : session.id, type: "user", delivery: "queue", time: { created: 1 } });
    }
    if (path.endsWith("/log")) { res.setHeader("content-type", "text/event-stream"); res.end(`data: ${JSON.stringify({ type: "log.synced", aggregateID: session.id, seq: 0 })}\n\n`); return; }
    if (path.endsWith("/inbox") || path.endsWith("/form") || path.endsWith("/permission")) return json(res, []);
    if (req.method === "DELETE") { res.statusCode = 403; res.end('{}'); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await tick(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); });
  vi.stubEnv("OPENCODE_HERDR_ORIGIN_DIR", "");
  const client = new OpenCodeClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, backend: "v2" });
  const service = new JobService(client, { storeRoot: root });
  const recordPath = async (id: string) => join(root, (await readdir(root))[0], "v2", `${id}.json`);
  const record = async (id: string) => JSON.parse(await readFile(await recordPath(id), "utf8"));
  const change = async (id: string, fn: (record: any) => void) => { const saved = await record(id); fn(saved); await writeFile(await recordPath(id), JSON.stringify(saved)); };
  return { client, service, root, session, calls, emit, record, change, close: () => { for (const stream of streams) stream.end(); } };
}

it.each(["sessions.create", "messages.enqueue", "messages.send", "messages.shell"] as const)("rejects display name before any %s write, including model selection", async operation => {
  const f = await fixture();
  await expect(operate(f.client, operation, { sessionId: operation === "sessions.create" ? undefined : f.session.id, directory: "/remote/project",
    body: { agent: "Plan", model: { providerID: "other", modelID: "other" }, command: "pwd", parts: [{ type: "text", text: "synthetic" }] } }))
    .rejects.toMatchObject({ name: "AgentIdNotFound", message: expect.stringContaining("agent_list") });
  expect(f.calls.filter(call => call.method !== "GET")).toEqual([]);
  const lookup = f.calls.find(call => call.url.pathname === "/api/agent/Plan")!;
  expect(lookup.url.searchParams.get("location[directory]")).toBe("/remote/project");
});

it.each([401, 403, 503, 599] as const)("preserves agent lookup %s failures without writes", async fault => {
  const f = await fixture({ agentStatus: fault });
  const error = await operate(f.client, "sessions.create", { body: { agent: "plan" } }).catch(error => error);
  expect(error.name).not.toBe("AgentIdNotFound");
  // 599 is the fixture's connection-reset sentinel, not an HTTP response.
  expect(error.status).toBe(fault === 599 ? undefined : fault);
  expect(f.calls.filter(call => call.method !== "GET")).toEqual([]);
});

it.each(["Plan", ""])("definitely rejects mismatched/malformed agent ID %j in jobs before writes", async agentID => {
  const f = await fixture({ agentID });
  const job = await f.service.start({ prompt: "synthetic", agent: "plan" });
  expect(job).toMatchObject({ status: "failed", error: { name: "BackendCapabilityError", message: expect.stringContaining("agent_list") } });
  expect(job.error?.message).toContain("ID");
  expect(f.calls.filter(call => call.method !== "GET")).toEqual([]);
});

it("validates exact ID/directory once per operation and leaves omission unchanged", async () => {
  const f = await fixture();
  await operate(f.client, "sessions.create", { directory: "/remote/project", body: { agent: "plan" } });
  expect(f.calls.map(call => call.url.pathname)).toEqual(["/api/agent/plan", "/api/session"]);
  expect(f.calls[1].body.agent).toBe("plan");
  expect(f.calls[0].url.searchParams.get("location[directory]")).toBe("/remote/project");
  f.calls.length = 0;
  await operate(f.client, "sessions.create", { body: {} });
  expect(f.calls.map(call => call.url.pathname)).toEqual(["/api/session"]);
});

it("keeps typed SDK AgentNotFound actionable in a job diagnostic", async () => {
  const f = await fixture();
  vi.spyOn(backend(f.client).api.agent, "get").mockRejectedValue({ _tag: "AgentNotFoundError", agentID: "Plan" });
  const job = await f.service.start({ prompt: "synthetic", agent: "Plan" });
  expect(job).toMatchObject({ status: "failed", error: { name: "AgentIdNotFound", message: expect.stringContaining("agent_list") } });
  expect(f.calls.filter(call => call.method !== "GET")).toEqual([]);
});

it("persists exact fresh startup failure from the SDK live drain with no projected user or resend", async () => {
  const f = await fixture();
  const job = await f.service.start({ prompt: "synthetic", agent: "plan" });
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  const failed = await f.service.get(job.jobId!);
  expect(failed).toMatchObject({ status: "failed", error: expectedError, inputs: [] });
  const saved = await f.record(job.jobId!);
  expect(saved.observation).toMatchObject({ outcome: "failed", queued: true, ownsExecution: false, cursor: 0, liveSeen: [1, 2, 3] });
  expect(saved.observation.delivered).not.toBe(true); expect(saved.observation.targetExecution).toBeUndefined();
  f.close();
  expect((await new JobService(f.client, { storeRoot: f.root }).get(job.jobId!)).error).toEqual(expectedError);
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(1);
  expect(f.calls.filter(call => call.method !== "GET").map(call => call.url.pathname)).toEqual(["/api/session", "/api/session/ses_startup/prompt"]);
  expect(f.calls.some(call => call.url.pathname.includes("/message/") || call.url.pathname.endsWith("/log"))).toBe(false);
});

it("waits for decoded server.connected after actual SDK HTTP reader readiness before sending one prompt", async () => {
  const f = await fixture({ connected: false });
  const probe = (backend(f.client) as V2Adapter).eventStreamReady();
  const started = f.service.start({ prompt: "synthetic" });
  await probe.ready; probe.dispose();
  // Give the HTTP-reader shortcut time to reach the server: it must not dispatch.
  await new Promise(resolve => setTimeout(resolve, 50));
  const beforeConnected = f.calls.filter(call => call.url.pathname.endsWith("/prompt")).length;
  f.emit({ type: "server.connected", id: "evt_ready", created: 1 });
  const job = await started;
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  expect(beforeConnected).toBe(0);
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(1);
  expect((await f.service.get(job.jobId!))).toMatchObject({ status: "failed", error: expectedError });
});

it.each(["close", "timeout"] as const)("never enqueues on actual SDK HTTP200 without connected before %s", async mode => {
  const f = await fixture({ connected: false, dispatch: false });
  const probe = (backend(f.client) as V2Adapter).eventStreamReady();
  const started = f.service.start({ prompt: "synthetic" });
  await probe.ready; probe.dispose();
  if (mode === "close") f.close();
  const job = await started;
  expect(job).toMatchObject({ status: "failed", error: { name: "LiveSubscriptionNotReady", message: expect.stringContaining("prompt was not sent") } });
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(0);
}, 10_000);

it("an eligible projection establishes failure and deduplicated copies add no evidence", () => {
  const events = prefix();
  const projected = projectLiveTurn(eligible(), [events[0], events[0], events[1], events[2]], "ses_startup");
  expect(projected.state).toMatchObject({ outcome: "failed", error: expectedError, liveSeen: [1, 2, 3] });
  expect(projected.duplicateCount).toBe(1);
});

it.each([
  ["no provenance", (s: any) => { delete s.startupFailureEligible; }],
  ["empty replay advanced cursor", (s: any) => { s.cursor = 1; }],
  ["replay row", (s: any) => { s.logEvents = 1; }],
  ["replay seen", (s: any) => { s.logSeen = [9]; }],
  ["not admitted", (s: any) => { s.admitted = false; }],
  ["not queued", (s: any) => { s.queued = false; }],
  ["delivered", (s: any) => { s.delivered = true; }],
  ["prior delivery", (s: any) => { s.latestDeliveredId = "prior"; }],
  ["owned", (s: any) => { s.ownsExecution = true; }],
  ["target execution", (s: any) => { s.targetExecution = 1; }],
  ["ownership lost", (s: any) => { s.ownershipLost = true; }],
  ["interrupted", (s: any) => { s.interruption = "shutdown"; }],
  ["assistant", (s: any) => { s.assistantIds = ["other"]; }],
  ["completed assistant", (s: any) => { s.completedAssistantIds = ["other"]; }],
  ["final assistant", (s: any) => { s.finalAssistantId = "other"; }],
  ["pending kind competition", (s: any) => { s.pendingKinds.other = "compaction"; }],
  ["pending delivery competition", (s: any) => { s.pendingDeliveries.other = "queue"; }],
  ["wrong execution start", (s: any) => { s.executionStart = 1; }],
] as const)("does not attribute startup with %s", (_, change) => {
  const s = projectLiveTurn(eligible(), prefix().slice(0, 2), "ses_startup").state; change(s);
  expect(projectLiveTurn(s, prefix().slice(2), "ses_startup").state.error).not.toMatchObject({ name: "ExecutionStartFailed" });
});

it.each([
  ["wrong session", (e: any[]) => { e[2].data.sessionID = "other"; }],
  ["wrong aggregate", (e: any[]) => { e[2].durable.aggregateID = "other"; }],
  ["competing user", (e: any[]) => { e[0].data.inboxID = "other"; }],
  ["compaction", (e: any[]) => { e[0].data.item.type = "compaction"; }],
  ["steer", (e: any[]) => { e[0].data.item.delivery = "steer"; }],
  ["missing enqueue with two starts", (e: any[]) => { e[0] = row("session.execution.started", 1); }],
  ["step", (e: any[]) => { e[1] = row("session.step.started", 2, { assistantMessageID: "other" }); }],
  ["gap", (e: any[]) => { e[2].durable.seq = 4; }],
  ["missing", (e: any[]) => { e.splice(1, 1); }],
  ["reordered", (e: any[]) => { [e[0], e[1]] = [e[1], e[0]]; }],
  ["malformed cause", (e: any[]) => { e[2].data.error = { type: "Error", message: 42 }; }],
  ["invalid status", (e: any[]) => { e[2].data.error.status = "404"; }],
] as const)("does not attribute startup from %s event evidence", (_, change) => {
  const events = structuredClone(prefix()); change(events);
  expect(projectLiveTurn(eligible(), events, "ses_startup").state.outcome).toBeUndefined();
});

it("does not requalify after competing control work is removed", () => {
  const [enqueue, start, failure] = prefix();
  const events = [enqueue, row("session.inbox.enqueued", 2, { inboxID: "control", item: { type: "compaction", delivery: "queue" } }),
    row("session.inbox.cancelled", 3, { inboxID: "control" }), { ...start, durable: { ...start.durable, seq: 4 } }, { ...failure, durable: { ...failure.durable, seq: 5 } }];
  expect(projectLiveTurn(eligible(), events, "ses_startup").state.outcome).toBeUndefined();
});

it("requires the current failure itself to be live seq3, not persisted live history", () => {
  const s = projectLiveTurn(eligible(), prefix().slice(0, 2), "ses_startup").state;
  s.liveSeen = [1, 2, 3]; s.liveCursor = 3;
  applyObservedEvent(s, prefix()[2] as never);
  expect(s.outcome).toBeUndefined();
  expect(projectLiveTurn(s, [row("session.execution.failed", 4, { error: cause })], "ses_startup").state.outcome).toBeUndefined();
  expect(projectLiveTurn(eligible(), prefix(), "ses_startup", { lost: true }).state.outcome).toBeUndefined();
});

it.each(["lost", "id", "session"] as const)("does not attribute buffered failure after %s receipt", async receipt => {
  const f = await fixture({ receipt }); const job = await f.service.start({ prompt: "synthetic" });
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  expect((await f.service.get(job.jobId!)).error).not.toMatchObject({ name: "ExecutionStartFailed" });
  expect((await f.record(job.jobId!)).observation.outcome).toBeUndefined();
  f.close(); await tick();
  expect(f.calls.filter(call => call.url.pathname.endsWith("/prompt"))).toHaveLength(1);
  expect(f.calls.some(call => ["DELETE", "PATCH"].includes(call.method))).toBe(false);
});

it("supplied sessions do not get fresh-session provenance", async () => {
  const f = await fixture(); const job = await f.service.start({ prompt: "synthetic", sessionId: f.session.id });
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  expect((await f.record(job.jobId!)).observation.startupFailureEligible).toBeUndefined();
  expect((await f.service.get(job.jobId!)).status).toBe("accepted");
});

it.each(["receipt ID", "receipt session", "missing receipt", "observation identity", "lost coverage", "cleared eligibility", "cancel intent", "interruption", "ownership loss"])("saved %s gates an otherwise eligible in-memory track", async guard => {
  const f = await fixture({ dispatch: false }); const job = await f.service.start({ prompt: "synthetic" });
  for (const event of prefix(job.messageId!).slice(0, 2)) f.emit(event);
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 2);
  await f.change(job.jobId!, saved => {
    if (guard === "receipt ID") saved.receipt.id = "wrong";
    if (guard === "receipt session") saved.receipt.sessionID = "other";
    if (guard === "missing receipt") delete saved.receipt;
    if (guard === "observation identity") saved.messageId = "wrong";
    if (guard === "lost coverage") saved.liveCoverage = "lost";
    if (guard === "cleared eligibility") delete saved.observation.startupFailureEligible;
    if (guard === "cancel intent") saved.cancelRequested = true;
    if (guard === "interruption") saved.observation.interruption = "shutdown";
    if (guard === "ownership loss") saved.observation.ownershipLost = true;
  });
  f.emit(prefix(job.messageId!)[2]);
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  const saved = await f.record(job.jobId!);
  expect(saved.observation.startupFailureEligible).toBeUndefined();
  expect(saved.observation.outcome).toBeUndefined();
  expect((await f.service.get(job.jobId!)).error).not.toMatchObject({ name: "ExecutionStartFailed" });
  expect((await f.record(job.jobId!)).observation.outcome).toBeUndefined();
});

it("no-event disconnect clears and saves provenance; restart cannot rearm it", async () => {
  const f = await fixture({ dispatch: false }); const job = await f.service.start({ prompt: "synthetic" });
  expect((await f.record(job.jobId!)).observation.startupFailureEligible).toBe(true);
  f.close(); await until(async () => (await f.record(job.jobId!)).liveCoverage === "lost");
  expect((await f.record(job.jobId!)).observation.startupFailureEligible).toBeUndefined();
  expect((await new JobService(f.client, { storeRoot: f.root }).get(job.jobId!)).status).toBe("unknown");
});

it("refresh saves disqualification on a process/connection restart gap", async () => {
  const f = await fixture({ dispatch: false }); const job = await f.service.start({ prompt: "synthetic" });
  const restartedClient = new OpenCodeClient({ baseUrl: f.client.getBaseUrl(), backend: "v2" });
  await new JobService(restartedClient, { storeRoot: f.root }).get(job.jobId!);
  expect((await f.record(job.jobId!)).observation.startupFailureEligible).toBeUndefined();
});

it("rejected cancel clears provenance before the write and never rearms after reset", async () => {
  const f = await fixture({ dispatch: false }); const job = await f.service.start({ prompt: "synthetic" });
  for (const event of prefix(job.messageId!).slice(0, 2)) f.emit(event);
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 2);
  const api = backend(f.client).api;
  const cancel = api.session.inbox.cancel.bind(api.session.inbox);
  vi.spyOn(api.session.inbox, "cancel").mockImplementation(async (...args: any[]) => {
    expect(await f.record(job.jobId!)).toMatchObject({ cancelRequested: true });
    expect((await f.record(job.jobId!)).observation.startupFailureEligible).toBeUndefined();
    return cancel(...args);
  });
  await f.service.cancel(job.jobId!);
  expect((await f.record(job.jobId!)).cancelRequested).toBe(false);
  f.emit(prefix(job.messageId!)[2]);
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  expect((await f.record(job.jobId!)).observation.outcome).toBeUndefined();
});

it("allowlists and redacts the live cause before persistence", async () => {
  const f = await fixture({ error: { type: "AgentNotFoundError", message: "https://example.invalid/error?token=private-fixture-token", status: 404,
    stack: "private stack", request: { token: "private request" }, prompt: "private prompt", secret: "private secret" } });
  const job = await f.service.start({ prompt: "synthetic" });
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 3);
  const saved = await f.record(job.jobId!);
  expect(saved.error).toEqual({ name: "ExecutionStartFailed", message: warning, cause: { type: "AgentNotFoundError", message: "https://example.invalid/error?token=priv***REDACTED***", status: 404 } });
  expect(JSON.stringify(saved)).not.toMatch(/private (stack|request|prompt|secret)/);
});

it("preserves an unwrapped sanitized delivered failure through the actual SDK live drain", async () => {
  const f = await fixture({ delivered: true, error: { type: "AgentNotFoundError", message: "https://example.invalid/error?token=private-fixture-token", status: 404,
    stack: "private stack", request: { token: "private request" }, prompt: "private prompt", secret: "private secret" } });
  const job = await f.service.start({ prompt: "synthetic" });
  await until(async () => (await f.record(job.jobId!)).observation.liveCursor === 4);
  const failed = await f.service.get(job.jobId!);
  const sanitized = { type: "AgentNotFoundError", message: "https://example.invalid/error?token=priv***REDACTED***", status: 404 };
  expect(failed).toMatchObject({ status: "failed", error: sanitized });
  expect(failed.error).not.toHaveProperty("cause");
  expect(failed.error?.name).not.toBe("ExecutionStartFailed");
  const saved = await f.record(job.jobId!);
  expect(saved.error).toEqual(sanitized);
  expect(saved.observation.delivered).toBe(true);
  expect(JSON.stringify(saved)).not.toMatch(/private (stack|request|prompt|secret)/);
});

it("renders warning and cause across job, workflow and task surfaces without remote mutations", async () => {
  const f = await fixture({ dispatch: false }); const job = await f.service.start({ prompt: "synthetic" });
  // Formatting is independent of attribution; a saved failed snapshot is the input contract.
  await f.change(job.jobId!, saved => { saved.status = "failed"; saved.error = expectedError; saved.inputs = []; saved.observation.outcome = "failed"; saved.observation.error = expectedError; });
  const handlers = new Map<string, Function>();
  const server = { tool: (...args: unknown[]) => { handlers.set(String(args[0]), args.at(-1) as Function); } } as McpServer;
  registerWorkflowTools(server, f.client, f.service); registerInputTools(server, f.client, f.service);
  const mutations = f.calls.filter(call => call.method !== "GET").length;
  for (const [name, args] of [
    ["opencode_job_get", { jobId: job.jobId }], ["opencode_job_cancel", { jobId: job.jobId }], ["opencode_job_input", { jobId: job.jobId }],
    ["opencode_check", { jobId: job.jobId, detailed: false }], ["opencode_check", { jobId: job.jobId, detailed: true }], ["opencode_wait", { jobId: job.jobId, timeoutSeconds: 1 }],
  ] as const) {
    const output = await handlers.get(name)!(args);
    expect(output.content[0].text, name).toContain(warning); expect(output.content[0].text, name).toContain("Agent unavailable");
    expect(output.structuredContent.error, name).toEqual(expectedError);
  }
  // Shared jobResult paths: test formatting only; never dispatch a new real job.
  const failed = await f.service.get(job.jobId!);
  vi.spyOn(f.service, "start").mockResolvedValue(failed);
  vi.spyOn(backend(f.client), "execute").mockResolvedValue({ id: f.session.id } as never);
  for (const name of ["opencode_run", "opencode_fire", "opencode_ask", "opencode_reply"]) {
    const output = await handlers.get(name)!({ prompt: "synthetic", sessionId: f.session.id, maxDurationSeconds: 1 });
    expect(output.content[0].text, name).toContain(warning); expect(output.structuredContent.error, name).toEqual(expectedError);
  }
  for (const detailed of [false, true]) {
    const task = taskFromJob(failed, detailed) as any;
    expect(task.status).toBe("completed"); expect(task.statusMessage).toContain(warning); expect(task.statusMessage).toContain("Agent unavailable");
    if (detailed) { expect(task.result.content[0].text).toContain(warning); expect(task.result.structuredContent.error).toEqual(expectedError); }
  }
  expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(mutations);
});

it("context/list distinguish ID and display name, with honest V1 name-selector fallback", async () => {
  const f = await fixture(); const handlers = new Map<string, Function>(); const schemas = new Map<string, any>();
  const server = { tool: (...args: unknown[]) => { handlers.set(String(args[0]), args.at(-1) as Function); schemas.set(String(args[0]), args[2]); } } as McpServer;
  registerWorkflowTools(server, f.client, f.service); registerMiscTools(server, f.client); registerSessionTools(server, f.client); registerMessageTools(server, f.client);
  for (const name of ["opencode_agent_list", "opencode_context"]) {
    const output = await handlers.get(name)!({}); expect(output.content[0].text).toContain("ID: plan | Name: Plan");
    expect(output.content[0].text).toContain("Planning"); expect(output.content[0].text).toContain("primary");
  }
  for (const [name, schema] of schemas) if (schema.agent) expect(schema.agent.description, name).toMatch(/agent ID/i);
  vi.spyOn(backend(f.client), "execute").mockImplementation(async operation => operation === "configuration.agents" ? [{ name: "Plan", description: "Legacy", mode: "primary" }] as never : {} as never);
  expect((await handlers.get("opencode_agent_list")!({})).content[0].text).toContain("V1 name selector: Plan");
});
