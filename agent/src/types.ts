import { z } from 'zod'

export const FAULT_CODES = ['LOW_BATTERY', 'STUCK', 'HEARTBEAT_LOST', 'ZONE_BLOCKED', 'JOB_TIMEOUT', 'SENSOR_FAULT'] as const
/** NONE = nothing actionable (e.g. a red herring or a fault that already cleared). */
export const RootCause = z.enum([...FAULT_CODES, 'NONE'])
export type RootCause = z.infer<typeof RootCause>

export const Tier = z.enum(['read', 'low', 'high'])
export type Tier = z.infer<typeof Tier>

export const Action = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  tier: Tier,
  status: z.enum(['EXECUTED', 'PROPOSED', 'FAILED']),
  proposalId: z.string().optional(),
  error: z.string().optional(),
})
export type Action = z.infer<typeof Action>

/** What the model reports back. Actions are not self-reported: they come from the tool log. */
export const Diagnosis = z.object({
  rootCause: RootCause.describe('The single underlying cause shared by the incidents in this group, or NONE'),
  confidence: z.number().min(0).max(1).describe('0 to 1'),
  escalate: z.boolean().describe('true if a human (maintenance or floor lead) must get involved'),
  summary: z.string().describe('Two or three sentences an operator can act on'),
})
export type Diagnosis = z.infer<typeof Diagnosis>

export const IncidentGroup = z.object({
  key: z.string(),
  reason: z.string(),
  incidentIds: z.array(z.string()),
})
export type IncidentGroup = z.infer<typeof IncidentGroup>

export const GroupResult = Diagnosis.extend({
  incidentIds: z.array(z.string()),
  actionsTaken: z.array(Action),
  actionsProposed: z.array(Action),
  toolsCalled: z.array(z.string()),
})
export type GroupResult = z.infer<typeof GroupResult>

export const TriageResult = z.object({
  runId: z.string(),
  variant: z.string(),
  model: z.string(),
  groups: z.array(GroupResult),
  tokensIn: z.number(),
  tokensOut: z.number(),
  costUsd: z.number(),
  latencyMs: z.number(),
})
export type TriageResult = z.infer<typeof TriageResult>
