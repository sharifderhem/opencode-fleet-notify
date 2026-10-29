import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import { gatewayGet, gatewayURL, readBytes, type Gateway } from './gateway.js'

const run = promisify(execFile)
const MAX_BYTES = 16 * 1024 * 1024
const MAX_FILES = 512
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
type Files = Record<string, Uint8Array>
type Entry = { name: string; version?: string; source: { source: string; repo?: string; url?: string; path?: string; ref?: string; sha256?: string } }
type Installed = { owner: string; revision: string; hashes: Record<string, string> }
type State = Record<string, Installed>
export type SyncResult = { installed: number; updated: number; unchanged: number; conflicts: string[]; failed: string[] }
export const defaultSkillsRoot = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'skills')

/** V1 has no skill inventory on the legacy plugin client. Inspect discovery roots. */
export async function localSkillNames(directory: string, extra: string[] = []): Promise<Set<string>> {
  const roots = new Set([defaultSkillsRoot(), join(homedir(), '.agents', 'skills'), join(homedir(), '.claude', 'skills'), ...extra])
  for (let cursor = resolve(directory); ; cursor = dirname(cursor)) {
    for (const folder of ['.opencode', '.agents', '.claude']) roots.add(join(cursor, folder, 'skills'))
    if (dirname(cursor) === cursor) break
  }
  const names = new Set<string>()
  const walk = async (directory: string, depth: number) => {
    if (depth > 6) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) { names.add(entry.name); await walk(join(directory, entry.name), depth + 1) }
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const text = await readFile(join(directory, entry.name), 'utf8')
        const name = /^name:\s*['"]?([a-z0-9]+(?:-[a-z0-9]+)*)['"]?\s*$/m.exec(text)?.[1]
        if (name) names.add(name)
      }
    }
  }
  for (const root of roots) await walk(root, 0)
  return names
}

function safePath(path: string): boolean {
  return !!path && !path.includes('\\') && !path.includes(':') && !path.includes('\0') && path.split('/').every(p => !!p && p !== '.' && p !== '..' && p !== '.git')
}
function sourceURL(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Skill sources must use credential-free HTTPS')
  return url.href
}

export function unpackZip(bytes: Uint8Array): Files {
  let size = 0; let count = 0
  const files = unzipSync(bytes, { filter(file) {
    if (file.name.endsWith('/')) return false
    if (!safePath(file.name) || ++count > MAX_FILES || (size += file.originalSize) > MAX_BYTES) throw new Error('Unsafe or oversized archive')
    return true
  } })
  // Extraction is performed ourselves as regular files: zip symlinks are never followed.
  return files
}

export async function downloadSource(entry: Entry, signal?: AbortSignal): Promise<Files> {
  const source = entry.source
  if (source.source === 'archive') {
    const response = await fetch(sourceURL(source.url ?? ''), { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    // Deliberately no gateway Authorization, even when the source host matches.
    const bytes = await readBytes(response, MAX_BYTES)
    if (source.sha256 && (!/^[a-f0-9]{64}$/i.test(source.sha256) || hash(bytes) !== source.sha256.toLowerCase())) throw new Error('Archive digest mismatch')
    return unpackZip(bytes)
  }
  if (!['github', 'url', 'git-subdir'].includes(source.source)) throw new Error('Unsupported skill source')
  if (source.source === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(source.repo ?? '')) throw new Error('Invalid GitHub repository')
  const url = sourceURL(source.source === 'github' ? `https://github.com/${source.repo}.git` : source.url ?? '')
  if (source.ref && (!/^[\w./-]+$/.test(source.ref) || source.ref.startsWith('-'))) throw new Error('Invalid git ref')
  if (source.path && !safePath(source.path)) throw new Error('Invalid source subdirectory')
  const temporary = await mkdtemp(join(tmpdir(), 'fleet-skills-'))
  // No checkout, submodules, hooks, shell expansion, or inherited Git credentials.
  const env = { PATH: process.env.PATH, HOME: temporary, XDG_CONFIG_HOME: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  const options = { env, timeout: 60_000, maxBuffer: MAX_BYTES, signal, windowsHide: true }
  try {
    const repo = join(temporary, 'repo')
    await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'clone', '--depth=1', '--filter=blob:none', '--no-checkout', ...(source.ref ? ['--branch', source.ref] : []), '--', url, repo], options)
    const tree = await run('git', ['-C', repo, 'ls-tree', '-rz', '--full-tree', 'HEAD'], options)
    const files: Files = Object.create(null); let size = 0; let count = 0
    for (const line of tree.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line)
      if (!match) continue
      let path = match[3]
      if (source.path) { if (!path.startsWith(source.path + '/')) continue; path = path.slice(source.path.length + 1) }
      if (!safePath(path) || match[1] === '120000') throw new Error('Unsafe repository file')
      if (++count > MAX_FILES) throw new Error('Too many repository files')
      const blob = await run('git', ['-C', repo, 'cat-file', 'blob', match[2]], { ...options, encoding: 'buffer' })
      size += blob.stdout.length
      if (size > MAX_BYTES) throw new Error('Repository too large')
      files[path] = new Uint8Array(blob.stdout)
    }
    return files
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** Only SKILL.md subtrees are installable. Ignore plugin hooks/MCP/commands. */
export function skillBundles(files: Files): Map<string, Files> {
  const result = new Map<string, Files>()
  for (const path of Object.keys(files)) {
    if (!safePath(path)) throw new Error('Unsafe skill path')
    if (path !== 'SKILL.md' && !path.endsWith('/SKILL.md')) continue
    const text = new TextDecoder('utf-8', { fatal: true }).decode(files[path])
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
    const name = frontmatter && /^name:\s*['"]?([a-z0-9]+(?:-[a-z0-9]+)*)['"]?\s*$/m.exec(frontmatter)?.[1]
    if (!name || name.length > 64 || !/^description:\s*\S/m.test(frontmatter!)) throw new Error('Skill requires a portable name and description')
    if (result.has(name)) throw new Error('Duplicate skill name')
    const prefix = path.slice(0, -'SKILL.md'.length)
    const bundle: Files = Object.create(null)
    for (const [file, bytes] of Object.entries(files)) {
      if (!file.startsWith(prefix)) continue
      const relative = file.slice(prefix.length)
      if (relative && safePath(relative)) bundle[relative] = bytes
    }
    if (Object.keys(bundle).some(p => p !== 'SKILL.md' && p.endsWith('/SKILL.md'))) throw new Error('Nested skill bundles are ambiguous')
    result.set(name, bundle)
  }
  if (!result.size) throw new Error('No SKILL.md found')
  return result
}

async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  if (dirname(absolute) !== absolute) await safeDirectory(dirname(absolute))
  try { const stat = await lstat(absolute); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe skills directory') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(absolute) }
}
async function hashes(path: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error('Local symlink conflict')
    if (entry.isDirectory()) Object.assign(result, await hashes(join(path, entry.name), name + '/'))
    else if (entry.isFile()) result[name] = hash(await readFile(join(path, entry.name)))
    else throw new Error('Local special-file conflict')
  }
  return result
}
const equal = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([p, h]) => b[p] === h)

async function acquireLock(lock: string): Promise<void> {
  try { await mkdir(lock) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await lstat(lock)).isDirectory() || (await lstat(lock)).isSymbolicLink()) throw new Error('Unsafe sync lock')
    // A recovery marker serializes contenders reclaiming a crashed process's lock.
    const lockTime = (await lstat(lock)).mtimeMs
    const recovery = join(lock, 'recovery')
    try { await mkdir(recovery) } catch { throw new Error('Skills sync already locked') }
    let stale = false
    try {
      try {
        const pid = Number(await readFile(join(lock, 'pid'), 'utf8'))
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid sync lock')
        try { process.kill(pid, 0) } catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH' }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        stale = Date.now() - lockTime > 300_000
      }
      if (!stale) throw new Error('Skills sync already locked')
      await rm(lock, { recursive: true })
      // Another process may win the new lock. Never remove its lock on failure.
      await mkdir(lock)
    } finally { if (!stale) await rm(recovery, { recursive: true, force: true }) }
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 })
}

export async function syncSkills(gateway: Gateway, options: {
  root?: string; signal?: AbortSignal; existingNames?: Set<string>;
  download?: typeof downloadSource;
} = {}): Promise<SyncResult> {
  const response = await gatewayGet(gateway, 'claude-code/plugins', options.signal) as { plugins?: Entry[] }
  if (!response || !Array.isArray(response.plugins) || response.plugins.length > 200) throw new Error('Invalid skill catalog')
  const root = options.root ?? defaultSkillsRoot()
  await safeDirectory(root)
  const statePath = join(root, '.fleet-state.json'); const lock = join(root, '.fleet-lock')
  await acquireLock(lock)
  const result: SyncResult = { installed: 0, updated: 0, unchanged: 0, conflicts: [], failed: [] }
  try {
    let state: State = {}
    try {
      if ((await lstat(statePath)).isSymbolicLink()) throw new Error('Unsafe state')
      state = JSON.parse(await readFile(statePath, 'utf8'))
      if (!state || typeof state !== 'object' || Array.isArray(state) || Object.entries(state).some(([name, v]) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !v || typeof v.owner !== 'string' || typeof v.revision !== 'string' || !v.hashes || typeof v.hashes !== 'object')) throw new Error('Invalid state')
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read managed skill state') }
    const save = async () => { const temp = join(root, `.fleet-state-${randomUUID()}`); await writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await rename(temp, statePath) }
    for (const entry of response.plugins) {
      if (options.signal?.aborted) break
      if (!entry || typeof entry.name !== 'string' || !entry.source || typeof entry.source !== 'object') { result.failed.push('invalid entry'); continue }
      const owner = hash(gatewayURL(gateway.baseURL, '') + '\0' + entry.name)
      const revision = hash(JSON.stringify({ version: entry.version, source: entry.source }))
      const managed = Object.entries(state).filter(([, v]) => v.owner === owner)
      try {
        const stableRevision = !!entry.version || !!entry.source.sha256
        if (stableRevision && managed.length && managed.every(([, v]) => v.revision === revision)) {
          for (const [name, previous] of managed) {
            if (equal(await hashes(join(root, name)), previous.hashes)) result.unchanged++
            else result.conflicts.push(name)
          }
          continue
        }
        const bundles = skillBundles(await (options.download ?? downloadSource)(entry, options.signal))
        for (const [name, files] of bundles) {
          const target = join(root, name); const previous = Object.hasOwn(state, name) ? state[name] : undefined
          let current: Record<string, string> | undefined
          try {
            const stat = await lstat(target)
            if (!stat.isDirectory() || stat.isSymbolicLink()) { result.conflicts.push(name); continue }
            current = await hashes(target)
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.conflicts.push(name); continue } }
          if ((current && (!previous || previous.owner !== owner || !equal(current, previous.hashes))) || (!previous && options.existingNames?.has(name))) { result.conflicts.push(name); continue }
          const next = Object.fromEntries(Object.entries(files).map(([p, bytes]) => [p, hash(bytes)]))
          if (current && equal(current, next)) { state[name] = { owner, revision, hashes: next }; await save(); result.unchanged++; continue }
          const stage = await mkdtemp(join(root, '.fleet-stage-')); const backup = join(root, `.fleet-backup-${randomUUID()}`)
          try {
            for (const [path, bytes] of Object.entries(files)) { await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), bytes, { flag: 'wx', mode: 0o600 }) }
            if (current) {
              if (!equal(await hashes(target), current)) { result.conflicts.push(name); continue }
              await rename(target, backup)
            } else {
              // Refuse a collision created while the archive was staged.
              try { await lstat(target); result.conflicts.push(name); continue } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
            }
            try { await rename(stage, target) } catch (error) { if (current) await rename(backup, target); throw error }
            state[name] = { owner, revision, hashes: next }; await save()
            if (current) { await rm(backup, { recursive: true }); result.updated++ } else result.installed++
          } finally { await rm(stage, { recursive: true, force: true }) }
        }
      } catch { result.failed.push(entry.name) }
    }
    // Additive by design: catalog withdrawal never deletes local skills.
    return result
  } finally { await rm(lock, { recursive: true, force: true }) }
}
