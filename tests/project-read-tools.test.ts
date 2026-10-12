import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/app.js";
import { OpenCodeClient } from "../src/client.js";
import { backend } from "../src/backends/adapter.js";
import { V2Adapter } from "../src/backends/v2.js";
import type { JobService } from "../src/jobs.js";

const names = ["opencode_file_read", "opencode_file_list", "opencode_find_file"];
const jobs = new Proxy({}, { get: () => () => { throw new Error("Unexpected job operation"); } }) as JobService;
let root: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "project-tools-synthetic-")); vi.stubEnv("HOME", root); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function connection(profile: "essential" | "full" = "essential") {
  const backendClient = new OpenCodeClient({ baseUrl: "http://127.0.0.1:9", backend: "v2" });
  const location = vi.spyOn((backend(backendClient) as V2Adapter).api.location, "get").mockResolvedValue({ directory: root } as any);
  const server = createServer(backendClient, jobs, profile);
  const client = new Client({ name: "synthetic", version: "1" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd); await client.connect(clientEnd);
  closers.push(() => server.close(), () => client.close());
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { client, server, location, call };
}
async function file(name: string, text = "synthetic source\n") { await fs.writeFile(`${root}/${name}`, text, { mode: 0o644 }); }
function error(result: any, code: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ error: { code, message: code }, text: code, isError: true });
  expect(result.content).toEqual([{ type: "text", text: code }]);
}
it("actually registers exactly three read-only guarded tools while full remains legacy", async () => {
  const { client } = await connection();
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(28);
  for (const name of names) {
    const tool = tools.find(tool => tool.name === name)!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toHaveProperty("directory");
    expect(tool.inputSchema.properties).not.toHaveProperty("sessionId");
    expect(tool.inputSchema.properties).not.toHaveProperty("searchDirectory");
  }
  for (const name of ["opencode_find_text", "opencode_find_symbol", "opencode_file_status", "opencode_session_delete", "opencode_shell"]) expect(tools.map(tool => tool.name)).not.toContain(name);
  const full = await connection("full");
  const legacy = (await full.client.listTools()).tools;
  expect(legacy).toHaveLength(87);
  expect(legacy.find(tool => tool.name === "opencode_find_file")!.inputSchema.properties).toHaveProperty("searchDirectory");
});
it("strictly accepts project context and rejects overrides/invalid inputs without echoing values", async () => {
  await file("plain.txt");
  const { call, location } = await connection();
  expect((await call("opencode_file_read", { directory: root, path: "plain.txt" })).structuredContent?.isError).toBe(false);
  expect(location).toHaveBeenCalledTimes(1);
  expect(location.mock.calls[0][0]).toEqual({ location: { directory: root } });
  for (const [name, args] of [
    ["opencode_file_read", { path: root + "/plain.txt" }],
    ["opencode_file_read", { path: "../private-marker" }],
    ["opencode_file_read", { path: "plain.txt", sessionId: "private-marker" }],
    ["opencode_find_file", { query: "plain", searchDirectory: "private-marker" }],
    ["opencode_file_list", { limit: 0 }],
    ["opencode_file_list", { limit: 1.5 }],
    ["opencode_file_read", { path: { privateMarker: true } }],
    ["opencode_find_file", { query: "" }],
    ["opencode_file_read", { path: "plain.txt", directory: "relative-private-marker" }],
  ] as const) {
    const result = await call(name, args); error(result, "PROJECT_READ_INVALID_REQUEST");
    expect(JSON.stringify(result)).not.toMatch(/private-marker|privateMarker/);
  }
  expect(location).toHaveBeenCalledTimes(1);
});
it("normalizes complete text without data duplication and lists/finds only eligible paths", async () => {
  await file("plain.txt"); await file(".env", "SYNTHETIC_DENIED"); await file("service.json", "SYNTHETIC_DENIED");
  const { call } = await connection();
  const result: any = await call("opencode_file_read", { path: "plain.txt" });
  expect(result.content).toEqual([{ type: "text", text: "synthetic source\n" }]);
  expect(result.structuredContent).toEqual({ text: "synthetic source\n", isError: false, data: { kind: "read", path: "plain.txt", bytesRead: 17, complete: true } });
  for (const [name, args] of [["opencode_file_list", {}], ["opencode_find_file", { query: "TXT" }]] as const) {
    const discovery: any = await call(name, args);
    expect(discovery.structuredContent.data).toMatchObject({ entries: [{ path: "plain.txt", type: "file" }], complete: true });
    expect(JSON.stringify(discovery)).not.toMatch(/\.env|service\.json|SYNTHETIC_DENIED/);
  }
  const missing = await call("opencode_file_read", { path: "missing" });
  const denied = await call("opencode_file_read", { path: ".env" });
  error(missing, "PROJECT_READ_UNAVAILABLE"); expect(denied).toEqual(missing);
});
it("bounds escape-heavy final normalized results and leaks no backend diagnostics", async () => {
  const escaped = "\u0001".repeat(65536); await file("escaped.txt", escaped);
  const { call, location } = await connection();
  const result: any = await call("opencode_file_read", { path: "escaped.txt" });
  expect(result.structuredContent.isError).toBe(false);
  expect(result.content[0].text).toBe(escaped);
  expect(result.structuredContent.data.content).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
  location.mockRejectedValue(new Error("PRIVATE_ROOT diagnostic"));
  error(await call("opencode_file_read", { path: "escaped.txt" }), "PROJECT_READ_UNAVAILABLE");
});
