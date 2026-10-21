import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../src/tui.ts'

const notice = { id: 'n1', type: 'notification', title: 'Maintenance', body: 'Restart tonight', severity: 'critical', requires_ack: true }
const settle = () => new Promise(resolve => setImmediate(resolve))
function harness(items, confirmed = false) {
  const receipts = [], seen = [], alerts = [], toasts = []
  let command, selections
  const ctx = {
    client: { rpc: () => ({ list: async () => items, seen: async ({ id }) => { seen.push(id) }, acknowledge: async ({ id }) => { receipts.push(id); return { ok: true } } }) },
    data: { location: { default: () => ({ directory: '/fixture' }) } },
    keymap: { layer: factory => { command = factory().commands[0] } },
    ui: { dialog: {
      confirm: async () => confirmed,
      alert: async options => { alerts.push(options) },
      select: async options => { selections = options; return options.options[0].value },
      clear: () => {},
    }, toast: { show: options => { toasts.push(options) } } },
  }
  return { ctx, receipts, seen, alerts, toasts, command: () => command, selections: () => selections }
}

test('Terminal Later does not acknowledge a required notice', async () => {
  const h = harness([notice], false)
  const dispose = plugin.setup(h.ctx)
  try { await settle(); assert.deepEqual(h.receipts, []); assert.deepEqual(h.seen, ['n1']) }
  finally { dispose() }
})
test('Terminal confirmation sends exactly one receipt and shows success', async () => {
  const h = harness([notice], true)
  const dispose = plugin.setup(h.ctx)
  try {
    await settle()
    assert.deepEqual(h.receipts, ['n1'])
    assert.equal(h.toasts[0].message, 'Acknowledgment received.')
  } finally { dispose() }
})
test('Terminal inbox opens already-seen notices immediately through dialogs', async () => {
  const h = harness([{ ...notice, requires_ack: false, seen: true }])
  const dispose = plugin.setup(h.ctx)
  try {
    await settle()
    assert.equal(h.alerts.length, 0)
    assert.equal(h.command().slash.name, 'fleet-notices')
    await h.command().run()
    assert.equal(h.selections().options[0].value, 'n1')
    assert.deepEqual(h.alerts, [{ title: 'Maintenance', message: 'Restart tonight' }])
    assert.deepEqual(h.receipts, [])
  } finally { dispose() }
})
test('Empty terminal inbox gives visible feedback', async () => {
  const h = harness([])
  const dispose = plugin.setup(h.ctx)
  try {
    await settle(); await h.command().run()
    assert.deepEqual(h.alerts, [{ title: 'Fleet notices', message: 'No active fleet notices.' }])
  } finally { dispose() }
})
