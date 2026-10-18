import type { Robot, Zone } from './api'

const GRID = 20
export const STATUS_COLOR: Record<Robot['status'], string> = {
  IDLE: '#8a94a6',
  WORKING: '#2f80ed',
  CHARGING: '#27ae60',
  FAULTED: '#eb5757',
  OFFLINE: '#333a45',
}

function zoneAt(zones: Zone[], x: number, y: number) {
  return zones.find((z) => x >= z.minX && x <= z.maxX && y >= z.minY && y <= z.maxY)
}

export function FleetMap({ robots, zones, highlight }: { robots: Robot[]; zones: Zone[]; highlight: Set<string> }) {
  const byCell = new Map<string, Robot[]>()
  for (const r of robots) {
    const k = `${r.position.x},${r.position.y}`
    byCell.set(k, [...(byCell.get(k) ?? []), r])
  }
  const cells = []
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const z = zoneAt(zones, x, y)
      const here = byCell.get(`${x},${y}`) ?? []
      const isLabelCell = z && x === z.minX && y === z.minY
      cells.push(
        <div
          key={`${x},${y}`}
          className={`cell ${z ? 'zone' : ''} ${z?.blocked ? 'blocked' : ''}`}
          title={z ? `${z.name}${z.blocked ? ' (BLOCKED)' : ''}` : undefined}
        >
          {isLabelCell && <span className="zone-label">{z.id}</span>}
          {here.map((r) => (
            <span
              key={r.id}
              className={`robot ${highlight.has(r.id) ? 'hl' : ''}`}
              style={{ background: STATUS_COLOR[r.status] }}
              title={`${r.id} · ${r.status} · ${Math.round(r.battery)}%${r.faultCode ? ` · ${r.faultCode}` : ''}${r.stuckTicks ? ` · stuck ${r.stuckTicks}` : ''}`}
            >
              {r.id.slice(2)}
            </span>
          ))}
        </div>,
      )
    }
  }
  return (
    <div>
      <div className="grid">{cells}</div>
      <div className="legend">
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span key={s}>
            <i style={{ background: c }} /> {s}
          </span>
        ))}
        <span>
          <i className="legend-blocked" /> blocked zone
        </span>
      </div>
    </div>
  )
}
