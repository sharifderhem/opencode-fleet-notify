// Exercise the installed desktop's embedded server, not a same-version Bun CLI.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const temp = await mkdtemp(join(tmpdir(), 'fleet-desktop-launcher-'))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const launcher = join(temp, 'desktop-host')
const app = process.env.OPENCODE_DESKTOP_APP ?? '/opt/OpenCode/ai.opencode.desktop'
const host = fileURLToPath(new URL('./desktop-host.cjs', import.meta.url))
try {
  await writeFile(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(app)} ${quote(host)} "$@"\n`, { mode: 0o700 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('./verify-features-host.mjs', import.meta.url)), '--legacy'], { stdio: 'inherit', env: { ...process.env, OPENCODE_BINARY: launcher } })
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)) })
} finally { await rm(temp, { recursive: true, force: true }) }
