import { z } from "zod";
import { directoryParam, outputFormatParam } from "./helpers.js";

export const executionEvidenceSchema = z.object({
  scope: z.literal("current-process-foreground"),
  attribution: z.literal("session-only"),
  observedAt: z.number().nullable(),
  root: z.enum(["active_observed", "indeterminate"]),
  subtree: z.enum(["active_observed", "indeterminate"]),
  activeSessionIDs: z.array(z.string().min(1)).max(201),
  discovery: z.enum(["scan_exhausted", "partial", "unavailable"]),
  issues: z.array(z.object({ source: z.enum(["active", "discovery"]),
    code: z.enum(["unavailable", "request_failed", "timeout", "malformed_response", "limit_reached", "invalid_ancestry"]),
  })).max(12),
});
export type ExecutionEvidence = z.infer<typeof executionEvidenceSchema>;

export function jobObservationMessage(job: { status: string; liveCoverage?: string; error?: unknown }): string | undefined {
  if (job.status !== "unknown") return undefined;
  const name = job.error && typeof job.error === "object" && "name" in job.error && typeof job.error.name === "string" && job.error.name.length
    ? job.error.name : undefined;
  if (name === "OpenCodeSubmissionError") return "Submission outcome unknown; observation will not resend it.";
  if (name === "LiveObservationLost" || (!name && job.liveCoverage === "lost")) {
    return "Job observation lost; original turn outcome is unknown. Session execution may continue. Do not resend automatically.";
  }
  return "Job outcome unknown; observation will not resend it.";
}

export const dispatchShape = {
  prompt: z.string().min(1).describe("Task or instruction to send to OpenCode"),
  sessionId: z.string().optional().describe("Existing session to continue; omit to create one"),
  title: z.string().optional().describe("Title for a new session"),
  providerID: z.string().optional().describe("Provider ID from provider discovery"),
  modelID: z.string().optional().describe("Model ID from provider discovery"),
  variant: z.string().optional().describe("Model variant"),
  agent: z.string().optional().describe("OpenCode agent ID (V2 exact ID; V1 agent name)"),
  directory: directoryParam,
  format: outputFormatParam,
};
export const runShape = {
  ...dispatchShape,
  maxDurationSeconds: z.number().positive().max(3600).optional()
    .describe("Maximum observation duration in seconds (default 600); timeout does not abort the job"),
};
export const runInputSchema = z.object(runShape);
