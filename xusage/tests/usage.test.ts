import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs'
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
  }).transformSync(`${source}\nexport { usage };`)
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
        return undefined
      },
    },
    fs: {
      read: async (path: string) => await Bun.file(path).text(),
      write: async (path: string, text: string) => { await Bun.write(path, text) },
      stat: async (path: string) => {
        const stat = await import('node:fs/promises').then(fs => fs.stat(path))
        return { mtimeMs: stat.mtimeMs }
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
      read: async (path: string) => path === join(env.root, 'settings.json')
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

  try {
    const event = { props: { hasSurvey: false, bodyColumns: 120 } }
    const first = await render($, event, async () => undefined)
    expect(text(first)).toContain('42k/1M (cp 400k)')
    expect(text(first)).not.toContain('usage request failed')
    expect(text(first)).not.toContain('retry in')
    expect(warning(first)).toBeUndefined()
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
        message: { model: 'claude-opus-5', usage: { input_tokens: 1, cache_read_input_tokens: 49_999 } },
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
        timestamp: new Date(Date.now() - 305_000).toISOString(),
        message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1_000, output_tokens: 5 } },
      }),
      JSON.stringify({
        type: 'assistant',
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
  globalThis.h = ((type: any, props: any, ...children: any[]) => ({ type, props, children })) as any
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
          kind: entry.isDirectory() ? 'directory' : 'file',
        })),
    },
    session: { id: async () => session, cwd: async () => '/tmp/work' },
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
    expect(text(find(rendered, 'wf_abc-0'))).toBe('- review-S8-r1 · claude-opus-5 · S8 · 50k tokens')
    const agentBox = find(rendered, 'b2')
    expect(text(agentBox.children[0])).toBe('Implement top-up bonus rate')
    expect(text(agentBox.children[1])).toBe(
      'b2 · subagent · claude-opus-5-5 · running · 130k tokens · started: 5m · activity: now',
    )
    expect(text(rendered)).toContain('130k tokens')
    expect(text(rendered)).toContain('50k tokens')
    expect(text(rendered)).toContain('started: 5m · activity: now')
  } finally {
    globalThis.h = originalH
    globalThis.setInterval = originalSetInterval
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
          kind: entry.isDirectory() ? 'directory' : 'file',
        })),
    },
    session: { id: async () => session, cwd: async () => '/tmp/work' },
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
