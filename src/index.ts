import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// keep in sync with package.json
const VERSION = "0.2.0"
const SERVICE = "fleet-notify"
const POLL_INTERVAL_MS = 90_000
const POLL_JITTER = 0.2
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 15 * 60_000
const MAX_TOASTS_PER_POLL = 5
const AUTO_ACK_AFTER_SHOWS = 3
const STATE_DIR = join(homedir(), ".local", "state", "opencode-fleet-notify")
const STATE_FILE = join(STATE_DIR, "state.json")
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

const INFO_DURATION_MS = 5_000
const WARNING_DURATION_MS = 30_000
const CRITICAL_DURATION_MS = 60_000

type Severity = "info" | "warning" | "critical"

type FeedItem = {
  id?: unknown
  type?: unknown
  severity?: unknown
  title?: unknown
  body?: unknown
  link?: unknown
  requires_ack?: unknown
  expires_at?: unknown
}

type FeedEnvelope = {
  version?: unknown
  etag?: unknown
  items?: unknown
}

type State = {
  lastEtag: string | null
  ackedIds: string[]
  notifiedIds: string[]
  showCounts: Record<string, number>
  /** Snapshots of unacked requires_ack items, re-toasted every poll (even on 304). */
  ackItems: Record<string, { title: string; body: string; severity: string }>
}

function emptyState(): State {
  return { lastEtag: null, ackedIds: [], notifiedIds: [], showCounts: {}, ackItems: {} }
}

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_FILE, "utf8")
    const parsed = JSON.parse(raw) as Partial<State>
    return {
      lastEtag: typeof parsed.lastEtag === "string" ? parsed.lastEtag : null,
      ackedIds: Array.isArray(parsed.ackedIds) ? parsed.ackedIds.filter((x) => typeof x === "string") : [],
      notifiedIds: Array.isArray(parsed.notifiedIds) ? parsed.notifiedIds.filter((x) => typeof x === "string") : [],
      showCounts:
        parsed.showCounts && typeof parsed.showCounts === "object"
          ? Object.fromEntries(
              Object.entries(parsed.showCounts).filter(([, v]) => typeof v === "number"),
            )
          : {},
      ackItems:
        parsed.ackItems && typeof parsed.ackItems === "object"
          ? Object.fromEntries(
              Object.entries(parsed.ackItems).filter(
                ([, v]) => v && typeof v === "object" && typeof (v as { title?: unknown }).title === "string",
              ),
            )
          : {},
    }
  } catch {
    return emptyState()
  }
}

async function saveState(state: State): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8")
  } catch {
    // state persistence is best-effort; never throw
  }
}

const GLOBAL_CONFIG = join(homedir(), ".opencode", "opencode.json")
const CONFIG_FILE = join(homedir(), ".config", "opencode", "fleet-notify.json")

/** First provider entry's apiKey and baseURL from a config file
 * (provider.*.options.apiKey/baseURL or provider.*.apiKey/baseURL).
 * Returns {} when the file is missing/unreadable. */
async function providerFromConfig(path: string): Promise<{ apiKey?: string; baseURL?: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    const providers = parsed.provider
    if (!providers || typeof providers !== "object") return {}
    for (const entry of Object.values(providers as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const options = e.options as Record<string, unknown> | undefined
      const apiKey = options?.apiKey ?? e.apiKey
      const baseURL = options?.baseURL ?? e.baseURL
      if (typeof apiKey === "string" && apiKey.length > 0) {
        return {
          apiKey,
          baseURL: typeof baseURL === "string" && baseURL.length > 0 ? baseURL : undefined,
        }
      }
    }
  } catch {
    // missing or unreadable config — not an error
  }
  return {}
}

/** The gateway origin a provider baseURL points at (e.g.
 * "https://gateway.example.com/api" → "https://gateway.example.com"). */
function originOf(baseURL: string | undefined): string | null {
  if (!baseURL) return null
  try {
    return new URL(baseURL).origin
  } catch {
    return null
  }
}

/**
 * Resolve the gateway API key.
 * Precedence: (1) ~/.local/share/opencode/auth.json entries,
 * (2) provider apiKey in project opencode.json, (3) in global
 * ~/.opencode/opencode.json, (4) FLEET_NOTIFY_API_KEY env var.
 */
async function resolveApiKey(): Promise<string | null> {
  try {
    const raw = await readFile(AUTH_FILE, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const value of Object.values(parsed)) {
      if (value && typeof value === "object") {
        const entry = value as Record<string, unknown>
        const candidate = entry.key ?? entry.token ?? entry.access ?? entry.apiKey
        if (typeof candidate === "string" && candidate.length > 0) return candidate
      } else if (typeof value === "string" && value.length > 0) {
        return value
      }
    }
  } catch {
    // no auth file or unreadable — fall through
  }
  const projectKey = await providerFromConfig(join(process.cwd(), "opencode.json"))
  if (projectKey.apiKey) return projectKey.apiKey
  const globalKey = await providerFromConfig(GLOBAL_CONFIG)
  if (globalKey.apiKey) return globalKey.apiKey
  const env = process.env.FLEET_NOTIFY_API_KEY
  if (typeof env === "string" && env.length > 0) return env
  return null
}

/**
 * Resolve the fleet server URL.
 * Precedence: (1) FLEET_NOTIFY_URL env var,
 * (2) ~/.config/opencode/fleet-notify.json {"url": ...},
 * (3) auto-discovery: {origin of the provider baseURL}/.well-known/fleet-notify
 *     → {"feed_url": ...}. Returns { url, source } or null.
 */
async function resolveFleetUrl(): Promise<{ url: string; source: string } | null> {
  const envUrl = process.env.FLEET_NOTIFY_URL
  if (typeof envUrl === "string" && envUrl.length > 0) return { url: envUrl, source: "env" }

  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Record<string, unknown>
    if (typeof parsed.url === "string" && parsed.url.length > 0) {
      return { url: parsed.url, source: "file" }
    }
  } catch {
    // no plugin config file — try discovery
  }

  const project = await providerFromConfig(join(process.cwd(), "opencode.json"))
  const global = await providerFromConfig(GLOBAL_CONFIG)
  const origin = originOf(project.baseURL) ?? originOf(global.baseURL)
  if (origin) {
    try {
      const res = await fetch(`${origin}/.well-known/fleet-notify`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const doc = (await res.json()) as Record<string, unknown>
        if (typeof doc.feed_url === "string" && doc.feed_url.length > 0) {
          return { url: doc.feed_url, source: "discovery" }
        }
      }
    } catch {
      // discovery failed — fall through
    }
  }
  return null
}

function isExpired(item: FeedItem): boolean {
  if (typeof item.expires_at !== "string") return false
  const t = Date.parse(item.expires_at)
  if (Number.isNaN(t)) return false
  return t <= Date.now()
}

function toastParams(item: FeedItem): { variant: "info" | "warning" | "error"; duration: number } {
  switch (item.severity) {
    case "critical":
      return { variant: "error", duration: CRITICAL_DURATION_MS }
    case "warning":
      return { variant: "warning", duration: WARNING_DURATION_MS }
    default:
      return { variant: "info", duration: INFO_DURATION_MS }
  }
}

function nextDelay(failures: number): number {
  if (failures <= 0) {
    const jitter = 1 + (Math.random() * 2 - 1) * POLL_JITTER
    return POLL_INTERVAL_MS * jitter
  }
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS)
  return backoff * (1 + (Math.random() * 2 - 1) * POLL_JITTER)
}

export const FleetNotify: Plugin = async ({ client }) => {
  const log = async (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: SERVICE, level, message, extra } })
    } catch {
      // logging must never throw
    }
  }

  const resolved = await resolveFleetUrl()
  if (!resolved) {
    await log(
      "debug",
      `disabled: no fleet server found (set FLEET_NOTIFY_URL, create ${CONFIG_FILE}, or serve /.well-known/fleet-notify on the gateway origin)`,
    )
    return {}
  }
  const url = resolved.url
  await log("info", `fleet-notify ${VERSION}: server from ${resolved.source}`)
  const base = url.replace(/\/+$/, "")

  const apiKey = await resolveApiKey()
  if (!apiKey) {
    await log("debug", "disabled: no API key found in auth.json, opencode.json providers, or FLEET_NOTIFY_API_KEY")
    return {}
  }

  const state = await loadState()
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const toast = async (title: string | undefined, message: string, variant: "info" | "warning" | "error", duration: number) => {
    try {
      await client.tui.showToast({ body: { title, message, variant, duration } })
    } catch (err) {
      await log("debug", "showToast failed", { error: String(err) })
    }
  }

  const ackItem = async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}/ack/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Fleet-Client": `opencode-fleet-notify/${VERSION}`,
        },
        body: JSON.stringify({ action: "ack" }),
      })
      // idempotent: treat 2xx and 404 as acked
      if (res.ok || res.status === 404) {
        if (!state.ackedIds.includes(id)) state.ackedIds.push(id)
        delete state.ackItems[id]
        await saveState(state)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  const handleItems = async (items: FeedItem[]) => {
    const now = Date.now()
    const fresh = items.filter((item) => {
      if (item.type !== "notification") return false // forward-compat: ignore unknown types
      if (typeof item.id !== "string" || item.id.length === 0) return false
      if (state.ackedIds.includes(item.id)) return false
      if (isExpired(item)) return false
      return true
    })

    const toShow = fresh.filter((item) => {
      const id = item.id as string
      if (item.requires_ack === true) return true // re-toast until acked
      return !state.notifiedIds.includes(id)
    })

    const capped = toShow.slice(0, MAX_TOASTS_PER_POLL)
    const overflow = toShow.length - capped.length

    for (const item of capped) {
      const id = item.id as string
      const title = typeof item.title === "string" ? item.title : "Fleet notice"
      const body = typeof item.body === "string" ? item.body : ""
      const link = typeof item.link === "string" && item.link ? `\n${item.link}` : ""
      const { variant, duration } = toastParams(item)
      await toast(title, body + link, variant, duration)

      state.showCounts[id] = (state.showCounts[id] ?? 0) + 1
      if (!state.notifiedIds.includes(id)) state.notifiedIds.push(id)
      if (item.requires_ack === true) {
        state.ackItems[id] = {
          title,
          body: body + link,
          severity: typeof item.severity === "string" ? item.severity : "critical",
        }
        await maybeAutoAck(id)
      }
      void now
    }

    if (overflow > 0) {
      await toast("Fleet notices", `+${overflow} more notice${overflow === 1 ? "" : "s"}`, "info", INFO_DURATION_MS)
    }

    await saveState(state)
  }

  /** Auto-ack once an ack-required item has been shown enough times. */
  const maybeAutoAck = async (id: string) => {
    if ((state.showCounts[id] ?? 0) >= AUTO_ACK_AFTER_SHOWS) {
      const ok = await ackItem(id)
      await log("debug", ok ? `auto-acked ${id} after ${AUTO_ACK_AFTER_SHOWS} shows` : `auto-ack failed for ${id}`)
    }
  }

  /** Re-toast unacked ack-required items — runs even when the feed is
   * unchanged (304), which is exactly when nagging matters most. */
  const reNag = async () => {
    for (const [id, item] of Object.entries(state.ackItems)) {
      if (state.ackedIds.includes(id)) {
        delete state.ackItems[id]
        continue
      }
      const { variant, duration } = toastParams({ severity: item.severity })
      await toast(item.title, item.body, variant, duration)
      state.showCounts[id] = (state.showCounts[id] ?? 0) + 1
      await maybeAutoAck(id)
    }
    await saveState(state)
  }

  const poll = async (initial: boolean) => {
    if (stopped) return
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "X-Fleet-Client": `opencode-fleet-notify/${VERSION}`,
      }
      if (state.lastEtag) headers["If-None-Match"] = state.lastEtag
      const query = initial ? "" : "?types=notification"
      const res = await fetch(`${base}/feed${query}`, { headers })

      if (res.status === 304) {
        failures = 0
        await reNag()
      } else if (res.ok) {
        failures = 0
        const envelope = (await res.json()) as FeedEnvelope
        const etag = typeof envelope.etag === "string" ? envelope.etag : res.headers.get("etag")
        if (etag && etag !== state.lastEtag) {
          state.lastEtag = etag
        }
        const items = Array.isArray(envelope.items) ? (envelope.items as FeedItem[]) : []
        await handleItems(items)
      } else if (res.status >= 500) {
        failures += 1
        await log("debug", `poll failed: HTTP ${res.status}`, { failures })
      } else {
        // 4xx: likely auth/config problem — back off too, but keep quiet
        failures += 1
        await log("debug", `poll failed: HTTP ${res.status}`, { failures })
      }
    } catch (err) {
      failures += 1
      await log("debug", "poll failed", { error: String(err), failures })
    }
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(async () => {
      await poll(false)
      schedule()
    }, nextDelay(failures))
    if (typeof timer === "object" && timer && "unref" in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  }

  await log("info", `fleet-notify ${VERSION} active, polling ${base}`)

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          await poll(true)
          if (!timer) schedule()
        }
      } catch {
        // never throw from hooks
      }
    },
    tool: {
      fleet_ack: tool({
        description: "Acknowledge a fleet notification by id so it stops re-appearing",
        args: {
          id: tool.schema.string().describe("The notification id to acknowledge"),
        },
        async execute(args) {
          const ok = await ackItem(args.id)
          return ok ? `Acknowledged ${args.id}` : `Failed to acknowledge ${args.id}`
        },
      }),
    },
    dispose: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

export default FleetNotify
