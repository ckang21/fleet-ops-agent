// MCP server: exposes the fleet tools to any MCP client (Claude Code, VS Code, MCP Inspector...).
// It reuses makeTools, so an outside AI gets exactly the same safety tiers as the built-in agent:
// high-risk calls only create a proposal. There is deliberately no approve/reject tool here, so an
// AI client can never approve its own proposal. That stays with the operator in the UI.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { TIERS, type ProposalStore } from './actions.ts'
import { config } from './config.ts'
import type { FleetClient } from './fleet.ts'
import { RunRecorder } from './recorder.ts'
import { makeTools } from './tools.ts'
import type { TriageResult } from './types.ts'

export interface McpDeps {
  fleet: FleetClient
  proposals: ProposalStore
  /** Runs one triage pass. Passed in so the HTTP API and MCP share the same "one run at a time" lock. */
  triage: (incidentIds?: string[]) => Promise<TriageResult>
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))

/** MCP tool results are text, so every result is sent as JSON. `{ error }` results are flagged as errors. */
function toResult(value: unknown) {
  const isError = typeof value === 'object' && value !== null && 'error' in value
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError }
}

export function buildMcpServer(deps: McpDeps) {
  const server = new McpServer({ name: 'fleet-ops', version: '0.1.0' })

  const register = (name: string, description: string, inputSchema: z.ZodType, readOnly: boolean, run: (args: any) => Promise<unknown>) =>
    server.registerTool(
      name,
      // The SDK's types are built against the zod 3 copy at the repo root, while this package uses
      // zod 4. It accepts both when running, so the schema's type is loosened here, in one place.
      { description, inputSchema: inputSchema as any, annotations: { readOnlyHint: readOnly } },
      async (args: any) => {
        try {
          return toResult(await run(args ?? {}))
        } catch (err) {
          return toResult({ error: errMsg(err) })
        }
      },
    )

  // The same 13 tools the agent uses. Proposals made over MCP land in the shared store, so they
  // show up as approval cards in the UI like any other.
  const tools = makeTools({
    fleet: deps.fleet,
    recorder: new RunRecorder(),
    proposals: deps.proposals,
    incidentIds: [],
    actions: [],
    variant: 'v2',
  }) as Record<string, any>

  for (const [name, tool] of Object.entries(tools)) {
    register(name, tool.description, tool.inputSchema, TIERS[name] === 'read', (args) => tool.execute(args, {}))
  }

  register(
    'listProposals',
    'List high-risk actions waiting for (or already decided by) a human operator. Read-only: proposals can only be approved or rejected by the operator in the dashboard, never through MCP.',
    z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'FAILED']).optional() }),
    true,
    async ({ status }) => deps.proposals.list(status),
  )

  register(
    'runTriage',
    'Run the full triage workflow (detect, group, diagnose, act or propose) with the local model. Triages every open incident unless incidentIds is given. Can take a minute on a local model.',
    z.object({ incidentIds: z.array(z.string()).optional() }),
    false,
    ({ incidentIds }) => deps.triage(incidentIds),
  )

  return server
}

/**
 * Handles one MCP request over HTTP. Stateless: each request gets a fresh server and transport, so
 * there are no sessions to track. Only requests addressed to localhost are accepted, which stops a
 * web page from reaching the server through DNS rebinding.
 */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, deps: McpDeps) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null }))
    return
  }
  const server = buildMcpServer(deps)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [`localhost:${config.port}`, `127.0.0.1:${config.port}`],
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}
