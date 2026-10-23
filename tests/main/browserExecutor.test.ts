import { describe, expect, it, vi } from 'vitest'
import {
  browserActionConfigSchema,
  browserNavigationProblem,
  checkNavigationUrl,
  getNodeType,
  resolveTemplate,
  validateWorkflowGraph
} from '../../src/shared/nodeSchema'
import type { WorkflowGraph, WorkflowNode } from '../../src/shared/contracts'
import { WORKFLOW_SCHEMA_VERSION } from '../../src/shared/nodeSchema'
import {
  createBrowserbaseClient,
  type BrowserbaseCredentials
} from '../../src/main/services/execution/browserbase'

/* -------------------------------------------------------------------- */
/* Schema: actions, bounds, required fields                              */
/* -------------------------------------------------------------------- */

function configOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return { name: 'Test step', action: 'navigate', url: 'https://example.com', ...overrides }
}

describe('browser action schema', () => {
  it('keeps old Prompt-2 configs valid (navigate/extractText/click/fillField)', () => {
    for (const action of ['navigate', 'extractText', 'click', 'fillField'] as const) {
      const result = browserActionConfigSchema.safeParse(
        configOf({ action, url: action === 'navigate' ? 'https://example.com' : undefined })
      )
      expect(result.success).toBe(true)
    }
  })

  it('accepts every new browser operation', () => {
    for (const action of ['extractPageText', 'waitFor', 'pageInfo', 'screenshot'] as const) {
      const result = browserActionConfigSchema.safeParse(configOf({ action }))
      expect(result.success).toBe(true)
    }
  })

  it('applies the documented timeout and limit defaults', () => {
    const parsed = browserActionConfigSchema.parse(configOf({}))
    expect(parsed.timeoutSeconds).toBe(30)
    expect(parsed.limit).toBe(2000)
  })

  it('rejects out-of-bounds timeouts and limits with field errors', () => {
    const tooSmall = browserActionConfigSchema.safeParse(configOf({ timeoutSeconds: 2 }))
    expect(tooSmall.success).toBe(false)
    const tooBig = browserActionConfigSchema.safeParse(configOf({ timeoutSeconds: 600 }))
    expect(tooBig.success).toBe(false)
    const tinyLimit = browserActionConfigSchema.safeParse(configOf({ limit: 5 }))
    expect(tinyLimit.success).toBe(false)
    const hugeLimit = browserActionConfigSchema.safeParse(configOf({ limit: 100000 }))
    expect(hugeLimit.success).toBe(false)
  })

  it('flags required fields per action', () => {
    expect(getNodeType('browserAction').requiredFields(configOf({ action: 'fillField', selector: '', value: '' })))
      .toContain('value')
    expect(getNodeType('browserAction').requiredFields(configOf({ action: 'pageInfo' })))
      .toEqual([])
  })

  it('rejects unsafe navigation targets as config issues, not pretend success', () => {
    const cases = [
      'javascript:alert(1)',
      'http://127.0.0.1:3000/admin',
      'http://localhost/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/x',
      'http://192.168.1.20/x',
      'user:pass@https://example.com/x'
    ]
    for (const url of cases) {
      const messages = getNodeType('browserAction').validateConfig(configOf({ url }))
      expect(messages['url'], `expected ${url} to be flagged`).toBeTruthy()
    }
  })

  it('allows ordinary public URLs', () => {
    const messages = getNodeType('browserAction').validateConfig(configOf({ url: 'https://example.com/' }))
    expect(messages['url']).toBeUndefined()
  })
})

describe('checkNavigationUrl', () => {
  it('demands http(s) and parses the URL rather than string-matching', () => {
    expect(checkNavigationUrl('https://example.com/').ok).toBe(true)
    expect(checkNavigationUrl('ftp://example.com/x').ok).toBe(false)
    expect(checkNavigationUrl('data:text/html,hi').ok).toBe(false)
    expect(checkNavigationUrl('javascript:void 0').ok).toBe(false)
    expect(checkNavigationUrl('not a url').ok).toBe(false)
    expect(checkNavigationUrl('').ok).toBe(false)
  })

  it('blocks loopback, private, link-local and metadata destinations', () => {
    for (const host of [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://[::1]/',
      'http://10.1.2.3/',
      'http://172.16.0.9/',
      'http://192.168.0.1/',
      'http://169.254.169.254/',
      'http://100.100.100.100/',
      'http://metadata.google.internal/'
    ]) {
      expect(checkNavigationUrl(host).ok, host).toBe(false)
    }
  })

  it('blocks embedded credentials in the URL', () => {
    expect(checkNavigationUrl('https://user:secret@example.com/').ok).toBe(false)
  })
})

describe('browser reference resolution', () => {
  it('resolves {{nodeId}} for browser text fields against upstream outputs only', () => {
    const map = new Map([['n_url', 'https://example.com/page']])
    const resolved = resolveTemplate('{{n_url}}/status', map)
    expect(resolved).toEqual({ ok: true, value: 'https://example.com/page/status' })
    const unknown = resolveTemplate('{{missing}}', map)
    expect(unknown.ok).toBe(false)
  })
})

describe('graph validation with browser nodes', () => {
  it('flags a private-network URL as a config issue that the planner will refuse', () => {
    const graph: WorkflowGraph = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'manual' } },
        {
          id: 'b',
          type: 'browserAction',
          position: { x: 200, y: 0 },
          config: configOf({ url: 'http://169.254.169.254/' })
        }
      ] as unknown as WorkflowNode[],
      edges: [{ id: 'e1', source: 't', target: 'b' }]
    }
    const result = validateWorkflowGraph(graph)
    expect(result.structural).toBe(true)
    expect(result.configIssues.some((issue) => issue.nodeId === 'b')).toBe(true)
  })

  it('still reports browser nodes as executable', () => {
    expect(getNodeType('browserAction').executable).toBe(true)
  })
})

/* -------------------------------------------------------------------- */
/* REST client                                                           */
/* -------------------------------------------------------------------- */

const credentials: BrowserbaseCredentials = { apiKey: 'bb_key_secret', projectId: 'proj_1' }

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0)
  } as unknown as Response
}

describe('browserbase REST client', () => {
  it('creates a session and returns the connect url + id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { id: 'sess_1', status: 'PENDING', connectUrl: 'wss://session-endpoint' })
    )
    const client = createBrowserbaseClient(fetchImpl as unknown as typeof fetch, credentials)
    const created = await client.createSession({ timeoutSeconds: 30 })
    expect(created).toMatchObject({ id: 'sess_1', status: 'PENDING' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; body?: string; headers: Record<string, string> }
    ]
    expect(url).toBe('https://api.browserbase.com/v1/sessions')
    expect(init.headers['x-bb-api-key']).toBe('bb_key_secret')
    expect(String(init.body)).toContain('"projectId":"proj_1"')
  })

  it('maps 401 to an auth failure without echoing the key', async () => {
    const client = createBrowserbaseClient(async () => jsonResponse(401, { message: 'bad key' }) as unknown as Response, credentials)
    const result = await client.createSession({ timeoutSeconds: 30 })
    expect(result).toMatchObject({ kind: 'auth' })
    expect(JSON.stringify(result)).not.toContain('bb_key_secret')
  })

  it('maps a project rejection to an actionable message', async () => {
    const client = createBrowserbaseClient(
      async () => jsonResponse(404, { message: 'project not found' }) as unknown as Response,
      credentials
    )
    const result = await client.createSession({ timeoutSeconds: 30 })
    expect(result).toMatchObject({ kind: 'invalid_project' })
  })

  it('maps 429 to rate limiting and network errors honestly', async () => {
    const limited = createBrowserbaseClient(async () => jsonResponse(429, {}) as unknown as Response, credentials)
    await expect(limited.createSession({ timeoutSeconds: 30 })).resolves.toMatchObject({ kind: 'rate_limit' })
    const broken = createBrowserbaseClient((async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch, credentials)
    await expect(broken.createSession({ timeoutSeconds: 30 })).resolves.toMatchObject({ kind: 'network' })
  })

  it('releases the session via the documented REQUEST_RELEASE update', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'sess_1' }))
    const client = createBrowserbaseClient(fetchImpl as unknown as typeof fetch, credentials)
    await expect(client.releaseSession('sess_1')).resolves.toBe('released')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; body: string; headers: Record<string, string> }
    ]
    expect(url).toContain('/v1/sessions/sess_1')
    expect(init.method).toBe('POST')
    expect(init.body).toContain('REQUEST_RELEASE')
    expect(init.body).toContain('REQUEST_RELEASE')
  })

  it('treats 404 on release as already-ended, other failures as unconfirmed', async () => {
    const gone = createBrowserbaseClient(async () => jsonResponse(404, {}) as unknown as Response, credentials)
    await expect(gone.releaseSession('sess_1')).resolves.toBe('not_found')
    const broken = createBrowserbaseClient(async () => jsonResponse(500, {}) as unknown as Response, credentials)
    await expect(broken.releaseSession('sess_1')).resolves.toBe('unconfirmed')
  })

  it('tolerates release network failures without throwing', async () => {
    const client = createBrowserbaseClient((async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch, credentials)
    await expect(client.releaseSession('sess_1')).resolves.toBe('unconfirmed')
  })

  it('disables recording and logging on created sessions', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 's', status: 'PENDING', connectUrl: 'wss://x' }))
    const client = createBrowserbaseClient(fetchImpl as unknown as typeof fetch, credentials)
    await client.createSession({ timeoutSeconds: 30 })
    const call = fetchImpl.mock.calls[0] as unknown as [unknown, { body: unknown }]
    const body = String(call[1]?.body ?? '')
    expect(body).toContain('"recordSession":false')
    expect(body).toContain('"logSession":false')
  })
})
