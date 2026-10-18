// Observability: one record per triage run with every tool call, token counts, cost and latency.
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.ts'
import type { Tier, TriageResult } from './types.ts'

export interface ToolCallRecord {
  group: string
  tool: string
  tier: Tier
  args: unknown
  outcome: 'ok' | 'proposed' | 'error'
  result?: unknown
  error?: string
  ms: number
}

export class RunRecorder {
  readonly runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  readonly startedAt = Date.now()
  toolCalls: ToolCallRecord[] = []
  tokensIn = 0
  tokensOut = 0
  currentGroup = ''

  addUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined) {
    this.tokensIn += usage?.inputTokens ?? 0
    this.tokensOut += usage?.outputTokens ?? 0
  }

  costUsd() {
    return (this.tokensIn * config.pricePerMInput + this.tokensOut * config.pricePerMOutput) / 1_000_000
  }

  async write(input: unknown, result: TriageResult) {
    await mkdir(config.logDir, { recursive: true })
    const line = JSON.stringify({ ...result, input, toolCalls: this.toolCalls, at: new Date().toISOString() })
    await appendFile(path.join(config.logDir, 'runs.jsonl'), line + '\n')
  }
}
