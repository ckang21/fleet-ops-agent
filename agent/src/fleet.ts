// Typed GraphQL client for the fleet simulator. Every agent tool goes through here.
import { GraphQLClient, gql } from 'graphql-request'
import { config } from './config.ts'

export type FaultCode =
  | 'LOW_BATTERY'
  | 'STUCK'
  | 'HEARTBEAT_LOST'
  | 'ZONE_BLOCKED'
  | 'JOB_TIMEOUT'
  | 'SENSOR_FAULT'

export interface Robot {
  id: string
  name: string
  type: string
  status: string
  battery: number
  position: { x: number; y: number }
  zoneId: string | null
  currentJobId: string | null
  lastHeartbeat: number
  faultCode: FaultCode | null
  stuckTicks: number
  outOfService: boolean
  outOfServiceReason: string | null
  avoidZones: string[]
}

export interface Job {
  id: string
  type: string
  from: string
  to: string
  priority: number
  status: string
  assignedRobotId: string | null
  createdAt: number
  startedAt: number | null
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
  robotId: string | null
  zoneId: string | null
  jobId: string | null
  type: FaultCode
  detectedAt: number
  severity: string
  status: string
  resolution: string | null
  escalated: boolean
  notes: string[]
}

export interface Snapshot {
  tick: number
  position: { x: number; y: number }
  battery: number
  status: string
}

export interface FleetSummary {
  tick: number
  robotCount: number
  byStatus: { status: string; count: number }[]
  avgBattery: number
  openIncidents: number
  queuedJobs: number
  throughput: number
}

const ROBOT = `id name type status battery position { x y } zoneId currentJobId lastHeartbeat faultCode stuckTicks outOfService outOfServiceReason avoidZones`
const JOB = `id type from to priority status assignedRobotId createdAt startedAt`
const ZONE = `id name minX minY maxX maxY blocked`
const INCIDENT = `id robotId zoneId jobId type detectedAt severity status resolution escalated notes`

export class FleetClient {
  private client: GraphQLClient

  constructor(url = config.graphqlUrl) {
    this.client = new GraphQLClient(url)
  }

  private req<T>(query: string, vars?: Record<string, unknown>): Promise<T> {
    return this.client.request<T>(query, vars)
  }

  async fleetSummary() {
    return (
      await this.req<{ fleetSummary: FleetSummary }>(
        gql`{ fleetSummary { tick robotCount byStatus { status count } avgBattery openIncidents queuedJobs throughput } }`,
      )
    ).fleetSummary
  }

  async robots(status?: string) {
    return (await this.req<{ robots: Robot[] }>(`query($s: RobotStatus) { robots(status: $s) { ${ROBOT} } }`, { s: status })).robots
  }

  async robot(id: string) {
    return (await this.req<{ robot: Robot | null }>(`query($id: ID!) { robot(id: $id) { ${ROBOT} } }`, { id })).robot
  }

  async robotHistory(id: string, lastTicks = 30) {
    return (
      await this.req<{ robotHistory: Snapshot[] }>(
        `query($id: ID!, $n: Int) { robotHistory(id: $id, lastTicks: $n) { tick position { x y } battery status } }`,
        { id, n: lastTicks },
      )
    ).robotHistory
  }

  async jobs(status?: string) {
    return (await this.req<{ jobs: Job[] }>(`query($s: JobStatus) { jobs(status: $s) { ${JOB} } }`, { s: status })).jobs
  }

  async zones() {
    return (await this.req<{ zones: Zone[] }>(`{ zones { ${ZONE} } }`)).zones
  }

  async incidents(status?: string) {
    return (
      await this.req<{ incidents: Incident[] }>(`query($s: IncidentStatus) { incidents(status: $s) { ${INCIDENT} } }`, { s: status })
    ).incidents
  }

  async reassignJob(jobId: string, robotId?: string | null) {
    return (
      await this.req<{ reassignJob: Job }>(`mutation($j: ID!, $r: ID) { reassignJob(jobId: $j, robotId: $r) { ${JOB} } }`, {
        j: jobId,
        r: robotId ?? null,
      })
    ).reassignJob
  }

  async sendToCharger(robotId: string) {
    return (await this.req<{ sendToCharger: Robot }>(`mutation($r: ID!) { sendToCharger(robotId: $r) { ${ROBOT} } }`, { r: robotId }))
      .sendToCharger
  }

  async resetRobot(robotId: string) {
    return (await this.req<{ resetRobot: Robot }>(`mutation($r: ID!) { resetRobot(robotId: $r) { ${ROBOT} } }`, { r: robotId })).resetRobot
  }

  async setOutOfService(robotId: string, reason: string) {
    return (
      await this.req<{ setOutOfService: Robot }>(
        `mutation($r: ID!, $why: String!) { setOutOfService(robotId: $r, reason: $why) { ${ROBOT} } }`,
        { r: robotId, why: reason },
      )
    ).setOutOfService
  }

  async rerouteAround(zoneId: string) {
    return (await this.req<{ rerouteAround: Robot[] }>(`mutation($z: ID!) { rerouteAround(zoneId: $z) { ${ROBOT} } }`, { z: zoneId }))
      .rerouteAround
  }

  async clearZone(zoneId: string) {
    return (await this.req<{ clearZone: Zone }>(`mutation($z: ID!) { clearZone(zoneId: $z) { ${ZONE} } }`, { z: zoneId })).clearZone
  }

  async escalate(incidentId: string, note: string) {
    return (
      await this.req<{ escalate: Incident }>(`mutation($i: ID!, $n: String!) { escalate(incidentId: $i, note: $n) { ${INCIDENT} } }`, {
        i: incidentId,
        n: note,
      })
    ).escalate
  }

  async resolveIncident(incidentId: string, resolution: string) {
    return (
      await this.req<{ resolveIncident: Incident }>(
        `mutation($i: ID!, $r: String!) { resolveIncident(incidentId: $i, resolution: $r) { ${INCIDENT} } }`,
        { i: incidentId, r: resolution },
      )
    ).resolveIncident
  }

  async injectFault(args: { faultCode: FaultCode; robotId?: string; zoneId?: string; count?: number; durationTicks?: number }) {
    return (
      await this.req<{ injectFault: { faultCode: FaultCode; robotIds: string[]; zoneId: string | null } }>(
        `mutation($f: FaultCode!, $r: ID, $z: ID, $c: Int, $d: Int) {
          injectFault(faultCode: $f, robotId: $r, zoneId: $z, count: $c, durationTicks: $d) { faultCode robotIds zoneId }
        }`,
        { f: args.faultCode, r: args.robotId ?? null, z: args.zoneId ?? null, c: args.count ?? null, d: args.durationTicks ?? null },
      )
    ).injectFault
  }

  async resetSimulation(seed: number, scenario = 'eval', autoTick = false) {
    return (
      await this.req<{ resetSimulation: boolean }>(
        `mutation($s: Int, $sc: String, $a: Boolean) { resetSimulation(seed: $s, scenario: $sc, autoTick: $a) }`,
        { s: seed, sc: scenario, a: autoTick },
      )
    ).resetSimulation
  }

  async advanceTicks(n: number) {
    return (await this.req<{ advanceTicks: number }>(`mutation($n: Int!) { advanceTicks(n: $n) }`, { n })).advanceTicks
  }
}
