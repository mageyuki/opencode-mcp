import { describe, expect, it, vi } from "vitest";
import { observeV2Session, type V2ObservationState } from "../src/backends/v2-observation.js";

/** Live OpenCode 2.0.18 replay: only log.synced, no durable rows, empty inbox. */
function liveReplayApi(seq = 23) {
  const messageGet = vi.fn(async ({ messageID }: { messageID: string }) => {
    if (messageID === "assistant-a") {
      return { id: "assistant-a", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "pong" }], finish: "stop" };
    }
    throw new Error(`unexpected message ${messageID}`);
  });
  return {
    api: {
      session: {
        get: vi.fn(async () => ({ id: "session", title: "Fixture", location: { directory: "/tmp/project" }, time: { created: 1, updated: 1, idle: 4 }, projectID: "project" })),
        log: vi.fn(() => (async function* () {
          yield { type: "log.synced", aggregateID: "session", seq };
        })()),
        inbox: { list: vi.fn(async () => []) },
        message: { get: messageGet },
        form: { list: vi.fn(async () => []) },
      },
      permission: { list: vi.fn(async () => []) },
    },
    messageGet,
  };
}

describe("OpenCode 2.0.18 log replay gap", () => {
  it("does not complete a fresh observation when the log replays only a valid sync cursor", async () => {
    const { api, messageGet } = liveReplayApi();
    const observed = await observeV2Session(api as never, "session", "user-a");
    expect(observed.state.synced).toBe(true);
    expect(observed.state.cursor).toBe(23);
    expect(observed.state.assistantIds).toEqual([]);
    expect(observed.snapshot.status).toBe("unknown");
    expect(observed.snapshot.result).toBeUndefined();
    expect(messageGet).not.toHaveBeenCalled();
  });

  it("keeps a previously queued job accepted after the inbox empties if delivery was never observed", async () => {
    const { api, messageGet } = liveReplayApi();
    const persisted: V2ObservationState = {
      version: 1,
      cursor: 12,
      messageId: "user-a",
      admitted: true,
      queued: true,
      synced: true,
      assistantIds: [],
      completedAssistantIds: [],
    };
    const observed = await observeV2Session(api as never, "session", "user-a", {}, persisted);
    expect(observed.snapshot.status).toBe("accepted");
    expect(observed.state.queued).toBe(true);
    expect(observed.state.delivered).not.toBe(true);
    expect(observed.snapshot.result).toBeUndefined();
    expect(messageGet).not.toHaveBeenCalled();
  });
});
