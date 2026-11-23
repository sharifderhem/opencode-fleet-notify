import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, platform as osPlatform, release as osRelease } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Runtime health: version, capability detection, per-feature status, one small
 * size-capped log file, and the npm "newer version" check. Everything here is
 * best-effort and must never throw into the host.
 */

export const PACKAGE_NAME = 'opencode-fleet-notify'
export const FEATURES = ['notifications', 'skills', 'mcp', 'modelMetadata'] as const
export type Feature = typeof FEATURES[number]
/** `ok`, `skipped:<reason>` or `failed:<error>`. */
export type FeatureStatus = 'ok' | `skipped:${string}` | `failed:${string}`

export type Env = {
  home?: string
  env?: Record<string, string | undefined>
  platform?: string
  now?: () => number
  fetch?: typeof fetch
  /** Overrides the registry for tests. */
  registryURL?: string
}

export const LOG_CAP_BYTES = 128 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

function readVersion(): string {
  // src/ and dist/ both sit one level below the package root.
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof parsed.version === 'string') return parsed.version
  } catch { /* Fall through. */ }
  return 'unknown'
}
export const VERSION = readVersion()

function resolved(e: Env = {}) {
  const platform = e.platform ?? osPlatform()
  const env = e.env ?? process.env
  const home = e.home ?? env.HOME ?? env.USERPROFILE ?? homedir()
  const path = platform === 'win32' ? win32 : posix
  return { platform, env, home, path, now: e.now ?? Date.now }
}

/** XDG_STATE_HOME, else LOCALAPPDATA on Windows, else ~/.local/state. */
export function stateDir(e?: Env): string {
  const { platform, env, home, path } = resolved(e)
  const base = env.XDG_STATE_HOME || (platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : path.join(home, '.local', 'state'))
  return path.join(base, PACKAGE_NAME)
}
export const logFile = (e?: Env) => resolved(e).path.join(stateDir(e), 'fleet-notify.log')
export const doctorFile = (e?: Env) => resolved(e).path.join(stateDir(e), 'fleet-doctor.txt')
const updateFile = (e?: Env) => resolved(e).path.join(stateDir(e), 'update-check.json')

/** Remove credentials from any text that may reach a log, toast or report. */
export function maskSecrets(text: string, secrets: Iterable<string> = []): string {
  let out = String(text)
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('***')
  return out
    .replace(/(Bearer\s+)[\w.~+/=-]{4,}/gi, '$1***')
    .replace(/\b(sk-[\w-]{4,})/g, 'sk-***')
    .replace(/((?:api[-_]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1***')
}

export const errorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error).slice(0, 200)

export type Caps = Record<string, boolean>
const has = (value: unknown, ...path: string[]): boolean => {
  let current: any = value
  for (const key of path) { if (current == null) return false; current = current[key] }
  return typeof current === 'function'
}

/** Feature-test host APIs instead of comparing version numbers. */
export function detectV2Capabilities(ctx: unknown): Caps {
  return {
    'provider.list': has(ctx, 'provider', 'list'), 'provider.transform': has(ctx, 'provider', 'transform'),
    'provider.reload': has(ctx, 'provider', 'reload'),
    'skill.list': has(ctx, 'skill', 'list'), 'skill.reload': has(ctx, 'skill', 'reload'),
    'mcp.transform': has(ctx, 'mcp', 'transform'), 'mcp.reload': has(ctx, 'mcp', 'reload'),
    'event.subscribe': has(ctx, 'event', 'subscribe'), 'command.transform': has(ctx, 'command', 'transform'),
    'session.synthetic': has(ctx, 'session', 'synthetic'), 'integration.connection': has(ctx, 'integration', 'connection', 'active'),
    'AbortSignal.any': typeof (AbortSignal as any).any === 'function',
  }
}
export function detectV1Capabilities(client: unknown): Caps {
  return {
    'app.log': has(client, 'app', 'log'), 'tui.showToast': has(client, 'tui', 'showToast'),
    'mcp.connect': has(client, 'mcp', 'connect'), 'mcp.disconnect': has(client, 'mcp', 'disconnect'),
    'session.prompt': has(client, 'session', 'prompt'), 'global.health': has(client, 'global', 'health'),
    'AbortSignal.any': typeof (AbortSignal as any).any === 'function',
  }
}

/** Compare dotted numeric versions; pre-release suffixes are ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map(n => Number.parseInt(n, 10))
  const a = parse(latest), b = parse(current)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export function updateAdvice(latest: string, current: string, e?: Env): string {
  const { path, home } = resolved(e)
  return [
    `opencode-fleet-notify ${latest} is available (running ${current}). OpenCode does not refresh "@latest" plugins by itself.`,
    `Fix: pin the exact version in your OpenCode config, e.g. "${PACKAGE_NAME}@${latest}", then restart OpenCode.`,
    `OpenCode 2.x: run "opencode plugin update ${PACKAGE_NAME}".`,
    `OpenCode 1.x: delete ${path.join(home, '.cache', 'opencode', 'packages', `${PACKAGE_NAME}@latest`)} and restart.`,
  ].join('\n')
}

export type HostInfo = { mode: 'v1' | 'v2' | 'unknown'; version?: string }

export class Health {
  readonly statuses = new Map<Feature, { status: FeatureStatus; note?: string }>()
  host: HostInfo = { mode: 'unknown' }
  caps: Caps = {}
  latest?: string
  checkedAt?: number
  updateNotice?: string
  private secrets = new Set<string>()
  private warnedLog = false
  constructor(public e: Env = {}) {}

  addSecret(secret: unknown) { if (typeof secret === 'string' && secret.length >= 4) this.secrets.add(secret) }

  /** Append one masked line; rotates (single backup) beyond the size cap. */
  log(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      const file = logFile(this.e)
      mkdirSync(resolved(this.e).path.dirname(file), { recursive: true })
      try { if (statSync(file).size > LOG_CAP_BYTES) renameSync(file, `${file}.1`) } catch { /* No file yet. */ }
      appendFileSync(file, `${new Date(resolved(this.e).now()).toISOString()} ${level} ${maskSecrets(message, this.secrets).replace(/\s*\n\s*/g, ' | ')}\n`)
    } catch { this.warnedLog = true /* Logging is best-effort. */ }
  }

  /** Records a feature status; logs only when it changes (low noise). */
  set(feature: Feature, status: FeatureStatus, note?: string): void {
    const previous = this.statuses.get(feature)
    this.statuses.set(feature, { status, note })
    if (previous?.status === status) return
    this.log(status.startsWith('failed') ? 'error' : 'info', `feature ${feature}: ${status}${note ? ` (${note})` : ''}`)
  }

  loaded(mode: 'v1' | 'v2', caps: Caps, hostVersion?: string): void {
    this.host = { mode, version: hostVersion ?? this.host.version }; this.caps = caps
    const missing = Object.entries(caps).filter(([, ok]) => !ok).map(([name]) => name)
    this.log('info', `loaded ${PACKAGE_NAME} ${VERSION} mode=${mode} host=${this.host.version ?? 'unknown'} runtime=${runtime()} os=${resolved(this.e).platform}${missing.length ? ` missing=${missing.join(',')}` : ''}`)
  }

  report(): string {
    const { platform } = resolved(this.e)
    const lines = [
      `Fleet notify doctor`,
      `plugin:   ${PACKAGE_NAME} ${VERSION}` + (this.latest ? ` (latest known on npm: ${this.latest}${isNewer(this.latest, VERSION) ? ' - UPDATE AVAILABLE' : ', up to date'})` : ' (latest known: not checked yet)'),
      `host:     OpenCode ${this.host.version ?? 'version unknown'}, plugin entry mode ${this.host.mode}`,
      `os:       ${platform} ${osRelease()}`,
      `runtime:  ${runtime()}`,
      `log file: ${logFile(this.e)}`,
      `features:`,
    ]
    for (const feature of FEATURES) {
      const entry = this.statuses.get(feature)
      lines.push(`  ${feature.padEnd(13)} ${entry ? entry.status : 'pending (not evaluated yet)'}${entry?.note ? ` (${entry.note})` : ''}`)
    }
    const missing = Object.entries(this.caps).filter(([, ok]) => !ok).map(([name]) => name)
    lines.push(`host APIs missing: ${missing.length ? missing.join(', ') : 'none'}`)
    if (this.latest && isNewer(this.latest, VERSION)) lines.push('', updateAdvice(this.latest, VERSION, this.e))
    return maskSecrets(lines.join('\n'), this.secrets)
  }

  /** Persist the report so hosts without local commands (V1) can display it. */
  writeReport(): string {
    const file = doctorFile(this.e)
    try { mkdirSync(resolved(this.e).path.dirname(file), { recursive: true }); writeFileSync(file, this.report() + '\n') } catch { /* Best-effort. */ }
    return file
  }
}

function runtime(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun
  return bun ? `bun ${bun} (node-compat ${process.versions.node})` : `node ${process.versions.node}`
}

export const health = new Health()

/** `git` presence matters only for Git skill sources. */
export function gitAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    try { execFile('git', ['--version'], { timeout: 5000, windowsHide: true }, error => resolve(!error)) } catch { resolve(false) }
  })
}

export type UpdateResult = { checked: boolean; latest?: string; newer: boolean; reason?: string }

/**
 * Query the public npm registry (no credentials), at most once per ~24h.
 * Never throws; a short timeout bounds the request.
 */
export async function checkForUpdate(h: Health, options: Record<string, unknown> = {}, current = VERSION): Promise<UpdateResult> {
  const { env, now } = resolved(h.e)
  if (options.updateCheck === false || env.FLEET_NOTIFY_UPDATE_CHECK === '0') return { checked: false, newer: false, reason: 'disabled' }
  const file = updateFile(h.e)
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { checkedAt?: number; latest?: string }
    if (typeof cached.latest === 'string') { h.latest = cached.latest; h.checkedAt = cached.checkedAt }
    if (typeof cached.checkedAt === 'number' && now() - cached.checkedAt >= 0 && now() - cached.checkedAt < DAY_MS) {
      return { checked: false, latest: h.latest, newer: false, reason: 'throttled' }
    }
  } catch { /* No previous check. */ }
  try {
    const fetcher = h.e.fetch ?? fetch
    const response = await fetcher(h.e.registryURL ?? `https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000), redirect: 'error',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const latest = (await response.json() as { version?: unknown }).version
    if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+/.test(latest)) throw new Error('unexpected registry response')
    h.latest = latest; h.checkedAt = now()
    try { mkdirSync(resolved(h.e).path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ checkedAt: h.checkedAt, latest })) } catch { /* Throttle state is optional. */ }
    const newer = isNewer(latest, current)
    if (newer) { h.updateNotice = updateAdvice(latest, current, h.e); h.log('warn', `update available: ${latest} (running ${current})`) }
    return { checked: true, latest, newer }
  } catch (error) {
    // Offline is normal: record quietly and retry next start (not throttled).
    h.log('info', `update check failed: ${errorText(error)}`)
    return { checked: true, newer: false, reason: `failed:${errorText(error)}` }
  }
}

/** Fire-and-forget: tells `notify` once if a newer version exists. */
export function startUpdateCheck(h: Health, options: Record<string, unknown>, notify: (message: string) => unknown): void {
  void checkForUpdate(h, options).then(result => { if (result.newer && h.updateNotice) return notify(h.updateNotice) }).catch(() => {})
}
