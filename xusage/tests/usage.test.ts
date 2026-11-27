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
    expect(text(second)).toContain('ultra')
    expect(text(second)).not.toContain('max20')
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
    expect(text(five)).toContain('max5h')
    expect(text(five)).not.toContain('max55h')
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
    // A narrow pane splits the agent meta from its state and moves model, effort and tokens to their own line.
    const narrow = await pane($, {
      requestId: 'usage-band-agents',
      surface: 'terminal',
      props: { bodyColumns: 60 },
    }, async () => undefined)
    const narrowAgent = find(narrow, 'b2')
    expect(narrowAgent.children[1].type).toBe('Box')
    expect(narrowAgent.children[1].children.length).toBe(2)
    expect(text(narrowAgent.children[1].children[0])).toBe('b2 · subagent · running')
    expect(text(narrowAgent.children[1].children[1])).toBe('claude-opus-5-5 · xhigh · 130k tokens')
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
    })}\n${JSON.stringify({ type: 'api-request' })}\n`,
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

test('keeps a workflow visible while it has not reported its end', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-wf-silent'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_silent')
  mkdirSync(root, { recursive: true })
  const past = new Date(Date.now() - 75 * 60_000)
  const journal = join(root, 'journal.jsonl')
  const agent = join(root, 'agent-a1.jsonl')
  await Bun.write(
    journal,
    `${JSON.stringify({ type: 'started', key: 'S1', agentId: 'a1', label: 'long impl', phase: 'Setup' })}\n`,
  )
  await Bun.write(
    agent,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: past.toISOString(),
      message: { model: 'claude-opus-5', usage: { input_tokens: 10 } },
    })}\n`,
  )
  utimesSync(journal, past, past)
  utimesSync(agent, past, past)
  mkdirSync(join(dir, 'workflows', 'scripts'), { recursive: true })
  const script = join(dir, 'workflows', 'scripts', 'long-run-wf_silent.js')
  await Bun.write(script, "export const meta = { name: 'long-run', description: 'Long silent run' };\n")
  utimesSync(script, past, past)
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).toContain('Workflows (1)')
    expect(rendered).toContain('Long silent run')
    expect(rendered).toContain('0 running')
    expect(rendered).not.toContain('long impl')
  } finally {
    harness.restore()
  }
})

test('counts only the attempts still writing as running', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-wf-quiet'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_mix')
  mkdirSync(root, { recursive: true })
  const attempt = async (agent: string, age: number, last: Record<string, unknown>) => {
    const path = join(root, `agent-${agent}.jsonl`)
    await Bun.write(
      path,
      `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } })}\n` +
        `${JSON.stringify(last)}\n`,
    )
    const past = new Date(Date.now() - age)
    utimesSync(path, past, past)
  }
  await Bun.write(
    join(root, 'journal.jsonl'),
    [
      JSON.stringify({ type: 'started', key: 'K-live', agentId: 'l1', label: 'live build', phase: 'Build' }),
      JSON.stringify({ type: 'started', key: 'K-quiet', agentId: 'q1', label: 'quiet build', phase: 'Build' }),
      JSON.stringify({ type: 'started', key: 'K-done', agentId: 'd1', label: 'done build', phase: 'Build' }),
      JSON.stringify({ type: 'result', key: 'K-done', agentId: 'd1', result: { score: 9 } }),
    ].join('\n') + '\n',
  )
  await attempt('l1', 60_000, { type: 'api-request' })
  // Killed between a tool result and the next request, then silent for hours.
  await attempt('q1', 3 * 60 * 60_000, { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).toContain('1 running · 1 done')
    expect(rendered).toContain('live build')
    expect(rendered).not.toContain('quiet build')
  } finally {
    harness.restore()
  }
})

test('stops counting attempts whose transcript ended its turn', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-wf-cancelled'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_cancel')
  mkdirSync(root, { recursive: true })
  const final = `${JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: { input_tokens: 10 }, content: [{ type: 'text', text: 'ok' }] },
  })}\n`
  await Bun.write(
    join(root, 'journal.jsonl'),
    [
      JSON.stringify({ type: 'started', key: 'K-live', agentId: 'l1', label: 'live impl', phase: 'Build' }),
      JSON.stringify({ type: 'started', key: 'K-dead', agentId: 'd1', label: 'cancelled impl', phase: 'Build' }),
      JSON.stringify({ type: 'started', key: 'K-hook', agentId: 'h1', label: 'stopped impl', phase: 'Build' }),
    ].join('\n') + '\n',
  )
  // No result line ever arrives for a cancelled key; only the transcript records how it ended.
  await Bun.write(join(root, 'agent-l1.jsonl'), `${final}${JSON.stringify({ type: 'api-request' })}\n`)
  await Bun.write(join(root, 'agent-d1.jsonl'), final)
  await Bun.write(
    join(root, 'agent-h1.jsonl'),
    `${final}${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } })}\n`,
  )
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).toContain('1 running')
    expect(rendered).toContain('live impl')
    expect(rendered).not.toContain('cancelled impl')
    expect(rendered).not.toContain('stopped impl')
  } finally {
    harness.restore()
  }
})

test('drops a workflow the host announced as stopped', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-wf-stopped'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const run = async (name: string, label: string) => {
    const root = join(dir, 'subagents', 'workflows', name)
    mkdirSync(root, { recursive: true })
    await Bun.write(
      join(root, 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', key: `${name}-k`, agentId: 'a1', label, phase: 'Setup' })}\n`,
    )
    await Bun.write(
      join(root, 'agent-a1.jsonl'),
      `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } })}\n`,
    )
  }
  await run('wf_dead', 'dead impl')
  await run('wf_live', 'live impl')
  await Bun.write(
    `${dir}.jsonl`,
    [
      JSON.stringify({
        type: 'user',
        toolUseResult: {
          status: 'async_launched',
          taskId: 'wdead01',
          taskType: 'local_workflow',
          workflowName: 'gone-wf',
          runId: 'wf_dead',
          summary: 'gone',
        },
      }),
      JSON.stringify({
        type: 'user',
        toolUseResult: {
          status: 'async_launched',
          taskId: 'wlive01',
          taskType: 'local_workflow',
          workflowName: 'live-wf',
          runId: 'wf_live',
          summary: 'live',
        },
      }),
      JSON.stringify({
        type: 'queue-operation',
        content:
          '<task-notification>\n<task-id>wdead01</task-id>\n<status>stopped</status>\n' +
          '<summary>Background workflow "gone-wf" stopped</summary>\n</task-notification>',
      }),
    ].join('\n') + '\n',
  )
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).toContain('Workflows (1)')
    expect(rendered).toContain('live-wf')
    expect(rendered).not.toContain('gone-wf')
    expect(rendered).not.toContain('dead impl')
  } finally {
    harness.restore()
  }
})

test('drops a workflow whose engine process is gone', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-wf-engine-gone'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_orphan')
  mkdirSync(root, { recursive: true })
  const past = new Date(Date.now() - 2 * 60 * 60_000)
  const journal = join(root, 'journal.jsonl')
  const agent = join(root, 'agent-a1.jsonl')
  await Bun.write(
    journal,
    `${JSON.stringify({ type: 'started', key: 'S1', agentId: 'a1', label: 'orphan impl', phase: 'Setup' })}\n`,
  )
  await Bun.write(
    agent,
    `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } })}\n`,
  )
  utimesSync(journal, past, past)
  utimesSync(agent, past, past)
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  // This engine started an hour ago; the run last wrote an hour before that and never wrote its final JSON.
  mkdirSync(join(env.root, 'sessions'), { recursive: true })
  await Bun.write(
    join(env.root, 'sessions', '4242.json'),
    JSON.stringify({ sessionId: session, startedAt: Date.now() - 60 * 60_000 }),
  )
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).not.toContain('Workflows (1)')
    expect(rendered).not.toContain('orphan impl')
  } finally {
    harness.restore()
  }
})

test('shows the conversation name in the band and the pane', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-wf-named'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  mkdirSync(join(env.root, 'sessions'), { recursive: true })
  await Bun.write(
    join(env.root, 'sessions', '777.json'),
    JSON.stringify({ sessionId: session, startedAt: Date.now(), name: 'co-tuong-ae' }),
  )
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    expect(paneText(await harness.render())).toContain('co-tuong-ae')
    expect(paneText(await harness.renderBand())).toContain('co-tuong-ae')
  } finally {
    harness.restore()
  }
})

test('stacks the band on a narrow terminal and drops the conversation name in the middle', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-band-tiers'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_band')
  mkdirSync(root, { recursive: true })
  await Bun.write(
    join(root, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'S1', agentId: 'a1', label: 'impl', phase: 'S1' })}\n`,
  )
  await Bun.write(
    join(root, 'agent-a1.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } })}\n`,
  )
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  mkdirSync(join(env.root, 'sessions'), { recursive: true })
  await Bun.write(
    join(env.root, 'sessions', '888.json'),
    JSON.stringify({ sessionId: session, startedAt: Date.now() - 60_000, name: 'band-tiers' }),
  )
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
  try {
    const wide = await harness.renderBand(120)
    expect(wide.props.flexDirection).toBe('row')
    // Items wrap whole instead of being squeezed mid-word when the row runs out of cells.
    expect(wide.props.flexWrap).toBe('wrap')
    expect(wide.children[0].props.flexWrap).toBe('wrap')
    expect(wide.children[0].props.columnGap).toBe(2)
    expect(paneText(wide)).toContain('band-tiers')
    const mid = await harness.renderBand(84)
    expect(mid.props.flexDirection).toBe('row')
    expect(paneText(mid)).not.toContain('band-tiers')
    const narrow = await harness.renderBand(60)
    // Two rows: the plan and its windows above, the counts and the conversation below.
    expect(narrow.props.flexDirection).toBe('column')
    expect(narrow.children.length).toBe(2)
    expect(narrow.children[0].props.flexWrap).toBe('wrap')
    expect(narrow.children[0].props.columnGap).toBe(2)
    expect(narrow.children[1].props.flexWrap).toBe('wrap')
    expect(paneText(narrow)).toContain('1 wf')
    expect(paneText(narrow)).toContain('band-tiers')
  } finally {
    harness.restore()
  }
})

test('keeps a reset to a clock time or a date, never both', async () => {
  for (const hours of [2, 72] as const) {
    const env = engine(async () => ({
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        five_hour: { utilization: 12, resets_at: new Date(Date.now() + hours * 60 * 60_000).toISOString() },
      }),
    }))
    const harness = await paneHarness(env, { session: `sess-reset-${hours}`, now: () => Date.now(), alive: [] })
    try {
      const drawn = paneText(await harness.renderBand(120))
      expect(drawn).not.toMatch(/\(\d{2}\/\d{2} \d{2}:\d{2}\)/)
      expect(drawn).toMatch(hours < 24 ? /\(\d{2}:\d{2}\)/ : /\(\d{2}\/\d{2}\)/)
    } finally {
      harness.restore()
    }
  }
})

test('stacks a workflow entry on a narrow terminal instead of truncating it', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-pane-narrow'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  const root = join(dir, 'subagents', 'workflows', 'wf_narrow')
  mkdirSync(root, { recursive: true })
  const past = new Date(Date.now() - 5 * 60_000)
  await Bun.write(
    join(root, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'S1', agentId: 'a1', label: 'impl', phase: 'S1' })}\n`,
  )
  const agent = join(root, 'agent-a1.jsonl')
  await Bun.write(
    agent,
    `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 2 } } })}\n` +
      `${JSON.stringify({ type: 'api-request' })}\n`,
  )
  utimesSync(agent, past, past)
  mkdirSync(join(dir, 'workflows', 'scripts'), { recursive: true })
  const script = join(dir, 'workflows', 'scripts', 'narrow-run-wf_narrow.js')
  await Bun.write(script, "export const meta = { name: 'narrow-run', description: 'Narrow run' };\n")
  utimesSync(script, past, past)
  await Bun.write(`${dir}.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [] } })}\n`)
  const harness = await paneHarness(env, { session, now: () => Date.now(), alive: [] })
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
    const wide = await harness.render(120)
    const wideRun = find(wide, 'wf_narrow')
    expect(wideRun.children[1].type).toBe('Text')
    expect(paneText(wideRun.children[1])).toContain('· started:')
    expect(paneText(wideRun.children[1])).toContain('· activity:')
    const wideAgent = find(wide, 'wf_narrow-0')
    expect(wideAgent.children[0].type).toBe('Text')
    expect(paneText(wideAgent.children[0])).toContain('· claude-opus-5')
    const narrow = await harness.render(60)
    const narrowRun = find(narrow, 'wf_narrow')
    // The counts keep their row; started and activity take one of their own.
    expect(narrowRun.children[1].type).toBe('Box')
    expect(narrowRun.children[1].children.length).toBe(2)
    expect(paneText(narrowRun.children[1].children[0])).not.toContain('started:')
    expect(paneText(narrowRun.children[1].children[1])).toContain('started:')
    const narrowAgent = find(narrow, 'wf_narrow-0')
    expect(narrowAgent.children[0].type).toBe('Box')
    expect(narrowAgent.children[0].children.length).toBe(2)
    expect(paneText(narrowAgent.children[0].children[0])).toBe('- impl')
    expect(paneText(narrowAgent.children[0].children[1])).toContain('claude-opus-5')
  } finally {
    harness.restore()
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
    })}\n${JSON.stringify({ type: 'api-request' })}\n`,
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
  options: {
    session: string
    now: () => number
    alive: string[]
    cap?: number
    columns?: number
    surface?: 'terminal' | 'desktop'
  },
) {
  const { register } = await loadModule()
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
    session: {
      id: async () => options.session,
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
  return {
    render: (columns?: number) =>
      pane($, {
        requestId: 'usage-band-agents',
        surface: options.surface ?? 'terminal',
        props: { bodyColumns: columns ?? options.columns ?? 120 },
      }, async () => undefined),
    renderBand: (columns?: number) =>
      band($, {
        surface: options.surface ?? 'terminal',
        props: { hasSurvey: false, bodyColumns: columns ?? options.columns ?? 120 },
      }, async () => undefined),
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

test('finds a command the user backgrounded by hand', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-manual'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-manual')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const now = boot + 30_000
  const output = join(tasks, 'bmanual1.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  await Bun.write(
    `${dir}.jsonl`,
    [
      JSON.stringify({ type: 'user', message: { content: [] } }),
      // Ctrl+B: the tool_use asked for no background flag, the result is the only launch record.
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(boot).toISOString(),
        message: {
          content: [{
            type: 'tool_use',
            id: 'tu1',
            name: 'Bash',
            input: { command: 'bash wait-load.sh', description: 'Wait for load1 below 9' },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(boot + 1_000).toISOString(),
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: `Command was manually backgrounded by user with ID: bmanual1. Output is being written to: ${output}.`,
          }],
        },
      }),
    ].join('\n') + '\n',
  )
  const harness = await paneHarness(env, { session, now: () => now, alive: [output] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).toContain('Background (1)')
    expect(rendered).toContain('Wait for load1 below 9')
    expect(rendered).toContain('bmanual1 · started: 30s · activity: now · running')
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

test('finds a subagent launch written while the pane was closed', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-reopen'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  const tasks = join(env.root, 'bg-reopen')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const start = boot + 30_000
  let now = start
  const first = join(tasks, 'breopen1.output')
  const second = join(tasks, 'breopen2.output')
  await Bun.write(first, 'out')
  await Bun.write(second, 'out')
  utimesSync(second, new Date(start), new Date(start))
  const agentPath = join(dir, 'subagents', 'agent-reopen1.jsonl')
  await Bun.write(agentPath, `${bgLaunch('tu1', 'breopen1', first, 'First shell', start)}\n`)
  // Away from the recent window: the launch below lands while the pane is closed, so only a second backfill sees it.
  const old = new Date(boot - 5 * 60_000)
  utimesSync(agentPath, old, old)
  const harness = await paneHarness(env, { session, now: () => now, alive: [first, second] })
  try {
    const seen = async (marker: string) => {
      let rendered = await harness.render()
      const deadline = Date.now() + 2_000
      while (!paneText(rendered).includes(marker) && Date.now() < deadline) {
        await Bun.sleep(25)
        rendered = await harness.render()
      }
      return paneText(rendered)
    }
    expect(await seen('First shell')).toContain('First shell')
    await Bun.write(
      agentPath,
      `${await Bun.file(agentPath).text()}${bgLaunch('tu2', 'breopen2', second, 'Late shell', start + 90_000)}\n`,
    )
    utimesSync(agentPath, old, old)
    now = start + 5 * 60_000
    const rendered = await seen('Late shell')
    expect(rendered).toContain('Background (2)')
    expect(rendered).toContain('Late shell')
    expect(rendered).toContain('breopen2 ·')
  } finally {
    harness.restore()
  }
})

test('shows an MCP call the host moved to a background task', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-mcp'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  // Started before the module loads, the way a pane reopened mid-task sees it; the host still calls it working.
  const started = Date.now() - 2_000
  const now = { at: started + 150_000 }
  const launch = [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(started).toISOString(),
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu-mcp',
          name: 'mcp__xermius-mcp__execute_command',
          input: { host_id: 'h1', command: 'uptime' },
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(started + 120_000).toISOString(),
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu-mcp',
          content: [{
            type: 'text',
            text: 'MCP tool "xermius-mcp/execute_command" is still running after 120s. It was moved to the background as task kj1031nm5 and keeps running; a notification follows. To stop it, use TaskStop with task_id "kj1031nm5".',
          }],
        }],
      },
    }),
  ].join('\n')
  await Bun.write(`${dir}.jsonl`, `${launch}\n`)
  const harness = await paneHarness(env, { session, now: () => now.at, alive: [] })
  try {
    const first = paneText(await harness.render())
    expect(first).toContain('Background (1)')
    expect(first).toContain('xermius-mcp/execute_command')
    expect(first).toContain('kj1031nm5 · started: 2m · running')
    await Bun.write(
      `${dir}.jsonl`,
      `${launch}\n${JSON.stringify({
        type: 'queue-operation',
        content: '<task-notification>\n<task-id>kj1031nm5</task-id>\n<status>completed</status>\n</task-notification>',
      })}\n`,
    )
    now.at = started + 200_000
    expect(paneText(await harness.render())).not.toContain('Background (1)')
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

test('shows a command the host set aside to deliver a queued message', async () => {
  const env = engine(async () => ok(12))
  const session = 'sess-bg-moved'
  const dir = join(env.root, 'projects', '-tmp-work', session)
  mkdirSync(dir, { recursive: true })
  const tasks = join(env.root, 'bg-moved')
  mkdirSync(tasks, { recursive: true })
  const boot = Date.now()
  const now = boot + 240_000
  const output = join(tasks, 'b0ggt4n6o.output')
  await Bun.write(output, 'out')
  utimesSync(output, new Date(now), new Date(now))
  const text =
    `Command was moved to the background (ID: b0ggt4n6o) so that a message that arrived while it was running ` +
    `can reach you; it was not interrupted. Output is being written to: ${output}. You will be notified when ` +
    `it completes. It is running now: do not start a second copy while it runs. If it is no longer needed, ` +
    `stop it with TaskStop. To check interim output, use Read on that file path.`
  const launch = [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(boot).toISOString(),
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu-moved',
          name: 'Bash',
          input: {
            command: 'cat > win-cpu.ps1 <<\'EOF\'\necho hi\nEOF\n',
            description: 'Measure per-process CPU during Windows flood',
            timeout: 400_000,
          },
        }],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: new Date(boot + 54_000).toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-moved', content: text }] },
    }),
  ].join('\n')
  await Bun.write(`${dir}.jsonl`, `${launch}\n`)
  const harness = await paneHarness(env, { session, now: () => now, alive: [output] })
  try {
    const rendered = paneText(await harness.render())
    expect(rendered).toContain('Background (1)')
    expect(rendered).toContain('Measure per-process CPU during Windows flood')
    expect(rendered).toContain('b0ggt4n6o · started: 4m · activity: now · running')
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
    expect(text(band)).toContain('ultra')
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
    expect(text(band)).toContain('ultra')
    expect(text(band)).toContain('42k/258k')
    expect(text(band)).toContain('1 agent')
    expect(text(band)).toContain('now')
    expect(text(band)).not.toContain('activity:')
    expect(text(band)).not.toContain('usage request failed')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})

test('one click on the band toggles ultracode and back', async () => {
  const { register } = await loadModule()
  const env = engine(async () => ok(10))
  const transcript = join(env.root, 'projects', '-tmp-work', 's1.jsonl')
  mkdirSync(join(env.root, 'projects', '-tmp-work'), { recursive: true })
  const write = async (entry: Record<string, unknown>) => {
    const before = await Bun.file(transcript).text().catch(() => '')
    await Bun.write(transcript, `${before}${JSON.stringify(entry)}\n`)
  }
  await write({
    type: 'assistant',
    perTurnEffort: 'medium',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
    timestamp: new Date(env.now()).toISOString(),
    sessionId: 's1',
  })
  let render: any
  const registration = { catch: () => registration }
  register((event: string, filter: any, handler: any) => {
    if (filter.component === 'AbovePrompt') render = handler
    return registration
  })
  const sent: string[] = []
  const $: any = {
    ...env.$,
    agent: { list: async () => [] },
    fs: { ...env.$.fs, list: async () => [] },
    session: {
      id: async () => 's1',
      model: async () => 'qoder/dfmodel',
      root: async () => '/tmp/work',
      cwd: async () => '/tmp/work',
      usage: async () => ({ context: { tokens: 42_000, window: 258_000 } }),
    },
    ui: {
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
      invalidate: async () => undefined,
      status: async () => undefined,
    },
    command: {
      run: async (e: any) => {
        sent.push(`/${e.command} ${e.args}`.trim())
        await write({
          type: 'user',
          message: {
            role: 'user',
            content: `<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>${e.args}</command-args>`,
          },
          timestamp: new Date(env.now()).toISOString(),
          sessionId: 's1',
        })
        await write({
          type: 'user',
          message: {
            role: 'user',
            content: e.args === 'ultracode on'
              ? '<local-command-stdout>Ultracode on (this session only): dynamic workflows on every task. Effort stays medium.</local-command-stdout>'
              : '<local-command-stdout>Ultracode off. Effort stays medium.</local-command-stdout>',
          },
          timestamp: new Date(env.now()).toISOString(),
          sessionId: 's1',
        })
        return { text: '' }
      },
    },
  }
  const originalH = globalThis.h
  const originalSetInterval = globalThis.setInterval
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
  globalThis.setInterval = (() => 1) as any
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return text(node.children ?? node.props?.children)
  }
  const press = (node: any, key: string): (() => Promise<void>) | undefined => {
    if (node == null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = press(child, key)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (node.type === 'Button' && node.props?.key === key) return node.props.onPress
    return press(node.children, key)
  }

  try {
    const band = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(band)).toContain('uc off')
    await press(band, 'ultra')!()
    expect(sent).toEqual(['/effort ultracode on'])
    const on = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(on)).toContain('uc on')
    await press(on, 'ultra')!()
    expect(sent).toEqual(['/effort ultracode on', '/effort ultracode off'])
    const off = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(off)).toContain('uc off')
    // The transcript, not the click override, must keep the label right afterwards.
    env.advance(6_000)
    const after = await render($, { props: { hasSurvey: false, bodyColumns: 80 } }, async () => undefined)
    expect(text(after)).toContain('uc off')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
  }
})
