// Isolated integration check. No real credentials, model calls, or production writes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packagePath = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? root)
const discovery = process.argv.includes('--discovery')
const fixture = await mkdtemp(join(tmpdir(), 'fleet-host-check-'))
const project = join(fixture, 'project')
await mkdir(project)
const receipts = []
let feedReads = 0
const item = { id: 'host-notice', type: 'notification', severity: 'critical', title: 'Host verification', body: 'Local fixture only', requires_ack: true }
const mock = createServer((req, res) => {
  if (req.url === '/.well-known/fleet-notify') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ feed_url: feedUrl }))
    return
  }
  assert.equal(req.headers.authorization, 'Bearer fixture-key')
  if (req.url === '/ack/host-notice' && req.method === 'POST') {
    receipts.push(item.id)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
  } else if (req.url.startsWith('/feed')) {
    feedReads++
    const etag = receipts.length ? 'after-ack' : 'before-ack'
    if (req.headers['if-none-match'] === etag) return res.writeHead(304).end()
    res.writeHead(200, { 'Content-Type': 'application/json', etag }).end(JSON.stringify({ version: 1, etag, items: receipts.length ? [] : [item] }))
  } else res.writeHead(404).end()
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const feedUrl = `http://127.0.0.1:${mock.address().port}`
await writeFile(join(project, 'opencode.json'), JSON.stringify({
  plugins: [{ package: packagePath, options: discovery ? {} : { url: feedUrl } }],
  ...(discovery ? { providers: { fixture: { name: 'Fixture gateway', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: feedUrl + '/v1', apiKey: 'fixture-key' } } } } : {}),
}))
const env = { ...process.env, FLEET_NOTIFY_API_KEY: 'fixture-key' }
if (discovery) { delete env.FLEET_NOTIFY_API_KEY; delete env.FLEET_NOTIFY_URL }
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) env[`XDG_${name}_HOME`] = join(fixture, name.toLowerCase())
const child = spawn(process.env.OPENCODE_BINARY ?? 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
child.stdout.on('data', d => { logs += d })
child.stderr.on('data', d => { logs += d })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, description) {
  for (let i = 0; i < 100; i++) {
    const value = await check()
    if (value) return value
    if (child.exitCode !== null) throw new Error(`Host exited during ${description}`)
    await pause(100)
  }
  throw new Error(`Timed out: ${description}`)
}
try {
  const host = await until(() => logs.match(/server listening on (http:\/\/[^\s]+)/)?.[1], 'host startup')
  const password = await until(() => logs.match(/server password ([^\s]+)/)?.[1], 'test authentication')
  async function api(path, body, method) {
    const response = await fetch(host + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json', 'x-opencode-directory': project },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  await api('/api/config')
  const plugin = await until(async () => (await api('/api/plugin')).data.find(p => p.id === 'opencode-fleet-notify'), 'plugin registration')
  assert.equal(plugin.state.status, 'active')
  assert.deepEqual(plugin.features, { server: true, tui: true })
  await until(() => feedReads > 0, 'feed poll')
  const listing = await api('/api/rpc/fleet-notify/list', { input: null })
  assert.equal(listing.output[0].id, item.id)
  assert.equal(receipts.length, 0)
  const session = (await api('/api/session', { title: 'Local notification check', location: { directory: project } })).data
  const commands = await api('/api/command')
  assert.ok(commands.data.some(c => c.name === 'fleet-ack'))
  // Exercise the real command path, not just a simulated RPC handler.
  await api(`/api/session/${session.id}/command`, { name: 'fleet-ack', text: item.id })
  assert.deepEqual(receipts, [item.id])
  assert.equal((await api('/api/rpc/fleet-notify/list', { input: null })).output.length, 0)
  await api('/api/location/reload', {})
  await until(async () => (await api('/api/plugin')).data.some(p => p.id === 'opencode-fleet-notify' && p.state.status === 'active'), 'reload')
  const afterReload = await until(async () => {
    try { return await api('/api/rpc/fleet-notify/list', { input: null }) } catch { return undefined }
  }, 'RPC ready after reload')
  assert.equal(afterReload.output.length, 0)
  assert.equal(receipts.length, 1)
  const info = (await api(`/api/session/${session.id}`)).data
  assert.equal(info.cost, 0)
  assert.equal(info.tokens.output, 0)
  console.log(JSON.stringify({ passed: true, discovery, checks: ['real host load', 'server and TUI entry discovery', 'feed retrieval', 'no automatic acknowledgment', 'slash-command receipt', 'reload persistence', 'zero model tokens'], fixture }, null, 2))
} finally {
  child.kill('SIGTERM')
  mock.closeAllConnections()
  await new Promise(resolve => mock.close(resolve))
  await writeFile(join(fixture, 'host.log'), logs.replace(/server password [^\s]+/g, 'server password [redacted]'))
}
