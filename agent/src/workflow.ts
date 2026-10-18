// Triage workflow: detect -> group -> diagnose (decide + act/propose inside the tools) -> log.
// A fixed pipeline rather than free chat, so every run is comparable and scorable.
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { proposals as defaultProposals, type ProposalStore } from './actions.ts'
import { modelName } from './config.ts'
import { makeDiagnoser, type Diagnoser } from './diagnosers.ts'
import { FleetClient, type Incident, type Robot, type Zone } from './fleet.ts'
import { RunRecorder } from './recorder.ts'
import { zoneDistance, type Variant } from './tools.ts'
import { TriageResult, type Action, type GroupResult, type IncidentGroup } from './types.ts'

export interface TriageDeps {
  fleet?: FleetClient
  proposals?: ProposalStore
  diagnoser?: Diagnoser
  variant?: Variant
}

/**
 * v2 grouping: an incident on a blocked zone pulls in every STUCK robot next to that zone, and
 * incidents on the same robot are handled together. Baseline: one group per incident.
 */
export function groupIncidents(incidents: Incident[], robots: Robot[], zones: Zone[], variant: Variant): IncidentGroup[] {
  if (variant === 'baseline') {
    return incidents.map((i) => ({ key: i.id, reason: 'one incident per group', incidentIds: [i.id] }))
  }
  const robotById = new Map(robots.map((r) => [r.id, r]))
  const groups = new Map<string, IncidentGroup>()
  const add = (key: string, reason: string, id: string) => {
    const g = groups.get(key) ?? { key, reason, incidentIds: [] }
    g.incidentIds.push(id)
    groups.set(key, g)
  }
  const blocked = zones.filter((z) => z.blocked)
  for (const inc of incidents) {
    if (inc.zoneId) {
      add(`zone:${inc.zoneId}`, `incidents around zone ${inc.zoneId}`, inc.id)
      continue
    }
    const robot = inc.robotId ? robotById.get(inc.robotId) : undefined
    const nearBlocked = inc.type === 'STUCK' && robot ? blocked.find((z) => zoneDistance(z, robot.position) <= 2) : undefined
    if (nearBlocked) add(`zone:${nearBlocked.id}`, `incidents around zone ${nearBlocked.id}`, inc.id)
    else add(`robot:${inc.robotId}`, `incidents on robot ${inc.robotId}`, inc.id)
  }
  return [...groups.values()]
}

const anyArray = z.array(z.any())

export function buildTriageWorkflow(deps: TriageDeps = {}) {
  const fleet = deps.fleet ?? new FleetClient()
  const proposals = deps.proposals ?? defaultProposals
  const diagnoser = deps.diagnoser ?? makeDiagnoser()
  const variant = deps.variant ?? 'v2'
  const recorder = new RunRecorder()

  const detect = createStep({
    id: 'detect',
    inputSchema: z.object({ incidentIds: z.array(z.string()).optional() }),
    outputSchema: z.object({ incidents: anyArray }),
    execute: async ({ inputData }) => {
      // Specific incidents (e.g. from the UI's Triage button) are fetched whatever their status, so
      // the agent can notice when one has already cleared. Otherwise triage everything still open.
      const ids = inputData.incidentIds
      const incidents = ids?.length ? (await fleet.incidents()).filter((i) => ids.includes(i.id)) : await fleet.incidents('OPEN')
      return { incidents }
    },
  })

  const group = createStep({
    id: 'group',
    inputSchema: z.object({ incidents: anyArray }),
    outputSchema: z.object({ incidents: anyArray, groups: anyArray }),
    execute: async ({ inputData }) => {
      const [robots, zones] = await Promise.all([fleet.robots(), fleet.zones()])
      return { incidents: inputData.incidents, groups: groupIncidents(inputData.incidents, robots, zones, variant) }
    },
  })

  const diagnose = createStep({
    id: 'diagnose',
    inputSchema: z.object({ incidents: anyArray, groups: anyArray }),
    outputSchema: z.object({ results: anyArray }),
    execute: async ({ inputData }) => {
      const byId = new Map((inputData.incidents as Incident[]).map((i) => [i.id, i]))
      const results: GroupResult[] = []
      for (const g of inputData.groups as IncidentGroup[]) {
        recorder.currentGroup = g.key
        const actions: Action[] = []
        const callsBefore = recorder.toolCalls.length
        const incidents = g.incidentIds.map((id) => byId.get(id)!).filter(Boolean)
        const d = await diagnoser.diagnose(incidents, { fleet, recorder, proposals, incidentIds: g.incidentIds, actions, variant })
        const toolsCalled = recorder.toolCalls.slice(callsBefore).map((c) => c.tool)
        results.push({
          ...d,
          // Escalating through the tool counts even if the model forgot to say so in its summary.
          escalate: d.escalate || toolsCalled.includes('escalate'),
          incidentIds: g.incidentIds,
          actionsTaken: actions.filter((a) => a.status === 'EXECUTED'),
          actionsProposed: actions.filter((a) => a.status === 'PROPOSED'),
          toolsCalled,
        })
      }
      return { results }
    },
  })

  const log = createStep({
    id: 'log',
    inputSchema: z.object({ results: anyArray }),
    outputSchema: TriageResult,
    execute: async ({ inputData }) => {
      const result: TriageResult = {
        runId: recorder.runId,
        variant,
        model: modelName(),
        groups: inputData.results as GroupResult[],
        tokensIn: recorder.tokensIn,
        tokensOut: recorder.tokensOut,
        costUsd: recorder.costUsd(),
        latencyMs: Date.now() - recorder.startedAt,
      }
      await recorder.write({ variant }, result)
      return result
    },
  })

  const workflow = createWorkflow({
    id: 'triage',
    inputSchema: z.object({ incidentIds: z.array(z.string()).optional() }),
    outputSchema: TriageResult,
  })
    .then(detect)
    .then(group)
    .then(diagnose)
    .then(log)
    .commit()

  return { workflow, recorder }
}

/** Runs one triage pass and returns the structured result. */
export async function runTriage(deps: TriageDeps = {}, incidentIds?: string[]) {
  const { workflow, recorder } = buildTriageWorkflow(deps)
  const run = await workflow.createRun()
  const res = await run.start({ inputData: { incidentIds } })
  if (res.status !== 'success') {
    throw new Error(`triage workflow ${res.status}: ${'error' in res ? String((res as any).error) : ''}`)
  }
  return { result: res.result as TriageResult, toolCalls: recorder.toolCalls }
}
