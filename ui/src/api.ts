// Calls to the fleet simulator (GraphQL) and the agent server (REST). Both go through Vite's proxy.

export interface Robot {
  id: string
  status: 'IDLE' | 'WORKING' | 'CHARGING' | 'FAULTED' | 'OFFLINE'
  battery: number
  position: { x: number; y: number }
  currentJobId: string | null
  faultCode: string | null
  stuckTicks: number
  outOfService: boolean
}
export interface Zone {
  id: string
  name: string
  minX: number
  minY: number
  maxX: number
  maxY: number
  blocked: boolean
}
export interface Incident {
  id: string
  type: string
  robotId: string | null
  zoneId: string | null
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  status: string
  detectedAt: number
  escalated: boolean
}
export interface Summary {
  tick: number
  byStatus: { status: string; count: number }[]
  avgBattery: number
  openIncidents: number
  queuedJobs: number
  throughput: number
}
export interface FleetState {
  robots: Robot[]
  zones: Zone[]
  incidents: Incident[]
  fleetSummary: Summary
}
export interface Proposal {
  id: string
  tool: string
  args: Record<string, unknown>
  reason: string
  incidentIds: string[]
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'FAILED'
  createdAt: string
  error?: string
}
export interface TriageGroup {
  incidentIds: string[]
  rootCause: string
  confidence: number
  escalate: boolean
  summary: string
  actionsTaken: { tool: string; args: Record<string, unknown> }[]
  actionsProposed: { tool: string; args: Record<string, unknown>; proposalId?: string }[]
}
export interface TriageResult {
  runId: string
  model: string
  groups: TriageGroup[]
  latencyMs: number
}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors?.length) throw new Error(body.errors[0].message)
  return body.data
}

export const fetchFleet = () =>
  gql<FleetState>(`{
    robots { id status battery position { x y } currentJobId faultCode stuckTicks outOfService }
    zones { id name minX minY maxX maxY blocked }
    incidents { id type robotId zoneId severity status detectedAt escalated }
    fleetSummary { tick byStatus { status count } avgBattery openIncidents queuedJobs throughput }
  }`)

async function agentApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json
}

export const triage = (incidentIds?: string[]) => agentApi<TriageResult>('/triage', { incidentIds })
export const listProposals = () => agentApi<Proposal[]>('/proposals')
export const decide = (id: string, decision: 'approve' | 'reject') => agentApi<unknown>(`/proposals/${id}/${decision}`, {})

export const injectFault = (faultCode: string, robotId?: string, zoneId?: string) =>
  gql(`mutation($f: FaultCode!, $r: ID, $z: ID) { injectFault(faultCode: $f, robotId: $r, zoneId: $z) { robotIds } }`, {
    f: faultCode,
    r: robotId || null,
    z: zoneId || null,
  })
export const clearZone = (zoneId: string) => gql(`mutation($z: ID!) { clearZone(zoneId: $z) { id } }`, { z: zoneId })
export const resetSim = (seed: number) => gql(`mutation($s: Int) { resetSimulation(seed: $s, scenario: "default", autoTick: true) }`, { s: seed })
