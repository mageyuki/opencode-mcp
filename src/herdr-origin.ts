import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

/** Prospective, best-effort origin evidence; never changes a confirmed API result. */
export async function markHerdrOrigin(sessionId: string): Promise<void> {
  const directory = process.env.OPENCODE_HERDR_ORIGIN_DIR;
  if (!directory) return;
  const handles: FileHandle[] = [];
  let temporary: string | undefined;
  try {
    if (typeof sessionId !== "string" || sessionId.match(/^ses_[A-Za-z0-9_-]{1,124}$/)?.[0] !== sessionId ||
        !isAbsolute(directory) || directory.includes("\0") || process.platform !== "linux") throw new Error();
    const components = directory.split("/").filter(Boolean);
    if (components.length < 2 || components.some(component => component === "." || component === "..")) throw new Error();
    const uid = process.getuid!();
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let parent = await fs.open("/", flags);
    handles.push(parent);
    // Walk one component at a time through held directory descriptors. Neither
    // an existing symlink nor a later path replacement can redirect publication.
    for (let index = 0; index < components.length; index++) {
      const path = `/proc/self/fd/${parent.fd}/${components[index]}`;
      let child: FileHandle;
      try { child = await fs.open(path, flags); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { await fs.mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        child = await fs.open(path, flags);
        handles.push(child);
        await parent.sync();
      }
      if (!handles.includes(child)) handles.push(child);
      const info = await child.stat();
      // General ancestors may be shared (e.g. /tmp). The mirror root and
      // origins directory themselves must already be private; never chmod them.
      const privateDirectory = index >= components.length - 2;
      if (!info.isDirectory() || (privateDirectory
        ? info.uid !== uid || (info.mode & 0o7777) !== 0o700
        : info.uid !== uid && info.uid !== 0)) throw new Error();
      parent = child;
    }
    const file = `/proc/self/fd/${parent.fd}/${sessionId}.json`;
    const payload = JSON.stringify({ sessionId }) + "\n";
    const exists = async (): Promise<boolean> => {
      let handle: FileHandle;
      try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      try {
        const info = await handle.stat();
        // A concurrent same-ID rename may unlink this still-open, valid inode.
        if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600 || info.nlink > 1 ||
            info.size !== Buffer.byteLength(payload) || await handle.readFile("utf8") !== payload) throw new Error();
        return true;
      } finally { await handle.close(); }
    };
    if (!await exists()) {
      const path = `/proc/self/fd/${parent.fd}/.${sessionId}.${randomUUID()}.tmp`;
      const fileHandle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary = path;
      try {
        await fileHandle.chmod(0o600); // Only our exclusively created temporary file.
        await fileHandle.writeFile(payload, "utf8");
        await fileHandle.sync();
      } finally { await fileHandle.close(); }
      // Another writer may have published while this temporary file was synced.
      if (await exists()) await fs.unlink(temporary);
      else await fs.rename(temporary, file);
      temporary = undefined;
    }
    await parent.sync();
  } catch {
    // Do not include paths, IDs, error text or request data, even in diagnostics.
    try { console.warn("Herdr origin marker unavailable"); } catch { /* closed log sink */ }
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
  }
}
