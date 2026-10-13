import { createRequestContext, throwIfAborted, withAbort, type RequestOptions } from "../async.js";
import { OpenCodeError } from "../client.js";
import type { ExecutionEvidence } from "../job-contract.js";
import type { V2Api } from "./v2-observation.js";
import { unwrapV2Error } from "./v2.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const failedRead = Symbol("failed evidence read");

/** Positive, non-atomic metadata evidence only; never reconstructs a turn outcome. */
export async function collectV2ExecutionEvidence(api: V2Api, sessionId: string, directory: string | undefined, options: RequestOptions): Promise<ExecutionEvidence> {
  const result: ExecutionEvidence = { scope: "current-process-foreground", attribution: "session-only", observedAt: null,
    root: "indeterminate", subtree: "indeterminate", activeSessionIDs: [], discovery: "unavailable", issues: [] };
  const issue = (source: "active" | "discovery", code: ExecutionEvidence["issues"][number]["code"]) => {
    if (!result.issues.some(item => item.source === source && item.code === code)) result.issues.push({ source, code });
  };
  // Own only the local cap; the enclosing get context owns caller expiry.
  // Explicit fields prevent ambient deadline/timeout from creating rival timers.
  const context = createRequestContext({ signal: options.signal, deadline: Date.now() + 2000, timeout: 2000 });
  let denied = false, gap = false, usablePage = false;
  let active: Record<string, unknown> | undefined;
  const parents = new Map<string, string>();
  const invalid = new Set<string>();
  const queue: Array<{ parentID: string; cursor?: string }> = [{ parentID: sessionId }];
  const attempted = new Map<string, Set<string | undefined>>();
  const proven = (child: string): boolean => {
    const seen = new Set<string>();
    while (child !== sessionId) {
      if (invalid.has(child) || seen.has(child)) return false;
      seen.add(child);
      const parent = parents.get(child); if (!parent) return false;
      child = parent;
    }
    return true;
  };
  const read = async (source: "active" | "discovery", signal: AbortSignal, invoke: () => PromiseLike<unknown>): Promise<unknown> => {
    let invoked = false;
    try {
      throwIfAborted(options.signal); throwIfAborted(signal);
      // Availability and synchronous invocation belong inside this boundary.
      const promise = invoke(); invoked = true;
      const value = await withAbort(promise, signal);
      throwIfAborted(options.signal); throwIfAborted(signal);
      return value;
    } catch (error) {
      throwIfAborted(options.signal);
      const normalized = unwrapV2Error(error);
      if (normalized instanceof OpenCodeError && [401, 403].includes(normalized.status)) denied = true;
      issue(source, signal.aborted ? "timeout" : invoked ? "request_failed" : "unavailable");
      if (source === "discovery") gap = true;
      return failedRead;
    }
  };
  try {
    throwIfAborted(options.signal);
    const phase = createRequestContext({ signal: context.signal, deadline: Date.now() + 1000, timeout: 1000 });
    try {
      const value = await read("active", phase.signal, () => api.session.active({ signal: phase.signal }));
      if (value !== failedRead) {
        if (object(value)) { active = value; result.observedAt = Date.now(); }
        else issue("active", "malformed_response");
      }
    } finally { phase.dispose(); }
    let calls = 0, rows = 0;
    while (queue.length && !denied) {
      throwIfAborted(options.signal);
      if (context.signal.aborted) { gap = true; issue("discovery", "timeout"); break; }
      if (calls >= 4 || rows >= 200) { gap = true; issue("discovery", "limit_reached"); break; }
      const query = queue.shift()!;
      if (!proven(query.parentID)) { gap = true; continue; }
      const seen = attempted.get(query.parentID) ?? new Set<string | undefined>();
      if (seen.has(query.cursor)) { gap = true; issue("discovery", "malformed_response"); continue; }
      seen.add(query.cursor); attempted.set(query.parentID, seen);
      calls++;
      const value = await read("discovery", context.signal, () => api.session.list({ parentID: query.parentID, limit: 50,
        ...(directory ? { directory } : {}), ...(query.cursor ? { cursor: query.cursor } : { order: "asc" as const }),
      }, { signal: context.signal }));
      if (value === failedRead) continue;
      if (!object(value) || !Array.isArray(value.data)) { gap = true; issue("discovery", "malformed_response"); continue; }
      usablePage = true;
      const remaining = Math.min(50, 200 - rows);
      if (value.data.length > remaining) { gap = true; issue("discovery", "limit_reached"); }
      for (const row of value.data.slice(0, remaining)) {
        rows++;
        if (!object(row) || !id(row.id) || !id(row.parentID)) { gap = true; issue("discovery", "malformed_response"); continue; }
        if (row.id === sessionId) { gap = true; issue("discovery", "invalid_ancestry"); continue; }
        // Conflicting assertions invalidate a previously retained edge, even if
        // this row is otherwise outside the queried parent/directory scope.
        const previous = parents.get(row.id);
        if (previous !== undefined && previous !== row.parentID) {
          invalid.add(row.id); gap = true; issue("discovery", "invalid_ancestry"); continue;
        }
        if (row.parentID !== query.parentID || (directory && (!object(row.location) || row.location.directory !== directory))) {
          gap = true; issue("discovery", "invalid_ancestry"); continue;
        }
        if (!previous) {
          parents.set(row.id, row.parentID);
          if (!proven(row.id)) { invalid.add(row.id); gap = true; issue("discovery", "invalid_ancestry"); }
          else queue.push({ parentID: row.id });
        }
      }
      if (!object(value.cursor) || (value.cursor.next !== undefined && value.cursor.next !== null && !id(value.cursor.next))) {
        gap = true; issue("discovery", "malformed_response"); continue;
      }
      const next = value.cursor.next;
      if (id(next)) {
        if (seen.has(next)) { gap = true; issue("discovery", "malformed_response"); }
        else queue.push({ parentID: query.parentID, cursor: next });
      }
    }
    throwIfAborted(options.signal);
    result.discovery = usablePage ? (gap || denied || queue.length ? "partial" : "scan_exhausted") : "unavailable";
    if (active) {
      for (const candidate of [sessionId, ...parents.keys()]) {
        if (!proven(candidate) || !Object.hasOwn(active, candidate)) continue;
        const state = active[candidate];
        if (object(state) && state.type === "running") result.activeSessionIDs.push(candidate);
        else issue("active", "malformed_response");
      }
      result.activeSessionIDs.sort();
      if (result.activeSessionIDs.includes(sessionId)) result.root = "active_observed";
      if (result.activeSessionIDs.length) result.subtree = "active_observed";
    }
    return result;
  } finally { context.dispose(); }
}
