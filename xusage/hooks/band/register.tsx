import type { EngineInterface, Register } from 'claude-code'

type Source = 'proxy' | 'claude'

type QuotaWindow = {
  key: string
  label: string
  used: number
  windowMinutes: number
  resetsAt: number | null
}

type Usage = {
  source: Source
  plan: string
  windows: QuotaWindow[]
  error?: string
  retryAt?: number
}

const EMPTY: Usage = { source: 'claude', plan: '', windows: [] }
const TTL_MS = 30_000
const PLAN_TTL_MS = 300_000
const RATE_LIMIT_TTL_MS = 300_000
const MAX_RATE_LIMIT_TTL_MS = 3_600_000

let windowsHost: boolean | undefined
const onWindows = async ($: EngineInterface) =>
  (windowsHost ??= (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT')

// A Windows session started from Git Bash carries an MSYS HOME (/c/Users/...), which no Windows path API resolves.
const home = async ($: EngineInterface) =>
  (await onWindows($))
    ? (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    : (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
const claudeDir = async ($: EngineInterface) =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await home($)}/.claude`

// Windows has none of the Unix tools this module runs, so every use goes through the helpers below: cmd.exe for
// mkdir/rmdir/move, $.fs for a file the host reads whole, and PowerShell only for a file too large for $.fs.read.
const TAIL_BYTES = 262_144
const READ_LIMIT = 4 * 1024 * 1024

const system32 = async ($: EngineInterface) => `${(await $.env.get('SystemRoot')) ?? 'C:\\Windows'}\\System32`

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// -EncodedCommand takes UTF-16LE base64, which sidesteps every layer of Windows argument quoting.
function utf16Base64(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    bytes.push(code & 255, code >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] +
      (i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? BASE64[n & 63] : '=')
  }
  return out
}

// PowerShell also closes a single-quoted string on the typographic quotes.
const psLiteral = (value: string) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`

async function powershell($: EngineInterface, script: string) {
  return await $.process
    .run([
      `${await system32($)}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', utf16Base64(`$ErrorActionPreference='Stop'\n${script}`),
    ])
    .catch(() => undefined)
}

// mkdir fails on an existing directory and rmdir on a non-empty one, which is what the cache lock relies on.
async function fileOp($: EngineInterface, op: 'mkdir' | 'rmdir' | 'move', ...paths: string[]): Promise<boolean> {
  if (!(await onWindows($))) {
    const run = await $.process.run([op === 'move' ? '/bin/mv' : `/bin/${op}`, ...paths]).catch(() => undefined)
    return run?.exitCode === 0
  }
  const native = paths.map(p => p.replace(/\//g, '\\'))
  // cmd.exe expands or splits these even inside an argument; PowerShell takes the path as a literal.
  if (native.some(p => /[%!^&|<>(),;=]/.test(p))) {
    const [from, to] = native.map(psLiteral)
    const script = op === 'mkdir'
      ? `New-Item -ItemType Directory -Path ${from} | Out-Null`
      : op === 'rmdir'
        ? `[IO.Directory]::Delete(${from})`
        : `Move-Item -LiteralPath ${from} -Destination ${to} -Force`
    return (await powershell($, script))?.exitCode === 0
  }
  const run = await $.process
    .run([`${await system32($)}\\cmd.exe`, '/d', '/c', ...(op === 'move' ? ['move', '/y'] : [op]), ...native])
    .catch(() => undefined)
  return run?.exitCode === 0
}

// A session transcript runs to tens of MB and is read every few seconds, so a PowerShell read is kept until the
// file changes. Finished agents are never read again, so only the most recently used reads are kept.
const LARGE_READS = 32
const largeReads = new Map<string, { size: number; mtimeMs: number; value: string | undefined }>()

async function windowsRead(
  $: EngineInterface,
  path: string,
  cut: (text: string) => string,
  script: string,
): Promise<string | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined) return undefined
  if (stat.size <= READ_LIMIT) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) return cut(text)
  }
  const key = `${path}\n${script}`
  const held = largeReads.get(key)
  // Re-inserted on every hit, so the Map's first key is the least recently used.
  largeReads.delete(key)
  if (held !== undefined && held.size === stat.size && held.mtimeMs === stat.mtimeMs) {
    largeReads.set(key, held)
    return held.value
  }
  // Shared for writing too: Claude Code may hold the transcript open while it appends.
  const run = await powershell($, [
    `$s=[IO.File]::Open(${psLiteral(path)},'Open','Read','ReadWrite, Delete')`,
    '$o=[Console]::OpenStandardOutput()',
    '$e=New-Object Text.UTF8Encoding($false)',
    'function emit($v){$b=$e.GetBytes($v+[char]10);$o.Write($b,0,$b.Length)}',
    script,
    '$o.Flush();$s.Close()',
  ].join('\n'))
  const value = run?.exitCode === 0 ? run.stdout : undefined
  largeReads.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, value })
  if (largeReads.size > LARGE_READS) largeReads.delete(largeReads.keys().next().value!)
  return value
}

/** The last 256 KB of a file, or undefined when it cannot be read. */
async function tailText($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await onWindows($))) {
    const out = await $.process.run(['/usr/bin/tail', '-c', String(TAIL_BYTES), path]).catch(() => undefined)
    return out?.exitCode === 0 ? out.stdout : undefined
  }
  return await windowsRead($, path, text => text.slice(-TAIL_BYTES), [
    `$n=[Math]::Min($s.Length,${TAIL_BYTES});[void]$s.Seek(-$n,'End')`,
    '$b=New-Object byte[] $n;$r=0',
    'while($r -lt $n){$k=$s.Read($b,$r,$n-$r);if($k -le 0){break};$r+=$k}',
    '$o.Write($b,0,$r)',
  ].join('\n'))
}

async function headLine($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await onWindows($))) {
    const out = await $.process.run(['/usr/bin/head', '-n', '1', path]).catch(() => undefined)
    return out?.exitCode === 0 ? out.stdout : undefined
  }
  return await windowsRead($, path, text => text.split('\n', 1)[0], [
    '$t=New-Object IO.StreamReader($s,[Text.Encoding]::UTF8)',
    '$l=$t.ReadLine();if($l -ne $null){emit $l}',
  ].join('\n'))
}

/**
 * grep: the lines matching `pattern` (an ERE), or with `only` each match on its own line; '' for no match,
 * undefined when the file cannot be read.
 */
async function grepFile($: EngineInterface, path: string, pattern: string, only = false): Promise<string | undefined> {
  if (!(await onWindows($))) {
    const out = await $.process.run(['/usr/bin/grep', only ? '-o' : '-E', pattern, path]).catch(() => undefined)
    return out === undefined || out.exitCode > 1 ? undefined : out.stdout
  }
  const cut = (text: string) => {
    const re = new RegExp(pattern, only ? 'g' : '')
    const lines = text.split('\n')
    const hits = only ? lines.flatMap(line => [...line.matchAll(re)].map(m => m[0])) : lines.filter(line => re.test(line))
    return hits.map(line => `${line}\n`).join('')
  }
  return await windowsRead($, path, cut, [
    '$t=New-Object IO.StreamReader($s,[Text.Encoding]::UTF8)',
    `$re=[regex]${psLiteral(pattern)}`,
    only
      ? 'while(($l=$t.ReadLine()) -ne $null){foreach($m in $re.Matches($l)){emit $m.Value}}'
      : 'while(($l=$t.ReadLine()) -ne $null){if($re.IsMatch($l)){emit $l}}',
  ].join('\n'))
}

// Absent flag = shown, same convention as ponytail's band.
async function hidden($: EngineInterface): Promise<boolean> {
  try {
    return (await $.fs.read(`${await claudeDir($)}/.usage-band`)).trim() === 'off'
  } catch {
    return false
  }
}

async function baseUrl($: EngineInterface): Promise<string> {
  let fromEnv: string | undefined
  try {
    fromEnv = (await $.env.get('ANTHROPIC_BASE_URL')) || undefined
  } catch {
    fromEnv = undefined
  }
  if (fromEnv) return fromEnv
  try {
    const settings = JSON.parse(await $.fs.read(`${await claudeDir($)}/settings.json`))
    return typeof settings?.env?.ANTHROPIC_BASE_URL === 'string' ? settings.env.ANTHROPIC_BASE_URL : ''
  } catch {
    return ''
  }
}

const isLocalProxy = (url: string) =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/.test(url)

const isAnthropic = (url: string) => /^https?:\/\/([^/]*\.)?anthropic\.com(\/|$)/.test(url)

async function pickSource($: EngineInterface): Promise<Source> {
  let forced: string | undefined
  try {
    forced = (await $.env.get('USAGE_BAND_SOURCE'))?.toLowerCase()
  } catch {
    forced = undefined
  }
  if (forced === 'proxy' || forced === 'claude') return forced
  const url = await baseUrl($)
  if (url !== '' && !isAnthropic(url)) return 'proxy'
  return 'claude'
}

const label = (minutes: number): string => {
  if (minutes >= 10080) return '7d'
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`
  return `${minutes}m`
}

const secondsToMs = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n * 1000 : null
}

// EasyCLIProxyAPI records the upstream Codex quota headers with every response.
async function proxyUsage($: EngineInterface): Promise<Usage> {
  let override: string | undefined
  try {
    override = (await $.env.get('USAGE_BAND_DB')) || undefined
  } catch {
    override = undefined
  }
  const windows = await onWindows($)
  const appData = windows ? await $.env.get('APPDATA') : undefined
  const candidates = [
    override,
    windows
      ? appData && `${appData}/com.cpa.gui/usage-records/usage.db`
      : `${await home($)}/Library/Application Support/com.cpa.gui/usage-records/usage.db`,
    `${await home($)}/.cli-proxy-api/usage.db`,
  ].filter((p): p is string => typeof p === 'string' && p !== '')
  // Windows ships no sqlite3, so it has to be on PATH there.
  const sqlite = windows ? 'sqlite3' : '/usr/bin/sqlite3'

  const sql = [
    'select',
    `json_extract(raw_message,'$.response_headers."X-Codex-Plan-Type"[0]') as plan,`,
    `json_extract(raw_message,'$.response_headers."X-Codex-Primary-Used-Percent"[0]') as p_used,`,
    `json_extract(raw_message,'$.response_headers."X-Codex-Primary-Window-Minutes"[0]') as p_win,`,
    `json_extract(raw_message,'$.response_headers."X-Codex-Primary-Reset-At"[0]') as p_reset,`,
    `json_extract(raw_message,'$.response_headers."X-Codex-Secondary-Used-Percent"[0]') as s_used,`,
    `json_extract(raw_message,'$.response_headers."X-Codex-Secondary-Window-Minutes"[0]') as s_win,`,
    `json_extract(raw_message,'$.response_headers."X-Codex-Secondary-Reset-At"[0]') as s_reset,`,
    'received_at from usage_inbox',
    `where json_extract(raw_message,'$.response_headers."X-Codex-Primary-Used-Percent"') is not null`,
    'order by id desc limit 1;',
  ].join(' ')

  let lastError = 'proxy database not found'
  for (const db of candidates) {
    const run = await $.process
      .run([sqlite, '-json', '-cmd', '.timeout 2000', db, sql])
      .catch(() => undefined)
    if (run === undefined) {
      lastError = 'sqlite3 unavailable'
      continue
    }
    if (run.exitCode !== 0) {
      const detail = String((run as any).stderr ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
      lastError = `sqlite3 exit ${run.exitCode}${detail ? `: ${detail}` : ''}`
      continue
    }
    if (run.stdout.trim() === '') {
      lastError = 'no quota recorded yet'
      continue
    }
    let row: Record<string, unknown>
    try {
      row = JSON.parse(run.stdout)[0]
    } catch {
      lastError = 'proxy database unreadable'
      continue
    }
    if (!row) {
      lastError = 'no quota recorded yet'
      continue
    }

    const windows: QuotaWindow[] = []
    for (const [prefix, key] of [['p', 'primary'], ['s', 'secondary']] as const) {
      const minutes = Number(row[`${prefix}_win`]) || 0
      const used = Number(row[`${prefix}_used`])
      const resetsAt = secondsToMs(row[`${prefix}_reset`])
      if (minutes <= 0 || !Number.isFinite(used) || resetsAt === null) continue
      windows.push({ key, label: label(minutes), used, windowMinutes: minutes, resetsAt })
    }
    if (windows.length === 0) {
      lastError = 'no quota recorded yet'
      continue
    }

    return {
      source: 'proxy',
      plan: typeof row.plan === 'string' ? row.plan : '',
      windows,
    }
  }
  return { ...EMPTY, source: 'proxy', error: lastError }
}

function planLabel(plan: unknown, tier: unknown): string {
  const base = typeof plan === 'string' ? plan : ''
  if (typeof tier !== 'string') return base
  const match = tier.match(/^default_claude_([^_]+)_(\d+(?:_\d+)?)x$/)
  return match === null ? base : `${match[1]}${match[2].replace('_', '.')}`
}

async function claudeToken($: EngineInterface): Promise<{ token: string; plan: string } | undefined> {
  // Claude Code keeps the Windows credentials in the file alone.
  const raw = (await onWindows($))
    ? undefined
    : await $.process
      .run(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'])
      .catch(() => undefined)
  if (raw !== undefined && raw.exitCode === 0 && raw.stdout.trim() !== '') {
    try {
      const creds = JSON.parse(raw.stdout)
      const token = creds?.claudeAiOauth?.accessToken
      if (typeof token === 'string' && token !== '') {
        return {
          token,
          plan: planLabel(creds.claudeAiOauth.subscriptionType, creds.claudeAiOauth.rateLimitTier),
        }
      }
    } catch {
      // fall through to the credentials file
    }
  }
  try {
    const creds = JSON.parse(await $.fs.read(`${await claudeDir($)}/.credentials.json`))
    const token = creds?.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token !== '') {
      return {
        token,
        plan: planLabel(creds.claudeAiOauth.subscriptionType, creds.claudeAiOauth.rateLimitTier),
      }
    }
  } catch {
    // no credentials available
  }
  return undefined
}

let planCache: { at: number; value: string } | undefined

async function currentPlan($: EngineInterface, fallback: string): Promise<string> {
  const now = await $.clock.now()
  if (planCache !== undefined && now - planCache.at < PLAN_TTL_MS) return planCache.value || fallback
  const auth = await claudeToken($)
  const value = auth?.plan || fallback
  planCache = { at: now, value }
  return value
}

const NATIVE_WINDOWS: [string, string][] = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_opus', '7d opus'],
  ['seven_day_sonnet', '7d sonnet'],
]

function retryDelay(value: string | null, now: number): number {
  const seconds = value === null ? Number.NaN : Number(value)
  const date = value === null ? Number.NaN : Date.parse(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : 0
  return Math.min(delay > 0 ? delay : RATE_LIMIT_TTL_MS, MAX_RATE_LIMIT_TTL_MS)
}

async function claudeUsage($: EngineInterface): Promise<Usage> {
  const auth = await claudeToken($)
  if (auth === undefined) return { ...EMPTY, source: 'claude', error: 'no Claude credentials' }

  const response = await $.http
    .fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
    })
    .catch(() => undefined)
  if (response === undefined || !response.ok) {
    const now = await $.clock.now()
    const retryAt = response?.status === 429
      ? now + retryDelay(response.headers['retry-after'] ?? null, now)
      : undefined
    return { ...EMPTY, source: 'claude', plan: auth.plan, error: 'usage request failed', retryAt }
  }

  let payload: Record<string, any>
  try {
    payload = JSON.parse(response.text)
  } catch {
    return { ...EMPTY, source: 'claude', plan: auth.plan, error: 'usage response unreadable' }
  }

  const windows: QuotaWindow[] = []
  for (const [key, windowLabel] of NATIVE_WINDOWS) {
    const bucket = payload?.[key]
    if (bucket == null || typeof bucket !== 'object') continue
    const used = Number(bucket.utilization)
    const resetsAt = typeof bucket.resets_at === 'string' ? Date.parse(bucket.resets_at) : Number.NaN
    if (!Number.isFinite(used)) continue
    windows.push({
      key,
      label: windowLabel,
      used,
      windowMinutes: key === 'five_hour' ? 300 : 10080,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    })
  }

  return { source: 'claude', plan: auth.plan, windows }
}

type Cache = { at: number; source: Source; value: Usage }

let cache: Cache | undefined
let pending: Promise<Usage> | undefined

function fresh(entry: Cache | undefined, source: Source, now: number): entry is Cache {
  if (entry === undefined || entry.source !== source) return false
  const expiresAt = entry.value.retryAt ?? entry.at +
    (entry.value.error !== undefined && entry.value.windows.length === 0 ? 5_000 : TTL_MS)
  return now < expiresAt
}

async function readCache($: EngineInterface, path: string): Promise<Cache | undefined> {
  try {
    const value = JSON.parse(await $.fs.read(path))
    return typeof value?.at === 'number' && typeof value?.value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

async function writeCache($: EngineInterface, path: string, entry: Cache): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await $.fs.write(temporary, JSON.stringify(entry))
  if (!(await fileOp($, 'move', temporary, path))) throw new Error('usage cache write failed')
}

async function acquireLock($: EngineInterface, path: string, now: number): Promise<boolean> {
  const modified = (await $.fs.stat(path).catch(() => undefined))?.mtimeMs
  if (modified !== undefined && now - modified > 30_000) await fileOp($, 'rmdir', path)
  return await fileOp($, 'mkdir', path)
}

async function usage($: EngineInterface): Promise<Usage> {
  const now = await $.clock.now()
  if (cache !== undefined && fresh(cache, cache.source, now)) return cache.value
  if (pending !== undefined) return pending
  pending = (async () => {
    const source = await pickSource($)
    if (fresh(cache, source, now)) return cache.value
    const path = `${await claudeDir($)}/xusage-cache.json`
    const lock = `${path}.lock`
    let shared = await readCache($, path)
    if (fresh(shared, source, now)) {
      cache = shared
      return shared.value
    }

    if (!await acquireLock($, lock, now)) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
        shared = await readCache($, path)
        const waitedNow = await $.clock.now()
        if (fresh(shared, source, waitedNow)) {
          cache = shared
          return shared.value
        }
      }
      return shared?.value ?? cache?.value ?? { ...EMPTY, source, error: 'usage unavailable' }
    }

    try {
      shared = await readCache($, path)
      const fetchedAt = await $.clock.now()
      if (fresh(shared, source, fetchedAt)) {
        cache = shared
        return shared.value
      }
      const value = await (source === 'proxy' ? proxyUsage($) : claudeUsage($))
      const previous = shared?.source === source ? shared.value : cache?.value
      const cachedValue = value.retryAt !== undefined && previous?.source === value.source && previous.windows.length > 0
        ? { ...previous, error: value.error, retryAt: value.retryAt }
        : value
      cache = { at: fetchedAt, source, value: cachedValue }
      await writeCache($, path, cache)
      return cachedValue
    } finally {
      await fileOp($, 'rmdir', lock)
    }
  })()
  try {
    return await pending
  } finally {
    pending = undefined
  }
}

type AgentEntry = { id: string; name?: string; description?: string; type: string; status: string }

const AGENTS_PANE = 'usage-band-agents'
const isActive = (a: AgentEntry) => a.status === 'running' || a.status === 'waiting'

// $.agent.list() returns every subagent and teammate of this session with its status.
let agents: { at: number; list: AgentEntry[] } | undefined

async function agentList($: EngineInterface): Promise<AgentEntry[]> {
  const now = await $.clock.now()
  if (agents !== undefined && now - agents.at < 3_000) return agents.list
  const list = (await $.agent.list().catch(() => [])) as AgentEntry[]
  const value = Array.isArray(list) ? list : []
  agents = { at: now, list: value }
  return value
}

// agent.list() keeps a finished background agent at status "waiting" for the rest of the session. Its meta
// file is rewritten with "finished": true when the loop ends, and only a resumed agent writes the transcript
// after it, so a newer transcript means the agent is active again.
async function agentFinished($: EngineInterface, transcript: string): Promise<boolean> {
  const meta = transcript.replace(/\.jsonl$/, '.meta.json')
  let finished = false
  try {
    finished = JSON.parse(await $.fs.read(meta))?.finished === true
  } catch {
    return false
  }
  if (!finished) return false
  const [metaStat, transcriptStat] = await Promise.all([
    $.fs.stat(meta).catch(() => undefined),
    $.fs.stat(transcript).catch(() => undefined),
  ])
  if (metaStat === undefined || transcriptStat === undefined) return false
  // The flag lands just before the transcript's final flush, milliseconds apart on the real files.
  return metaStat.mtimeMs >= transcriptStat.mtimeMs - 2_000
}

async function liveAgents($: EngineInterface): Promise<AgentEntry[]> {
  const dir = await sessionDir($).catch(() => '')
  const active = (await agentList($).catch(() => [])).filter(isActive)
  if (dir === '') return active
  const live: AgentEntry[] = []
  for (const a of active) {
    if (!(await agentFinished($, `${dir}/subagents/agent-${a.id}.jsonl`))) live.push(a)
  }
  return live
}

const agentName = (a: AgentEntry) => a.name ?? a.description ?? a.id

type WorkflowRun = {
  id: string
  /** The task id the conversation calls the run by; absent until its launch result is found. */
  task?: string
  title: string
  startedAt: number
  at: number
  agents: { label: string; phase: string; model: string; tokens: number | undefined }[]
  done: number
  failed: number
}

// The script's later steps are not in the journal until they start, so a run has no known total.
const progress = (w: WorkflowRun) =>
  [`${w.agents.length} running`, w.done > 0 ? `${w.done} done` : '', w.failed > 0 ? `${w.failed} failed` : '']
    .filter(Boolean)
    .join(' · ')

// Workflow runs are invisible to $.agent.list (it keeps local_agent and teammates only), so read the engine's
// per-session run state: a wf dir exists while running and its final JSON appears when the run ends.
// A run killed with its process (crash, quit, restart) never gets that JSON, so a run whose journal and agent
// transcripts have all been silent for STALE_MS counts as dead.
// shortcut: private on-disk layout; if it changes, workflows silently disappear from the pane.
// shortcut: a single tool call silent for longer than STALE_MS hides its still-live run.
const STALE_MS = 60 * 60_000
let workflows: { at: number; list: WorkflowRun[] } | undefined
let sessionDirCache: { session: string; dir: string } | undefined

async function sessionDir($: EngineInterface): Promise<string> {
  const session = await $.session.id()
  if (sessionDirCache?.session === session) return sessionDirCache.dir
  const projects = `${await claudeDir($)}/projects`
  // root, not cwd: a shell cd moves cwd but never the session's project folder.
  const start = await $.session.root().catch(() => $.session.cwd())
  const encoded = `${projects}/${start.replace(/[^a-zA-Z0-9]/g, '-')}/${session}`
  let dir: string | undefined = encoded
  if (!(await $.fs.exists(encoded).catch(() => false))) {
    dir = undefined
    for (const p of await $.fs.list(projects).catch(() => [])) {
      const candidate = `${projects}/${p.name}/${session}`
      if (await $.fs.exists(candidate).catch(() => false)) {
        dir = candidate
        break
      }
    }
  }
  // A folder not there yet is looked up again next time instead of being held for the whole session.
  if (dir === undefined) return encoded
  sessionDirCache = { session, dir }
  return dir
}

// Same title Claude shows: the workflow's own description, not the prompt of whichever agent runs first.
// Only the script exists while a run is active; the run's final JSON is written when it ends.
// shortcut: the script is scanned as text, not evaluated.
function metaString(source: string, field: string): string {
  const start = source.search(/export\s+const\s+meta\s*=\s*\{/)
  if (start < 0) return ''
  const head = source.slice(start, start + 4000)
  const match = new RegExp(`(?:^|[\\s,{])${field}\\s*:\\s*`).exec(head)
  if (match === null) return ''
  let i = match.index + match[0].length
  const quote = head[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return ''
  let value = ''
  for (i += 1; i < head.length; i += 1) {
    const char = head[i]
    if (char === '\\') {
      value += head[i + 1] ?? ''
      i += 1
    } else if (char === quote) {
      return value.trim()
    } else {
      value += char
    }
  }
  return ''
}

// The script is written once at launch, so its mtime doubles as the run's start time.
async function workflowInfo(
  $: EngineInterface,
  dir: string,
  name: string,
): Promise<{ title: string; startedAt: number }> {
  const scripts = await $.fs.list(`${dir}/workflows/scripts`).catch(() => [])
  const script = scripts.find(f => f.kind === 'file' && f.name.endsWith(`-${name}.js`))
  if (script === undefined) return { title: name, startedAt: 0 }
  const path = `${dir}/workflows/scripts/${script.name}`
  const source = await $.fs.read(path).catch(() => '')
  return {
    title: metaString(source, 'description') || metaString(source, 'name') || name,
    startedAt: await mtime($, path),
  }
}

// The meta file is rewritten when an agent finishes, so the spawn time comes from the transcript's first line.
async function agentStart($: EngineInterface, path: string): Promise<number> {
  const line = await headLine($, path)
  if (line === undefined) return 0
  const match = line.match(/"timestamp":"([^"]+)"/)
  const ms = match === null ? Number.NaN : Date.parse(match[1])
  return Number.isNaN(ms) ? 0 : ms
}

// The conversation names a run by the task id its launch result carries; the run id only names the directory. That
// result is the one place the pair sits together, so a run launched before the pane looked needs a transcript scan.
// A miss is retried only after a pause: the result is written just after the run dir and may not be there yet.
const TASK_SCAN_MS = 30_000
let taskIds: { at: number; map: Map<string, string> } | undefined

async function taskIdMap($: EngineInterface, dir: string, names: readonly string[]): Promise<Map<string, string>> {
  if (taskIds !== undefined && names.every(name => taskIds?.map.has(name))) return taskIds.map
  const now = await $.clock.now()
  if (taskIds !== undefined && now - taskIds.at < TASK_SCAN_MS) return taskIds.map
  const map = taskIds?.map ?? new Map<string, string>()
  const found = await grepFile(
    $,
    `${dir}.jsonl`,
    '"taskId":"[^"]*","taskType":"local_workflow"[^}]*"runId":"[^"]*"',
    true,
  ).catch(() => undefined)
  for (const line of (found ?? '').split('\n')) {
    const pair = /^"taskId":"([^"]+)".*"runId":"([^"]+)"$/.exec(line)
    if (pair !== null) map.set(pair[2], pair[1])
  }
  taskIds = { at: now, map }
  return map
}

// The run dirs holding a .jsonl written within STALE_MS.
async function recentRuns($: EngineInterface, dir: string, now: number): Promise<Set<string>> {
  const root = `${dir}/subagents/workflows`
  if (await onWindows($)) {
    // No find: one listing per run dir, which carries each file's mtime without a stat.
    const names = new Set<string>()
    for (const run of await $.fs.list(root).catch(() => [])) {
      if (run.kind !== 'dir') continue
      const files = await $.fs.list(`${root}/${run.name}`).catch(() => [])
      if (files.some(f => f.kind === 'file' && f.name.endsWith('.jsonl') && now - f.mtimeMs <= STALE_MS)) {
        names.add(run.name)
      }
    }
    return names
  }
  // One find instead of a stat per run dir: a session accumulates hundreds of finished runs.
  const recent = await $.process
    .run(['/usr/bin/find', root, '-mindepth', '2', '-maxdepth', '2', '-name', '*.jsonl', '-mmin', `-${STALE_MS / 60_000}`])
    .catch(() => undefined)
  return new Set(
    (recent?.stdout ?? '').split('\n').flatMap(path => {
      const parts = path.split('/')
      return parts.length < 2 ? [] : [parts[parts.length - 2]]
    }),
  )
}

async function runningWorkflows($: EngineInterface): Promise<WorkflowRun[]> {
  const now = await $.clock.now()
  if (workflows !== undefined && now - workflows.at < 3_000) return workflows.list
  const dir = await sessionDir($)
  const names = await recentRuns($, dir, now)
  const list: WorkflowRun[] = []
  for (const name of names) {
    const root = `${dir}/subagents/workflows/${name}`
    const journal = `${root}/journal.jsonl`
    const journalAt = await mtime($, journal)
    if (journalAt === 0) continue
    // A resumed run keeps its id and appends to the old journal while the previous run's final JSON stays put,
    // so the run is over only once that JSON is at least as new as the journal.
    if ((await mtime($, `${dir}/workflows/${name}.json`)) >= journalAt) continue
    let at = 0
    // Fallback only: agent metas are rewritten when an agent finishes, so their mtimes are not spawn times.
    let earliest = now
    for (const f of await $.fs.list(root).catch(() => [])) {
      if (f.kind !== 'file') continue
      const time = await mtime($, `${root}/${f.name}`)
      if (time === 0) continue
      earliest = Math.min(earliest, time)
      if (f.name.endsWith('.jsonl')) at = Math.max(at, time)
    }
    if (now - at > STALE_MS) continue
    // Result lines carry the agent's whole output, so only their keys are read; started/failed lines are small and
    // read in journal order, since a failed attempt may be retried under the same key.
    const events = await grepFile($, journal, '"type":"(started|failed)"').catch(() => undefined)
    const results = await grepFile($, journal, '"type":"result","key":"[^"]*"', true).catch(() => undefined)
    if (events === undefined) continue
    const done = new Set(
      (results ?? '').split('\n').flatMap(line => {
        const at = line.indexOf('"key":"')
        return at < 0 ? [] : [line.slice(at + 7, -1)]
      }),
    )
    // A retried key is logged as started more than once; keep one row, for its latest attempt, until its result arrives.
    const pending = new Map<string, { label: string; phase: string; agentId: string }>()
    const failed = new Set<string>()
    for (const line of events.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        const key = String(row.key)
        if (done.has(key)) continue
        if (row.type === 'failed') {
          if (pending.get(key)?.agentId !== String(row.agentId ?? '')) continue
          pending.delete(key)
          failed.add(key)
          continue
        }
        failed.delete(key)
        pending.set(key, { label: String(row.label ?? name), phase: String(row.phase ?? ''), agentId: String(row.agentId ?? '') })
      } catch {
        // the engine may be halfway through writing the last line
      }
    }
    const agents: WorkflowRun['agents'] = []
    for (const { agentId, ...a } of pending.values()) {
      const usage = agentId === '' ? undefined : await agentUsage($, `${root}/agent-${agentId}.jsonl`)
      agents.push({ ...a, model: usage?.model ?? '', tokens: usage?.tokens })
    }
    const info = await workflowInfo($, dir, name)
    list.push({
      id: name,
      title: info.title,
      startedAt: info.startedAt > 0 ? info.startedAt : earliest,
      at,
      agents,
      done: done.size,
      failed: failed.size,
    })
  }
  if (list.length > 0) {
    const tasks = await taskIdMap($, dir, list.map(w => w.id)).catch(() => undefined)
    for (const w of list) w.task = tasks?.get(w.id) || undefined
  }
  workflows = { at: now, list }
  return list
}

type Activity = { at: number; agents: Record<string, number>; workflows: Record<string, number> }

// The engine reports no timestamps for agents or runs, so file mtimes stand in for them: agent transcripts are
// appended per turn, workflow journals per launch/result. The session transcript gets rewritten for bookkeeping
// (cost-state lines carry no timestamp), so it is read from its last timestamped line instead of its mtime.
// shortcut: a long silent tool call still reads as idle.
let activity: { at: number; value: Activity } | undefined

const mtime = async ($: EngineInterface, path: string) =>
  (await $.fs.stat(path).catch(() => undefined))?.mtimeMs ?? 0

async function transcriptTime($: EngineInterface, path: string): Promise<number> {
  // A window of the tail, not the whole (tens of MB) transcript.
  const out = await tailText($, path)
  if (out === undefined) return 0
  const stamps = [...out.matchAll(/"timestamp":"([^"]+)"/g)]
  const last = stamps[stamps.length - 1]
  const ms = last === undefined ? Number.NaN : Date.parse(last[1])
  return Number.isNaN(ms) ? 0 : ms
}

// The model and token count are recorded per assistant message. Claude's agent view shows the latest request's
// input side, i.e. the context the agent carries now, not the summed spend. Read the tail backwards.
// shortcut: a tail window smaller than the last tool result yields no model or tokens.
async function agentUsage($: EngineInterface, path: string): Promise<{ model: string; tokens: number | undefined }> {
  const out = await tailText($, path)
  if (out === undefined) return { model: '', tokens: undefined }
  const lines = out.split('\n')
  let model: string | undefined
  let tokens: number | undefined
  for (let i = lines.length - 1; i >= 0 && (model === undefined || tokens === undefined); i -= 1) {
    if (!lines[i].includes('"model"')) continue
    try {
      const message = JSON.parse(lines[i]).message
      if (model === undefined && typeof message?.model === 'string' && message.model !== '<synthetic>') {
        model = message.model
      }
      const usage = message?.usage
      if (tokens === undefined && usage !== undefined) {
        tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
      }
    } catch {
      // the window may start mid-line
    }
  }
  return { model: model ?? '', tokens }
}

async function lastActivity($: EngineInterface, runs: WorkflowRun[]): Promise<Activity> {
  const now = await $.clock.now()
  if (activity !== undefined && now - activity.at < 3_000) return activity.value
  const dir = await sessionDir($)
  const value: Activity = { at: await transcriptTime($, `${dir}.jsonl`), agents: {}, workflows: {} }
  for (const a of (await agentList($).catch(() => [])).filter(isActive)) {
    const at = await mtime($, `${dir}/subagents/agent-${a.id}.jsonl`)
    value.agents[a.id] = at
    value.at = Math.max(value.at, at)
  }
  for (const run of runs) {
    value.workflows[run.id] = run.at
    value.at = Math.max(value.at, run.at)
  }
  activity = { at: now, value }
  return value
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

const tone = (used: number) => (used >= 90 ? 'error' : used >= 70 ? 'warning' : undefined)

function resetIn(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function resetAt(resetsAt: number): string {
  const d = new Date(resetsAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function tokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  return value < 1000 ? String(value) : `${Number((value / 1000).toFixed(1))}k`
}

const MIN_COMPACT = 100_000
const MAX_COMPACT = 1_000_000

const envFlag = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())

function compactSize(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i)
  if (match === null) return undefined
  const unit = match[2]?.toLowerCase()
  const size = Number(match[1]) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1000 : 1)
  return Number.isFinite(size) && size > 0 ? Math.round(size) : undefined
}

// Window only, not the firing threshold: the summary buffer and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE lower that further.
async function compactSuffix($: EngineInterface, window: number | undefined): Promise<string> {
  if (typeof window !== 'number') return ''
  const settings = await compactSettings($)
  if (settings?.autoCompactEnabled === false) return ''
  let value: number | undefined
  try {
    const disabled = await $.env.get('DISABLE_AUTO_COMPACT')
    const noCompact = await $.env.get('DISABLE_COMPACT')
    if (envFlag(disabled) || envFlag(noCompact) ||
      envFlag(settings?.env?.DISABLE_AUTO_COMPACT) || envFlag(settings?.env?.DISABLE_COMPACT)) return ''
    value = compactSize(await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) ??
      compactSize(settings?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  } catch {
    value = compactSize(settings?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  }
  if (value === undefined) {
    let model: string | undefined
    try {
      const current = await $.session.model()
      model = typeof current === 'string' ? current : undefined
    } catch {
      model = undefined
    }
    const perModel = model === undefined ? undefined : settings?.modelSettings?.[model]?.autoCompactWindow
    value = compactSize(perModel) ?? compactSize(settings?.autoCompactWindow)
  }
  if (value === undefined) return ''
  const effective = Math.min(Math.max(value, MIN_COMPACT), MAX_COMPACT, window)
  return ` (cp ${tokenCount(effective)})`
}

// settings.read can be refused by the runtime, so the files remain the source of truth.
async function compactSettings($: EngineInterface): Promise<any> {
  const layer = async (path: string) => {
    try {
      const value = JSON.parse(await $.fs.read(path))
      return value !== null && typeof value === 'object' ? value : undefined
    } catch {
      return undefined
    }
  }
  const dir = await claudeDir($)
  const layers = [await layer(`${dir}/settings.json`), await layer(`${dir}/settings.local.json`)]
  try {
    const merged = await $.settings.read()
    if (merged !== null && typeof merged === 'object') layers.push(merged)
  } catch {
    // fall back to the files above
  }
  return Object.assign({}, ...layers.filter(Boolean))
}

export const register: Register = on => {
  let ticker: ReturnType<typeof setInterval> | undefined
  let beat: ReturnType<typeof setInterval> | undefined
  let paneTicker: ReturnType<typeof setInterval> | undefined
  let live = false
  let beats = 0

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await hidden($))) return next(e)
    if (ticker === undefined) {
      ticker = setInterval(() => {
        Promise.resolve($.ui.invalidate('ui.render')).catch(() => undefined)
      }, 60_000)
    }
    // A live view of running work needs a finer tick than the once-a-minute usage refresh; when idle, 15s is
    // enough to notice a background agent starting.
    if (beat === undefined) {
      beat = setInterval(() => {
        beats += 1
        if (live || beats % 3 === 0) Promise.resolve($.ui.invalidate('ui.render')).catch(() => undefined)
      }, 5_000)
    }
    const below = await next(e).catch(() => undefined)
    const { Box, Text, Button } = $.ui.resolve(e)
    const stack = (mine: NonNullable<typeof below>) =>
      below ? <Box flexDirection="column">{mine}{below}</Box> : mine

    const now = await $.clock.now()
    let u: Usage
    try {
      u = await usage($)
    } catch {
      u = { ...EMPTY, source: 'claude', error: 'usage unavailable' }
    }
    const showWhen = e.props.bodyColumns >= 100
    const context = await $.session.usage().then(result => result.context).catch(() => undefined)
    const contextLabel = typeof context?.tokens === 'number' && typeof context.window === 'number'
      ? `${tokenCount(context.tokens)}/${tokenCount(context.window)}`
      : ''
    const contextText = contextLabel === ''
      ? ''
      : `${contextLabel}${await compactSuffix($, context.window)}`
    const agentRows = await liveAgents($)
    const active = agentRows.length
    const wf = await runningWorkflows($).catch(() => [])
    const wfAgents = wf.reduce((n, w) => n + w.agents.length, 0)
    const totalAgents = active + wfAgents
    const act = await lastActivity($, wf).catch(() => undefined)
    live = active > 0 || wf.length > 0
    const badge = [
      wf.length > 0 ? `${wf.length} wf` : '',
      totalAgents > 0 ? `${totalAgents} agent${totalAgents === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const openAgents = async () => {
      const result = await $.ui
        .open({
          id: AGENTS_PANE,
          title: 'Agents',
          focus: true,
          closeOnEscape: true,
          rows: Math.min(20, totalAgents + 2 * wf.length + 3),
        })
        .catch(() => undefined)
      if (result !== undefined && result.isPlaced !== false) {
        await $.ui.invalidate('ui.render').catch(() => undefined)
        return
      }
      const lines = [
        ...agentRows.map(a => `${agentName(a)} · ${a.status}`),
        ...wf.flatMap(w => [
          `${w.title} · ${progress(w)}`,
          ...w.agents.map(a => `  ${[a.label, a.model, a.phase, a.tokens === undefined ? '' : `${tokenCount(a.tokens)} tokens`].filter(Boolean).join(' · ')}`),
        ]),
      ]
      $.ui.toast(lines.join('\n'), 8000)
    }

    if (u.error !== undefined && u.windows.length === 0) {
      return stack(
        <Box flexDirection="row" gap={2} alignItems="center" width={e.props.bodyColumns}>
          <Text dimColor>{u.source}</Text>
          {contextText !== '' && <Text dimColor>{contextText}</Text>}
        </Box>
      )
    }
    const shownPlan = u.source === 'proxy'
      ? `proxy${u.plan ? ` ${u.plan}` : ''}`
      : (await currentPlan($, u.plan)) || 'claude'

    return stack(
      // No width: the band stretches the row, and bodyColumns does not match the webview's width.
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" gap={2} alignItems="center">
          <Text bold>{shownPlan}</Text>
          {u.windows.map(w => (
            <Text key={w.key}>
              <Text dimColor>{w.label} </Text>
              <Text bold color={tone(w.used)}>{Math.round(w.used)}%</Text>
              {w.resetsAt !== null && (
                <Text dimColor>
                  {' '}↻ {resetIn(w.resetsAt, now)}
                  {showWhen ? ` (${resetAt(w.resetsAt)})` : ''}
                </Text>
              )}
            </Text>
          ))}
          {contextText !== '' && <Text dimColor>{contextText}</Text>}
          {badge !== '' && (
            <Button key="agents" plain onPress={openAgents}>
              <Text bold color="suggestion">
                {badge}
              </Text>
            </Button>
          )}
        </Box>
        {act !== undefined && act.at > 0 && <Text dimColor>activity: {ago(now - act.at)}</Text>}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== AGENTS_PANE) return next(e)
    // The band's 60s tick is too coarse for a live view; refresh only while this pane is open.
    if (paneTicker === undefined) {
      paneTicker = setInterval(() => {
        void (async () => {
          const open = await $.ui.panes().catch(() => [])
          if (Array.isArray(open) && open.some(p => p.id === AGENTS_PANE)) {
            await $.ui.invalidate('ui.render').catch(() => undefined)
          }
        })()
      }, 3_000)
    }
    const rows = await liveAgents($)
    const runs = await runningWorkflows($).catch(() => [])
    const now = await $.clock.now()
    const act = await lastActivity($, runs).catch(() => undefined)
    const dir = await sessionDir($).catch(() => '')
    const modelText = new Map<string, string>()
    const tokenText = new Map<string, string>()
    const startedAt = new Map<string, number>()
    for (const a of rows) {
      const path = `${dir}/subagents/agent-${a.id}.jsonl`
      const { model, tokens } = await agentUsage($, path)
      if (model !== '') modelText.set(a.id, ` · ${model}`)
      if (tokens !== undefined) tokenText.set(a.id, ` · ${tokenCount(tokens)} tokens`)
      const started = await agentStart($, path)
      if (started > 0) startedAt.set(a.id, started)
    }
    const timeline = (started: number | undefined, at: number | undefined) =>
      [
        started !== undefined && started > 0 ? `started: ${ago(now - started).replace(' ago', '')}` : '',
        at !== undefined && at > 0 ? `activity: ${ago(now - at)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    const { Box, Text, Button } = $.ui.resolve(e)
    const close = () => {
      $.ui.close({ id: AGENTS_PANE }).catch(() => undefined)
    }
    return (
      // No width: bodyColumns is narrower than the webview pane, so lines would truncate mid-pane.
      <Box flexDirection="column" gap={1}>
        {rows.length === 0 ? (
          <Text dimColor>{runs.length > 0 ? 'No direct agent — see Workflows below' : 'No agent running'}</Text>
        ) : (
          rows.map(a => {
            const span = timeline(startedAt.get(a.id), act?.agents[a.id])
            return (
              <Box key={a.id} flexDirection="column">
                {/* Same shape as a workflow: the name on top, id and the rest on the line below. */}
                <Text bold wrap="truncate-end">
                  {agentName(a)}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {a.id.slice(0, 8)}
                  {' · '}
                  {a.type === 'in_process_teammate' ? 'teammate' : 'subagent'}
                  {modelText.get(a.id) ?? ''}
                  {' · '}
                  {a.status}
                  {tokenText.get(a.id) ?? ''}
                  {span === '' ? '' : ` · ${span}`}
                </Text>
              </Box>
            )
          })
        )}
        {runs.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              Workflows ({runs.length})
            </Text>
            {runs.map(w => {
              const span = timeline(w.startedAt, act?.workflows[w.id])
              return (
                <Box key={w.id} flexDirection="column">
                  <Text bold wrap="truncate-end">
                    {w.title}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {w.task ?? w.id} · {progress(w)}
                    {span === '' ? '' : ` · ${span}`}
                  </Text>
                  {w.agents.map((a, i) => (
                    <Text key={`${w.id}-${i}`} wrap="truncate-end">
                      <Text dimColor>{'- '}</Text>
                      <Text bold>{a.label}</Text>
                      <Text dimColor>
                        {[a.model, a.phase, a.tokens === undefined ? '' : `${tokenCount(a.tokens)} tokens`]
                          .filter(Boolean)
                          .map(part => ` · ${part}`)
                          .join('')}
                      </Text>
                    </Text>
                  ))}
                </Box>
              )
            })}
          </Box>
        )}
        <Button key="close" plain label="Close" onPress={close} />
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
