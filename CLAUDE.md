# Fleet Ops Agent — Build Notes

Portfolio project: AI agents that help operators diagnose and act on robot-fleet issues, with
automated incident triage, approval-gated actions, and an eval suite that measures agent quality.

## Decisions (agreed with the owner)

- **$0 to run.** No paid LLM APIs. The agent uses a local model through **Ollama**
  (`qwen3:8b`, fits the RTX 5060 Ti 8 GB). A deterministic **mock** diagnoser is used in CI and tests.
  The provider is picked by `LLM_PROVIDER=ollama|mock` in `.env`; adding a paid provider later is one setting.
- **Go 1.27** is installed at `C:\Program Files\Go\bin` (older shells may not have it on PATH).
- **No employer branding.** Don't name any company or job posting in the repo; it's a standalone project.
- Repo: public `ckang21/fleet-ops-agent`, push after each phase.
- After the build, write `docs/LEARNING.md`: a plain-English walkthrough of how every part works and how it was built.

## Architecture

```
ui (React + CopilotKit) ──GraphQL──► fleet-sim (Go, gqlgen)
   │ chat / approvals                     ▲
   ▼                                      │ GraphQL tools
agent (TypeScript, Mastra) ───────────────┘
   ▲
evals (TypeScript): golden scenarios → run triage → score → report
```

Monorepo: `fleet-sim/`, `agent/`, `evals/`, `ui/`, `docker-compose.yml`, `README.md`.

## Phases (priority order)

1. **fleet-sim (Go):** robots/jobs/zones/incidents on a 20×20 grid, 1 s ticks, seeded RNG, fault
   detectors (LOW_BATTERY, STUCK, HEARTBEAT_LOST, ZONE_BLOCKED, JOB_TIMEOUT, SENSOR_FAULT), GraphQL API
   with queries, action mutations, `injectFault`, `resetSimulation`, `advanceTicks`. `go test ./...` passes.
2. **agent (TS/Mastra):** read tools + action tools over GraphQL. Safety tiers: read = always; low-risk
   (`sendToCharger`, `reassignJob`) = auto; high-risk (`setOutOfService`, `resetRobot`, `rerouteAround`)
   = proposal that an operator must approve. Triage workflow: detect → group → diagnose → decide →
   act/propose → log, with structured (Zod) output. JSONL run log with tool calls, tokens, latency.
3. **evals:** 20 golden scenarios (3 per fault type + tricky cases), scoring for root cause, actions,
   escalation, grouping, safety violations (target 0), cost and latency. `npm run eval` writes
   `evals/report.md` + `evals/results.json`. CI runs the mock eval and fails if safety violations > 0.
   Record before/after numbers in the README.
4. **ui:** fleet map, incident panel with Triage, CopilotKit chat with fleet state as context,
   approval cards (Approve / Reject), fault injector.
5. **packaging:** docker-compose, `.env.example`, README (pitch, diagram, eval table, design decisions, next steps).
6. **MCP server (`agent/src/mcp.ts`, added 2026-11-15):** served by the agent process at `POST /mcp` (stateless
   Streamable HTTP, localhost only) so it shares the proposal store with the UI. Wraps `makeTools`, plus
   `listProposals` and `runTriage`. Never add an approve/reject tool: approval belongs to the operator only.

Check current docs/installed types for Mastra, CopilotKit and gqlgen; their APIs change quickly.
