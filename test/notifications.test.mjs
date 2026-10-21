import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifications, restore } from '../src/notifications.ts'

const notice = (id = 'n1', overrides = {}) => ({ id, type: 'notification', title: 'Maintenance', body: 'Restart tonight', severity: 'critical', requires_ack: true, ...overrides })
function harness({ items = [notice()], deliver = async () => true, saved, ackStatus = 200 } = {}) {
  const calls = []
  let current = items, status = ackStatus, revision = 1, malformed = false
  const state = restore(saved)
  const engine = createNotifications({ url: 'https://fleet.test', apiKey: 'test-key', state, save: async () => {}, deliver,
    fetch: async (url, init) => {
      calls.push({ url, ...init })
      if (url.includes('/ack/')) return new Response('{}', { status })
      if (malformed) return new Response('not json', { status: 200 })
      const tag = `"${revision}-${url.includes('?') ? 'filtered' : 'full'}"`
      if (init.headers['If-None-Match'] === tag) return new Response(null, { status: 304 })
      return Response.json({ version: 1, items: current, etag: tag }, { headers: { etag: tag } })
    },
  })
  return { engine, state, calls, setItems(v) { current = v; revision++ }, setStatus(v) { status = v }, malformed() { malformed = true } }
}

test('Repeated polls and display never acknowledge; explicit action does', async () => {
  const h = harness()
  await h.engine.poll(true)
  for (let i = 0; i < 5; i++) await h.engine.poll()
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0)
  assert.equal(h.engine.list().length, 1)
  assert.equal(await h.engine.acknowledge('n1'), true)
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1)
  assert.equal(h.engine.list().length, 0)
  assert.equal(await h.engine.acknowledge('n1'), true)
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1)
})
test('No session / failed delivery stays pending and retries on unchanged feed', async () => {
  let available = false, attempts = 0
  const h = harness({ deliver: async () => { attempts++; return available } })
  await h.engine.poll()
  assert.deepEqual(h.state.delivered, [])
  available = true
  await h.engine.poll()
  assert.equal(attempts, 2)
  assert.deepEqual(h.state.delivered, ['n1'])
  await h.engine.poll()
  assert.equal(attempts, 2)
})
test('404 does not become a receipt; queued explicit acknowledgment survives restart', async () => {
  const h = harness({ ackStatus: 404 })
  await h.engine.poll()
  assert.equal(await h.engine.acknowledge('n1'), false)
  assert.deepEqual(h.state.acked, [])
  const restarted = harness({ saved: JSON.parse(JSON.stringify(h.state)) })
  await restarted.engine.poll()
  assert.deepEqual(restarted.state.acked, ['n1'])
  assert.deepEqual(restarted.state.pendingAcks, [])
})
test('Removed and expired items stop appearing; unknown and malformed items are ignored', async () => {
  const h = harness({ items: [notice(), null, { type: 'future' }, notice('expired', { expires_at: '2000-01-01T00:00:00Z' })] })
  await h.engine.poll()
  assert.deepEqual(h.engine.list().map(n => n.id), ['n1'])
  h.setItems([])
  await h.engine.poll()
  assert.deepEqual(h.engine.list(), [])
})
test('Malformed response retains previous cache and ETag', async () => {
  const h = harness()
  await h.engine.poll()
  const before = JSON.stringify(h.state)
  h.malformed()
  await assert.rejects(h.engine.poll())
  assert.equal(JSON.stringify(h.state), before)
})
test('Full and filtered feeds do not share validators', async () => {
  const h = harness()
  await h.engine.poll(true)
  await h.engine.poll(false)
  assert.equal(h.calls[1].headers['If-None-Match'], undefined)
  await h.engine.poll(false)
  assert.equal(h.calls[2].headers['If-None-Match'], '"1-filtered"')
  await h.engine.poll(true)
  assert.equal(h.calls[3].headers['If-None-Match'], undefined)
})
test('Backlog advances five at a time and does not starve behind unacked items', async () => {
  const delivered = []
  const h = harness({ items: Array.from({ length: 12 }, (_, i) => notice(`n${i}`)), deliver: async n => { delivered.push(n.id); return true } })
  await h.engine.poll(); assert.equal(delivered.length, 5)
  await h.engine.poll(); assert.equal(delivered.length, 10)
  await h.engine.poll(); assert.equal(delivered.length, 12)
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 0)
})
test('Reject unknown ack IDs without contacting server', async () => {
  const h = harness()
  assert.equal(await h.engine.acknowledge('other'), false)
  assert.equal(h.calls.length, 0)
})
test('Stop aborts in-flight network request', async () => {
  let started
  const pending = new Promise(resolve => { started = resolve })
  const engine = createNotifications({ url: 'https://fleet.test', apiKey: 'test', state: restore(), save: async () => {}, deliver: async () => true,
    fetch: async (_, { signal }) => { started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
  })
  const poll = engine.poll()
  await pending
  engine.stop()
  await assert.rejects(poll, /aborted/)
})
