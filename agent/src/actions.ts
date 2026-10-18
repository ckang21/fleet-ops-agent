// Safety tiers and the approval queue for high-risk actions.
import type { FleetClient } from './fleet.ts'
import type { Tier } from './types.ts'

export const TIERS: Record<string, Tier> = {
  getFleetSummary: 'read',
  listIncidents: 'read',
  getRobot: 'read',
  getRobotHistory: 'read',
  listZones: 'read',
  listJobs: 'read',
  // Low risk: easy to undo and they only move work around.
  reassignJob: 'low',
  sendToCharger: 'low',
  escalate: 'low',
  resolveIncident: 'low',
  // High risk: they take hardware offline or change routing for the whole fleet.
  resetRobot: 'high',
  setOutOfService: 'high',
  rerouteAround: 'high',
}

export const requiresApproval = (tool: string) => TIERS[tool] === 'high'

/** Runs a mutation against the fleet. Used directly for low-risk tools, and on approval for high-risk ones. */
export async function executeAction(fleet: FleetClient, tool: string, args: Record<string, any>): Promise<unknown> {
  switch (tool) {
    case 'reassignJob':
      return fleet.reassignJob(args.jobId, args.robotId)
    case 'sendToCharger':
      return fleet.sendToCharger(args.robotId)
    case 'escalate':
      return fleet.escalate(args.incidentId, args.note)
    case 'resolveIncident':
      return fleet.resolveIncident(args.incidentId, args.resolution)
    case 'resetRobot':
      return fleet.resetRobot(args.robotId)
    case 'setOutOfService':
      return fleet.setOutOfService(args.robotId, args.reason)
    case 'rerouteAround':
      return fleet.rerouteAround(args.zoneId)
  }
  throw new Error(`unknown action ${tool}`)
}

export interface Proposal {
  id: string
  tool: string
  args: Record<string, any>
  reason: string
  incidentIds: string[]
  runId: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED'
  createdAt: string
  decidedAt?: string
  error?: string
}

export class ProposalStore {
  private proposals = new Map<string, Proposal>()
  private next = 1

  create(p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal {
    // Collapse duplicates: the same pending action proposed twice is one decision for the operator.
    for (const existing of this.proposals.values()) {
      if (existing.status === 'PENDING' && existing.tool === p.tool && JSON.stringify(existing.args) === JSON.stringify(p.args)) {
        return existing
      }
    }
    const proposal: Proposal = { ...p, id: `P-${String(this.next++).padStart(4, '0')}`, status: 'PENDING', createdAt: new Date().toISOString() }
    this.proposals.set(proposal.id, proposal)
    return proposal
  }

  list(status?: Proposal['status']) {
    return [...this.proposals.values()].filter((p) => !status || p.status === status)
  }

  get(id: string) {
    return this.proposals.get(id)
  }

  async approve(id: string, fleet: FleetClient) {
    const p = this.mustBePending(id)
    try {
      const result = await executeAction(fleet, p.tool, p.args)
      p.status = 'APPROVED'
      return { proposal: p, result }
    } catch (err) {
      p.status = 'FAILED'
      p.error = String(err instanceof Error ? err.message : err)
      return { proposal: p, error: p.error }
    } finally {
      p.decidedAt = new Date().toISOString()
    }
  }

  reject(id: string) {
    const p = this.mustBePending(id)
    p.status = 'REJECTED'
    p.decidedAt = new Date().toISOString()
    return p
  }

  clear() {
    this.proposals.clear()
  }

  private mustBePending(id: string) {
    const p = this.proposals.get(id)
    if (!p) throw new Error(`proposal ${id} not found`)
    if (p.status !== 'PENDING') throw new Error(`proposal ${id} is already ${p.status}`)
    return p
  }
}

export const proposals = new ProposalStore()
