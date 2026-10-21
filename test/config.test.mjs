import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.ts'

const context = (options, providers) => ({ options, provider: { list: async () => ({ data: providers }) }, integration: { connection: { active: async () => undefined } } })
const providers = [
  { id: 'other', settings: { baseURL: 'https://other.test/v1', apiKey: 'wrong-key' } },
  { id: 'gateway', settings: { baseURL: 'https://gateway.test/api', apiKey: 'right-key' } },
]
test('Explicit URL resolves matching provider, never first unrelated credential', async () => {
  assert.deepEqual(await resolveConfig(context({ url: 'https://gateway.test/fleet' }, providers)), { url: 'https://gateway.test/fleet', apiKey: 'right-key' })
})
test('Ambiguous and unrelated provider selection disables safely', async () => {
  assert.equal(await resolveConfig(context({ url: 'https://fleet.test' }, providers)), undefined)
  assert.equal(await resolveConfig(context({ url: 'https://gateway.test/fleet' }, [...providers, providers[1]])), undefined)
})
test('An explicitly selected provider supports a separately hosted fleet service', async () => {
  assert.deepEqual(await resolveConfig(context({ url: 'https://fleet.test', provider: 'gateway' }, providers)), { url: 'https://fleet.test', apiKey: 'right-key' })
})
test('Uses resolved OpenCode integration key before provider settings', async () => {
  const ctx = context({ url: 'https://gateway.test/fleet' }, [{ ...providers[1], integrationID: 'gateway' }])
  ctx.integration.connection.active = async () => ({ id: 'connection' })
  ctx.integration.connection.resolve = async () => ({ type: 'key', key: 'saved-key' })
  assert.equal((await resolveConfig(ctx)).apiKey, 'saved-key')
})
test('Discovery preserves provider identity and rejects cross-origin credentials', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async url => Response.json({ feed_url: String(url).includes('other.test') ? 'https://unexpected.test/fleet' : 'https://gateway.test/fleet' })
  try { assert.deepEqual(await resolveConfig(context({}, providers)), { url: 'https://gateway.test/fleet', apiKey: 'right-key' }) }
  finally { globalThis.fetch = original }
})
