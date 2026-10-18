import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProposalStore, TIERS } from '../src/actions.ts'
import type { FleetClient } from '../src/fleet.ts'
import { RunRecorder } from '../src/recorder.ts'
import { makeTools } from '../src/tools.ts'
import type { Action } from '../src/types.ts'
import { groupIncidents } from '../src/workflow.ts'

// A fleet client that records which mutations actually ran.
function fakeFleet() {
  const ran: string[] = []
  const handler = {
    get(_: unknown, prop: string) {
      return async (...args: unknown[]) => {
        ran.push(prop)
        return { prop, args }
      }
    },
  }
  return { fleet: new Proxy({}, handler) as unknown as FleetClient, ran }
}

function setup() {
  const { fleet, ran } = fakeFleet()
  const proposals = new ProposalStore()
  const actions: Action[] = []
  const recorder = new RunRecorder()
  const tools = makeTools({ fleet, recorder, proposals, incidentIds: ['INC-0001'], actions, variant: 'v2' }) as Record<string, any>
  return { tools, ran, proposals, actions, recorder, fleet }
}

for (const tool of ['resetRobot', 'setOutOfService', 'rerouteAround']) {
  test(`${tool} is high risk: it becomes a proposal and never touches the fleet`, async () => {
    const { tools, ran, proposals, actions } = setup()
    const input = tool === 'rerouteAround' ? { zoneId: 'AISLE_3', reason: 'r' } : { robotId: 'R-01', reason: 'r' }
    const out = await tools[tool].execute(input, {})
    assert.equal(out.status, 'PROPOSED')
    assert.deepEqual(ran, [])
    assert.equal(proposals.list('PENDING').length, 1)
    assert.equal(actions[0].status, 'PROPOSED')
  })
}

test('low-risk actions run immediately', async () => {
  const { tools, ran, actions } = setup()
  await tools.sendToCharger.execute({ robotId: 'R-01', reason: 'low battery' }, {})
  assert.deepEqual(ran, ['sendToCharger'])
  assert.equal(actions[0].status, 'EXECUTED')
})

test('a proposal only runs when an operator approves it', async () => {
  const { tools, ran, proposals, fleet } = setup()
  const { proposalId } = await tools.rerouteAround.execute({ zoneId: 'AISLE_3', reason: 'blocked' }, {})
  assert.deepEqual(ran, [])
  await proposals.approve(proposalId, fleet)
  assert.deepEqual(ran, ['rerouteAround'])
  await assert.rejects(() => proposals.approve(proposalId, fleet), /already APPROVED/)
})

test('rejected proposals never run', async () => {
  const { tools, ran, proposals } = setup()
  const { proposalId } = await tools.resetRobot.execute({ robotId: 'R-02', reason: 'jammed' }, {})
  proposals.reject(proposalId)
  assert.deepEqual(ran, [])
})

test('duplicate proposals collapse into one decision', async () => {
  const { tools, proposals } = setup()
  await tools.rerouteAround.execute({ zoneId: 'AISLE_3', reason: 'a' }, {})
  await tools.rerouteAround.execute({ zoneId: 'AISLE_3', reason: 'b' }, {})
  assert.equal(proposals.list('PENDING').length, 1)
})

test('every tool has a safety tier', () => {
  const { tools } = setup()
  for (const name of Object.keys(tools)) assert.ok(TIERS[name], `${name} has no tier`)
})

test('v2 grouping puts stuck robots next to a blocked zone into one group', () => {
  const zones = [{ id: 'AISLE_3', name: 'Aisle 3', minX: 13, minY: 4, maxX: 14, maxY: 15, blocked: true }]
  const robot = (id: string, x: number, y: number) => ({ id, position: { x, y } }) as any
  const inc = (id: string, type: string, robotId: string | null, zoneId: string | null = null) => ({ id, type, robotId, zoneId }) as any
  const incidents = [inc('I1', 'STUCK', 'R-01'), inc('I2', 'STUCK', 'R-02'), inc('I3', 'ZONE_BLOCKED', null, 'AISLE_3'), inc('I4', 'LOW_BATTERY', 'R-09')]
  const robots = [robot('R-01', 12, 5), robot('R-02', 12, 8), robot('R-09', 2, 2)]

  const v2 = groupIncidents(incidents, robots, zones, 'v2')
  assert.equal(v2.length, 2)
  assert.deepEqual(v2.find((g) => g.key === 'zone:AISLE_3')?.incidentIds.sort(), ['I1', 'I2', 'I3'])
  assert.equal(groupIncidents(incidents, robots, zones, 'baseline').length, 4)
})
