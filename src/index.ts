import { createHash } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { FleetNotify } from "./legacy.js"
import { resolveConfig } from "./config.js"
import { createNotifications, message, restore } from "./notifications.js"
import { Fleet } from "./rpc.js"
import { startFeatures } from "./features.js"
import { withLegacyFeatures } from "./legacy-features.js"

const definition = Plugin.define({
  id: "opencode-fleet-notify",
  setup(ctx) {
    const stopFeatures = startFeatures(ctx)
    const controller = new AbortController()
    let stop: (() => void) | undefined
    const disposers: Array<() => Promise<void>> = []
    // Discovery and network work must not hold up OpenCode startup.
    const ready = (async () => {
      let config: Awaited<ReturnType<typeof resolveConfig>>
      let discoveryAttempts = 0
      // Provider transforms may finish after our setup. Keep discovery retryable.
      while (!controller.signal.aborted) {
        try { config = await resolveConfig(ctx) } catch { /* Retry unavailable registries/discovery. */ }
        if (config) break
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve() }
          const timer = setTimeout(done, Math.min(3000 * 2 ** discoveryAttempts++, 60_000))
          timer.unref?.()
          controller.signal.addEventListener("abort", done, { once: true })
          if (controller.signal.aborted) done()
        })
      }
      if (!config || controller.signal.aborted) return
      const key = `notifications-v2-${createHash("sha256").update(`${ctx.location.directory}\0${config.url}\0${config.apiKey}`).digest("hex")}`
      const state = restore(await ctx.storage.get(key))
      let sessionID: string | undefined
      const engine = createNotifications({
        ...config, state,
        save: (value) => ctx.storage.set(key, value),
        deliver: async (notice) => {
          // In 2.1.1 this queues input; it does not immediately render a message.
          if (ctx.options.sessionMessages !== true) return false
          if (!sessionID) {
            const sessions = await ctx.session.list({ directory: ctx.location.directory, limit: 20 })
            sessionID = sessions.data.filter((s) => !s.parentID && !s.time.archived)
              .sort((a, b) => b.time.updated - a.time.updated)[0]?.id
          }
          if (!sessionID) return false
          try {
            await ctx.session.synthetic({ sessionID, text: message(notice), resume: false, metadata: { fleetNoticeID: notice.id } })
            return true
          } catch {
            sessionID = undefined
            return false
          }
        },
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      let failures = 0
      let polling: Promise<void> | undefined
      const poll = (full: boolean) => {
        if (controller.signal.aborted) return Promise.resolve()
        if (polling) return polling
        polling = engine.poll(full).then(() => { failures = 0 }, () => { failures += 1 }).finally(() => { polling = undefined })
        return polling
      }
      const schedule = () => {
        if (controller.signal.aborted) return
        const delay = (failures ? Math.min(30_000 * 2 ** (failures - 1), 900_000) : 90_000) * (0.8 + Math.random() * 0.4)
        timer = setTimeout(async () => { await poll(false); schedule() }, delay)
        timer.unref?.()
      }
      const rpc = await ctx.rpc.register(Fleet, {
        list: async () => engine.list(),
        seen: async (input) => { await engine.seen((input as { id: string }).id); return null },
        acknowledge: async (input) => ({ ok: await engine.acknowledge((input as { id: string }).id) }),
      })
      disposers.push(() => rpc.dispose())
      const command = await ctx.command.transform((editor) => {
        editor.add({
          name: "fleet-ack", description: "Acknowledge a fleet notice you have read: /fleet-ack <id>",
          execute: async ({ sessionID: sid, prompt }) => {
            const id = prompt.text.trim()
            const ok = !!id && await engine.acknowledge(id)
            await ctx.session.synthetic({ sessionID: sid, resume: false,
              text: ok ? `Fleet notice ${id} acknowledged.` : "Acknowledgment not confirmed. Use /fleet-ack <id> from a current notice; delivery failures will retry." })
          },
        })
      })
      disposers.push(() => command.dispose())
      stop = () => {
        if (timer) clearTimeout(timer)
        engine.stop()
        for (const dispose of disposers.splice(0)) void dispose().catch(() => {})
      }
      if (controller.signal.aborted) { stop(); return }
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.created" || event.data.parentID || event.data.location.directory !== ctx.location.directory) continue
          sessionID = event.data.sessionID
          await poll(true)
        }
      })().catch(() => {})
      await poll(true)
      schedule()
    })().catch((error) => {
      controller.abort()
      stop?.()
      for (const dispose of disposers.splice(0)) void dispose().catch(() => {})
      console.warn(`[fleet-notify] setup failed: ${error instanceof Error ? error.name : "unknown error"}`)
    })
    return async () => {
      await stopFeatures()
      controller.abort()
      stop?.()
      await ready
    }
  },
})

// Official compatibility shape: V1 >=1.18.29 calls server(), V2 calls setup().
export default { ...definition, server: withLegacyFeatures(FleetNotify) }
