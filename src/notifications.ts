export type Notice = {
  id: string
  type: "notification"
  title: string
  body: string
  severity: "info" | "warning" | "critical"
  requires_ack: boolean
  link?: string
  expires_at?: string
}

export type State = {
  etags: Record<string, string>
  items: Notice[]
  delivered: string[]
  seen: string[]
  acked: string[]
  pendingAcks: string[]
}

export function notices(value: unknown): Notice[] {
  if (!Array.isArray(value)) throw new Error("Invalid feed items")
  return value.flatMap((item): Notice[] => {
    if (!item || typeof item !== "object" || item.type !== "notification") return []
    if (typeof item.id !== "string" || !item.id || typeof item.title !== "string" || typeof item.body !== "string") return []
    return [{ id: item.id, type: "notification", title: item.title, body: item.body,
      severity: item.severity === "critical" || item.severity === "warning" ? item.severity : "info",
      requires_ack: item.requires_ack === true,
      ...(typeof item.link === "string" ? { link: item.link } : {}),
      ...(typeof item.expires_at === "string" ? { expires_at: item.expires_at } : {}),
    }]
  })
}

export function restore(value: unknown): State {
  const raw = value && typeof value === "object" ? value as Partial<State> : {}
  const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  return {
    etags: Object.fromEntries(Object.entries(raw.etags ?? {}).filter(([, v]) => typeof v === "string")),
    items: notices(Array.isArray(raw.items) ? raw.items : []),
    delivered: strings(raw.delivered), seen: strings(raw.seen), acked: strings(raw.acked), pendingAcks: strings(raw.pendingAcks),
  }
}

export function active(item: Notice): boolean {
  return !item.expires_at || !Number.isFinite(Date.parse(item.expires_at)) || Date.parse(item.expires_at) > Date.now()
}

export function message(item: Notice): string {
  return `[Fleet notice: ${item.severity}] ${item.title}\n${item.body}${item.link ? `\n${item.link}` : ""}\nID: ${item.id}${item.requires_ack ? `\nAcknowledgment required. Run /fleet-ack ${item.id} after reading.` : ""}`
}

/** All mutations are serialized, including UI confirmations and background polls. */
export function createNotifications(options: {
  url: string
  apiKey: string
  state: State
  save: (state: State) => Promise<void>
  deliver: (notice: Notice) => Promise<boolean>
  fetch?: typeof fetch
}) {
  const state = options.state
  const request = options.fetch ?? fetch
  const controller = new AbortController()
  let tail: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run)
    tail = result.catch(() => {})
    return result
  }
  async function http(path: string, init: RequestInit = {}) {
    const abort = new AbortController()
    const stop = () => abort.abort()
    controller.signal.addEventListener("abort", stop, { once: true })
    if (controller.signal.aborted) abort.abort()
    const timer = setTimeout(stop, 10_000)
    try {
      const response = await request(`${options.url.replace(/\/+$/, "")}${path}`, {
        ...init, redirect: "error", signal: abort.signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, "X-Fleet-Client": "opencode-fleet-notify/0.5.0", ...init.headers },
      })
      // Keep the deadline active while reading the body, not only the headers.
      const body = await response.arrayBuffer()
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers })
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener("abort", stop)
    }
  }
  const visible = () => state.items.filter((n) => active(n) && !state.acked.includes(n.id))
  async function sendAck(id: string): Promise<boolean> {
    try {
      const res = await http(`/ack/${encodeURIComponent(id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ack" }),
      })
      if (!res.ok) return false
      if (!state.acked.includes(id)) state.acked.push(id)
      state.pendingAcks = state.pendingAcks.filter((x) => x !== id)
      await options.save(state)
      return true
    } catch { return false }
  }
  return {
    list: () => visible().map((item) => ({ ...item, seen: state.seen.includes(item.id) })),
    seen: (id: string) => serial(async () => {
      if (visible().some((n) => n.id === id) && !state.seen.includes(id)) state.seen.push(id)
      await options.save(state)
    }),
    acknowledge: (id: string) => serial(async () => {
      if (state.acked.includes(id)) return true
      if (!visible().some((n) => n.id === id)) return false
      if (!state.pendingAcks.includes(id)) state.pendingAcks.push(id)
      await options.save(state)
      return sendAck(id)
    }),
    poll: (full = false) => serial(async () => {
      if (controller.signal.aborted) return
      for (const id of [...state.pendingAcks]) await sendAck(id)
      const scope = full ? "full" : "notification"
      const res = await http(`/feed${full ? "" : "?types=notification"}`, {
        headers: state.etags[scope] ? { "If-None-Match": state.etags[scope] } : {},
      })
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`Fleet HTTP ${res.status}`)
        const envelope = await res.json() as { version?: unknown; items?: unknown; etag?: unknown }
        if (!envelope || envelope.version !== 1 || !Array.isArray(envelope.items)) throw new Error("Invalid fleet envelope")
        state.items = notices(envelope.items)
        delete state.etags[full ? "notification" : "full"]
        const etag = res.headers.get("etag") ?? (typeof envelope.etag === "string" ? envelope.etag : undefined)
        if (etag) state.etags[scope] = etag
        else delete state.etags[scope]
        // A full feed also contains the authoritative notification snapshot.
        // Never reuse its ETag for the filtered feed.
      }
      for (const item of visible().filter((n) => !state.delivered.includes(n.id)).slice(0, 5)) {
        try {
          if (await options.deliver(item)) state.delivered.push(item.id)
        } catch { /* Retry undelivered messages, including on a 304 response. */ }
      }
      await options.save(state)
    }),
    stop: () => controller.abort(),
  }
}
