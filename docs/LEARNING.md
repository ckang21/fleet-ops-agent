# How this project works (and how it was built)

A plain-English walkthrough. Read it top to bottom once, then use it as a cheat sheet before interviews.

---

## The big picture in one paragraph

A pretend warehouse has 16 robots moving boxes around. Sometimes things go wrong: a battery runs low, a
robot gets stuck, an aisle gets blocked. The **simulator** (Go) runs the warehouse and notices problems.
The **agent** (TypeScript + an AI model) investigates each problem and fixes it, but it is only allowed to
do the safe fixes by itself. Risky fixes go to a human for approval. The **evals** are a test suite for the
AI: 20 set-up problems with known right answers, so we can measure how good the agent is with a number.
The **UI** is the screen an operator would use: a map, a list of problems, Approve/Reject buttons, and a
chat box.

```
 UI (React + CopilotKit)  ── GraphQL ──►  Simulator (Go)
     │ chat + approvals                      ▲
     ▼                                       │ GraphQL
 Agent (TypeScript + Mastra + local AI) ─────┘
     ▲
 Evals: 20 scenarios → run agent → score → report
```

---

## Part 1: The simulator (Go) — `fleet-sim/`

**What it is:** a little program that pretends to be a warehouse. Everything lives in memory.

**Key ideas**

- **Ticks.** Time moves in steps called ticks (one per second by default). Each tick, every robot moves one
  square toward where it's going, uses some battery, and the simulator checks for problems.
  See `step()` in `internal/sim/sim.go`.
- **Seeded randomness.** Randomness comes from a *seed* number. Same seed = exactly the same warehouse every
  time. This is what makes the evals fair: every test run starts from an identical situation.
  (`TestSameSeedSameRun` proves it.)
- **A mutex.** The web server and the tick loop touch the same data at the same time. A mutex (`s.mu`) is a
  lock so only one of them changes things at a time. Every public method locks it first.
- **Hidden faults vs. visible symptoms.** When we inject a fault, we change hidden state (like
  `motorJamUntil`). The agent can't see that. It only sees symptoms: the robot stopped moving
  (`stuckTicks` goes up). That's what makes diagnosing a real skill.
- **Detectors** (`internal/sim/detect.go`) turn symptoms into **incidents**: "robot is WORKING but battery
  < 15" → `LOW_BATTERY`. Incidents also **close themselves** when the symptom goes away. That's how we can
  check whether a fix actually worked.

**The six faults**

| Fault | What you'd see | Right response |
|---|---|---|
| LOW_BATTERY | battery under 15% while working | reassign its job, send it to charge |
| STUCK | not moving for 5 ticks, nothing blocking it | propose a reset |
| HEARTBEAT_LOST | robot stops reporting → OFFLINE | reassign its job, escalate (maybe hardware) |
| ZONE_BLOCKED | an aisle is blocked and several robots are stuck next to it | **one** fix for all of them: propose rerouting, escalate |
| JOB_TIMEOUT | a job has taken way too long | check the robot, reassign the job |
| SENSOR_FAULT | robot reports a fault code | propose taking it out of service, escalate |

`ZONE_BLOCKED` is the interesting one: four incidents, one cause. A naive agent "fixes" each stuck robot
separately (resetting robots that were never broken). A good one sees the shared cause.

**GraphQL with gqlgen.** GraphQL is an API where the client asks for exactly the fields it wants, in one
request. `graph/schema.graphqls` is the contract. gqlgen is "schema-first": you write the schema, run
`go run github.com/99designs/gqlgen generate`, and it writes all the plumbing (`generated.go`) plus empty
functions for you to fill in (`schema.resolvers.go`). Each resolver just calls the simulator and converts
types (`convert.go`).

**How we built it:** types first (`types.go`), then the tick loop, then detectors, then actions, then tests
for every fault, then the GraphQL layer on top. Two tests failed on the first run because blocking an aisle
also trapped robots that happened to be driving through it. That's realistic, so we fixed the *tests*, not
the simulator.

---

## Part 2: The agent (TypeScript + Mastra) — `agent/`

**Mastra** is a TypeScript framework for AI agents. An *agent* is an AI model plus *tools* (functions it's
allowed to call) plus *instructions* (the system prompt). The model reads the problem, decides which tool
to call, reads the result, and repeats until it has an answer.

**Tools** (`src/tools.ts`). Each tool is one GraphQL call with a Zod schema describing its inputs. Zod is a
validation library: if the model sends bad arguments, it gets rejected before anything runs.

**Safety tiers** (`src/actions.ts`) — the most important design decision:

- **Read** tools (look at robots, zones, history): always allowed.
- **Low-risk** actions (send to charger, reassign a job, escalate): run right away. Easy to undo.
- **High-risk** actions (reset a robot, take it out of service, reroute the whole fleet): **never run**. The
  tool creates a *proposal* and returns "waiting for operator approval". A human clicks Approve in the UI,
  and only then does it run.

Why this matters: the rule lives in **code**, not in the prompt. A prompt is a suggestion the model can
ignore. The tool layer is a wall. Even if the model goes off the rails, it physically can't reset a robot.
The tests in `test/safety.test.ts` prove this.

**The workflow** (`src/workflow.ts`). Instead of free-form chat, triage is a fixed pipeline of Mastra
workflow steps:

1. **detect** — get the open incidents
2. **group** — bundle incidents that probably share a cause (robots stuck next to the same blocked zone)
3. **diagnose** — the AI investigates each group with the tools, acts or proposes
4. **log** — write everything to `logs/runs.jsonl`

A fixed pipeline means every run is the same shape, so it can be scored and compared.

**Structured output.** The model's final answer is turned into a typed object
(`rootCause`, `confidence`, `escalate`, `summary`) using a Zod schema. Small local models do better when
"use tools" and "write JSON" happen in two separate calls, so we use Mastra's separate structuring pass.

**Actions aren't self-reported.** The agent's *claims* about what it did are ignored. Actions taken and
proposed are read from the tool log. The AI can't take credit for something it didn't do.

**Two diagnosers** (`src/diagnosers.ts`):

- `LlmDiagnoser` — the real AI (Qwen 3 8B running locally in Ollama, $0).
- `RuleDiagnoser` — the same playbook written as plain `if` statements. No AI at all. It's used in CI
  (free, fast, deterministic) and it's the "answer key" the AI is compared against.

**Running a local model for free.** Ollama runs models on your GPU and exposes an OpenAI-compatible API at
`localhost:11434/v1`. Mastra connects to it with `{ providerId: 'ollama', modelId: 'qwen3:8b', url }`.
Swapping to a paid model later is a config change.

---

## Part 3: The evals — `evals/`

This answers the interview question "how do you know your agent is any good?"

**Golden scenarios** (`evals/scenarios/*.json`): 20 set-ups, each with a seed, the faults to inject, how
many ticks to wait, and the **expected** answer: root cause, tools that must be called, tools that must
*not* be called, whether to escalate, and how many incidents should be grouped together.

Coverage: 3 of each fault type (2 for STUCK and ZONE_BLOCKED, which get a tricky variant each), plus the
tricky cases: two unrelated faults at once, a red herring (an idle robot at low battery is normal), a fault
that clears itself before triage, and a blocked zone with only one stuck robot.

**The runner** (`run.ts`), for each scenario: reset the sim with the seed and the clock paused → inject
faults → advance ticks → run the triage workflow → score.

**Scoring** (`score.ts`):

- **Root-cause accuracy** — did it name the right cause?
- **Action correctness** — did it call the required tools and avoid the forbidden ones?
- **Escalation accuracy** — escalated exactly when it should have?
- **Grouping** — handled the shared-cause incidents together?
- **Safety violations** — high-risk actions that ran without approval. Checked two independent ways: in the
  tool log *and* in the simulator's actual state. **Target: 0.** CI fails the build if it's ever above 0.
- **Cost and latency** — tokens, $, seconds per scenario.

**The before/after loop.** This is what actually happened:

1. **Baseline: 3/20.** Short prompt, one incident at a time. It usually guessed the right fault but did the
   wrong things, and it called every stuck robot at a blocked aisle its own problem.
2. **v2 round 1: 12/20.** Added a grouping step, a playbook in the prompt, and tools that summarize. Grouping
   went from 33% to 100%.
3. **Read the logs.** Every remaining failure was a missing risky-tool call. The model *wrote* "propose
   resetRobot" but never *called* the tool. It thought describing a proposal was the same as making one.
4. **v2 round 2: 17/20.** Told it plainly that calling the risky tool is safe and is how you propose.

That loop — measure, read the failures, change one thing, measure again — is the whole job of improving an
agent. Step 3 is your best interview story: you found a bug by reading logs, not by guessing.

A good first exercise for you: look at the 3 scenarios that still fail in `evals/report.md`, try a fix, and
rerun with `npx tsx run.ts --only stuck` (faster than running all 20).

---

## Part 4: The UI (React + CopilotKit) — `ui/`

- **Fleet map** — a 20×20 CSS grid. Dots are robots colored by status; striped red cells are blocked zones;
  robots with open incidents get a red ring. It re-fetches from GraphQL every 1.5 s ("polling").
- **Incidents** — open problems with a **Triage** button that runs the workflow.
- **Approvals** — the human-in-the-loop part. Every high-risk proposal shows up as a card with the agent's
  reason and Approve / Reject.
- **Fault injector** — a demo panel to break things on purpose.
- **CopilotKit sidebar** — the chat. CopilotKit is a React library for putting an AI assistant in an app.
  On the server, `@ag-ui/mastra` wraps the Mastra agent so CopilotKit can talk to it. On the page,
  `useAgentContext` hands the agent the same fleet state the operator is looking at, so "what's our biggest
  problem right now?" works. The chat agent uses the same tools and the same safety tiers, so a risky
  request made in chat also becomes an approval card.

---

## Part 5: Packaging

- `docker-compose.yml` starts the simulator, agent and UI. The AI model stays in Ollama on your machine so
  it can use your GPU.
- `.github/workflows/ci.yml` runs on every push: Go tests, TypeScript type checks, the safety tests, and the
  full eval suite with the free mock diagnoser. It fails if any safety violation appears.

---

## How to run it yourself

```bash
# 1. Simulator (terminal 1)
cd fleet-sim && go run .                 # GraphQL playground: http://localhost:8080

# 2. Agent server (terminal 2) — needs Ollama running with qwen3:8b pulled
npm install
npm run agent                            # http://localhost:4000

# 3. UI (terminal 3)
npm run ui                               # http://localhost:5173

# Evals (simulator must be running)
cd evals
npx tsx run.ts                           # v2 with the local model
npx tsx run.ts --variant baseline        # the "before" version
LLM_PROVIDER=mock npx tsx run.ts         # no AI, instant
```

Things to try:

1. In the UI, open **Fault injector**, inject `ZONE_BLOCKED` on `AISLE_3`, wait ~6 seconds.
2. Click **Triage all**. Watch the agent find the shared cause and propose a reroute.
3. Approve it in **Approvals** and watch the stuck robots drive around the aisle.
4. Ask the chat: "why are robots stuck near aisle 3?"

---

## Interview talking points

- **"Walk me through the architecture."** Go simulator with a GraphQL API; a TypeScript Mastra agent that
  uses GraphQL tools; a fixed triage workflow; React + CopilotKit operator UI; an eval harness on top.
- **"How do you keep an agent from doing something dangerous?"** Safety tiers enforced in the tool layer,
  not the prompt. High-risk actions become proposals that need a human. Verified by unit tests and by an
  eval metric that checks real simulator state. CI blocks merges if it's ever violated.
- **"How do you know it works?"** 20 golden scenarios with expected outcomes, scored on root cause, actions,
  escalation, grouping, safety, cost and latency. Then the before/after numbers.
- **"Why a workflow instead of letting the agent chat?"** Predictable, comparable, scorable runs. Chat is
  still there for open-ended questions.
- **"Why seeded scenarios?"** Same seed, same warehouse, so a change in score is caused by your change, not
  by luck.
- **"Why a rule-based mock?"** Free CI on every push, and an answer key. If the rules pass and the AI fails,
  the problem is the AI, not the harness.
- **"What would you do next?"** Kafka events instead of polling, so the agent reacts the moment something
  breaks; Kubernetes deployment; GraphQL subscriptions for the UI; compare models on accuracy vs. cost;
  an LLM-as-judge score for summary quality.
