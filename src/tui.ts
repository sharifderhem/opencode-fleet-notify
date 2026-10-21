import { Plugin } from "@opencode/plugin/tui"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Fleet } from "./rpc.js"
import { active, notices, type Notice } from "./notifications.js"

const definition = Plugin.define({
  id: "opencode-fleet-notify",
  setup(ctx) {
    const fleet = ctx.client.rpc(Fleet)
    const controller = new AbortController()
    const options = () => ({ location: ctx.location ?? ctx.data.location.default(), signal: controller.signal })
    const lastShown = new Map<string, number>()
    let busy = false
    let ownedDialog = false
    const show = async (notice: Notice) => {
      ownedDialog = true
      try {
        if (notice.requires_ack) {
          const confirmed = await ctx.ui.dialog.confirm({ title: notice.title, message: `${notice.body}${notice.link ? `\n${notice.link}` : ""}`,
            label: { confirm: "Acknowledge", cancel: "Later" } })
          if (confirmed === true && !controller.signal.aborted) {
            const result = await fleet.acknowledge({ id: notice.id }, options()) as { ok: boolean }
            ctx.ui.toast.show({ message: result.ok ? "Acknowledgment received." : "Acknowledgment pending; will retry.", variant: result.ok ? "success" : "warning" })
          }
        } else {
          await ctx.ui.dialog.alert({ title: notice.title, message: `${notice.body}${notice.link ? `\n${notice.link}` : ""}` })
        }
        if (!controller.signal.aborted) await fleet.seen({ id: notice.id }, options())
      } finally { ownedDialog = false }
    }
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "fleet-notify.inbox", title: "Fleet notices", group: "Fleet",
        palette: true, slash: { name: "fleet-notices" },
        run: async () => {
          if (busy || controller.signal.aborted) return
          busy = true
          ownedDialog = true
          try {
            const items = notices(await fleet.list(null, options())).filter(active)
            if (!items.length) {
              await ctx.ui.dialog.alert({ title: "Fleet notices", message: "No active fleet notices." })
              return
            }
            const id = await ctx.ui.dialog.select({ title: "Fleet notices", options: items.map((item) => ({
              title: item.title, value: item.id,
              description: `${item.severity}${item.requires_ack ? " — acknowledgment required" : ""}`,
            })) })
            const item = items.find((item) => item.id === id)
            if (item && !controller.signal.aborted) await show(item)
          } catch {
            if (!controller.signal.aborted) ctx.ui.toast.show({ message: "Fleet notices are temporarily unavailable. Try again shortly.", variant: "warning" })
          } finally { busy = false; ownedDialog = false }
        },
      }],
    }))
    const tick = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try {
        const raw = await fleet.list(null, options())
        const seen = new Set(Array.isArray(raw) ? raw.filter((x) => x?.seen === true).map((x) => x.id) : [])
        const pending = notices(raw).filter((n) => active(n) && (n.requires_ack || !seen.has(n.id)))
          .filter((n) => !lastShown.has(n.id) || (n.requires_ack && Date.now() - lastShown.get(n.id)! >= 90_000))
        pending.sort((a, b) => Number(lastShown.has(a.id)) - Number(lastShown.has(b.id)))
        for (const item of pending.slice(0, 5)) {
          if (controller.signal.aborted) break
          lastShown.set(item.id, Date.now())
          try { await show(item) } catch { lastShown.delete(item.id); break }
        }
        if (pending.length > 5) ctx.ui.toast.show({ message: `+${pending.length - 5} more fleet notices. Use /fleet-notices to view all.`, duration: 10_000 })
      } catch { /* Server may still be initializing, disconnected, or disabled. */ }
      finally { busy = false }
    }
    const timer = setInterval(() => void tick(), 4000)
    timer.unref?.()
    void tick()
    return () => {
      controller.abort()
      clearInterval(timer)
      if (ownedDialog) ctx.ui.dialog.clear()
    }
  },
})

// Load the V1 UI only when a V1 host invokes it. V2 does not use Solid.
const tui: TuiPluginModule["tui"] = async (...args) => {
  const { default: legacy } = await import("./legacy-tui.js")
  return legacy.tui!(...args)
}

export default { ...definition, tui }
