import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin, Hooks } from '@opencode-ai/plugin'
import { gatewayGet, modelMetadata, selectProvider, type Gateway } from './gateway.js'
import { syncSkills, localSkillNames } from './skills.js'

/** V1 config hook enriches provider metadata in memory, without disk config edits. */
export const legacyFeatures: Plugin = async ({ directory }, options = {}) => {
  let gateway: Gateway | undefined
  const abort = new AbortController()
  let pending: Promise<unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let extraPaths: string[] = []
  const refreshSkills = () => {
    if (!gateway || pending || options.skills === false || abort.signal.aborted) return pending
    pending = (async () => {
      const result = await syncSkills(gateway!, { signal: abort.signal, existingNames: await localSkillNames(directory, extraPaths) })
      if (result.installed || result.updated) console.info('[fleet-notify] Skills synced; V1 may require reloading the project to discover changes.')
      if (result.conflicts.length || result.failed.length) console.warn(`[fleet-notify] Skills: ${result.conflicts.length} conflicts preserved; ${result.failed.length} sources unavailable.`)
    })().catch(() => { if (!abort.signal.aborted) console.warn('[fleet-notify] Skills could not refresh; existing files preserved.') }).finally(() => { pending = undefined })
    return pending
  }
  const hooks: Hooks = {
    config: async config => {
      const candidates = Object.entries(config.provider ?? {}).map(([id, p]) => ({ id, baseURL: p.options?.baseURL, apiKey: p.options?.apiKey }))
      const selected = selectProvider(candidates, options)
      if (!selected) return
      let apiKey = selected.apiKey
      try {
        const auth = JSON.parse(await readFile(join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'auth.json'), 'utf8'))
        if (auth[selected.id]?.type === 'api' && typeof auth[selected.id].key === 'string') apiKey = auth[selected.id].key
      } catch { /* Use this provider's configured key, never a different account. */ }
      if (typeof apiKey !== 'string' || !apiKey) return
      gateway = { providerID: selected.id, baseURL: selected.baseURL as string, apiKey }
      extraPaths = (config as typeof config & { skills?: { paths?: string[] } }).skills?.paths ?? []
      // V1 invokes provider.models before custom providers enter its database.
      // Enrich the in-memory config instead so custom LiteLLM providers work too.
      if (options.modelMetadata !== false) {
        try {
          const metadata = modelMetadata(await gatewayGet(gateway, 'model/info', abort.signal))
          const provider = config.provider![selected.id]
          const models = provider.models ??= {}
          for (const [alias, info] of metadata) {
            const targets = Object.entries(models).filter(([id, model]) => (model.id ?? id) === alias)
            if (!targets.length) targets.push([alias, models[alias] = {}])
            for (const [, model] of targets) {
              const cost = { ...model.cost }
              if (info.input !== undefined) cost.input = info.input
              if (info.output !== undefined) cost.output = info.output
              if (info.read !== undefined) cost.cache_read = info.read
              if (info.write !== undefined) cost.cache_write = info.write
              if (cost.input !== undefined && cost.output !== undefined) model.cost = cost as typeof model.cost
              const limit: { context?: number; input?: number; output?: number } = { ...model.limit }
              if (info.context !== undefined) { limit.context = info.context; limit.input = info.context }
              if (info.outputLimit !== undefined) limit.output = info.outputLimit
              if (limit.context !== undefined && limit.output !== undefined) model.limit = limit as typeof model.limit
            }
          }
        } catch { console.warn('[fleet-notify] Model metadata unavailable; existing values preserved.') }
      }
      // Avoid a recursive config/skills request while the config hook is executing.
      if (!timer) {
        const tick = async () => { await refreshSkills(); if (!abort.signal.aborted) { timer = setTimeout(tick, 300_000); timer.unref?.() } }
        timer = setTimeout(tick, 1000); timer.unref?.()
      }
    },
    event: async ({ event }) => { if (event.type === 'session.created') await refreshSkills() },
    dispose: async () => { abort.abort(); if (timer) clearTimeout(timer); await pending },
  }
  return hooks
}

export function withLegacyFeatures(notifications: Plugin): Plugin {
  return async (input, options) => {
    const features = await legacyFeatures(input, options)
    const original = await notifications(input, options)
    const combined: Hooks = {
      ...original,
      async config(config) { await original.config?.(config); await features.config?.(config) },
      async event(event) { await Promise.all([original.event?.(event), features.event?.(event)]) },
      async dispose() { await Promise.all([original.dispose?.(), features.dispose?.()]) },
    }
    return combined
  }
}
