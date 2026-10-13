import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import { posix, isAbsolute } from "node:path";
import { isIP } from "node:net";
import type { OpenCodeClient } from "./client.js";
import { backend } from "./backends/adapter.js";
import { V2Adapter } from "./backends/v2.js";
import { createRequestContext, currentRequestOptions, type RequestOptions } from "./async.js";

export type ProjectReadCode = "PROJECT_READ_INVALID_REQUEST" | "PROJECT_READ_UNAVAILABLE" |
  "PROJECT_READ_UNSUPPORTED" | "PROJECT_READ_TOO_LARGE" | "PROJECT_READ_NOT_TEXT" |
  "PROJECT_READ_BUDGET" | "PROJECT_READ_BUSY";
export class ProjectReadError extends Error {
  constructor(readonly code: ProjectReadCode) { super(code); }
}
const fail = (code: ProjectReadCode = "PROJECT_READ_UNAVAILABLE"): never => { throw new ProjectReadError(code); };
export type ProjectReadRequest = { directory?: string } & (
  { kind: "read"; path: string } | { kind: "list"; path?: string; limit?: number } |
  { kind: "find"; query: string; type?: "file" | "directory"; limit?: number });
export type ProjectReadEntry = { path: string; type: "file" | "directory" };
export type ProjectReadData = { kind: "read"; path: string; content: string; bytesRead: number; complete: true } |
  { kind: "list" | "find"; entries: ProjectReadEntry[]; complete: boolean };
const controls = /[\x00-\x1f\x7f]/;
const validText = (value: string) => !controls.test(value) && !value.includes("\\") && Buffer.from(value).toString("utf8") === value;
export function projectDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || !validText(value) || Buffer.byteLength(value) > 4096 ||
      value.split("/").some(part => part === "." || part === "..")) return fail("PROJECT_READ_INVALID_REQUEST");
  return "/" + value.split("/").filter(Boolean).join("/");
}
export function projectPath(value: unknown): string {
  if (typeof value !== "string" || !value || !validText(value) || Buffer.byteLength(value) > 4096 ||
      /^(?:\/|~|[a-z][a-z0-9+.-]*:)/i.test(value)) return fail("PROJECT_READ_INVALID_REQUEST");
  const parts = value.split("/").filter(Boolean);
  if (parts.length > 32 || parts.includes("..")) return fail("PROJECT_READ_INVALID_REQUEST");
  return parts.filter(part => part !== ".").join("/") || ".";
}
function validate(request: ProjectReadRequest): void {
  const keys = request.kind === "read" ? ["kind", "directory", "path"] : request.kind === "list" ? ["kind", "directory", "path", "limit"] :
    request.kind === "find" ? ["kind", "directory", "query", "type", "limit"] : [];
  if (!keys.length || Object.keys(request).some(key => !keys.includes(key))) fail("PROJECT_READ_INVALID_REQUEST");
  if (request.directory !== undefined) projectDirectory(request.directory);
  if (request.kind === "read" || request.kind === "list") projectPath(request.path ?? (request.kind === "list" ? "." : undefined));
  if (request.kind === "find" && (typeof request.query !== "string" || request.query.length < 1 || request.query.length > 256 ||
      request.type !== undefined && !["file", "directory"].includes(request.type))) fail("PROJECT_READ_INVALID_REQUEST");
  if ("limit" in request && request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200)) fail("PROJECT_READ_INVALID_REQUEST");
}
const sensitiveStores = new Set(".ssh .gnupg .aws .azure .kube .docker .claude .codex .grok credentials secrets .secrets".split(" "));
const generated = new Set(".superpowers .worktrees superpowers-worktrees node_modules __pycache__ cache sessions".split(" "));
function secretName(name: string, directory: boolean): boolean {
  const n = name.toLowerCase();
  return n === ".git" || n === "history.jsonl" || directory && n.endsWith(".git") || sensitiveStores.has(n) ||
    /^\.?(auth|credentials?|secrets?|tokens?)([._-].*)?$/.test(n) ||
    n.startsWith(".env") || n.startsWith("service.json") || /^opencode-langfuse\.json/.test(n) || n === "runtime.env" ||
    n.startsWith("runtime") && n.includes(".json") ||
    [".netrc", ".git-credentials", ".npmrc", ".pypirc", ".dockercfg", ".htpasswd", "opencode.json", "opencode.jsonc", "settings.local.json"].includes(n) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/.test(n) || /\.(pem|key|p12|pfx|kdbx)$/.test(n);
}
function generatedName(name: string): boolean {
  const n = name.toLowerCase();
  return generated.has(n) || n === "history.jsonl" || n.includes(".bak") || /(?:~|\.log|\.db)$/.test(n) || /\.sqlite/.test(n);
}
const beneath = (path: string, parent: string) => path === parent || path.startsWith(parent === "/" ? "/" : parent + "/");
function privateLocations(home: string): string[] {
  const config = new Set([`${home}/.config`]), data = new Set([`${home}/.local/share`]), state = new Set([`${home}/.local/state`]);
  for (const [name, set] of [["XDG_CONFIG_HOME", config], ["XDG_DATA_HOME", data], ["XDG_STATE_HOME", state]] as const) {
    const value = process.env[name];
    if (value && isAbsolute(value)) set.add(posix.normalize(value));
  }
  const paths = [...config].flatMap(path => [`${path}/opencode-tunnel`, `${path}/tunnel-client`])
    .concat([...data].map(path => `${path}/opencode`), [...state].flatMap(path => [`${path}/opencode`, `${path}/opencode-mcp`]));
  const task = process.env.OPENCODE_TASK_STORE;
  if (task && isAbsolute(task)) paths.push(posix.normalize(task));
  return paths.concat(["/proc", "/sys", "/dev", "/etc/shadow", "/etc/gshadow", "/etc/ssl/private"])
    .map(path => posix.normalize(path).replace(/\/+$/, "") || "/");
}
type Repo = { directory: Directory; checked: boolean };
type Directory = { handle: FileHandle; logical: string; info: Stats; repo?: Repo };
const proc = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Request-local held objects; no root/cache/authorizer and no backend file reads. */
class ReadOperation {
  readonly handles = new Set<FileHandle>();
  readonly privatePaths: string[];
  readonly gitEnv: NodeJS.ProcessEnv;
  root!: Directory;
  constructor(readonly home: string, readonly signal: AbortSignal, readonly deadline: number) {
    this.privatePaths = privateLocations(home);
    this.gitEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: `${home}/.config`,
      LANG: process.env.LANG ?? "C", LC_ALL: process.env.LC_ALL, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  }
  check(): void { if (this.signal.aborted || Date.now() >= this.deadline) fail("PROJECT_READ_BUDGET"); }
  excluded(path: string, directory: boolean, child = false): boolean {
    return this.privatePaths.some(store => beneath(path, store)) || path.split("/").filter(Boolean).some(part => secretName(part, true)) ||
      secretName(posix.basename(path), directory) || (child && generatedName(posix.basename(path))) || posix.basename(path).toLowerCase() === "history.jsonl";
  }
  async open(path: string, flags: number): Promise<FileHandle> {
    this.check(); const handle = await fs.open(path, flags); this.handles.add(handle); this.check(); return handle;
  }
  async close(handle: FileHandle): Promise<void> { await handle.close(); this.handles.delete(handle); }
  async cleanup(): Promise<void> {
    for (const handle of [...this.handles].reverse()) await handle.close().catch(() => {});
    this.handles.clear();
  }
  async marker(directory: Directory): Promise<void> {
    this.check();
    try {
      const info = await fs.lstat(`${proc(directory.handle)}/.git`);
      this.check();
      if (!info.isDirectory() && !info.isFile() || info.isSymbolicLink()) fail();
      directory.repo = { directory, checked: false };
    } catch (error) {
      this.check();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async ignored(repo: Repo, candidates: string[]): Promise<Set<string>> {
    this.check();
    // check-ignore rejects PATHSPEC_LITERAL. A fixed ./ prefix prevents
    // colon-prefixed filenames from becoming magic; this command inspects
    // individual pathnames and does not expand wildcard-bearing names.
    const supplied = candidates.map(path => "./" + path);
    const input = supplied.map(path => path + "\0").join("");
    if (Buffer.byteLength(input) > 65536) fail();
    const info = await fs.stat(proc(repo.directory.handle));
    if (info.dev !== repo.directory.info.dev || info.ino !== repo.directory.info.ino) fail();
    this.check();
    // cwd pins the held directory in the child. /proc/self would refer to the
    // Git process, whose descriptor table does not contain our handles.
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", ["--git-dir=.git", "--work-tree=.", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"],
        { cwd: `/proc/${process.pid}/fd/${repo.directory.handle.fd}`, env: this.gitEnv, signal: this.signal, stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = []; let length = 0, error: unknown;
      child.on("error", e => { error = e; });
      child.stdin.on("error", e => { error = e; });
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65536) { error = new ProjectReadError("PROJECT_READ_UNAVAILABLE"); child.kill(); }
        else chunks.push(chunk);
      });
      child.on("close", code => {
        if (error || code !== 0 && code !== 1) reject(new ProjectReadError("PROJECT_READ_UNAVAILABLE"));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
    this.check();
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(output); } catch { return fail(); }
    if (text && !text.endsWith("\0")) fail();
    const matches = text ? text.slice(0, -1).split("\0") : [];
    if (matches.some(path => !supplied.includes(path)) || new Set(matches).size !== matches.length) fail();
    repo.checked = true;
    return new Set(matches.map(path => path.slice(2)));
  }
  async policy(directory: Directory): Promise<void> {
    if (directory.repo && !directory.repo.checked) await this.ignored(directory.repo, []);
  }
  async enter(directory: Directory): Promise<void> {
    // A returned directory name is classified only in its parent repository.
    // Its own marker becomes relevant only when actually entering its contents.
    await this.marker(directory); await this.policy(directory);
  }
  async visible(parent: Directory, logical: string, directory: boolean): Promise<boolean> {
    if (!parent.repo) return true;
    const path = posix.relative(parent.repo.directory.logical, logical) + (directory ? "/" : "");
    return !(await this.ignored(parent.repo, [path])).has(path);
  }
  async capture(path: string): Promise<void> {
    if (this.excluded(path, true)) fail();
    const handle = await this.open("/", directoryFlags);
    let current: Directory = { handle, logical: "/", info: await handle.stat() };
    await this.marker(current);
    for (const component of path.split("/").filter(Boolean)) {
      const child = await this.open(`${proc(current.handle)}/${component}`, directoryFlags);
      current = { handle: child, logical: posix.join(current.logical, component), info: await child.stat(), repo: current.repo };
      await this.marker(current);
    }
    this.root = current;
    await this.policy(current);
    if (current.repo && current.repo.directory !== current && !await this.visible(current.repo.directory, path, true)) fail();
    this.check();
  }
  async openChild(parent: Directory, name: string, directory: boolean): Promise<Directory | { handle: FileHandle; logical: string; info: Stats } | undefined> {
    this.check();
    const logical = posix.join(parent.logical, name);
    if (this.excluded(logical, directory, true)) return undefined;
    let handle: FileHandle;
    try { handle = await this.open(`${proc(parent.handle)}/${name}`, directory ? directoryFlags : fileFlags); }
    catch (error) {
      this.check();
      // Absent/ineligible entries are omitted; uncertain I/O is not success.
      if (["ENOENT", "ELOOP", "ENOTDIR", "EACCES", "EPERM", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
    const info = await handle.stat(); this.check();
    if (info.mode & 0o044 && (directory ? info.isDirectory() && info.dev === this.root.info.dev : info.isFile() && info.nlink === 1)) {
      if (!directory) return { handle, logical, info };
      return { handle, logical, info, repo: parent.repo };
    }
    await this.close(handle); return undefined;
  }
  async child(parent: Directory, name: string, directory: boolean) {
    const child = await this.openChild(parent, name, directory);
    if (child && !await this.visible(parent, child.logical, directory)) { await this.close(child.handle); return undefined; }
    return child;
  }
  async walk(path: string): Promise<Directory> {
    let current = this.root;
    for (const part of path === "." ? [] : path.split("/")) {
      const child = await this.child(current, part, true);
      if (!child) fail(); current = child as Directory;
      await this.enter(current);
    }
    return current;
  }
  async read(path: string): Promise<ProjectReadData> {
    const parts = path === "." ? [] : path.split("/"); const name = parts.pop(); if (!name) return fail();
    const parent = await this.walk(parts.join("/") || ".");
    const child = await this.child(parent, name, false); if (!child) return fail();
    if (child.info.size > 65536) fail("PROJECT_READ_TOO_LARGE");
    const buffer = Buffer.alloc(65537); let bytesRead = 0;
    while (bytesRead < buffer.length) {
      this.check();
      const next = await child.handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      this.check(); if (next.bytesRead === 0) break; bytesRead += next.bytesRead;
    }
    if (bytesRead > 65536) fail("PROJECT_READ_TOO_LARGE");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { return fail("PROJECT_READ_NOT_TEXT"); }
    if (content.includes("\0")) fail("PROJECT_READ_NOT_TEXT");
    return { kind: "read", path, content, bytesRead, complete: true };
  }
  async discover(request: Extract<ProjectReadRequest, { kind: "list" | "find" }>): Promise<ProjectReadData> {
    const startPath = request.kind === "list" ? projectPath(request.path ?? ".") : ".";
    const start = await this.walk(startPath);
    const entries: ProjectReadEntry[] = [], limit = request.limit ?? 100;
    let visited = 0, directories = 0, complete = true, stop = false;
    const visit = async (directory: Directory, depth: number): Promise<void> => {
      this.check();
      if (directories >= 256) { complete = false; stop = true; return; }
      directories++;
      // Node supports Buffer entry names; the pinned Node 22 type definitions
      // omit this runtime encoding. Fatal decoding below omits invalid UTF-8.
      const stream = await fs.opendir(proc(directory.handle), { encoding: "buffer" as BufferEncoding, bufferSize: 1 });
      type Candidate = { name: string; relative: string; directory: boolean; gitPath: string };
      let pending: Candidate[] = [], pendingBytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending; pending = []; pendingBytes = 0;
        // Every member belongs to this same parent repository/held cwd. Only
        // bounded names are buffered, never file bodies or unbounded handles.
        const ignored = directory.repo ? await this.ignored(directory.repo, batch.map(candidate => candidate.gitPath)) : new Set<string>();
        for (const candidate of batch) {
          this.check(); if (stop) break;
          if (ignored.has(candidate.gitPath)) continue;
          if (candidate.directory && request.kind === "find" && (depth >= 16 || directories >= 256 || visited >= 4096)) {
            complete = false; stop = true; break;
          }
          // Hint/ignore filtering is not object validation. Open without links
          // and fstat the final handle, rejecting hinted/final type mismatches,
          // private modes, hardlinks, special files and cross-device directories.
          const child = await this.openChild(directory, candidate.name, candidate.directory); if (!child) continue;
          try {
            const type = candidate.directory ? "directory" : "file";
            if (request.kind === "list" || (!request.type || request.type === type) && candidate.relative.toLowerCase().includes(request.query.toLowerCase())) {
              entries.push({ path: candidate.relative, type });
              if (entries.length >= limit) { complete = false; stop = true; break; }
            }
            if (candidate.directory && request.kind === "find") {
              await this.enter(child as Directory); await visit(child as Directory, depth + 1);
            }
          } finally { await this.close(child.handle); }
        }
      };
      try {
        while (!stop) {
          this.check();
          // At a structural stop, unclassified buffered names are discarded;
          // only already admitted entries survive, with no further probing.
          if (visited >= 4096) { complete = false; stop = true; break; }
          const entry = await stream.read(); this.check(); if (!entry) { await flush(); break; } visited++;
          let name: string;
          try { name = typeof entry.name === "string" ? entry.name : new TextDecoder("utf-8", { fatal: true }).decode(entry.name); }
          catch { continue; }
          if (!name || !validText(name) || name.includes("/") || name === "." || name === "..") continue;
          const relative = posix.relative(this.root.logical, posix.join(directory.logical, name));
          try { projectPath(relative); } catch { continue; }
          const isDirectory = entry.isDirectory();
          const logical = posix.join(directory.logical, name);
          if (this.excluded(logical, isDirectory, true)) continue;
          // Nonmatching non-directories can never be emitted or traversed.
          // They still consume the visit budget, but no open/stat/Git work.
          if (!isDirectory && request.kind === "find" && (request.type === "directory" || !relative.toLowerCase().includes(request.query.toLowerCase()))) continue;
          const gitPath = directory.repo ? posix.relative(directory.repo.directory.logical, logical) + (isDirectory ? "/" : "") : "";
          const bytes = directory.repo ? Buffer.byteLength("./" + gitPath + "\0") : 0;
          if (bytes > 65536) fail();
          if (pending.length >= 64 || pendingBytes + bytes > 65536) { await flush(); if (stop) break; }
          pending.push({ name, relative, directory: isDirectory, gitPath }); pendingBytes += bytes;
        }
      } finally { await stream.close(); }
    };
    await visit(start, 0); this.check();
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { kind: request.kind, entries, complete };
  }
}
let busy = false;
export async function executeProjectRead(client: OpenCodeClient, request: ProjectReadRequest, options: RequestOptions = {}): Promise<ProjectReadData> {
  if (busy) return fail("PROJECT_READ_BUSY");
  busy = true;
  let operation: ReadOperation | undefined, context: ReturnType<typeof createRequestContext> | undefined;
  try {
    validate(request);
    const inherited = currentRequestOptions();
    context = createRequestContext({ ...inherited, ...options, timeout: Math.min(options.timeout ?? inherited.timeout ?? 2000, 2000) }, 2000);
    const host = new URL(client.getBaseUrl()).hostname.replace(/^\[|\]$/g, "");
    if (process.platform !== "linux" || client.getBackendIdentity().kind !== "v2" ||
        !(host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127."))) fail("PROJECT_READ_UNSUPPORTED");
    let home: string; try { home = projectDirectory(process.env.HOME); } catch { return fail(); }
    operation = new ReadOperation(home, context.signal, context.deadline);
    operation.check(); client.assertBackendAvailable();
    const adapter = backend(client); if (!(adapter instanceof V2Adapter)) return fail("PROJECT_READ_UNSUPPORTED");
    const value = await adapter.api.location.get({ location: request.directory === undefined ? undefined : { directory: request.directory } }, { signal: context.signal });
    operation.check();
    let root: string; try { root = projectDirectory(value?.directory); } catch { return fail(); }
    if (request.directory !== undefined && root !== projectDirectory(request.directory)) fail();
    await operation.capture(root);
    const result = request.kind === "read" ? await operation.read(projectPath(request.path)) : await operation.discover(request);
    operation.check(); return result;
  } catch (error) {
    if (context && (context.signal.aborted || Date.now() >= context.deadline)) return fail("PROJECT_READ_BUDGET");
    if (error instanceof ProjectReadError) throw error;
    return fail();
  } finally {
    await operation?.cleanup(); context?.dispose(); busy = false;
  }
}
