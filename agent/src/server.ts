// HTTP server for the operator UI:
//   POST /api/triage                    run the triage workflow (optional { incidentIds })
//   GET  /api/proposals                 high-risk actions waiting for an operator
//   POST /api/proposals/:id/approve     run it
//   POST /api/proposals/:id/reject      drop it
//   /api/copilotkit/*                   CopilotKit chat, backed by the Mastra agent
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { MastraAgent } from '@ag-ui/mastra'
import { Agent } from '@mastra/core/agent'
import { CopilotRuntime } from '@copilotkit/runtime/v2'
import { createCopilotNodeListener } from '@copilotkit/runtime/v2/node'
import { proposals } from './actions.ts'
import { config, modelConfig, modelName } from './config.ts'
import { FleetClient } from './fleet.ts'
import { instructions } from './prompt.ts'
import { RunRecorder } from './recorder.ts'
import { makeTools } from './tools.ts'
import { runTriage } from './workflow.ts'

const fleet = new FleetClient()

// The chat agent shares the triage agent's tools and safety tiers, so a high-risk request made in
// chat also becomes a proposal card instead of running.
const chatAgent = new Agent({
  id: 'fleet-ops-chat',
  name: 'Fleet Ops Chat',
  instructions:
    instructions('v2') +
    `\nYou are chatting with an operator. Answer questions about the fleet using the tools. When you
propose a high-risk action, tell the operator its proposal id so they can approve it in the Approvals panel.`,
  model: modelConfig(),
  tools: makeTools({ fleet, recorder: new RunRecorder(), proposals, incidentIds: [], actions: [], variant: 'v2' }),
})

const copilot = createCopilotNodeListener({
  runtime: new CopilotRuntime({
    agents: { fleetOps: new MastraAgent({ agent: chatAgent, resourceId: 'operator' }) as any },
  }),
  basePath: '/api/copilotkit',
  cors: true,
})

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

let triageRunning = false

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/copilotkit')) return await copilot(req, res)
    if (req.method === 'OPTIONS') return send(res, 204, null)

    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, model: modelName() })

    if (req.method === 'POST' && url.pathname === '/api/triage') {
      if (triageRunning) return send(res, 409, { error: 'a triage run is already in progress' })
      triageRunning = true
      try {
        const body = await readJson(req)
        const { result } = await runTriage({ fleet, proposals }, body.incidentIds)
        return send(res, 200, result)
      } finally {
        triageRunning = false
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/proposals') {
      return send(res, 200, proposals.list().reverse())
    }

    const m = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(approve|reject)$/)
    if (req.method === 'POST' && m) {
      const [, id, decision] = m
      return send(res, 200, decision === 'approve' ? await proposals.approve(id, fleet) : { proposal: proposals.reject(id) })
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(config.port, () => console.log(`agent on http://localhost:${config.port} (model ${modelName()}, fleet ${config.graphqlUrl})`))
