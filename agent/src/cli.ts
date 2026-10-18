// Run one triage pass against the live simulator and print the result.
//   npm run triage -w agent              (v2, model from LLM_PROVIDER)
//   npm run triage -w agent -- baseline
import { runTriage } from './workflow.ts'
import type { Variant } from './tools.ts'

const variant = (process.argv[2] as Variant) ?? 'v2'
const { result } = await runTriage({ variant })
console.log(JSON.stringify(result, null, 2))
