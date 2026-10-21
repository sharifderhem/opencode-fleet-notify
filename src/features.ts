import type { Plugin } from '@opencode/plugin'
import { enrichModel, gatewayGet, modelMetadata, selectProvider, type Gateway, type ModelMetadata } from './gateway.js'
import { syncSkills } from './skills.js'

/** Separate lifecycle: notification discovery/outages never disable LiteLLM features. */
export function startFeatures(ctx: Plugin.Context): () => Promise<void> {
  const abort = new AbortController()
  let snapshot = new Map<string, ModelMetadata>()
  let providerID: string | undefined
  let dispose: (() => Promise<void>) | undefined
  let pending: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    if (pending || abort.signal.aborted) return pending ?? Promise.resolve()
    pending = (async () => {
      const providers = (await ctx.provider.list()).data
      const selected = selectProvider(providers.map(p => ({ id: p.id, baseURL: p.settings?.baseURL, apiKey: p.settings?.apiKey })), ctx.options)
      if (!selected) return
      const provider = providers.find(p => p.id === selected.id)!
      let apiKey: unknown = selected.apiKey
      if (provider.integrationID) {
        const connection = await ctx.integration.connection.active(provider.integrationID)
        const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
        if (credential?.type === 'key') apiKey = credential.key
      }
      if (typeof apiKey !== 'string' || !apiKey) return
      const gateway: Gateway = { providerID: selected.id, baseURL: selected.baseURL as string, apiKey }
      await Promise.allSettled([
        (async () => {
          if (ctx.options.modelMetadata === false) return
          const next = modelMetadata(await gatewayGet(gateway, 'model/info', abort.signal))
          if (abort.signal.aborted) return
          providerID = selected.id; snapshot = next
          if (!dispose) {
            const registration = await ctx.provider.transform(editor => {
              if (!providerID) return
              const current = editor.get(providerID)
              if (!current) return
              for (const [id, model] of current.models) {
                const metadata = snapshot.get(model.modelID) ?? snapshot.get(id)
                if (metadata) editor.models.update(providerID, id, draft => enrichModel(draft, metadata, true))
              }
            })
            dispose = () => registration.dispose()
          } else await ctx.provider.reload()
        })(),
        (async () => {
          if (ctx.options.skills === false) return
          const existing = (await ctx.skill.list()).data
          const result = await syncSkills(gateway, { signal: abort.signal, existingNames: new Set(existing.map(s => s.id)) })
          if (!abort.signal.aborted && (result.installed || result.updated)) await ctx.skill.reload()
          if (result.conflicts.length || result.failed.length) console.warn(`[fleet-notify] Skills: ${result.conflicts.length} conflicts preserved; ${result.failed.length} sources unavailable.`)
        })(),
      ]).then(results => {
        for (const result of results) if (result.status === 'rejected' && !abort.signal.aborted) console.warn('[fleet-notify] A LiteLLM feature could not refresh; existing data preserved.')
      })
    })().catch(() => { /* Registries can be unavailable during host setup. */ }).finally(() => { pending = undefined })
    return pending
  }
  void refresh()
  // Retry startup races/network failures. Sources with revisions avoid repeated downloads.
  let startupRetries = 5
  const schedule = () => { retry = setTimeout(async () => { await refresh(); if (!abort.signal.aborted) schedule() }, startupRetries-- > 0 ? 1000 : 300_000); retry.unref?.() }
  schedule()
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      if (event.type === 'session.created' && !event.data.parentID && event.data.location.directory === ctx.location.directory) await refresh()
    }
  })().catch(() => {})
  return async () => { abort.abort(); if (retry) clearTimeout(retry); await pending; await events; await dispose?.() }
}
