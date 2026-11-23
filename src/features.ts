import type { Plugin } from '@opencode/plugin'
import { enrichModel, gatewayGet, modelMetadata, selectProvider, type Gateway, type ModelMetadata } from './gateway.js'
import { MCP_NAME, remoteMcpConfig, sameMcpConfig, type RemoteMcpConfig } from './mcp.js'
import { syncSkills } from './skills.js'
import { detectV2Capabilities, errorText, gitAvailable, health, type Feature } from './health.js'

/** Separate lifecycle: notification discovery/outages never disable LiteLLM features. */
export function startFeatures(ctx: Plugin.Context): () => Promise<void> {
  health.caps = detectV2Capabilities(ctx)
  const abort = new AbortController()
  let snapshot = new Map<string, ModelMetadata>()
  let providerID: string | undefined
  let dispose: (() => Promise<void>) | undefined
  let mcpSnapshot: RemoteMcpConfig | undefined
  let mcpDispose: (() => Promise<void>) | undefined
  let mcpCollision = false
  let pending: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const refresh = (refreshCatalog = true) => {
    if (pending || abort.signal.aborted) return pending ?? Promise.resolve()
    pending = (async () => {
      const options = ctx.options ?? {}
      const gate = (feature: Feature, off: boolean) => { if (off) health.set(feature, 'skipped:disabled by plugin option'); return off }
      const disabled = { modelMetadata: gate('modelMetadata', options.modelMetadata === false), skills: gate('skills', options.skills === false), mcp: gate('mcp', options.mcp === false) }
      const skipAll = (reason: string) => { for (const f of ['modelMetadata', 'skills', 'mcp'] as const) if (!disabled[f]) health.set(f, `skipped:${reason}`) }
      if (!health.caps['provider.list']) return skipAll('host lacks provider.list')
      const providers = (await ctx.provider.list()).data
      const selected = selectProvider(providers.map(p => ({ id: p.id, baseURL: p.settings?.baseURL, apiKey: p.settings?.apiKey })), options)
      if (!selected) return skipAll(typeof options.provider === 'string' ? `no provider matched options.provider "${options.provider}" with a valid baseURL` : 'no provider matched (need a provider named "litellm" or options.provider)')
      const provider = providers.find(p => p.id === selected.id)!
      let apiKey: unknown = selected.apiKey
      try {
        if (provider.integrationID && health.caps['integration.connection']) {
          const connection = await ctx.integration.connection.active(provider.integrationID)
          const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
          if (credential?.type === 'key') apiKey = credential.key
        }
      } catch (error) { return skipAll(`could not read key integration (${errorText(error)})`) }
      if (typeof apiKey !== 'string' || !apiKey) return skipAll(`no apiKey for provider "${selected.id}"`)
      health.addSecret(apiKey)
      const gateway: Gateway = { providerID: selected.id, baseURL: selected.baseURL as string, apiKey }
      await Promise.allSettled([
        (async () => {
          if (disabled.modelMetadata) return
          if (!health.caps['provider.transform']) return health.set('modelMetadata', 'skipped:host lacks provider.transform')
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
          } else if (health.caps['provider.reload']) await ctx.provider.reload()
          health.set('modelMetadata', 'ok')
        })().catch(error => { health.set('modelMetadata', `failed:${errorText(error)}`); throw error }),
        (async () => {
          if (disabled.skills) return
          if (!health.caps['skill.list']) return health.set('skills', 'skipped:host lacks skill.list')
          const existing = (await ctx.skill.list()).data
          const result = await syncSkills(gateway, { signal: abort.signal, existingNames: new Set(existing.map(s => s.id)) })
          if (!abort.signal.aborted && (result.installed || result.updated) && health.caps['skill.reload']) await ctx.skill.reload()
          if (result.conflicts.length || result.failed.length) console.warn(`[fleet-notify] Skills: ${result.conflicts.length} conflicts preserved; ${result.failed.length} sources unavailable.`)
          if (result.failed.length) health.set('skills', `failed:${result.failed.length} source(s) unavailable [${(result.reasons ?? []).join('; ')}]${await gitAvailable() ? '' : ' (git not found on PATH; Git skill sources need it)'}`, `${result.conflicts.length} conflicts preserved`)
          else health.set('skills', 'ok', `${result.conflicts.length} conflicts preserved`)
        })().catch(error => { health.set('skills', `failed:${errorText(error)}`); throw error }),
        (async () => {
          if (disabled.mcp) return
          if (!health.caps['mcp.transform']) return health.set('mcp', 'skipped:host lacks mcp.transform')
          const next = remoteMcpConfig(gateway, true)
          if (!mcpDispose) {
            mcpSnapshot = next
            const registration = await ctx.mcp.transform(editor => {
              if (editor.get(MCP_NAME)) {
                if (!mcpCollision) console.warn(`[fleet-notify] MCP: preserved developer-owned ${MCP_NAME} entry.`)
                mcpCollision = true
                health.set('mcp', 'skipped:developer-owned fleet-litellm entry preserved')
                return
              }
              mcpCollision = false
              if (mcpSnapshot) { editor.set(MCP_NAME, mcpSnapshot); health.set('mcp', 'ok') }
            })
            if (abort.signal.aborted) { await registration.dispose(); return }
            mcpDispose = () => registration.dispose()
          } else {
            const changed = !sameMcpConfig(mcpSnapshot, next)
            if (!refreshCatalog && !changed) return
            mcpSnapshot = changed ? next : { ...next, disabled: true }
            if (!health.caps['mcp.reload']) return
            await ctx.mcp.reload()
            if (!changed && !abort.signal.aborted) {
              mcpSnapshot = next
              await ctx.mcp.reload()
            }
          }
        })().catch(error => { health.set('mcp', `failed:${errorText(error)}`); throw error }),
      ]).then(results => {
        for (const result of results) if (result.status === 'rejected' && !abort.signal.aborted) console.warn('[fleet-notify] A LiteLLM feature could not refresh; existing data preserved.')
      })
    })().catch(error => { health.log('warn', `refresh failed: ${errorText(error)}`) /* Registries can be unavailable during host setup. */ }).finally(() => { pending = undefined })
    return pending
  }
  void refresh(false)
  // Startup retries do not reconnect MCP; sessions and the interval refresh its catalog.
  let startupRetries = 5
  const schedule = () => { retry = setTimeout(async () => { await refresh(startupRetries <= 0); if (!abort.signal.aborted) schedule() }, startupRetries-- > 0 ? 1000 : 300_000); retry.unref?.() }
  schedule()
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
      if (event.type === 'session.created' && !event.data.parentID && event.data.location.directory === ctx.location.directory) await refresh()
    }
  })().catch(() => {})
  return async () => { abort.abort(); if (retry) clearTimeout(retry); await pending; await events; await dispose?.(); await mcpDispose?.() }
}
