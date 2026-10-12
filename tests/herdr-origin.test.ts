import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { markHerdrOrigin } from "../src/herdr-origin.js";

describe("Herdr origin publication", () => {
  let root: string, origins: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "herdr-origin-"));
    origins = join(root, "opencode-herdr-mirror", "origins");
    vi.stubEnv("OPENCODE_HERDR_ORIGIN_DIR", origins);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("marker_is_private_atomic_and_idempotent", async () => {
    const file = join(origins, "ses_confirmed.json");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expected = '{"sessionId":"ses_confirmed"}\n';
    let done = false;
    const writing = Promise.all(Array.from({ length: 30 }, () => markHerdrOrigin("ses_confirmed")))
      .finally(() => { done = true; });
    do {
      const contents = await fs.readFile(file, "utf8").catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (contents !== undefined) expect(contents).toBe(expected);
      await nextTurn();
    } while (!done);
    await writing;
    expect(warning).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe(expected);
    const inode = (await fs.stat(file)).ino;
    await markHerdrOrigin("ses_confirmed");
    expect((await fs.stat(file)).ino).toBe(inode);
    expect(await fs.readdir(origins)).toEqual(["ses_confirmed.json"]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(file)).uid).toBe(process.getuid!());
    for (const directory of [join(root, "opencode-herdr-mirror"), origins]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it("syncs complete private bytes before atomic rename, then the directory", async () => {
    // The OS boundary is instrumented, not replaced with a fake publisher.
    await fs.mkdir(origins, { recursive: true, mode: 0o700 });
    const open = fs.open.bind(fs), rename = fs.rename.bind(fs);
    const order: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args), info = await handle.stat();
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await sync(); order.push(info.isDirectory() ? "directory-sync" : "file-sync");
      });
      return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      expect(await fs.readFile(from, "utf8")).toBe('{"sessionId":"ses_durable"}\n');
      expect((await fs.stat(from)).mode & 0o777).toBe(0o600);
      await expect(fs.lstat(join(origins, "ses_durable.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(order).toContain("file-sync");
      order.push("rename");
      await rename(from, to);
    });
    await markHerdrOrigin("ses_durable");
    expect(order).toEqual(["file-sync", "rename", "directory-sync"]);
    expect(await fs.readFile(join(origins, "ses_durable.json"), "utf8")).toBe('{"sessionId":"ses_durable"}\n');
  });

  it("accepts a valid open marker replaced by a concurrent same-ID rename", async () => {
    await fs.mkdir(origins, { recursive: true, mode: 0o700 });
    const file = join(origins, "ses_confirmed.json"), replacement = join(origins, ".replacement.tmp");
    const payload = '{"sessionId":"ses_confirmed"}\n';
    await fs.writeFile(file, payload, { mode: 0o600 });
    await fs.writeFile(replacement, payload, { mode: 0o600 });
    const open = fs.open.bind(fs), warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!replaced && String(args[0]).endsWith("/ses_confirmed.json")) {
        replaced = true;
        await fs.rename(replacement, file);
        expect((await handle.stat()).nlink).toBe(0);
      }
      return handle;
    });
    await markHerdrOrigin("ses_confirmed");
    expect(replaced).toBe(true);
    expect(warning).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe(payload);
  });

  it("opt_in_absent_has_no_io", async () => {
    vi.stubEnv("OPENCODE_HERDR_ORIGIN_DIR", undefined);
    const open = vi.spyOn(fs, "open"), mkdir = vi.spyOn(fs, "mkdir");
    await markHerdrOrigin("ses_ignored");
    expect(open).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["", "ses_", "ses_../escape", "ses_a/b", "ses_a\n", "ses_a\r", "ses_é", `ses_${"a".repeat(125)}`])
    ("rejects invalid filename identity %j without writing", async id => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(markHerdrOrigin(id)).resolves.toBeUndefined();
      expect(await fs.readdir(root)).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
    });

  it("accepts both ID length boundaries and the permitted ASCII alphabet", async () => {
    const ids = ["ses_a", `ses_${"A".repeat(121)}0_-`];
    for (const id of ids) {
      await markHerdrOrigin(id);
      expect(JSON.parse(await fs.readFile(join(origins, `${id}.json`), "utf8"))).toEqual({ sessionId: id });
    }
  });

  it("relative origin disables writes with a sanitized warning", async () => {
    vi.stubEnv("OPENCODE_HERDR_ORIGIN_DIR", "relative-secret-sentinel/origins");
    const open = vi.spyOn(fs, "open"), mkdir = vi.spyOn(fs, "mkdir");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(markHerdrOrigin("ses_confirmed")).resolves.toBeUndefined();
    expect(open).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("relative-secret-sentinel");
  });

  it.each(["symlink-file", "symlink-directory", "symlink-ancestor", "public-file", "public-directory", "public-parent", "malformed", "mismatch", "extra-key", "directory-file"])
    ("refuses existing unsafe %s without repair or traversal", async kind => {
      await fs.mkdir(origins, { recursive: true, mode: 0o700 });
      const file = join(origins, "ses_confirmed.json"), victim = join(root, "victim");
      await fs.writeFile(victim, "unchanged sentinel", { mode: 0o600 });
      if (kind === "symlink-file") await fs.symlink(victim, file);
      else if (kind === "symlink-directory") {
        await fs.rmdir(origins); await fs.symlink(root, origins);
      } else if (kind === "symlink-ancestor") {
        const alias = join(root, "alias"); await fs.symlink(join(root, "opencode-herdr-mirror"), alias);
        vi.stubEnv("OPENCODE_HERDR_ORIGIN_DIR", join(alias, "origins"));
      } else if (kind === "public-directory") await fs.chmod(origins, 0o755);
      else if (kind === "public-parent") await fs.chmod(join(root, "opencode-herdr-mirror"), 0o755);
      else if (kind === "directory-file") await fs.mkdir(file, { mode: 0o700 });
      else await fs.writeFile(file, kind === "malformed" ? "{" : kind === "mismatch" ? '{"sessionId":"ses_other"}\n' : kind === "extra-key" ? '{"sessionId":"ses_confirmed","title":"secret"}\n' : '{"sessionId":"ses_confirmed"}\n', { mode: kind === "public-file" ? 0o644 : 0o600 });
      const before = await fs.lstat(file).catch(() => undefined);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(markHerdrOrigin("ses_confirmed")).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
      expect(await fs.readFile(victim, "utf8")).toBe("unchanged sentinel");
      if (before) expect((await fs.lstat(file)).ino).toBe(before.ino);
      if (kind === "public-directory") expect((await fs.stat(origins)).mode & 0o777).toBe(0o755);
      if (kind === "public-parent") expect((await fs.stat(join(root, "opencode-herdr-mirror"))).mode & 0o777).toBe(0o755);
      if (kind === "symlink-directory" || kind === "symlink-ancestor") {
        await expect(fs.lstat(join(root, "ses_confirmed.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    });

  it.each(["file-sync", "rename", "directory-sync"])("%s failure is nonthrowing and leaves no partial published file", async fault => {
    await fs.mkdir(origins, { recursive: true, mode: 0o700 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {}), open = fs.open.bind(fs);
    const error = new Error(`private-error-${root}`);
    if (fault === "rename") vi.spyOn(fs, "rename").mockRejectedValue(error);
    else vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args), info = await handle.stat();
      if (info.isDirectory() === (fault === "directory-sync")) vi.spyOn(handle, "sync").mockRejectedValue(error);
      return handle;
    });
    await expect(markHerdrOrigin("ses_confirmed")).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-error");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
    if (fault === "directory-sync") expect(await fs.readFile(join(origins, "ses_confirmed.json"), "utf8")).toBe('{"sessionId":"ses_confirmed"}\n');
    else expect(await fs.readdir(origins)).toEqual([]);
  });

  it("even a failing warning sink cannot reject creation", async () => {
    vi.stubEnv("OPENCODE_HERDR_ORIGIN_DIR", "relative");
    vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("closed log sink"); });
    await expect(markHerdrOrigin("ses_confirmed")).resolves.toBeUndefined();
  });
});
