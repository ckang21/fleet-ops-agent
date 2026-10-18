// A Diagnoser investigates one group of incidents with the tools and reports a diagnosis.
// The tools themselves record which actions ran or were proposed, so nothing here is self-reported.
import { Agent } from '@mastra/core/agent'
import { config, modelConfig } from './config.ts'
import type { Incident } from './fleet.ts'
import { instructions } from './prompt.ts'
import { makeTools, zoneDistance, type ToolContext } from './tools.ts'
import { Diagnosis, type RootCause } from './types.ts'

export interface Diagnoser {
  diagnose(incidents: Incident[], ctx: ToolContext): Promise<Diagnosis>
}

export class LlmDiagnoser implements Diagnoser {
  async diagnose(incidents: Incident[], ctx: ToolContext): Promise<Diagnosis> {
    const agent = new Agent({
      id: 'fleet-ops-agent',
      name: 'Fleet Ops Agent',
      instructions: instructions(ctx.variant),
      model: modelConfig(),
      tools: makeTools(ctx),
    })
    const prompt = `Triage these incidents:
${JSON.stringify(incidents.map(({ id, type, robotId, zoneId, jobId, severity, status }) => ({ id, type, robotId, zoneId, jobId, severity, status })))}

Investigate, take or propose the right actions, then give your diagnosis.`
    const res = await agent.generate(prompt, {
      maxSteps: 12,
      // A second pass turns the free-text answer into the Diagnosis object; small local models
      // are more reliable when tool use and JSON output happen in separate calls.
      structuredOutput: { schema: Diagnosis, model: modelConfig() },
    })
    ctx.recorder.addUsage(res.usage)
    const parsed = Diagnosis.safeParse(res.object)
    if (!parsed.success) {
      return { rootCause: 'NONE', confidence: 0, escalate: false, summary: `Could not parse a diagnosis. Model said: ${res.text.slice(0, 400)}` }
    }
    return parsed.data
  }
}

/**
 * Deterministic diagnoser that follows the playbook with plain code. It needs no model, so CI can
 * run the whole pipeline (tools, approval gating, scoring) for free. It is also the reference the
 * LLM is measured against.
 */
export class RuleDiagnoser implements Diagnoser {
  async diagnose(incidents: Incident[], ctx: ToolContext): Promise<Diagnosis> {
    const tools = makeTools(ctx) as Record<string, any>
    const call = (name: string, input: Record<string, unknown>) => tools[name].execute(input, {})

    const open = new Set(((await call('listIncidents', {})) as { id: string }[]).map((i) => i.id))
    const live = incidents.filter((i) => open.has(i.id))
    if (live.length === 0) {
      return { rootCause: 'NONE', confidence: 0.9, escalate: false, summary: 'These incidents cleared on their own. No action needed.' }
    }

    const zones = (await call('listZones', {})) as { id: string; blocked: boolean; bounds: number[] }[]
    const blocked = zones.filter((z) => z.blocked)
    const zoneInc = live.find((i) => i.type === 'ZONE_BLOCKED')
    const stuck = live.filter((i) => i.type === 'STUCK')

    // Shared cause: robots stuck next to a blocked zone.
    let blockedZone = zoneInc?.zoneId ?? null
    if (!blockedZone && stuck.length > 0 && blocked.length > 0) {
      for (const inc of stuck) {
        const r = await call('getRobot', { robotId: inc.robotId })
        const near = blocked.find((z) => {
          const [minX, minY, maxX, maxY] = z.bounds
          return zoneDistance({ id: z.id, name: z.id, minX, minY, maxX, maxY, blocked: true }, r.position) <= 2
        })
        if (near) {
          blockedZone = near.id
          break
        }
      }
    }
    if (blockedZone) {
      await call('rerouteAround', { zoneId: blockedZone, reason: `Robots stuck at blocked zone ${blockedZone}` })
      await call('escalate', { incidentId: (zoneInc ?? live[0]).id, note: `Zone ${blockedZone} is blocked. Needs someone on the floor to clear it.` })
      return {
        rootCause: 'ZONE_BLOCKED',
        confidence: 0.9,
        escalate: true,
        summary: `${live.length} incident(s) share one cause: ${blockedZone} is blocked. Proposed rerouting around it and escalated so it gets cleared.`,
      }
    }

    // Otherwise handle the most severe incident type in the group.
    const order: RootCause[] = ['SENSOR_FAULT', 'HEARTBEAT_LOST', 'LOW_BATTERY', 'STUCK', 'JOB_TIMEOUT']
    const primary = [...live].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))[0]
    const robot = primary.robotId ? await call('getRobot', { robotId: primary.robotId }) : null
    const jobId = robot?.currentJobId ?? primary.jobId

    switch (primary.type) {
      case 'SENSOR_FAULT':
        await call('setOutOfService', { robotId: primary.robotId, reason: 'Sensor fault reported' })
        await call('escalate', { incidentId: primary.id, note: `Sensor fault on ${primary.robotId}. Needs maintenance.` })
        return { rootCause: 'SENSOR_FAULT', confidence: 0.9, escalate: true, summary: `${primary.robotId} has a sensor fault. Proposed taking it out of service and escalated to maintenance.` }
      case 'HEARTBEAT_LOST':
        if (jobId) await call('reassignJob', { jobId, reason: `${primary.robotId} is offline` })
        await call('escalate', { incidentId: primary.id, note: `${primary.robotId} lost its heartbeat. Possible hardware or network fault.` })
        return { rootCause: 'HEARTBEAT_LOST', confidence: 0.85, escalate: true, summary: `${primary.robotId} went offline. Reassigned its job and escalated.` }
      case 'LOW_BATTERY':
        if (jobId) await call('reassignJob', { jobId, reason: 'Battery critically low' })
        await call('sendToCharger', { robotId: primary.robotId, reason: 'Battery below 15%' })
        return { rootCause: 'LOW_BATTERY', confidence: 0.95, escalate: false, summary: `${primary.robotId} is nearly out of battery. Reassigned its job and sent it to charge.` }
      case 'STUCK': {
        await call('getRobotHistory', { robotId: primary.robotId, lastTicks: 10 })
        await call('resetRobot', { robotId: primary.robotId, reason: 'No movement and no blocked zone nearby' })
        return { rootCause: 'STUCK', confidence: 0.8, escalate: false, summary: `${primary.robotId} isn't moving and nothing is blocking it. Proposed a drive reset.` }
      }
      case 'JOB_TIMEOUT':
        await call('getRobotHistory', { robotId: primary.robotId, lastTicks: 10 })
        if (jobId) await call('reassignJob', { jobId, reason: `${primary.robotId} is too slow to finish the job` })
        return { rootCause: 'JOB_TIMEOUT', confidence: 0.75, escalate: false, summary: `Job ${jobId} ran too long on ${primary.robotId}. Reassigned it.` }
    }
    return { rootCause: 'NONE', confidence: 0.5, escalate: false, summary: 'Nothing actionable found.' }
  }
}

export function makeDiagnoser(): Diagnoser {
  return config.provider === 'mock' ? new RuleDiagnoser() : new LlmDiagnoser()
}
