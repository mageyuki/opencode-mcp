import { applyObservedEvent, startupFailureCause, type V2ObservationState } from "./v2-observation.js";
import type { V2Api } from "./v2-observation.js";

export interface LiveEvent {
  type?: string;
  durable?: { seq?: number; aggregateID?: string };
  data?: Record<string, unknown>;
}

export interface LiveProjection {
  state: V2ObservationState;
  lost: boolean;
  duplicateCount: number;
}

const HANDLED = new Set([
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.inbox.delivered",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
]);

/** Apply a filtered public event stream. Sequence gaps are not subscription loss. */
export function projectLiveTurn(
  state: V2ObservationState,
  events: readonly unknown[],
  sessionID: string,
  options: { lost?: boolean } = {},
): LiveProjection {
  const next = structuredClone(state);
  if (options.lost) delete next.startupFailureEligible;
  const priorCursor = state.liveCursor ?? 0;
  const seen = new Set<number>();
  let duplicateCount = 0;
  for (const raw of events) {
    const event = raw as LiveEvent;
    const data = event.data ?? {};
    if (data.sessionID !== sessionID || event.durable?.aggregateID !== sessionID) continue;
    const seq = event.durable?.seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0) {
      if (seen.has(seq) || seq <= priorCursor) { duplicateCount += 1; continue; }
      seen.add(seq);
      if (seq > (next.liveCursor ?? 0)) next.liveCursor = seq;
    }
    if (!event.type || !HANDLED.has(event.type) || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) continue;
    if (next.logSeen?.includes(seq)) continue;
    (next.liveSeen ??= []).push(seq);
    const competing = event.type === "session.inbox.delivered" && data.inboxID !== next.messageId &&
      next.delivered && !next.outcome && next.pendingKinds?.[String(data.inboxID)] !== "compaction";
    applyObservedEvent(next, {
      type: event.type,
      durable: { aggregateID: sessionID, seq, version: 1 },
      data,
    } as never, true);
    // Unlike finite log replay, a live turn is never completed by a queued
    // boundary: only its own execution success and final fetched step suffice.
    if (competing) { delete next.outcome; next.ownsExecution = false; next.ownershipLost = true; }
  }
  return { state: next, lost: options.lost === true && next.outcome !== "completed", duplicateCount };
}

type Track = { sessionID: string; state: V2ObservationState; registered: boolean; queue: unknown[]; draining?: Promise<void>;
  onChange: (state: V2ObservationState, lost: boolean, event?: unknown) => Promise<{ state: V2ObservationState; done: boolean }> };
const connections = new WeakMap<V2Api, LiveConnection>();

/** Keep only correlation metadata for this session, never inbox payloads. */
function correlationEvent(raw: unknown, sessionID: string): LiveEvent | undefined {
  const event = raw as LiveEvent;
  if (!event?.type || !HANDLED.has(event.type) || event.data?.sessionID !== sessionID ||
      event.durable?.aggregateID !== sessionID) return undefined;
  const data = event.data;
  return { type: event.type, durable: { seq: event.durable.seq, aggregateID: sessionID },
    data: { sessionID, inboxID: data.inboxID, item: data.item && typeof data.item === "object"
      ? { type: (data.item as Record<string, unknown>).type, delivery: (data.item as Record<string, unknown>).delivery } : undefined,
    delivery: data.delivery, assistantMessageID: data.assistantMessageID, finish: data.finish, reason: data.reason,
    ...(event.type === "session.execution.failed" ? { error: startupFailureCause(data.error) } : {}) } };
}

/** One stream per connection, never tied to an MCP request's abort signal. */
class LiveConnection {
  private readonly tracks = new Set<Track>();
  private readonly controller = new AbortController();
  private iterator?: AsyncIterator<unknown>;
  private closed = false;
  private readyState: "pending" | "ready" | "failed" = "pending";
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private failure?: Error;
  constructor(private readonly api: V2Api) {
    this.readyPromise = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  }

  get ready(): Promise<void> { return this.readyPromise; }
  get alive(): boolean { return !this.closed && this.readyState === "ready"; }

  add(track: Track): void {
    this.tracks.add(track);
    if (this.iterator) return;
    this.iterator = this.api.event.subscribe({ signal: this.controller.signal })[Symbol.asyncIterator]();
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      while (!this.closed) {
        const next = await this.iterator!.next();
        if (next.done) break;
        if ((next.value as { type?: string })?.type === "server.connected") {
          if (this.readyState === "pending") { this.readyState = "ready"; this.resolveReady(); }
          continue;
        }
        for (const track of [...this.tracks]) {
          const event = correlationEvent(next.value, track.sessionID);
          if (!event) continue;
          if (track.queue.length >= 10_000) { this.failure = new Error("V2 live event buffer exceeded its limit"); break; }
          track.queue.push(event);
          if (track.registered) void this.drain(track);
        }
        if (this.failure) break;
      }
    } catch { /* A broken subscription is an observation gap, not an execution result. */ }
    finally {
      this.closed = true;
      if (this.readyState === "pending") {
        this.readyState = "failed";
        this.rejectReady(this.failure ?? new Error("V2 live event subscription closed before ready"));
      }
      if (connections.get(this.api) === this) connections.delete(this.api);
      for (const track of this.tracks) if (track.registered) {
        while (track.queue.length && this.tracks.has(track)) await this.drain(track);
        if (track.draining) await track.draining;
        if (!this.tracks.has(track)) continue;
        try { await track.onChange(track.state, true); } catch { /* No safe outcome can be inferred. */ }
      }
      this.tracks.clear();
      this.controller.abort();
      if (this.iterator?.return) void this.iterator.return().catch(() => {});
    }
  }

  register(track: Track): void {
    if (this.closed) throw new Error("V2 live event subscription closed before prompt receipt was registered");
    track.registered = true;
    void this.drain(track);
  }

  private async drain(track: Track): Promise<void> {
    if (track.draining) return track.draining;
    const draining = (async () => {
      while (track.registered && this.tracks.has(track) && track.queue.length) {
        const event = track.queue.shift()!;
        const projected = projectLiveTurn(track.state, [event], track.sessionID);
        if (projected.state.liveCursor === track.state.liveCursor) continue;
        track.state = projected.state;
        try {
          const result = await track.onChange(track.state, false, event);
          track.state = result.state;
          if (result.done) { this.remove(track); break; }
        } catch { /* The event was consumed; later events must not reclaim stale ownership. */ }
      }
    })();
    track.draining = draining.finally(() => {
      track.draining = undefined;
      if (track.registered && this.tracks.has(track) && track.queue.length) void this.drain(track);
    });
    return track.draining;
  }

  remove(track: Track): void {
    this.tracks.delete(track);
    if (!this.tracks.size) {
      this.closed = true;
      if (connections.get(this.api) === this) connections.delete(this.api);
      this.controller.abort();
      if (this.iterator?.return) void this.iterator.return().catch(() => {});
    }
  }
}

export function trackLiveTurn(api: V2Api, sessionID: string, state: V2ObservationState,
  onChange: Track["onChange"], _transportReady?: Promise<void>): { ready: Promise<void>; alive: () => boolean; register: () => void; stop: () => void } {
  let connection = connections.get(api);
  // An HTTP reader is not protocol readiness; only decoded server.connected qualifies.
  if (!connection) { connection = new LiveConnection(api); connections.set(api, connection); }
  const track: Track = { sessionID, state, onChange, registered: false, queue: [] };
  connection.add(track);
  return { ready: connection.ready, alive: () => connection.alive,
    register: () => connection.register(track), stop: () => connection.remove(track) };
}
