/** LiteLLM reads only: never infer a gateway URL from the notification path. */
export type Gateway = { providerID: string; baseURL: string; apiKey: string }
export type ProviderCandidate = { id: string; baseURL?: unknown; apiKey?: unknown }

export function gatewayURL(base: string, route: string): string {
  const url = new URL(base)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid gateway URL')
  // /api/v1 is a common completion base; management routes live at /api.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/' + route.replace(/^\/+/, '')
  return url.href
}

export function selectProvider(candidates: ProviderCandidate[], options: Record<string, unknown>): ProviderCandidate | undefined {
  const valid = candidates.filter(p => {
    try { return typeof p.baseURL === 'string' && !!gatewayURL(p.baseURL, 'model/info') } catch { return false }
  })
  if (typeof options.provider === 'string') return valid.find(p => p.id === options.provider)
  const named = valid.filter(p => p.id.toLowerCase() === 'litellm')
  if (named.length === 1) return named[0]
  if (typeof options.url === 'string') {
    try {
      const matches = valid.filter(p => new URL(p.baseURL as string).origin === new URL(options.url as string).origin)
      if (matches.length === 1) return matches[0]
    } catch { /* An invalid notification URL must not select an unrelated provider. */ }
  }
  return undefined // Other providers need explicit selection, even if there is only one.
}

export async function readBytes(response: Response, max: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > max) throw new Error('Response too large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty response')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > max) throw new Error('Response too large')
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export async function gatewayGet(gateway: Gateway, route: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(gatewayURL(gateway.baseURL, route), {
    headers: { Authorization: `Bearer ${gateway.apiKey}`, Accept: 'application/json' },
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  return JSON.parse(new TextDecoder().decode(await readBytes(response, 4 * 1024 * 1024)))
}

export type ModelMetadata = { input?: number; output?: number; read?: number; write?: number; context?: number; outputLimit?: number }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export function modelMetadata(value: unknown): Map<string, ModelMetadata> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) throw new Error('Invalid model catalog')
  const result = new Map<string, ModelMetadata>(); const duplicates = new Set<string>()
  for (const row of (value as { data: any[] }).data) {
    if (!row || typeof row.model_name !== 'string' || !row.model_info || typeof row.model_info !== 'object') continue
    const info = row.model_info; const metadata: ModelMetadata = {}
    for (const [source, target] of [['input_cost_per_token', 'input'], ['output_cost_per_token', 'output'], ['cache_read_input_token_cost', 'read'], ['cache_creation_input_token_cost', 'write']] as const) {
      if (finite(info[source]) && finite(info[source] * 1_000_000)) metadata[target] = info[source] * 1_000_000
    }
    if (Number.isSafeInteger(info.max_input_tokens) && info.max_input_tokens > 0) metadata.context = info.max_input_tokens
    if (Number.isSafeInteger(info.max_output_tokens) && info.max_output_tokens > 0) metadata.outputLimit = info.max_output_tokens
    if (result.has(row.model_name)) duplicates.add(row.model_name)
    result.set(row.model_name, metadata)
  }
  // Multiple deployments behind an alias may have different pricing/capacity.
  for (const name of duplicates) result.delete(name)
  return result
}

/** Patch only reported values; retain host/user values when LiteLLM says null. */
export function enrichModel(model: any, info: ModelMetadata, v2: boolean): void {
  if (info.context !== undefined) { model.limit.context = info.context; model.limit.input = info.context }
  if (info.outputLimit !== undefined) model.limit.output = info.outputLimit
  const baseline = v2 ? model.cost.find((c: any) => !c.tier) : model.cost
  // Do not flatten context-tier pricing into one incorrect price.
  if (v2 ? model.cost.some((c: any) => c.tier) : model.cost.tiers?.length || model.cost.experimentalOver200K) return
  if (v2 && !baseline && (info.input === undefined || info.output === undefined || info.read === undefined || info.write === undefined)) return
  const cost = baseline ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }
  if (info.input !== undefined) cost.input = info.input
  if (info.output !== undefined) cost.output = info.output
  if (info.read !== undefined) cost.cache.read = info.read
  if (info.write !== undefined) cost.cache.write = info.write
  if (v2 && !baseline) model.cost.push(cost)
}
