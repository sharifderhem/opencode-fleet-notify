// Isolate every test from the real HOME/XDG directories and the network.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'fleet-test-home-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.XDG_STATE_HOME = join(root, 'state')
process.env.XDG_CONFIG_HOME = join(root, 'config')
process.env.XDG_DATA_HOME = join(root, 'data')
process.env.XDG_CACHE_HOME = join(root, 'cache')
process.env.FLEET_NOTIFY_UPDATE_CHECK = '0'
delete process.env.FLEET_NOTIFY_URL
delete process.env.FLEET_NOTIFY_API_KEY
export const testRoot = root
