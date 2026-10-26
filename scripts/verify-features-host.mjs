// Real OpenCode host, isolated configuration, fake LiteLLM, no paid/model requests.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
const legacy = process.argv.includes('--legacy')
const root = resolve(process.env.FLEET_TEST_PACKAGE_PATH ?? new URL('..', import.meta.url).pathname)
const fixture = await mkdtemp(join(tmpdir(), 'fleet-features-host-'))
const project = join(fixture, 'project'); await mkdir(project)
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
let version = '1'; let downloads = 0; let catalogReads = 0; let metadataReads = 0
let mcpInitializes = 0; let mcpLists = 0; let mcpCalls = 0; let mcpOfflineReads = 0
let mcpOffline = false
const archive = httpsServer({ key: await readFile(join(fixture, 'key.pem')), cert: await readFile(join(fixture, 'cert.pem')) }, (req, res) => {
  assert.equal(req.headers.authorization, undefined); downloads++
  res.end(zipSync({ 'skills/fleet-fixture/SKILL.md': strToU8(`---\nname: fleet-fixture\ndescription: Isolated host test\n---\nRevision ${version}\n`), 'skills/fleet-fixture/references/guide.md': strToU8('Reference fixture') }))
})
await new Promise(r => archive.listen(0, '127.0.0.1', r))
const mock = createServer(async (req, res) => {
  if (!req.url.startsWith('/gateway/')) return res.writeHead(404).end()
  if (req.url === '/gateway/mcp') {
    if (mcpOffline) { mcpOfflineReads++; return res.writeHead(503).end('MCP fixture offline') }
    if (req.headers['x-litellm-api-key'] !== 'Bearer fixture-key') return res.writeHead(403).end('MCP fixture denied')
    assert.equal(req.headers.authorization, undefined)
    if (req.method !== 'POST') return res.writeHead(405).end()
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if (message.method === 'notifications/initialized') return res.writeHead(202).end()
    res.setHeader('Content-Type', 'application/json')
    if (message.method === 'initialize') {
      mcpInitializes++
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fleet-fixture', version: '1.0.0' } } }))
    }
    if (message.method === 'tools/list') {
      mcpLists++
      const tools = [{ name: 'fleet_fixture_echo', description: 'Return harmless fixture text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
      if (version === '2') tools.push({ name: 'fleet_fixture_added', description: 'Dynamically added fixture tool', inputSchema: { type: 'object', properties: {} } })
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }))
    }
    if (message.method === 'tools/call') {
      mcpCalls++
      assert.equal(message.params.name, 'fleet_fixture_echo')
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `fixture echo: ${message.params.arguments.text}` }] } }))
    }
    if (message.method === 'ping') return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown fixture method' } }))
  }
  assert.equal(req.headers.authorization, 'Bearer fixture-key')
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/gateway/model/info') { metadataReads++; return res.end(JSON.stringify({ data: [{ model_name: 'fixture-model', model_info: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000006, cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost: 0.000003, max_input_tokens: 128000, max_output_tokens: 4096 } }] })) }
  if (req.url === '/gateway/claude-code/plugins') { catalogReads++; return res.end(JSON.stringify({ plugins: [{ name: 'fixture', version, source: { source: 'archive', url: `https://127.0.0.1:${archive.address().port}/skill.zip` } }] })) }
  res.writeHead(404).end('{}')
})
await new Promise(r => mock.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${mock.address().port}/gateway/v1`
const config = legacy ? {
  plugin: [[root, {}]], provider: { litellm: { npm: '@ai-sdk/openai-compatible', options: { baseURL, apiKey: 'fixture-key' }, models: { 'fixture-model': { name: 'Fixture' } } } },
} : {
  plugins: [{ package: root, options: {} }], providers: { litellm: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL, apiKey: 'fixture-key' }, models: { 'fixture-model': { name: 'Fixture' } } } },
}
config.$schema = 'https://opencode.ai/config.json'
await writeFile(join(project, 'opencode.json'), JSON.stringify(config))
const env = { ...process.env, HOME: fixture, NODE_EXTRA_CA_CERTS: join(fixture, 'cert.pem'), OPENCODE_SERVER_PASSWORD: 'fixture-password' }
delete env.FLEET_NOTIFY_API_KEY; delete env.FLEET_NOTIFY_URL
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) env[`XDG_${name}_HOME`] = join(fixture, name.toLowerCase())
const skillRoot = join(env.XDG_CONFIG_HOME, 'opencode', 'skills')
await mkdir(join(skillRoot, 'personal'), { recursive: true }); await writeFile(join(skillRoot, 'personal', 'SKILL.md'), '---\nname: personal\ndescription: Keep this skill\n---\nPersonal instructions\n')
const child = spawn(process.env.OPENCODE_BINARY ?? 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d)
const pause = ms => new Promise(r => setTimeout(r, ms))
async function until(check, description) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; if (child.exitCode !== null) throw new Error(`Host exited: ${description}`); await pause(100) }
  throw new Error(`Timed out: ${description}`)
}
try {
  const host = await until(() => logs.match(/server listening on (http:\/\/[^\s]+)/)?.[1], 'startup')
  const password = legacy ? 'fixture-password' : await until(() => logs.match(/server password ([^\s]+)/)?.[1] ?? 'fixture-password', 'password')
  const prefix = legacy ? '' : '/api'
  async function api(path, body) {
    const response = await fetch(host + prefix + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json', 'x-opencode-directory': project }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`${path}: ${response.status}: ${await response.text()}`)
    return response.json()
  }
  await api('/config')
  if (!legacy) await api('/plugin')
  await api(legacy ? '/provider' : '/model')
  await until(() => catalogReads && metadataReads, 'gateway requests')
  await until(async () => { try { return (await readFile(join(skillRoot, 'fleet-fixture/SKILL.md'), 'utf8')).includes('Revision 1') } catch { return false } }, 'skill install')
  const models = await api(legacy ? '/provider' : '/model')
  await writeFile(join(fixture, 'models.json'), JSON.stringify(models, null, 2))
  const skills = await until(async () => { const skills = await api('/skill'); return JSON.stringify(skills).includes('fleet-fixture') && skills }, 'host skill discovery')
  await writeFile(join(fixture, 'skills.json'), JSON.stringify(skills, null, 2))
  const model = legacy ? models.all.find(p => p.id === 'litellm').models['fixture-model'] : models.data.find(m => m.providerID === 'litellm' && m.id === 'fixture-model')
  assert.equal(model.limit.context, 128000); assert.equal(model.limit.output, 4096)
  assert.deepEqual(legacy ? model.cost : model.cost[0], { input: 2, output: 6, cache: { read: 1, write: 3 } })
  assert.match(JSON.stringify(skills), /fleet-fixture/); assert.match(JSON.stringify(skills), /personal/)
  const mcps = await until(async () => { const value = await api('/mcp'); return JSON.stringify(value).includes('fleet-litellm') && JSON.stringify(value).includes('connected') && value }, 'MCP connection')
  await until(() => mcpInitializes > 0 && mcpLists > 0, 'MCP discovery')
  const callResponse = await fetch(baseURL.replace(/\/v1$/, '') + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-litellm-api-key': 'Bearer fixture-key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'fleet_fixture_echo', arguments: { text: 'works' } } }),
  })
  assert.equal(callResponse.status, 200)
  const call = await callResponse.json()
  assert.equal(call.result.content[0].text, 'fixture echo: works'); assert.equal(mcpCalls, 1)
  const denied = await fetch(baseURL.replace(/\/v1$/, '') + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'x-litellm-api-key': 'Bearer denied-key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'fleet_fixture_echo', arguments: { text: 'denied' } } }),
  })
  assert.equal(denied.status, 403); assert.equal(mcpCalls, 1)
  await writeFile(join(fixture, 'mcp.json'), JSON.stringify({ status: mcps, discovery: { initializes: mcpInitializes, lists: mcpLists }, call, denied: denied.status }, null, 2))
  const before = catalogReads; const beforeMcpLists = mcpLists
  await api('/session', legacy ? { title: 'Refresh' } : { title: 'Refresh', location: { directory: project } })
  await until(() => catalogReads > before, 'repeat sync')
  await until(() => mcpLists > beforeMcpLists, 'MCP catalog refresh on new session')
  await pause(300); assert.equal(downloads, 1)
  version = '2'; const beforeAddedMcpLists = mcpLists
  await api('/session', legacy ? { title: 'Update' } : { title: 'Update', location: { directory: project } })
  await until(async () => (await readFile(join(skillRoot, 'fleet-fixture/SKILL.md'), 'utf8')).includes('Revision 2'), 'updated skill')
  await until(() => mcpLists > beforeAddedMcpLists, 'new MCP tool discovery')
  mcpOffline = true; const beforeOfflineReads = mcpOfflineReads
  await api('/session', legacy ? { title: 'Offline' } : { title: 'Offline', location: { directory: project } })
  await until(() => mcpOfflineReads > beforeOfflineReads, 'MCP offline failure')
  await until(async () => { const value = await api('/mcp'); return JSON.stringify(value).includes('fleet-litellm') && JSON.stringify(value).includes('failed') && value }, 'MCP failed status')
  mcpOffline = false; const beforeRecoveryLists = mcpLists
  await api('/session', legacy ? { title: 'Recovery' } : { title: 'Recovery', location: { directory: project } })
  await until(() => mcpLists > beforeRecoveryLists, 'MCP reconnect and catalog recovery')
  await until(async () => { const value = await api('/mcp'); return JSON.stringify(value).includes('fleet-litellm') && JSON.stringify(value).includes('connected') && value }, 'MCP recovered status')
  assert.equal(downloads, 2)
  assert.match(await readFile(join(skillRoot, 'personal/SKILL.md'), 'utf8'), /Personal instructions/)
  assert.equal(await readFile(join(project, 'opencode.json'), 'utf8'), JSON.stringify(config))
  console.log(JSON.stringify({ passed: true, legacy, fixture, checks: ['gateway prefix/auth', 'archive without gateway credentials', 'real skill discovery', 'preserved personal skill', 'model limits and exact prices', 'MCP connection and tool discovery', 'harmless MCP tool call', 'denied MCP credential', 'new MCP tool discovery on refresh', 'MCP offline recovery', 'unchanged revision skips download', 'changed revision updates', 'saved config untouched'] }, null, 2))
} finally {
  child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); mock.closeAllConnections(); archive.closeAllConnections()
  await Promise.all([new Promise(r => mock.close(r)), new Promise(r => archive.close(r))])
  await writeFile(join(fixture, 'host.log'), logs.replace(/server password [^\s]+/g, 'server password [redacted]'))
  console.log(`Host diagnostics: ${fixture}`)
}
