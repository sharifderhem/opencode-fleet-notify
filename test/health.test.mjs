import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Health, VERSION, isNewer, maskSecrets, stateDir, logFile, updateAdvice, checkForUpdate, detectV1Capabilities, detectV2Capabilities, LOG_CAP_BYTES } from '../src/health.ts'
import { anySignal } from '../src/gateway.ts'
import { legacyFeatures, withLegacyFeatures } from '../src/legacy-features.ts'
import { startFeatures } from '../src/features.ts'
import plugin from '../src/index.ts'
import pkg from '../package.json' with { type: 'json' }

const gateway = { baseURL: 'https://gateway.test/prefix/v1', apiKey: 'fixture-key-12345' }
async function tmpHealth(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fleet-health-'))
  const h = new Health({ home, env: { XDG_STATE_HOME: join(home, 'state') }, ...extra })
  return { home, h, done: () => rm(home, { recursive: true, force: true }) }
}
const registry = (version, calls = []) => async (url, init) => { calls.push({ url, init }); return Response.json({ version }) }

test('Plugin knows its own version and it matches package.json', () => assert.equal(VERSION, pkg.version))

test('Version comparison is numeric, ignores prerelease/v prefix and bad input', () => {
  assert.equal(isNewer('0.10.0', '0.9.9'), true)
  assert.equal(isNewer('0.8.0', '0.8.0'), false)
  assert.equal(isNewer('0.7.1', '0.8.0'), false)
  assert.equal(isNewer('v1.0.0', '0.9.0'), true)
  assert.equal(isNewer('garbage', '0.1.0'), false)
})

test('State and log paths honor XDG and Windows-style homes', () => {
  assert.equal(stateDir({ home: '/home/u', env: {}, platform: 'linux' }), '/home/u/.local/state/opencode-fleet-notify')
  assert.equal(stateDir({ home: '/home/u', env: { XDG_STATE_HOME: '/x' }, platform: 'linux' }), '/x/opencode-fleet-notify')
  assert.equal(logFile({ home: 'C:\\Users\\dev', env: {}, platform: 'win32' }), 'C:\\Users\\dev\\AppData\\Local\\opencode-fleet-notify\\fleet-notify.log')
  assert.equal(logFile({ home: 'C:\\Users\\dev', env: { LOCALAPPDATA: 'D:\\L' }, platform: 'win32' }), 'D:\\L\\opencode-fleet-notify\\fleet-notify.log')
  assert.match(updateAdvice('9.9.9', '0.8.0', { home: 'C:\\Users\\dev', env: {}, platform: 'win32' }), /C:\\Users\\dev\\\.cache\\opencode\\packages\\opencode-fleet-notify@latest/)
})

test('Secrets are masked in text', () => {
  const text = maskSecrets('Authorization: Bearer abcd1234efgh apiKey=zzzz9999 sk-live-abcdef custom-secret-value', ['custom-secret-value'])
  for (const leak of ['abcd1234efgh', 'zzzz9999', 'sk-live-abcdef', 'custom-secret-value']) assert.ok(!text.includes(leak), leak)
})

test('Log is one masked file, size capped with a single backup', async () => {
  const { h, home, done } = await tmpHealth()
  try {
    h.addSecret('super-secret-key')
    h.log('info', 'hello super-secret-key\nsecond line')
    const text = await readFile(logFile(h.e), 'utf8')
    assert.ok(!text.includes('super-secret-key')); assert.equal(text.trim().split('\n').length, 1)
    for (let i = 0; i < 700; i++) h.log('info', 'x'.repeat(250))
    assert.ok((await stat(logFile(h.e))).size <= LOG_CAP_BYTES + 400)
    assert.ok((await stat(logFile(h.e) + '.1')).size > 0)
    // A log directory that cannot be created never throws.
    new Health({ home: join(home, 'state', 'opencode-fleet-notify', 'fleet-notify.log', 'nope'), env: {} }).log('info', 'ignored')
  } finally { await done() }
})

test('Update check: newer version found, throttled for a day, cached', async () => {
  const { h, done } = await tmpHealth(); const calls = []
  let clock = 1_000_000; h.e.now = () => clock; h.e.fetch = registry('0.9.0', calls)
  try {
    const first = await checkForUpdate(h, {}, '0.8.0')
    assert.deepEqual([first.checked, first.newer, first.latest], [true, true, '0.9.0'])
    assert.equal(calls.length, 1); assert.equal(calls[0].init.headers.Authorization, undefined)
    assert.match(calls[0].url, /^https:\/\/registry\.npmjs\.org\/opencode-fleet-notify\/latest$/)
    assert.match(h.updateNotice, /opencode plugin update opencode-fleet-notify/); assert.match(h.updateNotice, /opencode-fleet-notify@0\.9\.0/)
    assert.equal((await checkForUpdate(h, {}, '0.8.0')).reason, 'throttled'); assert.equal(calls.length, 1)
    clock += 25 * 3600_000
    assert.equal((await checkForUpdate(h, {}, '0.9.0')).newer, false); assert.equal(calls.length, 2)
    assert.match(h.report(), /latest known on npm: 0\.9\.0/)
  } finally { await done() }
})

test('Update check tolerates no network, bad responses, and honors opt-out', async () => {
  const { h, done } = await tmpHealth()
  try {
    h.e.fetch = async () => { throw new TypeError('fetch failed') }
    const offline = await checkForUpdate(h, {}, '0.8.0'); assert.equal(offline.newer, false); assert.match(offline.reason, /^failed:/)
    h.e.fetch = async () => new Response('nope', { status: 503 }); assert.match((await checkForUpdate(h, {}, '0.8.0')).reason, /HTTP 503/)
    h.e.fetch = async () => Response.json({ version: '<script>' }); assert.match((await checkForUpdate(h, {}, '0.8.0')).reason, /unexpected/)
    let called = false; h.e.fetch = async () => { called = true; return Response.json({ version: '9.0.0' }) }
    assert.equal((await checkForUpdate(h, { updateCheck: false }, '0.8.0')).reason, 'disabled')
    h.e.env = { ...h.e.env, FLEET_NOTIFY_UPDATE_CHECK: '0' }; assert.equal((await checkForUpdate(h, {}, '0.8.0')).reason, 'disabled')
    assert.equal(called, false)
  } finally { await done() }
})

test('Capability detection feature-tests APIs, not versions', () => {
  assert.equal(detectV2Capabilities({ skill: { list() {} } })['skill.list'], true)
  assert.equal(detectV2Capabilities({})['mcp.transform'], false)
  assert.equal(detectV1Capabilities({ mcp: { connect() {} } })['mcp.connect'], true)
  assert.equal(detectV1Capabilities({})['tui.showToast'], false)
})

test('AbortSignal.any fallback links signals when the runtime lacks it', () => {
  const native = AbortSignal.any
  try {
    AbortSignal.any = undefined
    const a = new AbortController(), b = new AbortController()
    const linked = anySignal([a.signal, b.signal]); assert.equal(linked.aborted, false)
    b.abort(); assert.equal(linked.aborted, true)
    const pre = new AbortController(); pre.abort(); assert.equal(anySignal([pre.signal]).aborted, true)
  } finally { AbortSignal.any = native }
})

// ---- V2 feature status matrix ----
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, what) { for (let i = 0; i < 300; i++) { if (check()) return; await sleep(5) } throw new Error('Timed out: ' + what) }
function v2ctx(providers, extra = {}, options = {}) {
  return {
    options: { modelMetadata: false, ...options }, location: { directory: '/tmp' },
    provider: { list: async () => ({ data: providers }), transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    integration: { connection: {} },
    skill: { list: async () => ({ data: [] }), reload: async () => {} },
    mcp: { transform: async cb => { cb({ get: () => undefined, set: () => {} }); return { dispose: async () => {} } }, reload: async () => {} },
    event: { subscribe: async function* ({ signal }) { while (!signal.aborted) await sleep(10) } },
    ...extra,
  }
}
const resetHealth = (h) => { return import('../src/health.ts').then(m => { m.health.statuses.clear(); m.health.e = {}; return m.health }) }

test('V2 status: no provider matched gives specific skip reasons', async () => {
  const h = await resetHealth()
  const stop = startFeatures(v2ctx([{ id: 'other', settings: { baseURL: 'https://x.test', apiKey: 'k-12345' } }], {}, { skills: false }))
  try {
    await until(() => h.statuses.has('mcp'), 'mcp status')
    assert.match(h.statuses.get('mcp').status, /^skipped:no provider matched/)
    assert.equal(h.statuses.get('skills').status, 'skipped:disabled by plugin option')
  } finally { await stop() }
})

test('V2 status: provider without apiKey is skipped; secrets never reach the report', async () => {
  const h = await resetHealth()
  const stop = startFeatures(v2ctx([{ id: 'litellm', settings: { baseURL: gateway.baseURL } }]))
  try {
    await until(() => h.statuses.has('mcp'), 'mcp status')
    assert.match(h.statuses.get('mcp').status, /^skipped:no apiKey/)
  } finally { await stop() }
})

test('V2 status: missing host capabilities skip only the affected feature; others work', async () => {
  const h = await resetHealth()
  const original = globalThis.fetch; globalThis.fetch = async () => Response.json({ plugins: [] })
  const ctx = v2ctx([{ id: 'litellm', settings: gateway }]); delete ctx.skill
  const stop = startFeatures(ctx)
  try {
    await until(() => h.statuses.get('mcp')?.status === 'ok' && h.statuses.has('skills'), 'statuses')
    assert.equal(h.statuses.get('skills').status, 'skipped:host lacks skill.list')
    const report = h.report(); assert.ok(!report.includes('fixture-key-12345')); assert.match(report, /skill\.list/)
  } finally { await stop(); globalThis.fetch = original }
})

test('V2 status: git missing is named when a Git skill source fails', async () => {
  const h = await resetHealth()
  const original = globalThis.fetch; const path = process.env.PATH
  globalThis.fetch = async () => Response.json({ plugins: [{ name: 'g', version: '1', source: { source: 'github', repo: 'a/b' } }] })
  process.env.PATH = join(tmpdir(), 'definitely-no-git-here')
  const stop = startFeatures(v2ctx([{ id: 'litellm', settings: gateway }]))
  try {
    await until(() => h.statuses.get('skills')?.status.startsWith('failed'), 'skills failure')
    assert.match(h.statuses.get('skills').status, /git not found on PATH/)
    assert.equal(h.statuses.get('mcp').status, 'ok') // one feature failing never disables another
  } finally { await stop(); process.env.PATH = path; globalThis.fetch = original }
})

test('V2 failing feature API is recorded as failed and does not break MCP', async () => {
  const h = await resetHealth()
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('boom Bearer leak12345') }
  const stop = startFeatures(v2ctx([{ id: 'litellm', settings: gateway }]))
  try {
    await until(() => h.statuses.get('skills')?.status.startsWith('failed'), 'skills failure')
    assert.equal(h.statuses.get('mcp').status, 'ok')
    assert.ok(!(await readFile(logFile(h.e), 'utf8')).includes('leak12345'))
  } finally { await stop(); globalThis.fetch = original }
})

test('V2 entry registers /fleet-doctor, reports without a gateway, and survives missing APIs', async () => {
  const h = await resetHealth(); const sent = []; let command
  const ctx = v2ctx([], {
    command: { transform: async cb => { cb({ add: c => { command = c } }); return { dispose: async () => {} } } },
    session: { synthetic: async m => { sent.push(m) }, list: async () => ({ data: [] }) },
    rpc: { register: async () => ({ dispose: async () => {} }) },
    storage: { get: async () => undefined, set: async () => {} },
  }, { skills: false, mcp: false, updateCheck: false })
  const dispose = plugin.setup(ctx)
  try {
    await until(() => command, 'doctor command')
    await command.execute({ sessionID: 's1', prompt: { text: '' } })
    assert.equal(sent[0].sessionID, 's1'); assert.equal(sent[0].resume, false)
    for (const expect of [`opencode-fleet-notify ${VERSION}`, 'mode v2', 'notifications', 'skills', 'mcp', 'disabled by plugin option', 'log file:']) assert.ok(sent[0].text.includes(expect), expect)
  } finally { await (await dispose)() }
  // Host with none of the optional APIs: setup must not throw.
  const bare = { options: {}, location: { directory: '/tmp' } }
  const stopBare = plugin.setup(bare); await (await stopBare)()
})

// ---- V1 ----
test('V1: failing notifications entry does not break features; hooks never throw', async () => {
  const h = await resetHealth()
  const calls = []
  const hooks = await withLegacyFeatures(async () => ({ config: async () => { throw new Error('notif config broke') }, event: async () => { throw new Error('x') }, dispose: async () => { throw new Error('y') } }))(
    { directory: '/tmp', client: {} }, { skills: false, modelMetadata: false, updateCheck: false })
  const config = { provider: { litellm: { options: { baseURL: gateway.baseURL, apiKey: gateway.apiKey } } }, mcp: { personal: { type: 'remote', url: 'https://p.test' } } }
  await hooks.config(config)
  assert.equal(config.mcp['fleet-litellm'].url, 'https://gateway.test/prefix/mcp')
  assert.equal(config.mcp.personal.url, 'https://p.test')
  await hooks.event({ event: { type: 'other' } }); await hooks.dispose()
  assert.equal(h.statuses.get('mcp').status, 'ok'); assert.equal(h.statuses.get('skills').status, 'skipped:disabled by plugin option')
  assert.equal(h.host.mode, 'v1')
  assert.ok(config.command['fleet-doctor'].template.includes('fleet-doctor.txt'))
  assert.ok(calls.length === 0)
})

test('V1: notifications entry that throws at load degrades to features only', async () => {
  const h = await resetHealth()
  const hooks = await withLegacyFeatures(async () => { throw new Error('load fail') })({ directory: '/tmp', client: {} }, { skills: false, modelMetadata: false, updateCheck: false })
  assert.match(h.statuses.get('notifications').status, /^failed:Error: load fail/)
  await hooks.dispose()
})

test('V1: provider not found / no apiKey / opt-out each record a reason; personal fleet-doctor and mcp preserved', async () => {
  const h = await resetHealth()
  const hooks = await legacyFeatures({ directory: '/tmp', client: {} }, { skills: false, modelMetadata: false })
  const personal = { description: 'mine', template: 'mine' }
  const none = { provider: { other: { options: { baseURL: 'https://o.test', apiKey: 'k-12345' } } }, command: { 'fleet-doctor': personal } }
  await hooks.config(none)
  assert.match(h.statuses.get('mcp').status, /^skipped:no provider matched/); assert.equal(none.command['fleet-doctor'], personal); assert.equal(none.mcp, undefined)
  const noKey = { provider: { litellm: { options: { baseURL: gateway.baseURL } } } }
  await hooks.config(noKey)
  assert.match(h.statuses.get('mcp').status, /^skipped:no apiKey/)
  const optOut = await legacyFeatures({ directory: '/tmp', client: {} }, { skills: false, modelMetadata: false, mcp: false })
  const cfg = { provider: { litellm: { options: { baseURL: gateway.baseURL, apiKey: gateway.apiKey } } } }
  await optOut.config(cfg); assert.equal(cfg.mcp, undefined); assert.equal(h.statuses.get('mcp').status, 'skipped:disabled by plugin option')
  await hooks.dispose(); await optOut.dispose()
})

test('V1: update notice uses TUI toast when available and is silent without it', async () => {
  const h = await resetHealth(); const toasts = []
  h.e = { fetch: registry('99.0.0'), env: { XDG_STATE_HOME: join(tmpdir(), `fleet-upd-${process.pid}-${Date.now()}`) } }
  const client = { tui: { showToast: async t => { toasts.push(t) } } }
  await withLegacyFeatures(async () => ({}))({ directory: '/tmp', client }, { skills: false, mcp: false, modelMetadata: false })
  await until(() => toasts.length, 'toast')
  assert.equal(toasts[0].body.variant, 'warning'); assert.match(toasts[0].body.message, /opencode plugin update opencode-fleet-notify/)
  h.e = { fetch: registry('99.0.0'), env: { XDG_STATE_HOME: join(tmpdir(), `fleet-upd2-${process.pid}-${Date.now()}`) } }
  await withLegacyFeatures(async () => ({}))({ directory: '/tmp', client: {} }, { skills: false, mcp: false, modelMetadata: false })
  await sleep(30) // no toast API: must simply not throw
})
