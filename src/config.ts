import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

function origin(value: unknown): string | undefined {
  try {
    const url = new URL(String(value))
    return ["https:", "http:"].includes(url.protocol) ? url.origin : undefined
  } catch { return undefined }
}

export async function resolveConfig(ctx: Plugin.Context): Promise<{ url: string; apiKey: string } | undefined> {
  let url = ctx.options.url ?? process.env.FLEET_NOTIFY_URL
  if (!url) {
    try {
      const config = JSON.parse(await readFile(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "fleet-notify.json"), "utf8"))
      url = config.url
    } catch { /* Optional fallback configuration. */ }
  }
  if (typeof url === "string" && origin(url) && process.env.FLEET_NOTIFY_API_KEY) {
    return { url: url.replace(/\/+$/, ""), apiKey: process.env.FLEET_NOTIFY_API_KEY }
  }
  const providers = (await ctx.provider.list()).data
  let candidates = providers.filter((p) => origin(p.settings?.baseURL))
  if (typeof ctx.options.provider === "string") candidates = candidates.filter((p) => p.id === ctx.options.provider)
  let selected: typeof candidates[number] | undefined
  if (!url) {
    for (const provider of candidates) {
      try {
        const response = await fetch(`${origin(provider.settings?.baseURL)}/.well-known/fleet-notify`, {
          signal: AbortSignal.timeout(5000), redirect: "error",
        })
        if (!response.ok) continue
        const doc = await response.json() as { feed_url?: unknown }
        if (!doc || typeof doc !== "object") continue
        if (typeof doc.feed_url !== "string" || !origin(doc.feed_url)) continue
        // Cross-origin discovery must not forward a provider's credential.
        // A separately hosted feed requires explicit url + provider options.
        if (origin(doc.feed_url) !== origin(provider.settings?.baseURL)) continue
        url = doc.feed_url
        selected = provider
        break
      } catch { /* Try the next configured gateway. */ }
    }
  } else {
    const matches = candidates.filter((p) => origin(p.settings?.baseURL) === origin(url))
    selected = typeof ctx.options.provider === "string" && candidates.length === 1
      ? candidates[0] : matches.length === 1 ? matches[0] : undefined
  }
  if (typeof url !== "string" || !origin(url)) return undefined
  let apiKey = process.env.FLEET_NOTIFY_API_KEY
  if (!apiKey && selected) {
    if (selected.integrationID) {
      const connection = await ctx.integration.connection.active(selected.integrationID)
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (credential?.type === "key") apiKey = credential.key
    }
    if (!apiKey && typeof selected.settings?.apiKey === "string") apiKey = selected.settings.apiKey
  }
  return apiKey ? { url: url.replace(/\/+$/, ""), apiKey } : undefined
}
