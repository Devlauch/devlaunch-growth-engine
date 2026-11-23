import { z } from "zod";
import type { AgentDefinition } from "../core/agentRunner.js";
import { registerTool, assignAgentTools, type AgentTool } from "../core/agentTools.js";
import { buildMeetingPrepBrief, type MeetingPrepBrief } from "../../meetingPrep.js";
import { requireProjectId, type QueryableDb } from "./types.js";

/**
 * meetingPreparationAgent: an LLM EXPLANATION LAYER ONLY, exactly like
 * marketingQa.ts's tryLlmExplanation() — this agent never invents a fact
 * about the meeting, the lead, the company, or the deal. It is given the
 * output of meetingPrep.ts's existing DETERMINISTIC buildMeetingPrepBrief()
 * (lead, company, contacts, ICP match, enrichment, deal, recent notes,
 * full activity timeline — all real, already-queried data) and may only
 * rephrase/organize/prioritize it into a readable briefing.
 */

export interface MeetingPreparationEvidence {
  brief: MeetingPrepBrief | null;
}

/**
 * Looks up the meeting's own lead_id first (meetings.lead_id), then calls
 * buildMeetingPrepBrief with it — same two-step shape routes/meetingPrep.ts
 * presumably already uses, so this never invents a leadId not actually
 * linked to the given meeting.
 */
export async function gatherMeetingPreparationEvidence(
  tenantDb: QueryableDb,
  tenantId: string,
  projectId: string,
  subjectId: string,
): Promise<MeetingPreparationEvidence> {
  const meetingResult = await tenantDb.query<{ lead_id: string }>(
    `SELECT lead_id FROM meetings WHERE id = $1 AND tenant_id = $2 AND project_id = $3`,
    [subjectId, tenantId, projectId],
  );
  const leadId = meetingResult.rows[0]?.lead_id;
  if (!leadId) {
    return { brief: null };
  }

  const brief = await buildMeetingPrepBrief(tenantDb, tenantId, projectId, leadId, subjectId);
  return { brief };
}

const meetingPreparationEvidenceTool: AgentTool<{ meetingId: string }, MeetingPreparationEvidence> = {
  name: "meeting_preparation_evidence_read",
  description:
    "Reads the real, already-computed meeting prep brief (lead, company, contacts, ICP match, enrichment, deal, recent notes, activity timeline) for one real meeting. Read-only; reuses meetingPrep.ts's buildMeetingPrepBrief directly.",
  inputSchema: z.object({ meetingId: z.string().uuid() }),
  async execute(input, context) {
    const projectId = requireProjectId(context);
    return gatherMeetingPreparationEvidence(context.tenantDb, context.tenantId, projectId, input.meetingId);
  },
};

registerTool(meetingPreparationEvidenceTool);

const outputSchema = z.object({
  briefingSummary: z.string().min(1),
  keyTalkingPoints: z.array(z.string()),
  risksToWatch: z.array(z.string()),
  evidence: z.array(z.string()),
});

export type MeetingPreparationOutput = z.infer<typeof outputSchema>;

export const meetingPreparationAgent: AgentDefinition<{ meetingId: string }, MeetingPreparationOutput> = {
  key: "meeting_preparation",
  label: "Meeting Preparation Agent",
  description:
    "Rephrases the already-computed, deterministic meeting prep brief (meetingPrep.ts) into a readable briefing — an explanation layer only, never a new source of facts.",
  systemPrompt:
    "You are a meeting preparation briefing assistant. You will be given the real output of an existing DETERMINISTIC meeting-prep engine (lead, company, contacts, ICP match, enrichment, deal, recent notes, and activity timeline) — this was already computed from real CRM records before you were called. Treat it as the complete and only source of truth: rephrase, organize, and prioritize it into a readable briefing. Do NOT add any attendee, fact, risk, or history item that is not already present in the evidence, and do not guess at a section marked unavailable. If the brief is null, say plainly that no meeting prep data is available for this meeting. Keep every bullet traceable to a specific section of the evidence.",
  inputSchema: z.object({ meetingId: z.string().uuid() }),
  outputSchema,
  outputFormatDescription:
    '{ "briefingSummary": string, "keyTalkingPoints": string[] (traceable to the given brief sections), "risksToWatch": string[] (traceable to the given brief sections, e.g. a low deal-health section or a stale activity timeline), "evidence": string[] }',
  tools: [meetingPreparationEvidenceTool],
  requiresApproval: false,
  maxTokens: 700,
};

assignAgentTools(meetingPreparationAgent.key, [meetingPreparationEvidenceTool.name]);
