# Fleet Ops Agent

Agentic incident response for a simulated warehouse robot fleet. A Go simulator runs 16 robots and detects
faults; a TypeScript **Mastra** agent investigates them through **GraphQL** tools, fixes what is safe to fix,
and sends anything risky to a human for approval; a **React + CopilotKit** dashboard lets an operator watch
the fleet, chat with the agent and approve its proposals. A 20-scenario golden eval suite measures root-cause
accuracy, action safety, escalation, cost and latency. An **MCP server** exposes the same tools to outside AI
clients (Claude Code, VS Code, MCP Inspector) behind the same approval gate.

Runs entirely on a local model (Qwen 3 8B via Ollama). **$0 per eval run, no API keys.**

**Stack:** TypeScript · Mastra · Go · GraphQL (gqlgen) · React · CopilotKit · MCP · Ollama · Docker · GitHub Actions

```
┌────────────────────┐   GraphQL    ┌──────────────────────────┐
│  Operator UI       │◄────────────►│  Fleet Sim (Go)          │
│  React + CopilotKit│              │  - 16 robots, 20×20 grid │
└─────────┬──────────┘              │  - fault detectors       │
          │ chat / approvals        │  - GraphQL API (gqlgen)  │
          ▼                         └──────────▲───────────────┘
┌────────────────────┐   GraphQL tools         │
│  Agent (TypeScript)│─────────────────────────┘
│  Mastra agent +    │◄──── MCP (HTTP) ──── Claude Code, VS Code,
│  triage workflow   │                      any MCP client
└─────────┬──────────┘
          │
┌─────────▼──────────┐
│  Evals (TS)        │  20 golden scenarios → run triage → score → report
└────────────────────┘
```

## Eval results

20 golden scenarios, Qwen 3 8B running locally on an RTX 5060 Ti:

| Version | Passed | Actions correct | Escalation | Grouping | Wrong extra causes | Safety violations | Avg latency | Cost |
|---|---|---|---|---|---|---|---|---|
| Baseline | 3/20 | 30% | 60% | 33% | 14 | 0 | 59.1 s | $0 |
| v2, round 1 | 12/20 | 70% | 90% | 100% | 0 | 0 | 24.3 s | $0 |
| **v2, round 2** | **17/20** | **85%** | **100%** | **100%** | **0** | **0** | 28.7 s | $0 |
| Rule-based reference (no model) | 20/20 | 100% | 100% | 100% | 0 | 0 | <0.1 s | $0 |

**What moved the numbers**

- **Baseline → round 1 (3 → 12 passed).** The baseline usually named the right fault but then did the wrong
  thing: it treated four robots stuck at one blocked aisle as four separate problems (14 wrong extra root
  causes) and often skipped the follow-up actions. Round 1 added a **grouping step** to the workflow, a
  fault **playbook** in the prompt, and tools that return **summaries** (e.g. "ticks since last move",
  "near a blocked zone") instead of raw rows. Grouping went from 33% to 100% and latency halved.
- **Round 1 → round 2 (12 → 17 passed).** Every remaining failure was a missing high-risk tool call. The run
  logs showed why: the model *wrote* "propose resetRobot for R-09" in its answer but never *called* the tool,
  so no proposal reached the operator. Rewording the high-risk tool descriptions and prompt to say "calling
  this is safe, it only creates a proposal" fixed most of them.
- **Safety violations stayed at 0 in every run**, including the baseline, because the approval gate is in the
  tool layer rather than the prompt.

Each row is one run; a small local model varies a little from run to run.

Full per-scenario tables: [`evals/report.md`](evals/report.md).

## How it works

**Simulator (`fleet-sim/`).** Robots move one cell per tick toward their jobs, drain battery and recharge.
Faults are injected as *hidden* state (a jammed motor, a dead radio); the agent only sees the symptoms.
Detectors turn symptoms into incidents and close them when the symptom goes away. Everything is seeded, so
the same seed replays the same warehouse exactly.

| Fault | Symptom | Correct response |
|---|---|---|
| `LOW_BATTERY` | battery < 15% while working | reassign job, send to charger |
| `STUCK` | no movement for 5 ticks, nothing blocking | propose a reset |
| `HEARTBEAT_LOST` | no heartbeat → OFFLINE | reassign job, escalate |
| `ZONE_BLOCKED` | aisle blocked, several robots stuck at it | **one** root cause: propose reroute, escalate |
| `JOB_TIMEOUT` | job running far too long | inspect, reassign |
| `SENSOR_FAULT` | robot reports a fault code | propose out-of-service, escalate |

**Agent (`agent/`).** Mastra agent with 6 read tools and 7 action tools, each a Zod-validated GraphQL call.
Triage is a Mastra workflow, not free chat: `detect → group → diagnose → log`, with a Zod-typed result.
Every run is logged to `logs/runs.jsonl` with each tool call, tokens, cost and latency.

**MCP server (`agent/src/mcp.ts`).** The agent process also serves the
[Model Context Protocol](https://modelcontextprotocol.io) at `POST /mcp`, so any MCP client can use the fleet:
the same 13 tools, plus `listProposals` and `runTriage` (the whole workflow, run by the local model). It is
built from the same tool definitions as the agent, so the tiers can't drift apart, and proposals made over MCP
appear as approval cards in the dashboard.

**Evals (`evals/`).** Each scenario resets the simulator with a seed (clock paused), injects faults, advances
time, runs the workflow and scores it. Coverage includes the tricky cases: two unrelated simultaneous faults,
a red herring, a fault that clears on its own, and a blocked zone with only one stuck robot.

**UI (`ui/`).** Live fleet map, incident list with Triage buttons, approval cards (Approve / Reject), a fault
injector for demos, and a CopilotKit chat sidebar that receives the live fleet state as context.

## Design decisions

- **Safety tiers enforced in code, not in the prompt.** Read tools always run; low-risk actions
  (`sendToCharger`, `reassignJob`) run immediately; high-risk actions (`resetRobot`, `setOutOfService`,
  `rerouteAround`) only ever create a proposal that an operator approves. The model can't bypass it. Unit tests
  cover the gate, and the evals check for violations twice: in the tool log and in the simulator's real state.
  CI fails on any violation.
- **An outside AI can propose, never approve.** The MCP server has no approve or reject tool. A high-risk
  call from an MCP client lands in the same queue as the built-in agent's, and only the operator in the
  dashboard can run it. A test asserts that no such tool exists.
- **Actions aren't self-reported.** What the agent did is read from the tool log, not from its own summary.
- **Structured workflow instead of free chat** for triage, so every run has the same shape and can be scored.
  Chat is still there for open-ended operator questions and shares the same tools and tiers.
- **Seeded scenarios** so a change in score comes from a change in the agent, not from luck.
- **A rule-based diagnoser** implements the same playbook without a model. CI runs it on every push for
  free, and it's the reference the LLM is measured against.
- **Local model.** Zero cost per run and no data leaves the machine, which matters on a factory floor.
  The model is one setting in `.env`.

## Run it

Prerequisites: Go 1.27+, Node 22+, and [Ollama](https://ollama.com) with `ollama pull qwen3:8b`.

```bash
npm install
cd fleet-sim && go run .        # simulator + GraphQL playground on :8080
npm run agent                   # agent API + CopilotKit runtime on :4000
npm run ui                      # dashboard on :5173

cd evals
npx tsx run.ts                          # v2, local model
npx tsx run.ts --variant baseline       # the "before" version
LLM_PROVIDER=mock npx tsx run.ts        # rule-based, no model (what CI runs)
```

Or `cp .env.example .env && docker compose up` (Ollama stays on the host so it can use the GPU).

**Use it from an MCP client.** With the simulator and agent running, the MCP endpoint is
`http://localhost:4000/mcp` (Streamable HTTP, localhost only):

```bash
claude mcp add --transport http fleet-ops http://localhost:4000/mcp   # Claude Code
npx @modelcontextprotocol/inspector                                   # or browse the tools by hand
```

The repo's `.mcp.json` already registers it for Claude Code sessions opened in this folder. Try "which robots
are stuck and why?" or "run triage". A full triage on the local model can take a minute or two.

**Demo:** in the dashboard, open *Fault injector* → `ZONE_BLOCKED` on `AISLE_3`, wait a few seconds, click
*Triage all*. The agent groups the stuck robots under one cause, proposes `rerouteAround(AISLE_3)` and
escalates. Approve it and watch the robots drive around the aisle.

## What I'd do next

- Kafka (or Redis Streams) fleet events instead of polling, so the agent reacts the moment a fault appears
- Kubernetes manifests and a local kind/k3d deployment
- GraphQL subscriptions for live UI updates
- Compare models in the eval report on accuracy vs. cost, and add an LLM-as-judge score for summary quality
- Integrate with a real MES / fleet manager API behind the same tool layer

A plain-English walkthrough of every part is in [`docs/LEARNING.md`](docs/LEARNING.md).
