import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeClient } from "../src/client.js";
import { backend } from "../src/backends/adapter.js";
import { V2Adapter } from "../src/backends/v2.js";

// Observe real process invocations; classification is never mocked.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { executeProjectRead as execute } from "../src/project-read.js";
let home: string, root: string, client: OpenCodeClient, location: ReturnType<typeof vi.spyOn>;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { PATH: process.env.PATH, HOME: home, LANG: "C" }, stdio: "pipe" });
async function dir(path: string) { await fs.mkdir(path, { recursive: true, mode: 0o755 }); await fs.chmod(path, 0o755); }
async function file(path: string, content: string | Buffer = "ordinary source\n", mode = 0o644) {
  await dir(path.slice(0, path.lastIndexOf("/"))); await fs.writeFile(path, content, { mode }); await fs.chmod(path, mode);
}
const read = (path: string, directory = root, options?: any) => execute(client, { kind: "read", directory, path }, options);
const list = (directory = root, path = ".", limit = 100) => execute(client, { kind: "list", directory, path, limit });
const find = (directory = root, query = "note", limit = 100) => execute(client, { kind: "find", directory, query, limit });
const denied = (work: Promise<unknown>, code = "PROJECT_READ_UNAVAILABLE") => expect(work).rejects.toMatchObject({ code, message: code });
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "project-read-synthetic-"));
  root = `${home}/project`; await dir(root);
  vi.stubEnv("HOME", home);
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OPENCODE_TASK_STORE"]) vi.stubEnv(name, "");
  client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:9", backend: "v2" });
  location = vi.spyOn((backend(client) as V2Adapter).api.location, "get").mockImplementation(async (args: any) => ({ directory: args.location?.directory ?? root, project: { directory: home } }) as any);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

it("uses only location metadata for explicit/default and selected-subdirectory authority", async () => {
  await file(`${root}/docs/plain.txt`);
  expect(await read("plain.txt", `${root}/docs`)).toMatchObject({ path: "plain.txt", content: "ordinary source\n", complete: true });
  expect(await execute(client, { kind: "read", path: "docs/plain.txt" })).toMatchObject({ bytesRead: 16 });
  expect(location).toHaveBeenCalledTimes(2);
  expect(location.mock.calls[1][0]).toEqual({ location: undefined });
  location.mockResolvedValue({ directory: home } as any);
  await denied(read("docs/plain.txt"));
  location.mockRejectedValue(new Error("private backend diagnostic"));
  await denied(read("docs/plain.txt"));
});
it("allows ordinary configuration/non-Git/untracked documents but not secrets or secret roots", async () => {
  const config = `${home}/.config/source`; await file(`${config}/guide.md`);
  expect(await read("guide.md", config)).toMatchObject({ content: "ordinary source\n" });
  for (const name of [".env.example", "service.json.bak", "auth.ts", "tokens", "id_rsa.pub", "settings.local.json", "runtime-extra.json", "opencode-langfuse.json.example", "private.pem", "history.jsonl", "opencode.jsonc", ".git-credentials"]) {
    await file(`${root}/${name}`); await denied(read(name));
  }
  for (const name of [".ssh", "auth-service", "archive.git"]) {
    await file(`${root}/${name}/plain.txt`); await denied(read("plain.txt", `${root}/${name}`));
  }
  await file(`${home}/history.jsonl/selected/plain.txt`);
  await denied(read("plain.txt", `${home}/history.jsonl/selected`));
  await file(`${root}/tokenizer.ts`); await file(`${root}/author.md`); await file(`${root}/config.json`);
  expect((await list()).entries.map((e: any) => e.path).sort()).toEqual(["author.md", "config.json", "tokenizer.ts"]);
  expect((await find(root, "TOKENIZER")).entries).toEqual([{ path: "tokenizer.ts", type: "file" }]);
});
it("uses each nearest real Git repository, literal colon paths, and prunes ignored ordinary selections", async () => {
  git(root, "init", "-q"); await dir(`${root}/inner`); git(`${root}/inner`, "init", "-q");
  await file(`${root}/.git/info/exclude`, "local-note.txt\nomitted/\n:notes.txt\n");
  await file(`${root}/inner/.git/info/exclude`, "nested-note.txt\n");
  for (const name of ["local-note.txt", ":notes.txt", ":public.txt", "plain.txt", "omitted/plain.txt", "inner/nested-note.txt", "inner/plain.txt", "literal*.txt", "literal-companion.txt"]) await file(`${root}/${name}`);
  await file(`${root}/.gitignore`, "literal\\*.txt\n");
  await denied(read("literal*.txt"));
  expect(await read("literal-companion.txt")).toMatchObject({ content: "ordinary source\n" });
  for (const scope of [home, root]) {
    const prefix = scope === home ? "project/" : "";
    for (const name of ["local-note.txt", ":notes.txt", "inner/nested-note.txt"]) await denied(read(prefix + name, scope));
    expect(await read(prefix + "inner/plain.txt", scope)).toMatchObject({ content: "ordinary source\n" });
    expect((await find(scope)).entries).toEqual([]);
    expect(JSON.stringify(await list(scope, prefix + "inner"))).not.toContain("nested-note");
  }
  await denied(read("nested-note.txt", `${root}/inner`));
  expect(await read(":public.txt")).toMatchObject({ path: ":public.txt" });
  await denied(read("plain.txt", `${root}/omitted`)); await denied(list(`${root}/omitted`)); await denied(find(`${root}/omitted`));
  await file(`${root}/.gitignore`, "inner/\n");
  await denied(read("inner/plain.txt"));
  expect(await read("plain.txt", `${root}/inner`)).toMatchObject({ content: "ordinary source\n" });
});
it("binds regular/gitfile worktrees and fails closed at an inner marker with missing HEAD", async () => {
  git(root, "init", "-q"); await file(`${root}/docs/only-here.txt`); await file(`${root}/docs/only-there.txt`); await file(`${root}/docs/.env.example`);
  git(root, "add", "docs"); git(root, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture");
  const linked = `${home}/linked`; git(root, "worktree", "add", "-qb", "fixture-linked", linked);
  await fs.chmod(linked, 0o755);
  await file(`${root}/.gitignore`, "docs/only-here.txt\n"); await file(`${linked}/.gitignore`, "docs/only-there.txt\n");
  await file(`${root}/.git/info/exclude`, "docs/local-note.txt\n");
  for (const repo of [root, linked]) {
    await file(`${repo}/docs/local-note.txt`);
    const hidden = repo === root ? "only-here.txt" : "only-there.txt";
    const visible = repo === root ? "only-there.txt" : "only-here.txt";
    for (const scope of [repo, `${repo}/docs`]) {
      const prefix = scope === repo ? "docs/" : "";
      await denied(read(prefix + hidden, scope)); await denied(read(prefix + "local-note.txt", scope)); await denied(read(prefix + ".env.example", scope));
      expect(await read(prefix + visible, scope)).toMatchObject({ path: prefix + visible });
      expect((await list(scope, scope === repo ? "docs" : ".")).entries).toEqual([{ path: prefix + visible, type: "file" }]);
    }
  }
  await dir(`${root}/broken/.git`); await file(`${root}/broken/plain.txt`);
  expect((await list()).entries).toContainEqual({ path: "broken", type: "directory" });
  for (const scope of [root, `${root}/broken`, home]) {
    const prefix = scope === home ? "project/broken/" : scope === root ? "broken/" : "";
    await denied(read(prefix + "plain.txt", scope)); await denied(list(scope, prefix || ".")); await denied(find(scope, "plain"));
  }
});
it("rejects path escapes, links, hardlinks and nonregular objects without following them", async () => {
  await file(`${root}/plain.txt`); await file(`${home}/outside.txt`, "OUTSIDE_MARKER");
  await fs.symlink(`${home}/outside.txt`, `${root}/link`); await fs.symlink(home, `${root}/linked-dir`);
  await fs.link(`${home}/outside.txt`, `${root}/hard`); execFileSync("mkfifo", [`${root}/fifo`]);
  for (const path of ["../outside.txt", "/outside.txt", "C:/outside.txt", "\\host\\file", "~/file", "file://outside", "a/../plain.txt", "a\nfile", "a/".repeat(33) + "file"]) await denied(read(path), "PROJECT_READ_INVALID_REQUEST");
  for (const path of ["link", "linked-dir/outside.txt", "hard", "fifo", "."]) await denied(read(path));
  await denied(read("outside.txt", `${root}/linked-dir`));
  expect(JSON.stringify(await list())).not.toMatch(/link|hard|fifo|OUTSIDE/);
});
it("retains the opened file object across a deterministic path replacement", async () => {
  await file(`${root}/plain.txt`); await file(`${home}/outside.txt`, "OUTSIDE_MARKER");
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    const handle = await (open as any)(...args);
    if (String(args[0]).endsWith("/plain.txt")) {
      await fs.rename(`${root}/plain.txt`, `${root}/moved.txt`);
      await fs.symlink(`${home}/outside.txt`, `${root}/plain.txt`);
    }
    return handle;
  });
  expect(await read("plain.txt")).toMatchObject({ content: "ordinary source\n" });
});
it("bounds complete text and rejects binary and private permissions", async () => {
  for (const size of [65536, 65537]) {
    await file(`${root}/sized.txt`, "x".repeat(size));
    if (size === 65536) expect(await read("sized.txt")).toMatchObject({ bytesRead: size, complete: true });
    else await denied(read("sized.txt"), "PROJECT_READ_TOO_LARGE");
  }
  for (const content of [Buffer.from([0xff]), Buffer.from("a\0b")]) { await file(`${root}/binary`, content); await denied(read("binary"), "PROJECT_READ_NOT_TEXT"); }
  await file(`${root}/plain.txt`, "private", 0o600); await denied(read("plain.txt"));
  await file(`${root}/private-dir/plain.txt`); await fs.chmod(`${root}/private-dir`, 0o700); await denied(read("private-dir/plain.txt"));
  expect((await list()).entries).not.toContainEqual({ path: "private-dir", type: "directory" });
});
it("unions default/inherited private stores and pins global Git excludes to default HOME", async () => {
  git(root, "init", "-q");
  await file(`${home}/.config/git/ignore`, "default-only-note.txt\n");
  await file(`${root}/default-only-note.txt`); await file(`${root}/custom-only-note.txt`);
  await file(`${root}/plain.txt`);
  for (const variant of ["one", "two"]) {
    for (const [name, suffix] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"]]) vi.stubEnv(name, `${home}/${variant}-${suffix}`);
    const stores = [".config/opencode-tunnel", ".config/tunnel-client", ".local/share/opencode", ".local/state/opencode", ".local/state/opencode-mcp", `${variant}-config/opencode-tunnel`, `${variant}-config/tunnel-client`, `${variant}-data/opencode`, `${variant}-state/opencode`, `${variant}-state/opencode-mcp`, "task-store"];
    vi.stubEnv("OPENCODE_TASK_STORE", `${home}/task-store`);
    for (const store of stores) { await file(`${home}/${store}/plain.txt`); await denied(read("plain.txt", `${home}/${store}`)); }
    vi.stubEnv("GIT_DIR", `${home}/wrong`); vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    await denied(read("default-only-note.txt"));
    expect(await read("custom-only-note.txt")).toMatchObject({ content: "ordinary source\n" });
    const alternative = execFileSync("git", ["--git-dir=.git", "--work-tree=.", "check-ignore", "--no-index", "./default-only-note.txt"],
      { cwd: root, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: `${home}/.config`, LANG: "C" }, stdio: "pipe" });
    expect(alternative.toString()).toBe("./default-only-note.txt\n");
    // The same actual command loses the default-only rule with inherited XDG.
    expect(() => execFileSync("git", ["--git-dir=.git", "--work-tree=.", "check-ignore", "--no-index", "./default-only-note.txt"],
      { cwd: root, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: `${home}/${variant}-config`, LANG: "C" }, stdio: "pipe" })).toThrowError(expect.objectContaining({ status: 1 }));
    expect(await read("plain.txt")).toMatchObject({ content: "ordinary source\n" });
  }
  await file(`${home}/global-ignore`, "custom-only-note.txt\n");
  await file(`${home}/.gitconfig`, `[core]\n excludesFile = ${home}/global-ignore\n`);
  await denied(read("custom-only-note.txt"));
  expect(await read("default-only-note.txt")).toMatchObject({ content: "ordinary source\n" });
  // Absolute inherited paths use lexical normalization, not a narrower
  // request-directory grammar, and never lose a known-store exclusion.
  await dir(`${home}/spelling`);
  vi.stubEnv("XDG_STATE_HOME", `${home}/spelling/../one-state`);
  await denied(read("plain.txt", `${home}/one-state/opencode`));
});
it("returns classified partial results for entry, visit, directory and depth limits", async () => {
  await file(`${root}/first.txt`); await file(`${root}/second.txt`);
  expect(await list(root, ".", 1)).toMatchObject({ complete: false, entries: [expect.objectContaining({ type: "file" })] });
  await dir(`${root}/deep/` + Array(17).fill("d").join("/"));
  expect(await find(root, "d", 200)).toMatchObject({ complete: false });
  await fs.rm(`${root}/deep`, { recursive: true });
  for (let i = 0; i < 256; i++) await dir(`${root}/d${i}`);
  expect(await find(root, "txt", 200)).toMatchObject({ complete: false });
  const visitsRoot = `${root}/visits`; await file(`${visitsRoot}/plain.txt`);
  for (let i = 0; i < 4100; i++) await file(`${visitsRoot}/.env-${i}`, "excluded");
  const opendir = fs.opendir.bind(fs); let visits = 0;
  vi.spyOn(fs, "opendir").mockImplementation(async (...args: any[]) => {
    const stream = await (opendir as any)(...args); const next = stream.read.bind(stream);
    stream.read = async () => { const entry = await next(); if (entry) visits++; return entry; }; return stream;
  });
  const partial = await list(visitsRoot, ".", 200);
  expect(partial.complete).toBe(false); expect(partial.entries.length).toBeLessThanOrEqual(1);
  expect(visits).toBe(4096); // Return limit 200 cannot explain this outcome.
}, 15000);
it("discards admitted results on cancellation/failure and holds the busy slot until I/O cleanup", async () => {
  await file(`${root}/plain.txt`);
  const controller = new AbortController();
  const opendir = fs.opendir.bind(fs); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const acquired = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, "opendir").mockImplementation(async (...args: any[]) => {
    const directory = await (opendir as any)(...args); entered(); await held; return directory;
  });
  const pending = execute(client, { kind: "list", directory: root }, { signal: controller.signal });
  await acquired; controller.abort();
  await denied(read("plain.txt"), "PROJECT_READ_BUSY"); release(); await denied(pending, "PROJECT_READ_BUDGET");
  vi.restoreAllMocks();
  vi.spyOn((backend(client) as V2Adapter).api.location, "get").mockResolvedValue({ directory: root } as any);
  expect(await read("plain.txt")).toMatchObject({ content: "ordinary source\n" });
  await denied(read("plain.txt", root, { deadline: Date.now() - 1 }), "PROJECT_READ_BUDGET");
  const stat = fs.lstat.bind(fs); let probes = 0;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: any[]) => {
    if (String(args[0]).endsWith("/.git") && ++probes > root.split("/").filter(Boolean).length + 1) throw new Error("private policy failure");
    return (stat as any)(...args);
  });
  await file(`${root}/later/plain.txt`);
  await denied(find(root, "plain"));
});
it("fails closed for remote/V1 backends, malformed metadata/selectors and invalid HOME", async () => {
  await file(`${root}/plain.txt`);
  const remote = new OpenCodeClient({ baseUrl: "http://remote.example.invalid", backend: "v2" });
  await denied(execute(remote, { kind: "read", path: "plain.txt" }), "PROJECT_READ_UNSUPPORTED");
  await denied(execute(new OpenCodeClient({ baseUrl: "http://127.0.0.1", backend: "v1" }), { kind: "read", path: "plain.txt" }), "PROJECT_READ_UNSUPPORTED");
  for (const directory of ["relative", `${root}/../project`, "", `${root}/x\n`]) await denied(read("plain.txt", directory), "PROJECT_READ_INVALID_REQUEST");
  location.mockResolvedValue({ directory: "relative" } as any); await denied(read("plain.txt"));
  vi.stubEnv("HOME", "relative"); await denied(read("plain.txt"));
});
it.each(["cancel", "deadline", "git-failure"] as const)("discards discovery after admission on %s", async failure => {
  await file(`${root}/first.txt`); await file(`${root}/later/plain.txt`);
  if (failure === "git-failure") { git(root, "init", "-q"); git(`${root}/later`, "init", "-q"); }
  const controller = new AbortController(); const start = Date.now();
  const opendir = fs.opendir.bind(fs), open = fs.open.bind(fs); let admissionObserved = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    const handle = await (open as any)(...args);
    if (String(args[0]).endsWith("/first.txt")) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        // Discovery closes this handle only after classifying/admitting it.
        admissionObserved = true;
        if (failure === "cancel") controller.abort();
        if (failure === "deadline") vi.spyOn(Date, "now").mockReturnValue(start + 3000);
        if (failure === "git-failure") await fs.unlink(`${root}/later/.git/HEAD`);
        return close();
      };
    }
    return handle;
  });
  vi.spyOn(fs, "opendir").mockImplementation(async (...args: any[]) => {
    const stream = await (opendir as any)(...args); const next = stream.read.bind(stream);
    const entries = []; for (;;) { const entry = await next(); if (!entry) break; entries.push(entry); }
    // Deterministic tiny-fixture enumeration, still real entry/descriptor/Git checks.
    entries.sort((a, b) => String(a.name) === "first.txt" ? -1 : String(b.name) === "first.txt" ? 1 : 0);
    stream.read = async () => entries.shift() ?? null;
    return stream;
  });
  const work = execute(client, { kind: "find", directory: root, query: "txt" }, { signal: controller.signal });
  await expect(work).rejects.toMatchObject({ code: failure === "git-failure" ? "PROJECT_READ_UNAVAILABLE" : "PROJECT_READ_BUDGET" });
  expect(admissionObserved).toBe(true);
  const error = await work.catch(error => error);
  expect(error).not.toHaveProperty("entries"); expect(error).not.toHaveProperty("data"); expect(error).not.toHaveProperty("content");
});
it("does not release its slot while cancelled descriptor cleanup is still pending", async () => {
  await file(`${root}/plain.txt`);
  const controller = new AbortController();
  const open = fs.open.bind(fs), opendir = fs.opendir.bind(fs);
  let release!: () => void, closing!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { closing = resolve; });
  let wrapped = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    const handle = await (open as any)(...args);
    if (!wrapped) {
      wrapped = true; const close = handle.close.bind(handle);
      handle.close = async () => { closing(); await barrier; return close(); };
    }
    return handle;
  });
  vi.spyOn(fs, "opendir").mockImplementation(async (...args: any[]) => {
    const stream = await (opendir as any)(...args); controller.abort(); return stream;
  });
  const pending = execute(client, { kind: "list", directory: root }, { signal: controller.signal });
  await acquired;
  await denied(read("plain.txt"), "PROJECT_READ_BUSY");
  release(); await denied(pending, "PROJECT_READ_BUDGET");
  vi.restoreAllMocks();
  vi.spyOn((backend(client) as V2Adapter).api.location, "get").mockResolvedValue({ directory: root } as any);
  expect(await read("plain.txt")).toMatchObject({ content: "ordinary source\n" });
});
it("excludes a trailing-slash task store even when its selected root is private", async () => {
  const store = `${home}/unknown-store`; await file(`${store}/plain.txt`); await fs.chmod(store, 0o700);
  vi.stubEnv("OPENCODE_TASK_STORE", `${store}/`);
  await denied(read("plain.txt", store));
});
it("batches real Git discovery and never opens nonmatching find files", async () => {
  git(root, "init", "-q");
  for (let i = 0; i < 800; i++) await file(`${root}/ordinary-${i}.txt`);
  for (const name of ["needle-a.txt", "needle-b.txt", "needle-hidden.txt"]) await file(`${root}/${name}`);
  await file(`${root}/.git/info/exclude`, "needle-hidden.txt\n");
  const observed = vi.mocked(spawn); observed.mockClear();
  const open = fs.open.bind(fs); let nonmatchingOpens = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args: any[]) => {
    if (/\/ordinary-\d+\.txt$/.test(String(args[0]))) nonmatchingOpens++;
    return (open as any)(...args);
  });
  const found = await find(root, "needle").catch(error => ({ failure: error.code }));
  console.info("Git discovery find evidence", JSON.stringify({ spawns: observed.mock.calls.length, nonmatchingOpens, outcome: "failure" in found ? found.failure : found.complete ? "complete" : "partial" }));
  expect(found).not.toHaveProperty("failure");
  expect(observed.mock.calls.length).toBeLessThanOrEqual(8);
  expect(nonmatchingOpens).toBe(0);
  expect(found).toMatchObject({ entries: [{ path: "needle-a.txt", type: "file" }, { path: "needle-b.txt", type: "file" }], complete: true });
  observed.mockClear();
  const listed = await list(root, ".", 200).catch(error => ({ failure: error.code }));
  console.info("Git discovery list evidence", JSON.stringify({ spawns: observed.mock.calls.length, outcome: "failure" in listed ? listed.failure : listed.complete ? "complete" : "partial" }));
  expect(listed).not.toHaveProperty("failure"); expect(observed.mock.calls.length).toBeLessThanOrEqual(8);
  expect(listed).toMatchObject({ complete: false, entries: expect.any(Array) });
  if (!("failure" in listed)) expect(listed.entries).toHaveLength(200);
}, 15000);
