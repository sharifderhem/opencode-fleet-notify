import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { gatewayURL, selectProvider, modelMetadata, enrichModel, gatewayGet } from '../src/gateway.ts'
import { syncSkills, skillBundles, unpackZip, downloadSource } from '../src/skills.ts'
import { legacyFeatures, withLegacyFeatures } from '../src/legacy-features.ts'

const gateway = { providerID: 'litellm', baseURL: 'https://gateway.test/prefix/v1', apiKey: 'fixture-key' }
const skill = (body = 'Original instructions') => ({ 'SKILL.md': strToU8(`---\nname: example\ndescription: Example fixture\n---\n${body}\n`), 'references/guide.md': strToU8('Support file') })
const entry = () => ({ name: 'bundle', version: '1', source: { source: 'archive', url: 'https://source.test/bundle.zip' } })
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-unit-'))
  const original = globalThis.fetch; const catalog = [entry()]; let reads = 0
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://gateway.test/prefix/claude-code/plugins')
    assert.equal(options.headers.Authorization, 'Bearer fixture-key')
    assert.equal(options.redirect, 'error')
    return Response.json({ plugins: catalog })
  }
  const options = { root, download: async () => { reads++; return skill() } }
  try { await fn({ root, catalog, options, reads: () => reads }) }
  finally { globalThis.fetch = original; await rm(root, { recursive: true, force: true }) }
}

test('Gateway URL retains deployment prefix and removes only trailing completion v1', () => {
  assert.equal(gatewayURL('https://host/prefix/v1/', '/model/info'), 'https://host/prefix/model/info')
  assert.equal(gatewayURL('https://host/prefix', 'claude-code/plugins'), 'https://host/prefix/claude-code/plugins')
  for (const bad of ['file:///tmp', 'https://user:pass@host', 'https://host/?key=secret']) assert.throws(() => gatewayURL(bad, 'model/info'))
})
test('Gateway selection is independent of notification URL and never guesses unrelated provider', () => {
  const candidates = [{ id: 'other', baseURL: 'https://other.test' }, { id: 'litellm', baseURL: 'https://gateway.test/api' }]
  assert.equal(selectProvider(candidates, {}).id, 'litellm')
  assert.equal(selectProvider([candidates[0]], {}), undefined)
  assert.equal(selectProvider(candidates, { provider: 'other' }).id, 'other')
})
test('Model mapping converts per-token prices, preserves missing fields and avoids ambiguous aliases', () => {
  const map = modelMetadata({ data: [{ model_name: 'model', model_info: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000005, cache_read_input_token_cost: 0, max_input_tokens: 128000, max_output_tokens: null } }] })
  const model = { cost: { input: 1, output: 1, cache: { read: 1, write: 9 } }, limit: { context: 1, output: 2048 } }
  enrichModel(model, map.get('model'), false)
  assert.deepEqual(model.cost, { input: 2, output: 5, cache: { read: 0, write: 9 } })
  assert.equal(model.limit.context, 128000); assert.equal(model.limit.output, 2048)
  assert.equal(modelMetadata({ data: [{ model_name: 'x', model_info: {} }, { model_name: 'x', model_info: {} }] }).size, 0)
  const v2 = { cost: [], limit: { context: 100, output: 10 } }
  enrichModel(v2, { input: 2, output: 5 }, true)
  assert.deepEqual(v2.cost, []) // No fabricated missing cache prices.
  enrichModel(v2, { input: 2, output: 5, read: 0.2, write: 3 }, true)
  assert.equal(v2.cost[0].cache.write, 3)
})
test('Context tier pricing is not flattened; invalid numeric metadata is ignored', () => {
  const model = { cost: [{ input: 10, output: 20, cache: { read: 1, write: 2 }, tier: { type: 'context', size: 100 } }], limit: {} }
  enrichModel(model, { input: 1, context: 200 }, true)
  assert.equal(model.cost[0].input, 10); assert.equal(model.limit.context, 200)
  assert.deepEqual(modelMetadata({ data: [{ model_name: 'x', model_info: { input_cost_per_token: -1, max_input_tokens: 0, output_cost_per_token: '3' } }] }).get('x'), {})
})
test('Archive extraction rejects traversal and excessive inflated size; requires real skill frontmatter', () => {
  assert.throws(() => unpackZip(zipSync({ '../escape': strToU8('bad') })))
  assert.throws(() => unpackZip(zipSync({ 'huge': new Uint8Array(17 * 1024 * 1024) })))
  assert.throws(() => skillBundles({ 'SKILL.md': strToU8('No name') }))
  const wrapped = Object.fromEntries(Object.entries(skill()).map(([name, data]) => ['repo/skills/example/' + name, data]))
  assert.equal(skillBundles(unpackZip(zipSync(wrapped))).get('example')['references/guide.md'].length, 12)
})
test('Skill archive fetch never sends gateway credentials and verifies a declared digest', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://source.test/bundle.zip')
    assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error')
    return new Response(zipSync(skill()))
  }
  try {
    assert.ok((await downloadSource(entry()))['SKILL.md'])
    await assert.rejects(downloadSource({ ...entry(), source: { ...entry().source, sha256: '0'.repeat(64) } }), /digest/)
    await assert.rejects(downloadSource({ ...entry(), source: { source: 'url', url: 'file:///tmp/repo' } }))
  } finally { globalThis.fetch = original }
})
test('Install, skip unchanged without download, then update changed version and supporting files', async () => fixture(async ({ root, catalog, options, reads }) => {
  assert.equal((await syncSkills(gateway, options)).installed, 1)
  assert.equal((await syncSkills(gateway, options)).unchanged, 1); assert.equal(reads(), 1)
  catalog[0].version = '2'; options.download = async () => skill('Updated instructions')
  assert.equal((await syncSkills(gateway, options)).updated, 1)
  assert.match(await readFile(join(root, 'example/SKILL.md'), 'utf8'), /Updated/)
  assert.equal(await readFile(join(root, 'example/references/guide.md'), 'utf8'), 'Support file')
}))
test('Preserve user-owned collisions and local edits, including additional local files', async () => fixture(async ({ root, catalog, options }) => {
  await mkdir(join(root, 'example')); await writeFile(join(root, 'example/SKILL.md'), 'Personal')
  assert.deepEqual((await syncSkills(gateway, options)).conflicts, ['example'])
  assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'Personal')
  await rm(join(root, 'example'), { recursive: true }); await syncSkills(gateway, options)
  await writeFile(join(root, 'example/personal.md'), 'Keep me'); catalog[0].version = '2'
  assert.deepEqual((await syncSkills(gateway, options)).conflicts, ['example'])
  assert.equal(await readFile(join(root, 'example/personal.md'), 'utf8'), 'Keep me')
}))
test('Conflicting host skill names and local symlinks never get overwritten', async () => fixture(async ({ root, options }) => {
  assert.deepEqual((await syncSkills(gateway, { ...options, existingNames: new Set(['example']) })).conflicts, ['example'])
  const outside = await mkdtemp(join(tmpdir(), 'fleet-outside-'))
  try {
    await symlink(outside, join(root, 'example'))
    assert.deepEqual((await syncSkills(gateway, options)).conflicts, ['example'])
    assert.deepEqual(await readdir(outside), [])
  } finally { await rm(outside, { recursive: true, force: true }) }
}))
test('Network errors and withdrawn catalog preserve installed skills; failed sources can retry', async () => fixture(async ({ root, catalog, options }) => {
  options.download = async () => { throw new Error('offline') }
  assert.deepEqual((await syncSkills(gateway, options)).failed, ['bundle'])
  options.download = async () => skill(); await syncSkills(gateway, options)
  catalog.length = 0; assert.equal((await syncSkills(gateway, options)).installed, 0)
  assert.match(await readFile(join(root, 'example/SKILL.md'), 'utf8'), /Original/)
  globalThis.fetch = async () => new Response('', { status: 403 })
  await assert.rejects(syncSkills(gateway, options), /403/)
  assert.match(await readFile(join(root, 'example/SKILL.md'), 'utf8'), /Original/)
}))
test('V1 enriches custom provider config in memory and preserves unrelated models', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async url => { assert.equal(url, 'https://gateway.test/prefix/model/info'); return Response.json({ data: [{ model_name: 'm', model_info: { input_cost_per_token: 0.000003 } }] }) }
  const hooks = await withLegacyFeatures(async () => ({}))({ directory: '/tmp' }, { skills: false })
  const config = { provider: { litellm: { options: { baseURL: gateway.baseURL, apiKey: gateway.apiKey }, models: { m: { limit: { context: 100 }, cost: { output: 7 } }, unrelated: { name: 'keep' } } } } }
  try {
    await hooks.config(config)
    assert.equal(config.provider.litellm.models.m.cost.input, 3)
    assert.equal(config.provider.litellm.models.m.cost.output, 7)
    assert.equal(config.provider.litellm.models.m.limit.context, 100)
    assert.deepEqual(config.provider.litellm.models.unrelated, { name: 'keep' })
  } finally { await hooks.dispose(); globalThis.fetch = original }
})

test('Concurrent sync is refused and a crashed-process lock is reclaimed', async () => fixture(async ({ root, options }) => {
  await mkdir(join(root, '.fleet-lock')); await writeFile(join(root, '.fleet-lock/pid'), String(process.pid))
  await assert.rejects(syncSkills(gateway, options), /locked/)
  await writeFile(join(root, '.fleet-lock/pid'), '2147483647')
  assert.equal((await syncSkills(gateway, options)).installed, 1)
}))
