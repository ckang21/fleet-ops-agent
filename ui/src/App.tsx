import { useCallback, useEffect, useMemo, useState } from 'react'
import { CopilotSidebar, useAgentContext } from '@copilotkit/react-core/v2'
import { fetchFleet, listProposals, triage, type FleetState, type Proposal, type TriageResult } from './api'
import { FleetMap } from './FleetMap'
import { ApprovalPanel, FaultInjector, IncidentPanel, TriagePanel } from './Panels'

function usePoll<T>(fn: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      setData(await fn())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [fn])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, ms)
    return () => clearInterval(t)
  }, [refresh, ms])
  return { data, error, refresh }
}

export function App() {
  const fleet = usePoll(fetchFleet, 1500)
  const props = usePoll(listProposals, 2000)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TriageResult | null>(null)
  const [triageError, setTriageError] = useState<string | null>(null)

  const state = fleet.data
  const active = useMemo(() => (state?.incidents ?? []).filter((i) => i.status !== 'RESOLVED'), [state])
  const highlight = useMemo(() => new Set(active.map((i) => i.robotId).filter(Boolean) as string[]), [active])

  // Give the chat agent the same picture the operator sees.
  useAgentContext({
    description: 'Live fleet state shown on the operator dashboard',
    value: state
      ? JSON.stringify({
          summary: state.fleetSummary,
          openIncidents: active,
          blockedZones: state.zones.filter((z) => z.blocked).map((z) => z.id),
          robots: state.robots.map((r) => ({ id: r.id, status: r.status, battery: Math.round(r.battery), x: r.position.x, y: r.position.y })),
          pendingApprovals: (props.data ?? []).filter((p) => p.status === 'PENDING').map((p) => ({ id: p.id, tool: p.tool, args: p.args })),
        })
      : 'loading',
  })

  const runTriage = async (ids?: string[]) => {
    setBusy(true)
    setTriageError(null)
    try {
      setResult(await triage(ids))
    } catch (e) {
      setTriageError(String(e))
    } finally {
      setBusy(false)
      fleet.refresh()
      props.refresh()
    }
  }

  return (
    <div className="app">
      <header className="top">
        <h1>Fleet Ops</h1>
        {state && (
          <div className="stats">
            <span>tick {state.fleetSummary.tick}</span>
            {state.fleetSummary.byStatus.map((s) => (
              <span key={s.status}>
                {s.status.toLowerCase()} {s.count}
              </span>
            ))}
            <span>battery {Math.round(state.fleetSummary.avgBattery)}%</span>
            <span>queued {state.fleetSummary.queuedJobs}</span>
            <span>done/60 ticks {state.fleetSummary.throughput}</span>
          </div>
        )}
      </header>
      {fleet.error && <p className="error banner">Can't reach the fleet simulator: {fleet.error}</p>}
      {state && (
        <main>
          <FleetMap robots={state.robots} zones={state.zones} highlight={highlight} />
          <div className="side">
            <ApprovalPanel proposals={(props.data ?? []) as Proposal[]} onChange={props.refresh} />
            <IncidentPanel incidents={state.incidents} busy={busy} onTriage={runTriage} />
            <TriagePanel result={result} error={triageError} />
            <FaultInjector fleet={state as FleetState} onChange={fleet.refresh} />
          </div>
        </main>
      )}
      <CopilotSidebar
        agentId="fleetOps"
        labels={{
          modalHeaderTitle: 'Fleet assistant',
          chatInputPlaceholder: 'Ask about the fleet, e.g. "why is R-07 stuck?"',
          welcomeMessageText: 'Ask me what is going on with the fleet. High-risk actions I suggest show up in Approvals.',
        }}
      />
    </div>
  )
}
