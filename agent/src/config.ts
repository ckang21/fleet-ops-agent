export const config = {
  graphqlUrl: process.env.FLEET_GRAPHQL_URL ?? 'http://localhost:8080/query',
  /** 'ollama' runs a local model; 'mock' is a deterministic rule-based diagnoser (no model at all). */
  provider: (process.env.LLM_PROVIDER ?? 'ollama') as 'ollama' | 'mock',
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434/v1',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:8b',
  /** USD per million tokens. A local model costs $0; set these to compare against a paid model. */
  pricePerMInput: Number(process.env.PRICE_PER_M_INPUT ?? 0),
  pricePerMOutput: Number(process.env.PRICE_PER_M_OUTPUT ?? 0),
  logDir: process.env.LOG_DIR ?? 'logs',
  port: Number(process.env.AGENT_PORT ?? 4000),
}

export function modelConfig() {
  return {
    providerId: 'ollama',
    modelId: config.ollamaModel,
    url: config.ollamaUrl,
    apiKey: 'ollama', // Ollama ignores the key, but the OpenAI-compatible client wants one
  } as const
}

export function modelName() {
  return config.provider === 'mock' ? 'mock-rules' : `ollama/${config.ollamaModel}`
}
