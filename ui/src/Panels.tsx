import { useState } from 'react'
import { clearZone, decide, injectFault, resetSim, type FleetState, type Incident, type Proposal, type TriageResult } from './api'

const describe = (p: { tool: string; args: Record<string, unknown> }) =>
  `${p.tool}(${Object.values(p.args)
    .filter((v) => typeof v === 'string' && v.length < 24)
    .join(', ')})`

export function IncidentPanel({
  incidents,
  busy,
  onTriage,
}: {
  incidents: Incident[]
  busy: boolean
  onTriage: (ids?: string[]) => void
}) {
  const active = incidents.filter((i) => i.status !== 'RESOLVED').sort((a, b) => b.detectedAt - a.detectedAt)
  return (
    <section className="panel">
      <header>
        <h2>Incidents ({active.length})</h2>
        <button disabled={busy || active.length === 0} onClick={() => onTriage()}>
          {busy ? 'Triaging…' : 'Triage all'}
        </button>
      </header>
      {active.length === 0 && <p className="muted">No open incidents.</p>}
      <ul className="incidents">
        {active.map((i) => (
          <li key={i.id}>
            <span className={`sev sev-${i.severity}`}>{i.severity}</span>
            <div>
              <strong>{i.type}</strong> {i.robotId ?? i.zoneId}
              <div className="muted small">
                {i.id} · tick {i.detectedAt} · {i.status}
                {i.escalated && ' · escalated'}
              </div>
            </div>
            <button disabled={busy} onClick={() => onTriage([i.id])}>
              Triage
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function TriagePanel({ result, error }: { result: TriageResult | null; error: string | null }) {
  if (error) return <section className="panel error">Triage failed: {error}</section>
  if (!result) return null
  return (
    <section className="panel">
      <header>
        <h2>Last triage</h2>
        <span className="muted small">
          {result.model} · {(result.latencyMs / 1000).toFixed(1)}s
        </span>
      </header>
      {result.groups.length === 0 && <p className="muted">Nothing to triage.</p>}
      {result.groups.map((g, i) => (
        <div key={i} className="diagnosis">
          <div>
            <strong>{g.rootCause}</strong> <span className="muted small">confidence {Math.round(g.confidence * 100)}%</span>
            {g.escalate && <span className="tag">escalated</span>}
          </div>
          <p>{g.summary}</p>
          <div className="small">
            {g.actionsTaken.length > 0 && <div>Done: {g.actionsTaken.map(describe).join(', ')}</div>}
            {g.actionsProposed.length > 0 && <div>Proposed: {g.actionsProposed.map((a) => `${describe(a)} [${a.proposalId}]`).join(', ')}</div>}
            <div className="muted">Incidents: {g.incidentIds.join(', ')}</div>
          </div>
        </div>
      ))}
    </section>
  )
}

export function ApprovalPanel({ proposals, onChange }: { proposals: Proposal[]; onChange: () => void }) {
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = proposals.filter((p) => p.status === 'PENDING')
  const decided = proposals.filter((p) => p.status !== 'PENDING').slice(0, 5)

  const act = async (id: string, d: 'approve' | 'reject') => {
    setWorking(id)
    setError(null)
    try {
      await decide(id, d)
    } catch (e) {
      setError(String(e))
    } finally {
      setWorking(null)
      onChange()
    }
  }

  return (
    <section className="panel">
      <header>
        <h2>Approvals ({pending.length})</h2>
      </header>
      {pending.length === 0 && <p className="muted">No actions waiting for approval.</p>}
      {pending.map((p) => (
        <div key={p.id} className="approval">
          <div>
            <span className="tag high">HIGH RISK</span> <strong>{describe(p)}</strong> <span className="muted small">{p.id}</span>
          </div>
          <p>{p.reason}</p>
          <div className="muted small">For incidents: {p.incidentIds.join(', ') || 'chat request'}</div>
          <div className="buttons">
            <button className="approve" disabled={working === p.id} onClick={() => act(p.id, 'approve')}>
              Approve
            </button>
            <button className="reject" disabled={working === p.id} onClick={() => act(p.id, 'reject')}>
              Reject
            </button>
          </div>
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      {decided.length > 0 && (
        <ul className="decided small">
          {decided.map((p) => (
            <li key={p.id}>
              {p.id} {describe(p)} → <strong>{p.status}</strong>
              {p.error && <span className="error"> ({p.error})</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const FAULTS = ['ZONE_BLOCKED', 'LOW_BATTERY', 'STUCK', 'HEARTBEAT_LOST', 'JOB_TIMEOUT', 'SENSOR_FAULT']

export function FaultInjector({ fleet, onChange }: { fleet: FleetState; onChange: () => void }) {
  const [fault, setFault] = useState('ZONE_BLOCKED')
  const [robot, setRobot] = useState('')
  const [zone, setZone] = useState('AISLE_3')
  const [msg, setMsg] = useState('')
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      setMsg(done)
    } catch (e) {
      setMsg(String(e))
    }
    onChange()
  }
  const blocked = fleet.zones.filter((z) => z.blocked)
  return (
    <details className="panel">
      <summary>
        <h2>Fault injector (demo)</h2>
      </summary>
      <div className="row">
        <select value={fault} onChange={(e) => setFault(e.target.value)}>
          {FAULTS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        {fault === 'ZONE_BLOCKED' ? (
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            {fleet.zones.filter((z) => z.id.startsWith('AISLE')).map((z) => (
              <option key={z.id}>{z.id}</option>
            ))}
          </select>
        ) : (
          <select value={robot} onChange={(e) => setRobot(e.target.value)}>
            <option value="">any working robot</option>
            {fleet.robots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} ({r.status})
              </option>
            ))}
          </select>
        )}
        <button onClick={() => run(() => injectFault(fault, fault === 'ZONE_BLOCKED' ? undefined : robot, fault === 'ZONE_BLOCKED' ? zone : undefined), `Injected ${fault}`)}>
          Inject
        </button>
      </div>
      <div className="row">
        {blocked.map((z) => (
          <button key={z.id} onClick={() => run(() => clearZone(z.id), `Cleared ${z.id}`)}>
            Clear {z.id}
          </button>
        ))}
        <button onClick={() => run(() => resetSim(Math.floor(Math.random() * 1000)), 'Simulation reset')}>Reset simulation</button>
      </div>
      {msg && <p className="muted small">{msg}</p>}
    </details>
  )
}
