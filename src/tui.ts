import { homedir } from "node:os"
import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { createComponent } from "solid-js"
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

// TUI half of opencode-fleet-notify: shows first-seen fleet notifications as
// center dialogs (the server half in ./index.ts polls and owns the feed).
// Confirming a requires_ack dialog queues a real ack, which the server half
// POSTs on its next cycle. Communication is via two files under STATE_DIR —
// the halves never call each other directly.

const STATE_DIR = join(homedir(), ".local", "state", "opencode-fleet-notify")
const STATE_FILE = join(STATE_DIR, "state.json")
const BRIDGE_FILE = join(STATE_DIR, "tui-bridge.json")
const CHECK_INTERVAL_MS = 4_000

type DialogItem = {
  id: string
  title: string
  body: string
  severity: string
  requires_ack: boolean
}

type Bridge = {
  shownIds: string[]
  ackQueue: string[]
}

async function readBridge(): Promise<Bridge> {
  try {
    const parsed = JSON.parse(await readFile(BRIDGE_FILE, "utf8")) as Partial<Bridge>
    return {
      shownIds: Array.isArray(parsed.shownIds) ? parsed.shownIds.filter((x) => typeof x === "string") : [],
      ackQueue: Array.isArray(parsed.ackQueue) ? parsed.ackQueue.filter((x) => typeof x === "string") : [],
    }
  } catch {
    return { shownIds: [], ackQueue: [] }
  }
}

async function writeBridge(bridge: Bridge): Promise<void> {
  try {
    await writeFile(BRIDGE_FILE, JSON.stringify(bridge), "utf8")
  } catch {
    // best-effort
  }
}

async function readPendingDialogs(): Promise<DialogItem[]> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as { pendingDialogs?: unknown }
    if (!Array.isArray(parsed.pendingDialogs)) return []
    return parsed.pendingDialogs.filter(
      (x): x is DialogItem => !!x && typeof x === "object" && typeof (x as DialogItem).id === "string",
    )
  } catch {
    return []
  }
}

async function showNext(api: TuiPluginApi, item: DialogItem, onDone: (acked: boolean) => void) {
  // One dialog at a time; onDone(true) means the user pressed confirm.
  const title = `${item.title}${item.requires_ack ? " — acknowledgement required" : ""}`
  if (item.requires_ack) {
    api.ui.dialog.replace(
      () =>
        createComponent(api.ui.DialogConfirm, {
          title,
          message: item.body,
          onConfirm: () => {
            api.ui.dialog.clear()
            onDone(true)
          },
          onCancel: () => {
            api.ui.dialog.clear()
            onDone(false)
          },
        }),
      () => onDone(false),
    )
  } else {
    api.ui.dialog.replace(
      () =>
        createComponent(api.ui.DialogAlert, {
          title,
          message: item.body,
          onConfirm: () => {
            api.ui.dialog.clear()
            onDone(false)
          },
        }),
      () => onDone(false),
    )
  }
}

const tui: TuiPluginModule["tui"] = async (api) => {
  let showing = false

  const tick = async () => {
    if (showing) return
    const [pending, bridge] = await Promise.all([readPendingDialogs(), readBridge()])
    const next = pending.find((d) => !bridge.shownIds.includes(d.id))
    if (!next) return

    showing = true
    showNext(api, next, async (acked) => {
      const fresh = await readBridge()
      if (!fresh.shownIds.includes(next.id)) fresh.shownIds.push(next.id)
      if (acked) fresh.ackQueue.push(next.id)
      await writeBridge(fresh)
      showing = false
    }).catch(() => {
      showing = false
    })
  }

  const interval = setInterval(() => void tick().catch(() => {}), CHECK_INTERVAL_MS)
  api.lifecycle.onDispose(() => clearInterval(interval))
  void tick().catch(() => {})
}

const module_: TuiPluginModule = { id: "opencode-fleet-notify", tui }
export default module_
