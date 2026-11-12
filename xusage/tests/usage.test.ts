import { afterEach, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sourcePath = new URL('../hooks/band/register.tsx', import.meta.url)
const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

async function loadModule() {
  const source = await Bun.file(sourcePath).text()
  const js = new Bun.Transpiler({
    loader: 'tsx',
    tsconfig: JSON.stringify({ compilerOptions: { jsx: 'react', jsxFactory: 'h' } }),
  }).transformSync(`${source}\nexport { usage, tailText, headLine, grepFile };`)
  const url = `data:text/javascript;base64,${Buffer.from(`${js}\n// ${crypto.randomUUID()}`).toString('base64')}`
  return await import(url)
}

async function loadUsage() {
  return (await loadModule()).usage as ($: any) => Promise<any>
}

type FetchResult = { status: number; ok: boolean; headers: Record<string, string>; text: string }

function engine(
  fetch: () => Promise<FetchResult>,
  sharedRoot?: string,
  oauth: Record<string, unknown> = { subscriptionType: 'max' },
) {
  let now = Math.floor(Date.now() / 1000) * 1000
  let calls = 0
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), 'xusage-test-'))
  roots.add(root)
  const $ = {
    clock: { now: async () => now },
    env: {
      get: async (name: string) => {
        if (name === 'USAGE_BAND_SOURCE') return 'claude'
        if (name === 'CLAUDE_CONFIG_DIR') return root
        // The module picks its Windows paths from these.
        if (name === 'OS' || name === 'SystemRoot') return process.env[name]
        return undefined
      },
    },
    fs: {
      // Windows has no Keychain, so the module reads the credentials file there.
      read: async (path: string) => path.endsWith('.credentials.json')
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', ...oauth } })
        : await Bun.file(path).text(),
      write: async (path: string, text: string) => { await Bun.write(path, text) },
      stat: async (path: string) => {
        const stat = await import('node:fs/promises').then(fs => fs.stat(path))
        return { size: stat.size, mtimeMs: stat.mtimeMs }
      },
    },
    process: {
      run: async (command: string[]) => {
        if (command[0] === '/usr/bin/security') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', ...oauth } }),
          }
        }
        const child = Bun.spawn({ cmd: command, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { exitCode, stdout, stderr }
      },
    },
    http: {
      fetch: async () => {
        calls += 1
        return fetch()
      },
    },
  }
  return {
    $,
    root,
    calls: () => calls,
    now: () => now,
    advance: (ms: number) => { now += ms },
  }
}

const ok = (used: number): FetchResult => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({ five_hour: { utilization: used, resets_at: '2026-10-27T10:00:00Z' } }),
})

const limited = (retryAfter?: string): FetchResult => ({
  status: 429,
  ok: false,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  text: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests' } }),
})

test('keeps last-known-good usage and honors Retry-After after a 429', async () => {
  const usage = await loadUsage()
  const responses = [ok(12), limited('120'), ok(34)]
  const env = engine(async () => {
    const response = responses.shift()
    if (response === undefined) throw new Error('unexpected request')
    return response
  })

  expect((await usage(env.$)).windows[0].used).toBe(12)
  env.advance(30_001)
  const stale = await usage(env.$)
  expect(stale.windows[0].used).toBe(12)
  expect(stale.error).toBe('usage request failed')

  env.advance(119_999)
  expect((await usage(env.$)).windows[0].used).toBe(12)
  expect(env.calls()).toBe(2)

  env.advance(1)
  expect((await usage(env.$)).windows[0].used).toBe(34)
  expect(env.calls()).toBe(3)
})

test('backs off for five minutes when a 429 has no Retry-After', async () => {
  const usage = await loadUsage()
  const env = engine(async () => limited())

  expect((await usage(env.$)).error).toBe('usage request failed')
  env.advance(299_999)
  expect((await usage(env.$)).error).toBe('usage request failed')
  expect(env.calls()).toBe(1)

  env.advance(1)
  await usage(env.$)
  expect(env.calls()).toBe(2)
})

test('caps Retry-After backoff at one hour', async () => {
  const usage = await loadUsage()
  const env = engine(async () => limited('7200'))

  await usage(env.$)
  env.advance(3_599_999)
  await usage(env.$)
  expect(env.calls()).toBe(1)

  env.advance(1)
  await usage(env.$)
  expect(env.calls()).toBe(2)
})

test('accepts an HTTP-date Retry-After', async () => {
  const usage = await loadUsage()
  const env = engine(async () => limited(new Date(env.now() + 120_000).toUTCString()))

  await usage(env.$)
  env.advance(119_999)
  await usage(env.$)
  expect(env.calls()).toBe(1)

  env.advance(1)
  await usage(env.$)
  expect(env.calls()).toBe(2)
})

test('deduplicates concurrent usage requests', async () => {
  const usage = await loadUsage()
  const releases: ((response: FetchResult) => void)[] = []
  const env = engine(() => new Promise(resolve => { releases.push(resolve) }))

  const first = usage(env.$)
  const second = usage(env.$)
  while (releases.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  for (const release of releases) release(ok(12))
  const results = await Promise.all([first, second])

  expect(results.map(result => result.windows[0].used)).toEqual([12, 12])
  expect(env.calls()).toBe(1)
})

test('shares one request across independent windows', async () => {
  const [firstUsage, secondUsage] = await Promise.all([loadUsage(), loadUsage()])
  const releases: ((response: FetchResult) => void)[] = []
  let calls = 0
  const fetch = () => {
    calls += 1
    return new Promise<FetchResult>(resolve => { releases.push(resolve) })
  }
  const firstEnv = engine(fetch)
  const secondEnv = engine(fetch, firstEnv.root)

  const first = firstUsage(firstEnv.$)
  const second = secondUsage(secondEnv.$)
  while (releases.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  for (const release of releases) release(ok(12))
  const results = await Promise.all([first, second])

  expect(results.map(result => result.windows[0].used)).toEqual([12, 12])
  expect(calls).toBe(1)
})

test('shares rate-limit backoff across independent windows', async () => {
  const [firstUsage, secondUsage] = await Promise.all([loadUsage(), loadUsage()])
  const firstEnv = engine(async () => limited('120'))
  const secondEnv = engine(async () => { throw new Error('unexpected request') }, firstEnv.root)

  const first = await firstUsage(firstEnv.$)
  const second = await secondUsage(secondEnv.$)

  expect(second.error).toBe('usage request failed')
  expect(second.retryAt).toBe(first.retryAt)
  expect(firstEnv.calls()).toBe(1)
  expect(secondEnv.calls()).toBe(0)
})

test('recovers a stale cache lock left by a closed window', async () => {
  const usage = await loadUsage()
  const env = engine(async () => ok(12))
  const lock = join(env.root, 'xusage-cache.json.lock')
  mkdirSync(lock)
  const stale = new Date(env.now() - 31_000)
  utimesSync(lock, stale, stale)

  expect((await usage(env.$)).windows[0].used).toBe(12)
  expect(env.calls()).toBe(1)
})

test('takes the cache lock under a path with spaces and shell metacharacters', async () => {
  const usage = await loadUsage()
  const root = mkdtempSync(join(tmpdir(), "xusage test & (it's) %x%-"))
  const env = engine(async () => ok(12), root)

  expect((await usage(env.$)).windows[0].used).toBe(12)
  expect(existsSync(join(root, 'xusage-cache.json'))).toBe(true)
  expect(existsSync(join(root, 'xusage-cache.json.lock'))).toBe(false)
})

// Over $.fs.read's 4 MiB cap, the Windows build reads through PowerShell instead of the host.
test('reads the head, tail and matches of a file over 4 MiB', async () => {
  const { tailText, headLine, grepFile } = await loadModule()
  const env = engine(async () => ok(12))
  const path = join(env.root, 'big.jsonl')
  const filler = `${JSON.stringify({ type: 'progress', text: 'x'.repeat(1000) })}\n`
  await Bun.write(
    path,
    [
      `${JSON.stringify({ type: 'user', timestamp: '2026-10-30T01:00:00.000Z', text: 'xin chào' })}\n`,
      `${JSON.stringify({ type: 'started', key: 'k1' })}\n`,
      filler.repeat(4500),
      `${JSON.stringify({ type: 'result', key: 'k1' })}\n`,
      `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-30T02:00:00.000Z' })}\n`,
    ].join(''),
  )

  expect(await headLine(env.$, path)).toContain('"timestamp":"2026-10-30T01:00:00.000Z"')
  expect(await headLine(env.$, path)).toContain('xin chào')
  const tail = await tailText(env.$, path)
  expect(tail.length).toBeLessThanOrEqual(262_144)
  expect(tail).toEndWith('"timestamp":"2026-10-30T02:00:00.000Z"}\n')
  expect(await grepFile(env.$, path, '"type":"(started|failed)"')).toBe(`${JSON.stringify({ type: 'started', key: 'k1' })}\n`)
  expect(await grepFile(env.$, path, '"type":"result","key":"[^"]*"', true)).toBe('"type":"result","key":"k1"\n')
  expect(await grepFile(env.$, path, '"type":"missing"')).toBe('')
  expect(await tailText(env.$, join(env.root, 'absent.jsonl'))).toBeUndefined()
})

test('renders compact usage labels without retry errors', async () => {
  const { register } = await loadModule()
  const oauth = { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }
  const responses = [limited('120'), ok(12), ok(12), ok(12)]
  const env = engine(async () => {
    const response = responses.shift()
    if (response === undefined) throw new Error('unexpected request')
    return response
  }, undefined, oauth)
  let render: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'AbovePrompt') render = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  let context: { tokens?: number; window: number } = { tokens: 42_000, window: 1_000_000 }
  let settings: any = { autoCompactWindow: 400_000 }
  const envValues: Record<string, string> = {}
  const $ = {
    ...env.$,
    env: { get: async (name: string) => envValues[name] ?? env.$.env.get(name) },
    agent: { list: async () => [] },
    fs: {
      ...env.$.fs,
      // The module joins with '/', which join() spells '\' on Windows.
      read: async (path: string) => path.replace(/\\/g, '/') === `${env.root.replace(/\\/g, '/')}/settings.json`
        ? JSON.stringify(settings)
        : env.$.fs.read(path),
      list: async () => [],
    },
    settings: { read: async () => { throw new Error('settings.read refused') } },
    session: { usage: async () => ({ context }), model: async () => 'claude-opus-5' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }
  const warning = (node: any): any => {
    if (node == null || typeof node !== 'object') return undefined
    if (node.props?.key === 'usage-error') return node
    return (node.children ?? []).map(warning).find(Boolean)
  }
  const tone = (node: any, color: string): any => {
    if (node == null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) return node.map((child: any) => tone(child, color)).find(Boolean)
    if (node.props?.color === color) return node
    return (node.children ?? []).map((child: any) => tone(child, color)).find(Boolean)
  }

  try {
    const event = { props: { hasSurvey: false, bodyColumns: 120 } }
    const first = await render($, event, async () => undefined)
    expect(text(first)).toContain('42k/1M (cp 400k)')
    expect(text(first)).not.toContain('usage request failed')
    expect(text(first)).not.toContain('retry in')
    expect(warning(first)).toBeUndefined()
    expect(tone(first, 'warning')).toBeUndefined()
    env.advance(120_000)
    const second = await render($, event, async () => undefined)
    expect(text(second)).toContain('max20')
    expect(text(second)).toContain('12%')
    expect(text(second)).toContain('42k/1M')
    expect(text(second).indexOf('42k/1M')).toBeGreaterThan(text(second).indexOf('12%'))
    expect(text(second)).not.toContain('usage request failed')
    expect(text(second)).not.toContain('retry in')
    expect(warning(second)).toBeUndefined()
    const narrow = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(narrow)).toContain('(cp 400k)')
    const mid = await render($, { props: { hasSurvey: false, bodyColumns: 95 } }, async () => undefined)
    expect(text(mid)).toContain('(cp 400k)')
    envValues.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '250k'
    const envWindow = await render($, event, async () => undefined)
    expect(text(envWindow)).toContain('42k/1M (cp 250k)')
    envValues.DISABLE_AUTO_COMPACT = '1'
    const disabled = await render($, event, async () => undefined)
    expect(text(disabled)).not.toContain('(cp ')
    delete envValues.DISABLE_AUTO_COMPACT
    delete envValues.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    settings = { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300k' } }
    const settingsEnv = await render($, event, async () => undefined)
    expect(text(settingsEnv)).toContain('42k/1M (cp 300k)')
    settings = { autoCompactWindow: 'auto' }
    const auto = await render($, event, async () => undefined)
    expect(text(auto)).not.toContain('(cp ')
    settings = { autoCompactEnabled: false, modelSettings: { 'claude-opus-5': { autoCompactWindow: 200_000 } } }
    const off = await render($, event, async () => undefined)
    expect(text(off)).not.toContain('(cp ')
    settings = { modelSettings: { 'claude-opus-5': { autoCompactWindow: 200_000 } } }
    const perModel = await render($, event, async () => undefined)
    expect(text(perModel)).toContain('(cp 200k)')
    settings = {}
    const none = await render($, event, async () => undefined)
    expect(text(none)).not.toContain('(cp ')
    settings = { autoCompactWindow: 400_000 }
    context = { tokens: 1_200_000, window: 1_000_000 }
    const millions = await render($, event, async () => undefined)
    expect(text(millions)).toContain('1.2M/1M')
    expect(text(tone(millions, 'warning'))).toBe('1.2M/1M (cp 400k)')
    context = { tokens: 1_000_000, window: 1_000_000 }
    const exactMillion = await render($, event, async () => undefined)
    expect(text(exactMillion)).toContain('1M/1M')
    context = { window: 258_000 }
    const unmeasured = await render($, event, async () => undefined)
    expect(text(unmeasured)).not.toContain('/258k')
    oauth.rateLimitTier = 'default_claude_max_5x'
    env.advance(300_001)
    const five = await render($, event, async () => undefined)
    expect(text(five)).toContain('max5')
    oauth.rateLimitTier = 'default_claude_max_6_5x'
    env.advance(300_001)
    const sixPointFive = await render($, event, async () => undefined)
    expect(text(sixPointFive)).toContain('max6.5')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('titles a running workflow with its script meta and names it by task id', async () => {
  const { register } = await loadModule()
  const env = engine(async () => ok(12))
  const session = 'sess-1'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const started = JSON.stringify({ type: 'started', key: 'S3-r2', agentId: 'a1', label: 'review-S8-r1', phase: 'S8' })
  const run = async (name: string) => {
    const root = join(dir, 'subagents', 'workflows', name)
    mkdirSync(root, { recursive: true })
    await Bun.write(join(root, 'journal.jsonl'), `${started}\n`)
    await Bun.write(
      join(root, 'agent-a1.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - 305_000).toISOString(),
        perTurnEffort: 'high',
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 1, cache_read_input_tokens: 49_999 },
          content: [{
            type: 'tool_use',
            id: 'tu_wf',
            name: 'Bash',
            input: { command: 'xcodebuild ...', description: 'Poll build' },
          }],
        },
      })}\n${JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_wf', content: 'ok' }] },
      })}\n`,
    )
    const past = new Date(Date.now() - 305_000)
    utimesSync(join(root, 'agent-a1.jsonl'), past, past)
  }
  await run('wf_abc')
  await run('wf_plain')
  // The Workflow tool's result is the only place a run's task id and run id sit side by side.
  await Bun.write(
    `${dir}.jsonl`,
    `${JSON.stringify({
      type: 'user',
      toolUseResult: {
        status: 'async_launched',
        taskId: 'wft7bs6ek',
        taskType: 'local_workflow',
        workflowName: 'zigavn-task3',
        runId: 'wf_abc',
        summary: 'S3 test-gap round 2 + review, then S4 -> S8',
      },
    })}\n`,
  )
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  await Bun.write(
    join(dir, 'subagents', 'agent-b2.jsonl'),
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - 4_830_000).toISOString(),
        message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1_000, output_tokens: 5 } },
      }),
      JSON.stringify({
        type: 'assistant',
        perTurnEffort: 'xhigh',
        message: {
          model: 'claude-opus-5-5',
          usage: { input_tokens: 2, cache_read_input_tokens: 129_349, cache_creation_input_tokens: 465, output_tokens: 191 },
        },
      }),
      '',
    ].join('\n'),
  )
  mkdirSync(join(dir, 'workflows', 'scripts'), { recursive: true })
  await Bun.write(
    join(dir, 'workflows', 'scripts', 'zigavn-task3-wf_abc.js'),
    [
      'export const meta = {',
      "  name: 'zigavn-task3',",
      "  description: 'S3 test-gap round 2 + review, then S4 -> S8',",
      "  phases: [{ title: 'S3' }, { title: 'Chain' }]",
      '};',
      '',
    ].join('\n'),
  )
  const past = new Date(Date.now() - 305_000)
  utimesSync(join(dir, 'workflows', 'scripts', 'zigavn-task3-wf_abc.js'), past, past)
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  // React drops falsy children, so the index-based assertions below should not see them either.
  globalThis.h = ((type: any, props: any, ...children: any[]) =>
    ({ type, props, children: children.filter(child => child !== false && child != null) })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    agent: {
      list: async () => [
        { id: 'b2', description: 'Implement top-up bonus rate', type: 'local_agent', status: 'running' },
      ],
    },
    fs: {
      ...env.$.fs,
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => session, root: async () => '/tmp/work', cwd: async () => '/tmp/work/sub' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }

  try {
    const rendered = await pane($, { requestId: 'usage-band-agents' }, async () => undefined)
    expect(text(rendered)).toContain('S3 test-gap round 2 + review, then S4 -> S8')
    expect(text(rendered)).toContain('review-S8-r1')
    expect(text(rendered)).toContain('wft7bs6ek')
    expect(text(rendered).indexOf('S3 test-gap round 2 + review, then S4 -> S8')).toBeLessThan(
      text(rendered).indexOf('wft7bs6ek'),
    )
    expect(text(rendered)).toContain('wf_plain')
    const find = (node: any, key: string): any => {
      if (node == null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child, key)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      if (node.props?.key === key) return node
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const hit = find(child, key)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    const wfBox = find(rendered, 'wf_abc')
    expect(text(wfBox.children[0])).toBe('S3 test-gap round 2 + review, then S4 -> S8')
    expect(text(wfBox.children[1])).toBe('wft7bs6ek · 1 running · started: 5m · activity: now')
    const runningSpan = wfBox.children[1].children.find((child: any) => child?.props?.color === 'success')
    expect(text(runningSpan)).toBe('1 running')
    const wfAgent = find(rendered, 'wf_abc-0')
    expect(text(wfAgent.children[0])).toBe('- review-S8-r1 · claude-opus-5 · high · S8 · 50k tokens')
    expect(text(wfAgent.children[1])).toBe('  Poll build')
    expect(text(wfAgent.children[2])).toBe('  started: 5m · activity: 5m ago')
    expect(text(rendered)).toContain('Agents (1)')
    const agentBox = find(rendered, 'b2')
    expect(text(agentBox.children[0])).toBe('Implement top-up bonus rate')
    expect(text(agentBox.children[1])).toBe('b2 · subagent · claude-opus-5-5 · xhigh · running · 130k tokens')
    expect(text(agentBox.children[2])).toBe('started: 1h20m · activity: now')
    expect(text(rendered)).toContain('130k tokens')
    expect(text(rendered)).toContain('50k tokens')
    expect(text(rendered)).toContain('started: 1h20m · activity: now')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('titles a saved workflow whose script has no run id', async () => {
  const { register } = await loadModule()
  const env = engine(async () => ok(12))
  const session = 'sess-saved'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_saved')
  mkdirSync(root, { recursive: true })
  const agentAt = new Date(env.now() - 305_000)
  await Bun.write(
    join(root, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'v2:1', agentId: 'a1', label: 'impl:0', phase: 'Tasks' })}\n`,
  )
  await Bun.write(
    join(root, 'agent-a1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: agentAt.toISOString(),
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 2 } },
    })}\n`,
  )
  utimesSync(join(root, 'agent-a1.jsonl'), agentAt, agentAt)
  // A saved workflow keeps one script per definition, with no run-id suffix; the launch result names it.
  await Bun.write(
    `${dir}.jsonl`,
    `${JSON.stringify({
      type: 'user',
      toolUseResult: {
        status: 'async_launched',
        taskId: 'w9f9oj61k',
        taskType: 'local_workflow',
        workflowName: 'kitrs-r9-close-execute',
        runId: 'wf_saved',
        summary: 'Execute the R9 close',
        scriptPath: `${dir}/workflows/scripts/kitrs-r9-close-execute.js`,
      },
    })}\n`,
  )
  mkdirSync(join(dir, 'workflows', 'scripts'), { recursive: true })
  const script = join(dir, 'workflows', 'scripts', 'kitrs-r9-close-execute.js')
  await Bun.write(
    script,
    [
      'export const meta = {',
      "  name: 'kitrs-r9-close-execute',",
      "  description: 'Execute the R9 close: implement, review, fix loop per task',",
      "  phases: [{ title: 'Tasks' }, { title: 'Final review' }],",
      '}',
      '',
    ].join('\n'),
  )
  const daysOld = new Date(Date.now() - 3 * 24 * 60 * 60_000)
  utimesSync(script, daysOld, daysOld)
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    agent: { list: async () => [] },
    fs: {
      ...env.$.fs,
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => session, root: async () => '/tmp/work', cwd: async () => '/tmp/work' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }

  try {
    const rendered = await pane($, { requestId: 'usage-band-agents' }, async () => undefined)
    expect(text(rendered)).toContain('Execute the R9 close: implement, review, fix loop per task')
    expect(text(rendered)).toContain('w9f9oj61k · 1 running · started: 5m')
    expect(text(rendered)).toContain('impl:0')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('keeps last-known-good rows when a pane read fails', async () => {
  const { register } = await loadModule()
  const env = engine(async () => ok(12))
  const session = 'sess-keep'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_keep')
  mkdirSync(root, { recursive: true })
  await Bun.write(
    join(root, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'S1', agentId: 'a1', label: 'keeper', phase: 'S1' })}\n`,
  )
  await Bun.write(
    join(root, 'agent-a1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date(env.now() - 60_000).toISOString(),
      message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 2 } },
    })}\n`,
  )
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  let failScan = false
  let failJournal = false
  let failAgents = false
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    process: {
      run: async (command: string[]) => {
        if (failScan && command[0] === '/usr/bin/find' && command.some(arg => arg.endsWith('/subagents/workflows'))) {
          throw new Error('scan failed')
        }
        if (failJournal && command[0] === '/usr/bin/grep' && command[command.length - 1].endsWith('/journal.jsonl')) {
          throw new Error('journal read failed')
        }
        return await env.$.process.run(command)
      },
    },
    agent: {
      list: async () => {
        if (failAgents) throw new Error('agent list failed')
        return [{ id: 'b1', description: 'Direct worker', type: 'local_agent', status: 'running' }]
      },
    },
    fs: {
      ...env.$.fs,
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => session, root: async () => '/tmp/work', cwd: async () => '/tmp/work' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }
  const frame = async () => {
    env.advance(3_100)
    return text(await pane($, { requestId: 'usage-band-agents' }, async () => undefined))
  }

  try {
    const first = await frame()
    expect(first).toContain('Workflows (1)')
    expect(first).toContain('keeper')
    expect(first).toContain('Agents (1)')
    expect(first).toContain('Direct worker')

    failScan = true
    const noScan = await frame()
    expect(noScan).toContain('Workflows (1)')
    expect(noScan).toContain('keeper')
    failScan = false

    failJournal = true
    const noJournal = await frame()
    expect(noJournal).toContain('Workflows (1)')
    expect(noJournal).toContain('keeper')
    failJournal = false

    failAgents = true
    const noAgents = await frame()
    expect(noAgents).toContain('Agents (1)')
    expect(noAgents).toContain('Direct worker')
    expect(noAgents).toContain('Workflows (1)')
    failAgents = false

    const healed = await frame()
    expect(healed).toContain('Workflows (1)')
    expect(healed).toContain('keeper')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('names the last tool a live agent started', async () => {
  const { register } = await loadModule()
  const env = engine(async () => ok(12))
  const session = 'sess-tool'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  const stamp = (offset: number) => new Date(env.now() - offset).toISOString()
  const transcript = join(dir, 'subagents', 'agent-a1.jsonl')
  await Bun.write(
    transcript,
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: stamp(30_000),
        message: {
          model: 'claude-opus-5-5',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{
            type: 'tool_use',
            id: 'tu-live',
            name: 'Bash',
            input: { command: 'sed -i ...', description: 'Replace $OUT/evidence uses with $EV' },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-live', content: 'done' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: stamp(11_000),
        message: {
          model: 'claude-opus-5-5',
          usage: { input_tokens: 2, cache_read_input_tokens: 129_349, cache_creation_input_tokens: 465, output_tokens: 191 },
          content: [{
            type: 'tool_use',
            id: 'tu-done',
            name: 'Read',
            input: { file_path: '/tmp/work/sub/a.ts' },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-done', content: 'ok' }] },
      }),
      '',
    ].join('\n'),
  )
  utimesSync(transcript, new Date(env.now()), new Date(env.now()))
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    agent: {
      list: async () => [
        { id: 'a1', description: 'Author Task 23 USER-RUN script', type: 'local_agent', status: 'running' },
      ],
    },
    fs: {
      ...env.$.fs,
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => session, root: async () => '/tmp/work', cwd: async () => '/tmp/work/sub' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }
  const find = (node: any, key: string): any => {
    if (node == null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, key)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (node.props?.key === key) return node
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const hit = find(child, key)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  try {
    const rendered = await pane($, { requestId: 'usage-band-agents' }, async () => undefined)
    expect(text(rendered)).toContain('Agents (1)')
    const agentBox = find(rendered, 'a1')
    expect(text(agentBox.children[0])).toBe('Author Task 23 USER-RUN script')
    expect(text(agentBox.children[1])).toBe('a1 · subagent · claude-opus-5-5 · running · 130k tokens')
    expect(text(agentBox.children[2])).toBe('Reading a.ts')
    expect(text(agentBox.children[3])).toBe('started: 30s · activity: now')
    // Only the newest tool, even though both already have results.
    expect(text(agentBox.children[2])).not.toContain('Replace $OUT/evidence uses with $EV')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('shows background tasks and marks a dead silent one stale', async () => {
  const { register } = await loadModule()
  const boot = Date.now()
  const env = engine(async () => ok(12))
  const session = 'sess-bg'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  const tasks = join(env.root, 'bg-tasks')
  mkdirSync(tasks, { recursive: true })
  const now = boot + 30_000
  const output = async (id: string, at = now) => {
    const path = join(tasks, `${id}.output`)
    await Bun.write(path, 'out')
    utimesSync(path, new Date(at), new Date(at))
    return path
  }
  const livePath = await output('blive123')
  const subPath = await output('bsub123')
  const oldPath = await output('bpre1234', boot - 7_200_000)
  const launch = (tool: string, id: string, path: string, at: number, label: string) => [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      message: {
        content: [{
          type: 'tool_use',
          id: tool,
          name: 'Bash',
          input: { command: 'bash run-lanes.sh', description: label, run_in_background: true },
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(at).toISOString(),
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: tool,
          content: `Command running in background with ID: ${id}. Output is being written to: ${path}. You will be notified when it completes.`,
        }],
      },
    }),
  ].join('\n')
  await Bun.write(
    `${dir}.jsonl`,
    [
      launch('tu1', 'blive123', livePath, boot, 'Run lanes per class'),
      launch('tu2', 'bstale12', join(tasks, 'bstale12.output'), boot, 'One-off cleanup'),
      launch('tu3', 'bnotif12', livePath, boot, 'Already done'),
      launch('tu4', 'bstop123', livePath, boot, 'Stopped by model'),
      launch('tu5', 'bpre1234', oldPath, boot - 7_200_000, 'Previous process'),
      launch('tu6', 'bold1234', join(tasks, 'bold1234.output'), boot - 90_000_000, 'Ancient task'),
      JSON.stringify({
        type: 'queue-operation',
        content: '<task-notification>\n<task-id>bnotif12</task-id>\n<status>completed</status>\n</task-notification>',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu9', name: 'TaskStop', input: { task_id: 'bstop123' } }] },
      }),
    ].join('\n') + '\n',
  )
  await Bun.write(
    join(dir, 'subagents', 'agent-sub1.jsonl'),
    `${launch('tu7', 'bsub123', subPath, boot, 'Subagent bg')}\n`,
  )
  let pane: any
  let band: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    if (filter.component === 'AbovePrompt') band = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    clock: { now: async () => now },
    process: {
      run: async (command: string[]) => command[0].endsWith('/lsof')
        ? {
          exitCode: 0,
          stdout: [livePath, subPath].map((path, i) => `p${i + 1}\nf1\nn${path}`).join('\n'),
          stderr: '',
        }
        : env.$.process.run(command),
    },
    agent: { list: async () => [] },
    fs: {
      ...env.$.fs,
      stat: async (path: string) => path === '/usr/sbin/lsof' || path === '/usr/bin/lsof'
        ? { size: 1, mtimeMs: 0 }
        : env.$.fs.stat(path),
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: {
      id: async () => session,
      root: async () => '/tmp/work',
      cwd: async () => '/tmp/work/sub',
      usage: async () => ({ context: { tokens: 42_000, window: 258_000 } }),
    },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }
  const find = (node: any, key: string): any => {
    if (node == null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, key)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (node.props?.key === key) return node
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const hit = find(child, key)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  // Windows has no lsof: the module asks PowerShell for an exclusive open, which only an open handle can refuse.
  const held = process.env.OS === 'Windows_NT' ? [livePath, subPath].map(path => openSync(path, 'a')) : []

  try {
    const rendered = await pane($, { requestId: 'usage-band-agents' }, async () => undefined)
    expect(text(rendered)).toContain('Background (3)')
    expect(text(rendered)).toContain('Run lanes per class')
    expect(text(rendered)).toContain('Subagent bg')
    const live = find(rendered, 'bg-blive123')
    expect(text(live.children[0])).toBe('Run lanes per class')
    expect(text(live.children[1])).toBe('blive123 · started: 30s · activity: now · running')
    const stale = find(rendered, 'bg-bstale12')
    expect(text(stale.children[1])).toBe('bstale12 · started: 30s · stale')
    const sub = find(rendered, 'bg-bsub123')
    expect(text(sub.children[1])).toBe('bsub123 · started: 30s · activity: now · running')
    expect(text(rendered)).not.toContain('Already done')
    expect(text(rendered)).not.toContain('Stopped by model')
    expect(text(rendered)).not.toContain('Previous process')
    expect(text(rendered)).not.toContain('Ancient task')
    const bar = await band($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(bar)).toContain('2 bg · 1 stale')
    const staleSpan = find(bar, 'agents').children[0].children.find((child: any) => child?.props?.color === 'warning')
    expect(text(staleSpan)).toBe(' · 1 stale')
  } finally {
    for (const handle of held) closeSync(handle)
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('marks a background task unverified when liveness cannot be probed', async () => {
  const { register } = await loadModule()
  const boot = Date.now()
  const env = engine(async () => ok(12))
  const session = 'sess-bg-unknown'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-unknown')
  mkdirSync(tasks, { recursive: true })
  const now = boot + 30_000
  const path = join(tasks, 'bunkn123.output')
  await Bun.write(path, 'out')
  utimesSync(path, new Date(now), new Date(now))
  await Bun.write(
    `${dir}.jsonl`,
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(boot).toISOString(),
        message: {
          content: [{
            type: 'tool_use',
            id: 'tu1',
            name: 'Bash',
            input: { command: 'sleep 600', description: 'Probe me', run_in_background: true },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(boot).toISOString(),
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: `Command running in background with ID: bunkn123. Output is being written to: ${path}. You will be notified when it completes.`,
          }],
        },
      }),
    ].join('\n') + '\n',
  )
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    clock: { now: async () => now },
    process: {
      // Windows probes through PowerShell instead of lsof, so both have to fail.
      run: async (command: string[]) => command[0].endsWith('/lsof') || command[0].endsWith('powershell.exe')
        ? { exitCode: 2, stdout: '', stderr: 'probe failed' }
        : env.$.process.run(command),
    },
    agent: { list: async () => [] },
    fs: {
      ...env.$.fs,
      stat: async (p: string) => p === '/usr/sbin/lsof' || p === '/usr/bin/lsof'
        ? { size: 1, mtimeMs: 0 }
        : env.$.fs.stat(p),
      exists: async (p: string) => existsSync(p),
      list: async (p: string) =>
        readdirSync(p, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(p, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => session, root: async () => '/tmp/work', cwd: async () => '/tmp/work/sub' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }

  try {
    const rendered = await pane($, { requestId: 'usage-band-agents' }, async () => undefined)
    expect(text(rendered)).toContain('Background (1)')
    expect(text(rendered)).toContain('bunkn123 · started: 30s · activity: now · unverified')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

// A pane harness for the background-task tests: lsof reports the listed outputs alive, every process.run
// stdout is capped like the host caps it, and the test controls the clock.
async function paneHarness(
  env: ReturnType<typeof engine>,
  options: { session: string; now: () => number; alive: string[]; cap?: number },
) {
  const { register } = await loadModule()
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const cap = options.cap ?? Number.POSITIVE_INFINITY
  const held = process.env.OS === 'Windows_NT' ? options.alive.map(path => openSync(path, 'a')) : []
  const $ = {
    ...env.$,
    clock: { now: async () => options.now() },
    process: {
      run: async (command: string[]) => {
        if (command[0].endsWith('/lsof')) {
          return {
            exitCode: 0,
            stdout: options.alive.map((path, i) => `p${i + 1}\nf1\nn${path}`).join('\n'),
            stderr: '',
          }
        }
        const result = await env.$.process.run(command)
        return result.stdout.length > cap ? { ...result, stdout: result.stdout.slice(0, cap) } : result
      },
    },
    agent: { list: async () => [] },
    fs: {
      ...env.$.fs,
      stat: async (path: string) => path === '/usr/sbin/lsof' || path === '/usr/bin/lsof'
        ? { size: 1, mtimeMs: 0 }
        : env.$.fs.stat(path),
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => options.session, root: async () => '/tmp/work', cwd: async () => '/tmp/work/sub' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  return {
    render: () => pane($, { requestId: 'usage-band-agents' }, async () => undefined),
    restore: () => {
      for (const handle of held) closeSync(handle)
      globalThis.h = originalH
      globalThis.setInterval = originalSetInterval
    },
  }
}

const paneText = (node: any): string => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(paneText).join('')
  return paneText(node.children ?? node.props?.children)
}

const bgLaunch = (tool: string, id: string, path: string, label: string, at: number, extra: Record<string, unknown> = {}) =>
  [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      ...extra,
      message: {
        content: [{
          type: 'tool_use',
          id: tool,
          name: 'Bash',
          input: { command: 'bash work.sh', description: label, run_in_background: true },
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(at).toISOString(),
      ...extra,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: tool,
          content: `Command running in background with ID: ${id}. Output is being written to: ${path}. You will be notified when it completes.`,
        }],
      },
    }),
  ].join('\n')

test('finds background tasks under the resumed conversation id', async () => {
  const env = engine(async () => ok(12))
  const runtime = 'runtime-0001'
  const conversation = 'fb281c7b-0000-4000-8000-000000000000'
  const dir = join(env.root, 'projects', '-tmp-work', conversation)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-resumed')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const now = boot + 30_000
  const output = join(tasks, 'bresume1.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  await Bun.write(
    `${dir}.jsonl`,
    `${bgLaunch('tu1', 'bresume1', output, 'Resumed shell', boot, { session_id: runtime })}\n`,
  )
  const harness = await paneHarness(env, { session: runtime, now: () => now, alive: [output] })
  try {
    const rendered = await harness.render()
    expect(paneText(rendered)).toContain('Background (1)')
    expect(paneText(rendered)).toContain('Resumed shell')
    expect(paneText(rendered)).toContain('bresume1 · started: 30s · activity: now · running')
  } finally {
    harness.restore()
  }
})

test('ignores a title stub at the runtime session id', async () => {
  const env = engine(async () => ok(12))
  const runtime = 'runtime-stub'
  const conversation = 'fb281c7b-0000-4000-8000-000000000001'
  const project = join(env.root, 'projects', '-tmp-work')
  const dir = join(project, conversation)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(project, runtime), { recursive: true })
  await Bun.write(join(project, runtime, 'custom-title.json'), '{"customTitle":"COTUONG"}')
  await Bun.write(
    `${join(project, runtime)}.jsonl`,
    JSON.stringify({ type: 'custom-title', customTitle: 'COTUONG', sessionId: runtime }),
  )
  const tasks = join(env.root, 'bg-stub')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const now = boot + 30_000
  const output = join(tasks, 'bstub123.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  await Bun.write(`${dir}.jsonl`, `${bgLaunch('tu1', 'bstub123', output, 'Behind the stub', boot, { session_id: runtime })}\n`)
  const harness = await paneHarness(env, { session: runtime, now: () => now, alive: [output] })
  try {
    const rendered = await harness.render()
    expect(paneText(rendered)).toContain('Background (1)')
    expect(paneText(rendered)).toContain('Behind the stub')
    expect(paneText(rendered)).toContain('bstub123 · started: 30s · activity: now · running')
  } finally {
    harness.restore()
  }
})

// 700 progress lines carry the anchor, so grep's ~4 MiB-shaped stdout cap (here 300 kB) fills before the launch.
const bgFiller = Array.from(
  { length: 700 },
  (_, i) => `{"type":"progress","n":${i},"text":"${'x'.repeat(400)}","run_in_background":true}`,
).join('\n')

test('recovers a launch past the capped grep output from the transcript tail', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-huge'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-huge')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const now = boot + 30_000
  const output = join(tasks, 'bhuge123.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  await Bun.write(`${dir}.jsonl`, `${bgFiller}\n${bgLaunch('tu1', 'bhuge123', output, 'Late launch', boot)}\n`)
  const harness = await paneHarness(env, { session, now: () => now, alive: [output], cap: 300_000 })
  try {
    const rendered = await harness.render()
    expect(paneText(rendered)).toContain('Background (1)')
    expect(paneText(rendered)).toContain('Late launch')
    expect(paneText(rendered)).toContain('bhuge123 · started: 30s · activity: now · running')
  } finally {
    harness.restore()
  }
})

test('finds a launch pushed past the tail by later output', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-beyond'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-beyond')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const now = boot + 30_000
  const output = join(tasks, 'bbeyond1.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  // Filler after the launch pushes it past the tail seed; filler before it fills the capped grep stdout.
  await Bun.write(`${dir}.jsonl`, `${bgFiller}\n${bgLaunch('tu1', 'bbeyond1', output, 'Deep launch', boot)}\n${bgFiller}\n`)
  const harness = await paneHarness(env, { session, now: () => now, alive: [output], cap: 300_000 })
  try {
    let rendered = await harness.render()
    const deadline = Date.now() + 5_000
    while (!paneText(rendered).includes('bbeyond1') && Date.now() < deadline) {
      await Bun.sleep(25)
      rendered = await harness.render()
    }
    expect(paneText(rendered)).toContain('Background (1)')
    expect(paneText(rendered)).toContain('Deep launch')
    expect(paneText(rendered)).toContain('bbeyond1 · started: 30s · activity: now · running')
  } finally {
    harness.restore()
  }
})

test('finds a foreground command the host moved to the background after its timeout', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-timeout'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-timeout')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const timeout = 600_000
  const now = boot + 1_080_000
  const output = join(tasks, 'bauto123.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  const launch = [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(boot).toISOString(),
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu-timeout',
          name: 'Bash',
          input: { command: 'bash export4.sh', description: 'Export report', timeout: timeout * 6 },
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(boot + timeout).toISOString(),
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu-timeout',
          content: `Command did not complete within its ${timeout / 1000}s timeout and was moved to the background (ID: bauto123). Output is being written to: ${output}. You will be notified when it completes.`,
        }],
      },
    }),
  ].join('\n')
  await Bun.write(`${dir}.jsonl`, `${launch}\n`)
  const harness = await paneHarness(env, { session, now: () => now, alive: [output] })
  try {
    const rendered = await harness.render()
    expect(paneText(rendered)).toContain('Background (1)')
    expect(paneText(rendered)).toContain('Export report')
    expect(paneText(rendered)).toContain('bauto123 · started: 18m · activity: now · running')
  } finally {
    harness.restore()
  }
})

test('keeps reading a capped refresh instead of skipping to the end of the file', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-grow'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-grow')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  let now = boot + 30_000
  const first = join(tasks, 'bgrow001.output')
  const second = join(tasks, 'bgrow002.output')
  for (const path of [first, second]) {
    await Bun.write(path, 'out')
    utimesSync(path, new Date(now), new Date(now))
  }
  const transcript = `${dir}.jsonl`
  await Bun.write(transcript, `${bgLaunch('tu1', 'bgrow001', first, 'First shell', boot)}\n`)
  const harness = await paneHarness(env, { session, now: () => now, alive: [first, second], cap: 300_000 })
  try {
    expect(paneText(await harness.render())).toContain('First shell')
    await Bun.write(
      transcript,
      `${await Bun.file(transcript).text()}${bgFiller}\n${bgLaunch('tu2', 'bgrow002', second, 'Second shell', boot)}\n`,
    )
    now += 31_000
    expect(paneText(await harness.render())).not.toContain('Second shell')
    now += 31_000
    const complete = paneText(await harness.render())
    expect(complete).toContain('Second shell')
    expect(complete).toContain('bgrow002')
  } finally {
    harness.restore()
  }
})

test('hides a finished background agent that the engine still reports as waiting', async () => {
  const { register } = await loadModule()
  const env = engine(async () => ok(12))
  const session = 'sess-2'
  const subagents = join(env.root, 'projects', '-tmp-work', session, 'subagents')
  mkdirSync(subagents, { recursive: true })
  const transcript = async (id: string, at: Date) => {
    const path = join(subagents, `agent-${id}.jsonl`)
    await Bun.write(
      path,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: at.toISOString(),
        message: { model: 'claude-opus-5', usage: { input_tokens: 10 } },
      })}\n`,
    )
    utimesSync(path, at, at)
  }
  const meta = async (id: string, finished: boolean, at: Date) => {
    const path = join(subagents, `agent-${id}.meta.json`)
    await Bun.write(path, JSON.stringify({ description: id, finished }))
    utimesSync(path, at, at)
  }
  const past = new Date(Date.now() - 300_000)
  // The real ordering: the meta gets its flag just before the transcript's last flush.
  await transcript('done1', new Date(past.getTime() + 65))
  await meta('done1', true, past)
  await transcript('res1', new Date(Date.now() - 60_000))
  await meta('res1', true, new Date(Date.now() - 600_000))
  await transcript('run1', new Date(Date.now() - 120_000))
  await meta('run1', false, new Date(Date.now() - 120_000))
  let pane: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'Pane') pane = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    agent: {
      list: async () => [
        { id: 'done1', description: 'Finished agent', type: 'local_agent', status: 'waiting' },
        { id: 'res1', description: 'Resumed agent', type: 'local_agent', status: 'waiting' },
        { id: 'run1', description: 'Live agent', type: 'local_agent', status: 'running' },
      ],
    },
    fs: {
      ...env.$.fs,
      exists: async (path: string) => existsSync(path),
      list: async (path: string) =>
        readdirSync(path, { withFileTypes: true }).map(entry => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          mtimeMs: entry.isFile() ? statSync(join(path, entry.name)).mtimeMs : 0,
        })),
    },
    session: { id: async () => session, root: async () => '/tmp/work', cwd: async () => '/tmp/work/sub' },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      close: async () => undefined,
      panes: async () => [],
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }

  try {
    const rendered = await pane($, { requestId: 'usage-band-agents' }, async () => undefined)
    expect(text(rendered)).toContain('Live agent')
    expect(text(rendered)).toContain('Resumed agent')
    expect(text(rendered)).not.toContain('Finished agent')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('uses the current credential plan when cached usage is stale', async () => {
  const { register } = await loadModule()
  const env = engine(
    async () => { throw new Error('unexpected request') },
    undefined,
    { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  )
  await Bun.write(join(env.root, 'xusage-cache.json'), JSON.stringify({
    at: env.now(),
    source: 'claude',
    value: {
      source: 'claude',
      plan: 'max',
      windows: [{
        key: 'five_hour',
        label: '5h',
        used: 23,
        windowMinutes: 300,
        resetsAt: env.now() + 3_600_000,
      }],
    },
  }))
  let render: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'AbovePrompt') render = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    agent: { list: async () => [] },
    fs: { ...env.$.fs, list: async () => [] },
    session: { usage: async () => ({ context: { tokens: 42_000, window: 258_000 } }) },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }

  try {
    const band = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(band)).toContain('max20')
    expect(env.calls()).toBe(0)
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('keeps plan, agents and activity when usage fails with nothing cached', async () => {
  const { register } = await loadModule()
  const env = engine(
    async () => limited('3600'),
    undefined,
    { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  )
  const session = 'sess-usage-failed'
  mkdirSync(join(env.root, 'projects', '-tmp-work'), { recursive: true })
  await Bun.write(
    join(env.root, 'projects', '-tmp-work', `${session}.jsonl`),
    `${JSON.stringify({ type: 'user', timestamp: new Date(env.now()).toISOString() })}\n`,
  )
  let render: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'AbovePrompt') render = handler
    return registration
  })
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const $ = {
    ...env.$,
    agent: { list: async () => [{ id: 'a1', name: 'worker', type: 'subagent', status: 'running' }] },
    fs: {
      ...env.$.fs,
      exists: async (path: string) => existsSync(path),
      list: async () => [],
    },
    session: {
      id: async () => session,
      root: async () => '/tmp/work',
      cwd: async () => '/tmp/work',
      usage: async () => ({ context: { tokens: 42_000, window: 258_000 } }),
    },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      invalidate: async () => undefined,
    },
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }

  try {
    const band = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(band)).toContain('max20')
    expect(text(band)).toContain('42k/258k')
    expect(text(band)).toContain('1 agent')
    expect(text(band)).toContain('activity:')
    expect(text(band)).not.toContain('usage request failed')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})
