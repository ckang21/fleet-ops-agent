// Eval harness: for each golden scenario, reset the sim with its seed, inject faults, run triage,
// then score the result.
//
//   npm run eval                                  # v2 with the provider from LLM_PROVIDER
//   npm run eval -- --variant baseline
//   npm run eval -- --only zone                   # scenarios whose id contains "zone"
//   LLM_PROVIDER=mock npm run eval                # rule-based diagnoser, no model (what CI runs)
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { FleetClient, ProposalStore, modelName, runTriage, type FaultCode, type Variant } from '@fleet/agent'
import { scoreScenario, totals, type Scenario, type ScenarioScore } from './score.ts'
import { writeReport } from './report.ts'

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const { values } = parseArgs({
  options: {
    variant: { type: 'string', default: 'v2' },
    only: { type: 'string' },
    label: { type: 'string' },
  },
})
const variant = values.variant as Variant
const fleet = new FleetClient()

async function loadScenarios() {
  const dir = path.join(here, 'scenarios')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  const all: Scenario[] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))))
  return values.only ? all.filter((s) => s.id.includes(values.only!)) : all
}

async function setUp(s: Scenario) {
  await fleet.resetSimulation(s.setup.seed, 'eval', false)
  await fleet.advanceTicks(s.setup.warmupTicks ?? 5)
  for (const f of s.setup.faults) {
    let robotId = f.robotId
    if (f.target === 'idle') {
      const idle = await fleet.robots('IDLE')
      if (!idle.length) throw new Error('scenario needs an idle robot but none is idle')
      robotId = idle[0].id
    }
    await fleet.injectFault({ faultCode: f.faultCode as FaultCode, robotId, zoneId: f.zoneId, count: f.count, durationTicks: f.durationTicks })
  }
  await fleet.advanceTicks(s.setup.ticks)
  if (!s.setup.extraTicks) return undefined
  const pinned = (await fleet.incidents('OPEN')).map((i) => i.id)
  await fleet.advanceTicks(s.setup.extraTicks)
  return pinned
}

async function runOne(s: Scenario): Promise<ScenarioScore> {
  const t = Date.now()
  try {
    const pinned = await setUp(s)
    const { result, toolCalls } = await runTriage({ fleet, proposals: new ProposalStore(), variant }, pinned)
    return scoreScenario(s, result, toolCalls, await fleet.robots())
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return {
      id: s.id, rootCause: 0, spurious: [], actionsCorrect: false, missingTools: [], forbiddenTools: [], escalation: 0,
      grouping: null, safetyViolations: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - t,
      pass: false, summary: '', error,
    }
  }
}

const scenarios = await loadScenarios()
const model = modelName()
const label = values.label ?? `${variant}__${model.replace(/[/:]/g, '-')}`
console.log(`Running ${scenarios.length} scenarios: variant=${variant} model=${model}`)

const scores: ScenarioScore[] = []
for (const s of scenarios) {
  const score = await runOne(s)
  scores.push(score)
  const mark = score.pass ? 'PASS' : 'FAIL'
  const why = score.error ?? [
    score.rootCause < 1 && `root cause ${score.rootCause.toFixed(2)}`,
    score.spurious.length && `spurious ${score.spurious.join(',')}`,
    score.missingTools.length && `missing ${score.missingTools.join(',')}`,
    score.forbiddenTools.length && `forbidden ${score.forbiddenTools.join(',')}`,
    score.escalation < 1 && 'escalation wrong',
    score.grouping === false && 'grouping wrong',
    score.safetyViolations && `${score.safetyViolations} SAFETY VIOLATION(S)`,
  ].filter(Boolean).join('; ')
  console.log(`${mark}  ${s.id.padEnd(22)} ${(score.latencyMs / 1000).toFixed(1).padStart(6)}s  ${why}`)
}

const summary = { label, variant, model, at: new Date().toISOString(), totals: totals(scores), scores }
const outDir = path.join(here, 'results')
await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, `${label}.json`), JSON.stringify(summary, null, 2))
await writeFile(path.join(here, 'results.json'), JSON.stringify(summary, null, 2))
await writeReport(here)

const tt = summary.totals
console.log(
  `\n${tt.passed}/${tt.scenarios} passed | root cause ${(tt.rootCauseAccuracy * 100).toFixed(0)}% | actions ${(tt.actionCorrectness * 100).toFixed(0)}% | ` +
    `escalation ${(tt.escalationAccuracy * 100).toFixed(0)}% | safety violations ${tt.safetyViolations} | avg ${tt.avgLatencyS.toFixed(1)}s | $${tt.costUsd.toFixed(4)}`,
)
// The build fails on any unapproved high-risk action, whatever the accuracy.
if (tt.safetyViolations > 0) process.exit(1)
