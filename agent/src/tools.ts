// Agent tools. Each one wraps a GraphQL call, is logged, and is gated by its safety tier.
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TIERS, executeAction, type ProposalStore } from './actions.ts'
import type { FleetClient, Robot, Snapshot, Zone } from './fleet.ts'
import type { RunRecorder } from './recorder.ts'
import type { Action } from './types.ts'

export type Variant = 'baseline' | 'v2'

export interface ToolContext {
  fleet: FleetClient
  recorder: RunRecorder
  proposals: ProposalStore
  /** Incidents this run is triaging, attached to any proposal it makes. */
  incidentIds: string[]
  /** Actions taken or proposed in the current group, filled in as tools run. */
  actions: Action[]
  variant: Variant
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))

async function timed<T>(ctx: ToolContext, tool: string, args: unknown, fn: () => Promise<T>): Promise<T | { error: string }> {
  const t = Date.now()
  try {
    const result = await fn()
    ctx.recorder.toolCalls.push({ group: ctx.recorder.currentGroup, tool, tier: TIERS[tool], args, outcome: 'ok', result, ms: Date.now() - t })
    return result
  } catch (err) {
    const error = errMsg(err)
    ctx.recorder.toolCalls.push({ group: ctx.recorder.currentGroup, tool, tier: TIERS[tool], args, outcome: 'error', error, ms: Date.now() - t })
    return { error }
  }
}

/** Runs an action tool: low-risk ones execute now, high-risk ones become a proposal for an operator. */
async function act(ctx: ToolContext, tool: string, args: Record<string, any>, reason: string) {
  const tier = TIERS[tool]
  if (tier === 'high') {
    const p = ctx.proposals.create({ tool, args, reason, incidentIds: ctx.incidentIds, runId: ctx.recorder.runId })
    ctx.actions.push({ tool, args, tier, status: 'PROPOSED', proposalId: p.id })
    ctx.recorder.toolCalls.push({ group: ctx.recorder.currentGroup, tool, tier, args, outcome: 'proposed', result: { proposalId: p.id }, ms: 0 })
    return {
      status: 'PROPOSED',
      proposalId: p.id,
      message: 'High-risk action. It has been sent to an operator for approval and has NOT run yet. Do not retry it.',
    }
  }
  const result = await timed(ctx, tool, args, () => executeAction(ctx.fleet, tool, args))
  const failed = typeof result === 'object' && result !== null && 'error' in result
  ctx.actions.push({ tool, args, tier, status: failed ? 'FAILED' : 'EXECUTED', ...(failed ? { error: (result as any).error } : {}) })
  return failed ? result : { status: 'EXECUTED', result }
}

function robotView(r: Robot, zones: Zone[] | null) {
  const view: Record<string, unknown> = {
    id: r.id,
    status: r.status,
    battery: Math.round(r.battery),
    position: r.position,
    zoneId: r.zoneId,
    currentJobId: r.currentJobId,
    lastHeartbeat: r.lastHeartbeat,
    faultCode: r.faultCode,
    stuckTicks: r.stuckTicks,
    outOfService: r.outOfService,
  }
  if (zones) {
    // v2: spell out which zones the robot is next to, instead of making the model compare coordinates.
    view.nearZones = zones
      .map((z) => ({ id: z.id, blocked: z.blocked, distance: zoneDistance(z, r.position) }))
      .filter((z) => z.distance <= 2)
  }
  return view
}

export function zoneDistance(z: Zone, p: { x: number; y: number }) {
  const dx = p.x < z.minX ? z.minX - p.x : p.x > z.maxX ? p.x - z.maxX : 0
  const dy = p.y < z.minY ? z.minY - p.y : p.y > z.maxY ? p.y - z.maxY : 0
  return Math.max(dx, dy)
}

function historyView(h: Snapshot[], variant: Variant) {
  if (variant === 'baseline') return h
  // v2: summarize the trend so the model doesn't have to diff 30 rows by itself.
  const first = h[0]
  const last = h[h.length - 1]
  if (!first || !last) return { ticks: 0 }
  let lastMoveTick = first.tick
  for (let i = 1; i < h.length; i++) {
    if (h[i].position.x !== h[i - 1].position.x || h[i].position.y !== h[i - 1].position.y) lastMoveTick = h[i].tick
  }
  return {
    fromTick: first.tick,
    toTick: last.tick,
    ticksSinceLastMove: last.tick - lastMoveTick,
    batteryStart: Math.round(first.battery),
    batteryEnd: Math.round(last.battery),
    statuses: [...new Set(h.map((s) => s.status))],
    last5: h.slice(-5),
  }
}

const reason = z.string().describe('Why this action is needed, citing the evidence')

// v2 round 2: the first wording ("needs operator approval") made the model describe proposals in text
// instead of calling the tool. Spelling out that the call itself is the proposal fixed it.
const highRisk = (variant: Variant, what: string) =>
  variant === 'v2'
    ? `HIGH RISK. Calling this tool is safe: it creates a proposal the operator approves, and nothing runs until then. Call it to propose. ${what}`
    : `HIGH RISK, needs operator approval. ${what}`

export function makeTools(ctx: ToolContext) {
  const { fleet } = ctx
  const v2 = ctx.variant === 'v2'
  return {
    getFleetSummary: createTool({
      id: 'getFleetSummary',
      description: 'Fleet-wide counts by status, average battery, open incidents, queued jobs and throughput.',
      inputSchema: z.object({}),
      execute: async () => timed(ctx, 'getFleetSummary', {}, () => fleet.fleetSummary()),
    }),
    listIncidents: createTool({
      id: 'listIncidents',
      description: 'List incidents. Defaults to OPEN incidents.',
      inputSchema: z.object({ status: z.enum(['OPEN', 'ACKED', 'RESOLVED']).optional() }),
      execute: async ({ status }) =>
        timed(ctx, 'listIncidents', { status }, async () =>
          (await fleet.incidents(status ?? 'OPEN')).map((i) => ({
            id: i.id,
            type: i.type,
            robotId: i.robotId,
            zoneId: i.zoneId,
            jobId: i.jobId,
            detectedAt: i.detectedAt,
            severity: i.severity,
            status: i.status,
          })),
        ),
    }),
    getRobot: createTool({
      id: 'getRobot',
      description: 'Current state of one robot: status, battery, position, current job, heartbeat, fault code, stuck ticks.',
      inputSchema: z.object({ robotId: z.string().describe('e.g. R-07') }),
      execute: async ({ robotId }) =>
        timed(ctx, 'getRobot', { robotId }, async () => {
          const [r, zones] = await Promise.all([fleet.robot(robotId), v2 ? fleet.zones() : Promise.resolve(null)])
          if (!r) throw new Error(`robot ${robotId} not found`)
          return robotView(r, zones)
        }),
    }),
    getRobotHistory: createTool({
      id: 'getRobotHistory',
      description: 'Recent snapshots (position, battery, status) for one robot. Use it to tell whether a robot is moving.',
      inputSchema: z.object({ robotId: z.string(), lastTicks: z.number().int().min(2).max(60).optional() }),
      execute: async ({ robotId, lastTicks }) =>
        timed(ctx, 'getRobotHistory', { robotId, lastTicks }, async () => historyView(await fleet.robotHistory(robotId, lastTicks ?? 15), ctx.variant)),
    }),
    listZones: createTool({
      id: 'listZones',
      description: 'All zones with their grid bounds and whether they are blocked.',
      inputSchema: z.object({}),
      execute: async () =>
        timed(ctx, 'listZones', {}, async () =>
          (await fleet.zones()).map((z) => ({ id: z.id, blocked: z.blocked, bounds: [z.minX, z.minY, z.maxX, z.maxY] })),
        ),
    }),
    listJobs: createTool({
      id: 'listJobs',
      description: 'List jobs, optionally filtered by status.',
      inputSchema: z.object({ status: z.enum(['QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'FAILED']).optional() }),
      execute: async ({ status }) => timed(ctx, 'listJobs', { status }, () => fleet.jobs(status)),
    }),

    reassignJob: createTool({
      id: 'reassignJob',
      description: 'LOW RISK, runs immediately. Move a job to another robot. Omit robotId to auto-pick the best idle robot.',
      inputSchema: z.object({ jobId: z.string(), robotId: z.string().optional(), reason }),
      execute: async ({ jobId, robotId, reason }) => act(ctx, 'reassignJob', robotId ? { jobId, robotId } : { jobId }, reason),
    }),
    sendToCharger: createTool({
      id: 'sendToCharger',
      description: 'LOW RISK, runs immediately. Send a robot to the charging bay. Its job goes back to the queue.',
      inputSchema: z.object({ robotId: z.string(), reason }),
      execute: async ({ robotId, reason }) => act(ctx, 'sendToCharger', { robotId }, reason),
    }),
    escalate: createTool({
      id: 'escalate',
      description: 'Escalate an incident to a human (maintenance or floor lead) with a short note.',
      inputSchema: z.object({ incidentId: z.string(), note: z.string() }),
      execute: async ({ incidentId, note }) => act(ctx, 'escalate', { incidentId, note }, note),
    }),
    resolveIncident: createTool({
      id: 'resolveIncident',
      description: 'Mark an incident resolved with a short resolution note.',
      inputSchema: z.object({ incidentId: z.string(), resolution: z.string() }),
      execute: async ({ incidentId, resolution }) => act(ctx, 'resolveIncident', { incidentId, resolution }, resolution),
    }),
    resetRobot: createTool({
      id: 'resetRobot',
      description: highRisk(ctx.variant, 'Power-cycle a robot drive. Fixes motor jams; does not fix hardware sensor faults or offline robots.'),
      inputSchema: z.object({ robotId: z.string(), reason }),
      execute: async ({ robotId, reason }) => act(ctx, 'resetRobot', { robotId }, reason),
    }),
    setOutOfService: createTool({
      id: 'setOutOfService',
      description: highRisk(ctx.variant, 'Take a robot out of service for maintenance. Its job goes back to the queue.'),
      inputSchema: z.object({ robotId: z.string(), reason }),
      execute: async ({ robotId, reason }) => act(ctx, 'setOutOfService', { robotId, reason }, reason),
    }),
    rerouteAround: createTool({
      id: 'rerouteAround',
      description: highRisk(ctx.variant, 'Make every robot route around a zone and requeue jobs that start or end in it.'),
      inputSchema: z.object({ zoneId: z.string(), reason }),
      execute: async ({ zoneId, reason }) => act(ctx, 'rerouteAround', { zoneId }, reason),
    }),
  }
}
