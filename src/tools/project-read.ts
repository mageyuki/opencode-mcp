import { z } from "zod";
import type { McpServer } from "../mcp-server.js";
import type { OpenCodeClient } from "../client.js";
import { executeProjectRead, projectDirectory, projectPath, ProjectReadError, type ProjectReadRequest } from "../project-read.js";

const path = z.string().refine(value => { try { projectPath(value); return true; } catch { return false; } })
  .describe("Project-relative path; no absolute paths, .., links, or secret files. Maximum 4096 UTF-8 bytes / 32 components.");
const directory = z.string().refine(value => { try { projectDirectory(value); return true; } catch { return false; } }).optional()
  .describe("Absolute project directory from the existing connection context; omitted uses the backend default. Same-host Linux/V2 only.");
const limit = z.number().int().min(1).max(200).optional().describe("Maximum returned entries, default 100; bounded discovery may be incomplete.");
const description = "Guarded project read on same-host Linux/V2. Excludes links, private modes, Git-ignored paths and conservative secret names (including auth.ts, src/auth, tokens, auth-service). No universal secret detection or hostile-writer sandbox.";
export function registerProjectReadTools(server: McpServer, client: OpenCodeClient): void {
  const run = async (request: ProjectReadRequest) => {
    try {
      const result = await executeProjectRead(client, request);
      if (result.kind === "read") {
        const { content, ...data } = result;
        return { content: [{ type: "text" as const, text: content }], structuredContent: { data } };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { data: result } };
    } catch (error) {
      const code = error instanceof ProjectReadError ? error.code : "PROJECT_READ_UNAVAILABLE";
      return { isError: true, content: [{ type: "text" as const, text: code }], structuredContent: { error: { code, message: code } } };
    }
  };
  server.tool("opencode_file_read", `Read complete UTF-8 project text, at most 65536 bytes; no binary/partial-file success. ${description}`,
    { path, directory }, async args => run({ kind: "read", ...args }));
  server.tool("opencode_file_list", `List eligible immediate project children as relative paths with a complete flag. ${description}`,
    { path: path.optional(), limit, directory }, async args => run({ kind: "list", ...args }));
  server.tool("opencode_find_file", `Find eligible relative paths by case-insensitive literal substring, not content, glob or fuzzy search. ${description}`,
    { query: z.string().min(1).max(256), type: z.enum(["file", "directory"]).optional(), limit, directory }, async args => run({ kind: "find", ...args }));
}
