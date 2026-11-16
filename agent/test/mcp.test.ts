import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ProposalStore, TIERS } from '../src/actions.ts'
import type { FleetClient } from '../src/fleet.ts'
import { buildMcpServer } from '../src/mcp.ts'

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

// A real MCP client talking to the real MCP server, joined in memory instead of over HTTP.
async function setup() {
  const { fleet, ran } = fakeFleet()
  const proposals = new ProposalStore()
  const triaged: (string[] | undefined)[] = []
  const server = buildMcpServer({
    fleet,
    proposals,
    triage: async (incidentIds) => {
      triaged.push(incidentIds)
      return { runId: 'run-test', variant: 'v2', model: 'mock-rules', groups: [], tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 }
    },
  })
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    return { isError: res.isError === true, text: res.content[0].text }
  }
  return { client, call, ran, proposals, fleet, triaged }
}

test('MCP lists every agent tool plus listProposals and runTriage', async () => {
  const { client } = await setup()
  const names = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, [...Object.keys(TIERS), 'listProposals', 'runTriage'].sort())
})

test('MCP has no way to approve or reject a proposal', async () => {
  const { client } = await setup()
  const { tools } = await client.listTools()
  for (const t of tools) assert.doesNotMatch(t.name, /approve|reject/i)
})

for (const tool of ['resetRobot', 'setOutOfService', 'rerouteAround']) {
  test(`${tool} over MCP becomes a proposal and never touches the fleet`, async () => {
    const { call, ran, proposals } = await setup()
    const args = tool === 'rerouteAround' ? { zoneId: 'AISLE_3', reason: 'r' } : { robotId: 'R-01', reason: 'r' }
    const out = JSON.parse((await call(tool, args)).text)
    assert.equal(out.status, 'PROPOSED')
    assert.deepEqual(ran, [])
    assert.equal(proposals.list('PENDING').length, 1)
  })
}

test('a proposal made over MCP shows in listProposals and runs only when the operator approves it', async () => {
  const { call, ran, proposals, fleet } = await setup()
  const { proposalId } = JSON.parse((await call('rerouteAround', { zoneId: 'AISLE_3', reason: 'blocked' })).text)
  const listed = JSON.parse((await call('listProposals', { status: 'PENDING' })).text)
  assert.deepEqual(listed.map((p: { id: string }) => p.id), [proposalId])
  assert.deepEqual(ran, [])
  await proposals.approve(proposalId, fleet)
  assert.deepEqual(ran, ['rerouteAround'])
})

test('low-risk actions over MCP run immediately', async () => {
  const { call, ran } = await setup()
  const out = JSON.parse((await call('sendToCharger', { robotId: 'R-01', reason: 'low battery' })).text)
  assert.equal(out.status, 'EXECUTED')
  assert.deepEqual(ran, ['sendToCharger'])
})

test('arguments are validated before anything runs', async () => {
  const { call, ran } = await setup()
  const res = await call('sendToCharger', { reason: 'no robot id' })
  assert.equal(res.isError, true)
  assert.deepEqual(ran, [])
})

test('runTriage passes the incident ids through and returns the result', async () => {
  const { call, triaged } = await setup()
  const out = JSON.parse((await call('runTriage', { incidentIds: ['INC-0001'] })).text)
  assert.equal(out.runId, 'run-test')
  assert.deepEqual(triaged, [['INC-0001']])
})
