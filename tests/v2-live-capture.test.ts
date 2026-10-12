import { describe, expect, it } from "vitest";
import { initialV2Observation } from "../src/backends/v2-observation.js";
import { projectLiveTurn } from "../src/backends/v2-live.js";

const sessionID = "ses_f17f7940cfferDLekaUEZHayKH";
const messageID = "msg_0e8087630001ZuPXl100udcXMr";
const assistantID = "msg_0e808764d001oGKUHwEtqU7gj3";
const otherSession = "ses_other";
const followupID = "msg_followup";
const followupAssistant = "msg_followup_assistant";

const captured = [
  { type: "session.inbox.enqueued", durable: { aggregateID: sessionID, seq: 1 }, data: { sessionID, inboxID: messageID, item: { type: "user", delivery: "queue" } } },
  { type: "session.execution.started", durable: { aggregateID: sessionID, seq: 2 }, data: { sessionID } },
  { type: "session.instructions.updated", durable: { aggregateID: sessionID, seq: 3 }, data: { sessionID } },
  { type: "session.inbox.delivered", durable: { aggregateID: sessionID, seq: 4 }, data: { sessionID, inboxID: messageID } },
  { type: "session.step.started", durable: { aggregateID: sessionID, seq: 5 }, data: { sessionID, assistantMessageID: assistantID, started: 1790599263834 } },
  { type: "session.step.ended", durable: { aggregateID: sessionID, seq: 11 }, data: { sessionID, assistantMessageID: assistantID, finish: "stop" } },
  { type: "session.execution.succeeded", durable: { aggregateID: sessionID, seq: 12 }, data: { sessionID } },
];

function project(events: readonly unknown[], message = messageID, prior = initialV2Observation(message)) {
  return projectLiveTurn(prior, events, sessionID);
}

describe("V2 live capture correlation", () => {
  it("binds the captured receipt to its assistant and execution success", () => {
    const projected = project(captured);
    expect(projected.lost).toBe(false);
    expect(projected.state.outcome).toBe("completed");
    expect(projected.state.finalAssistantId).toBe(assistantID);
    expect(projected.state.synced).not.toBe(true);
  });

  it("keeps a follow-up distinct from the completed first turn", () => {
    const first = project(captured);
    const second = project([
      ...captured,
      { type: "session.inbox.enqueued", durable: { aggregateID: sessionID, seq: 13 }, data: { sessionID, inboxID: followupID, item: { type: "user", delivery: "queue" } } },
      { type: "session.execution.started", durable: { aggregateID: sessionID, seq: 14 }, data: { sessionID } },
      { type: "session.inbox.delivered", durable: { aggregateID: sessionID, seq: 15 }, data: { sessionID, inboxID: followupID } },
      { type: "session.step.started", durable: { aggregateID: sessionID, seq: 16 }, data: { sessionID, assistantMessageID: followupAssistant, started: 50 } },
      { type: "session.step.ended", durable: { aggregateID: sessionID, seq: 17 }, data: { sessionID, assistantMessageID: followupAssistant, finish: "stop" } },
      { type: "session.execution.succeeded", durable: { aggregateID: sessionID, seq: 18 }, data: { sessionID } },
    ], followupID);
    expect(first.state.finalAssistantId).toBe(assistantID);
    expect(second.state.outcome).toBe("completed");
    expect(second.state.finalAssistantId).toBe(followupAssistant);
  });

  it("applies events that arrived before the prompt response", () => {
    const early = captured.slice(0, 2);
    const projected = project(early);
    expect(projected.state.admitted).toBe(true);
    expect(projected.state.executionStart).toBe(2);
  });

  it("does not treat a filtered sequence gap as subscription loss", () => {
    const projected = project(captured);
    expect(projected.lost).toBe(false);
    expect(projected.state.finalAssistantId).toBe(assistantID);
  });

  it("ignores a duplicate sequence in the same session and a same sequence in another session", () => {
    const projected = projectLiveTurn(initialV2Observation(messageID), [
      ...captured,
      captured[0],
      { type: "session.execution.succeeded", durable: { aggregateID: otherSession, seq: 12 }, data: { sessionID: otherSession } },
    ], sessionID);
    expect(projected.duplicateCount).toBe(1);
    expect(projected.state.outcome).toBe("completed");
    expect(projected.state.finalAssistantId).toBe(assistantID);
  });

  it("does not reopen a completed turn when a later user input is delivered", () => {
    const completed = project(captured);
    const after = project([
      ...captured,
      { type: "session.inbox.enqueued", durable: { aggregateID: sessionID, seq: 13 }, data: { sessionID, inboxID: followupID, item: { type: "user", delivery: "queue" } } },
      { type: "session.inbox.delivered", durable: { aggregateID: sessionID, seq: 14 }, data: { sessionID, inboxID: followupID } },
    ], messageID, completed.state);
    expect(after.state.outcome).toBe("completed");
    expect(after.state.finalAssistantId).toBe(assistantID);
  });

  it("loses ownership for a competing user input before execution success", () => {
    const projected = project([
      captured[0], captured[1], captured[3],
      { type: "session.inbox.enqueued", durable: { aggregateID: sessionID, seq: 5 }, data: { sessionID, inboxID: followupID, item: { type: "user", delivery: "queue" } } },
      { type: "session.inbox.delivered", durable: { aggregateID: sessionID, seq: 6 }, data: { sessionID, inboxID: followupID } },
      { type: "session.execution.succeeded", durable: { aggregateID: sessionID, seq: 7 }, data: { sessionID } },
    ]);
    expect(projected.state.outcome).not.toBe("completed");
    expect(projected.state.ownershipLost).toBe(true);
  });

  it("does not treat compaction delivery as a competing user input", () => {
    const projected = project([
      captured[0], captured[1], captured[3],
      { type: "session.inbox.enqueued", durable: { aggregateID: sessionID, seq: 5 }, data: { sessionID, inboxID: "compact", item: { type: "compaction", delivery: "queue" } } },
      { type: "session.inbox.delivered", durable: { aggregateID: sessionID, seq: 6 }, data: { sessionID, inboxID: "compact" } },
      { type: "session.step.started", durable: { aggregateID: sessionID, seq: 9 }, data: { sessionID, assistantMessageID: assistantID, started: 3 } },
      { ...captured[5], durable: { aggregateID: sessionID, seq: 7 } },
      { ...captured[6], durable: { aggregateID: sessionID, seq: 8 } },
    ]);
    expect(projected.state.outcome).toBe("completed");
    expect(projected.state.finalAssistantId).toBe(assistantID);
  });

  it("does not accept an intermediate tool-calls step as the final answer", () => {
    const projected = project([
      captured[0], captured[1], captured[3],
      { type: "session.step.started", durable: { aggregateID: sessionID, seq: 5 }, data: { sessionID, assistantMessageID: "partial", started: 1 } },
      { type: "session.step.ended", durable: { aggregateID: sessionID, seq: 6 }, data: { sessionID, assistantMessageID: "partial", finish: "tool-calls" } },
      { type: "session.step.started", durable: { aggregateID: sessionID, seq: 7 }, data: { sessionID, assistantMessageID: assistantID, started: 2 } },
      { type: "session.step.ended", durable: { aggregateID: sessionID, seq: 8 }, data: { sessionID, assistantMessageID: assistantID, finish: "stop" } },
      captured[6],
    ]);
    expect(projected.state.finalAssistantId).toBe(assistantID);
    expect(projected.state.finalAssistantId).not.toBe("partial");
  });

  it("marks an explicit subscription loss before completion as not completed", () => {
    const projected = projectLiveTurn(initialV2Observation(messageID), captured.slice(0, 4), sessionID, { lost: true });
    expect(projected.lost).toBe(true);
    expect(projected.state.outcome).not.toBe("completed");
  });
});
