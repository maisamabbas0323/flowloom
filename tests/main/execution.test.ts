import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowGraph, WorkflowNode } from '../../src/shared/contracts'
import {
  WORKFLOW_SCHEMA_VERSION,
  conditionConfigSchema,
  hasValidReferenceSyntax,
  resolveTemplate
} from '../../src/shared/nodeSchema'
import type { Logger } from '../../src/main/lib/log'
import { plan } from '../../src/main/services/execution/planner'
import {
  ExecutorError,
  dataExecutor,
  conditionExecutor,
  delayExecutor,
  joinExecutor,
  cancellableDelay,
  evaluateCondition
} from '../../src/main/services/execution/executors'

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
}

function node(
  id: string,
  type: WorkflowNode['type'] | string,
  config: Record<string, unknown> = {},
  x = 0,
  y = 0
): WorkflowNode {
  return { id, type, position: { x, y }, config } as unknown as WorkflowNode
}

function edge(id: string, source: string, target: string, sourceHandle?: string) {
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target }
}

function record(graph: WorkflowGraph) {
  return {
    id: 'wf_test0001',
    name: 'Test flow',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: null,
    view: null,
    graph
  }
}

function recordType(value: ReturnType<typeof record>) {
  return value as unknown as Parameters<typeof plan>[0]
}

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

describe('execution planner', () => {
  it('plans a valid deterministic workflow', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('data1', 'data', { value: 'hello' })
          ],
          edges: [edge('e1', 'trig1', 'data1')]
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.errors).toEqual([])
    expect(outcome.graph?.triggers).toEqual(['trig1'])
    expect(outcome.graph?.incomingByTarget.get('data1')).toEqual(['e1'])
  })

  it('refuses a workflow with no trigger with an honest error', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [node('data1', 'data', { value: 'hello' })],
          edges: []
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.errors[0]).toMatch(/no trigger/i)
  })

  it('refuses a disconnected trigger with an honest error', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [node('trig1', 'trigger', { kind: 'manual' })],
          edges: []
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.join(' ')).toMatch(/not connected/i)
  })

  it('refuses unfinished configuration instead of running half a workflow', () => {
    // Shape-valid but empty: the condition needs a comparable value for
    // its `contains` operator, so a run may not start.
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('cond1', 'condition', { checkText: 'abc', operator: 'contains', contains: '' })
          ],
          edges: [edge('e1', 'trig1', 'cond1')]
        }),
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.join(' ')).toMatch(/finish the configuration/i)
    expect(outcome.errors.join(' ')).toMatch(/compares against/)
  })

  it('recognizes operator-required fields: isEmpty needs no comparison value', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('cond1', 'condition', { checkText: 'abc', operator: 'isEmpty' })
          ],
          edges: [edge('e1', 'trig1', 'cond1')]
        }),
      ),
      logger
    )
    expect(outcome.ok).toBe(true)
  })

  it('plans a fully-configured browser action for execution (Prompt 4)', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('brws1', 'browserAction', { name: 'Open example', action: 'navigate', url: 'https://example.com' })
          ],
          edges: [edge('e1', 'trig1', 'brws1')]
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(true)
  })

  it('refuses a half-configured browser action with its missing detail', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('brws1', 'browserAction', { name: 'Click something', action: 'click' })
          ],
          edges: [edge('e1', 'trig1', 'brws1')]
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.join(' ')).toMatch(/finish the configuration/i)
  })

  it('refuses nodes unreachable from the trigger', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('data1', 'data', { value: 'a' }),
            node('data2', 'data', { value: 'b' })
          ],
          edges: [edge('e1', 'trig1', 'data1')]
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.join(' ')).toMatch(/not reachable/i)
  })

  it('reports structural graph problems (missing edge endpoints)', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [node('trig1', 'trigger', { kind: 'manual' })],
          edges: [edge('e1', 'trig1', 'ghost')]
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.graph).toBeNull()
  })

  it('rejects cycles as invalid structures rather than looping', () => {
    const outcome = plan(
      recordType(
        record({
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          nodes: [
            node('trig1', 'trigger', { kind: 'manual' }),
            node('data1', 'data', { value: 'a' }),
            node('data2', 'data', { value: 'b' })
          ],
          edges: [edge('e1', 'trig1', 'data1'), edge('e2', 'data1', 'data2'), edge('e3', 'data2', 'data1')]
        })
      ),
      logger
    )
    expect(outcome.ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* Reference syntax                                                    */
/* ------------------------------------------------------------------ */

describe('reference templating', () => {
  it('accepts well-formed {{nodeId}} references only', () => {
    expect(hasValidReferenceSyntax('{{data1}}')).toBe(true)
    expect(hasValidReferenceSyntax('a {{ n_0 }} b')).toBe(true)
    expect(hasValidReferenceSyntax('{{javascript:alert(1)}}')).toBe(false)
    expect(hasValidReferenceSyntax('{{missing close')).toBe(false)
    expect(hasValidReferenceSyntax('plain text')).toBe(true)
  })

  it('resolves references from finished upstream outputs', () => {
    const upstream = new Map<string, string>([['data1', 'Flowloom rocks']])
    const resolved = resolveTemplate('Report: {{data1}}!', upstream)
    expect(resolved).toEqual({ ok: true, value: 'Report: Flowloom rocks!' })
  })

  it('rejects references to nodes that never finished, with all known ids', () => {
    const upstream = new Map<string, string>([['data1', 'x']])
    const rejected = resolveTemplate('{{ghost}}', upstream)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error).toContain('data1')
  })

  it('rejects resolution past the payload limit', () => {
    const upstream = new Map<string, string>([['big', 'x'.repeat(70_000)]])
    const rejected = resolveTemplate('{{big}}', upstream)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error).toMatch(/payload limit/i)
  })
})

/* ------------------------------------------------------------------ */
/* Executors                                                           */
/* ------------------------------------------------------------------ */

const SIGNAL = { cancelled: false, listeners: new Set<() => void>() }

beforeEach(() => {
  SIGNAL.cancelled = false
  SIGNAL.listeners.clear()
})

describe('deterministic node executors', () => {
  it('data publishes its configured value, resolved from templates', async () => {
    const upstream = new Map([['data0', { value: 'seeded' }]])
    const result = await dataExecutor(
      node('data1', 'data', { value: 'Copy of {{data0}}' }) as any,
      { config: { value: 'Copy of {{data0}}' }, input: null, upstream, signal: SIGNAL }
    )
    expect(result.value).toBe('Copy of seeded')
  })

  it('data fails on unresolved references instead of producing nothing', async () => {
    await expect(
      dataExecutor(node('data1', 'data', { value: '{{ghost}}' }) as any, {
        config: { value: '{{ghost}}' },
        input: null,
        upstream: new Map(),
        signal: SIGNAL
      })
    ).rejects.toThrow(/no upstream step/)
  })

  it('evaluates every condition operator with type-aware comparisons', () => {
    // contains / doesNotContain
    expect(evaluateCondition('Flowloom rocks', 'contains', 'rocks').taken).toBe('true')
    expect(evaluateCondition('Flowloom', 'contains', 'zzz').taken).toBe('false')
    expect(evaluateCondition('Flowloom', 'doesNotContain', 'zzz').taken).toBe('true')
    expect(evaluateCondition('Flowloom', 'doesNotContain', 'loom').taken).toBe('false')
    // equals / notEquals (exact, case-sensitive)
    expect(evaluateCondition('abc', 'equals', 'abc').taken).toBe('true')
    expect(evaluateCondition('abc', 'equals', 'ABC').taken).toBe('false')
    expect(evaluateCondition('abc', 'notEquals', 'ABC').taken).toBe('true')
    expect(evaluateCondition('abc', 'notEquals', 'abc').taken).toBe('false')
    // isEmpty / isNotEmpty
    expect(evaluateCondition('', 'isEmpty', 'irrelevant').taken).toBe('true')
    expect(evaluateCondition('text', 'isEmpty', 'irrelevant').taken).toBe('false')
    expect(evaluateCondition('text', 'isNotEmpty', 'irrelevant').taken).toBe('true')
    expect(evaluateCondition('', 'isNotEmpty', 'irrelevant').taken).toBe('false')
  })

  it('evaluates missing values predictably: empty checkText is empty, not missing', () => {
    // One deterministic rule: a resolved empty string is genuinely empty.
    expect(evaluateCondition('', 'contains', 'x').taken).toBe('false')
    expect(evaluateCondition('', 'isEmpty', 'x').taken).toBe('true')
  })

  it('condition executor resolves both operands through references', async () => {
    const upstream = new Map([['data1', { value: 'hello world' }]])
    const result = (await conditionExecutor(node('cond', 'condition', {}) as any, {
      config: { checkText: '{{data1}}', operator: 'contains', contains: 'world' },
      input: { value: 'hello world' },
      upstream,
      signal: SIGNAL
    })) as { value: string; branch: 'true' | 'false' }
    expect(result.branch).toBe('true')
    expect(result.value).toBe('hello world')
  })

  it('condition executor fails on missing input rather than picking a branch', async () => {
    await expect(
      conditionExecutor(node('cond', 'condition', {}) as any, {
        config: { checkText: '{{ghost}}', operator: 'contains', contains: 'x' },
        input: null,
        upstream: new Map(),
        signal: SIGNAL
      })
    ).rejects.toBeInstanceOf(ExecutorError)
  })

  it('condition schema coexists with old saved configs (operator default)', () => {
    const parsed = conditionConfigSchema.safeParse({ checkText: 'a', contains: 'b' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.operator).toBe('contains')
    parsed.success && expect(conditionConfigSchema.safeParse({ checkText: 'a', contains: 'b', extra: 1 }).success).toBe(false)
  })

  it('join passes through the delivered input and rejects absence', async () => {
    const result = await joinExecutor(node('join1', 'join', { behavior: 'all' }) as any, {
      config: { behavior: 'all' },
      input: { value: 'merged data' },
      upstream: new Map(),
      signal: SIGNAL
    })
    expect(result.value).toBe('merged data')
    await expect(
      joinExecutor(node('join1', 'join', { behavior: 'all' }) as any, {
        config: { behavior: 'all' },
        input: null,
        upstream: new Map(),
        signal: SIGNAL
      })
    ).rejects.toThrow(/no connected branch/i)
  })

  it('delay actually waits the configured duration', async () => {
    const started = Date.now()
    await cancellableDelay(120, SIGNAL)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(80)
  }, 4_000)

  it('delay executor validates its bounds honestly', async () => {
    await expect(
      delayExecutor(node('d', 'delay', { seconds: 0 }) as any, {
        config: { seconds: 0 },
        input: null,
        upstream: new Map(),
        signal: SIGNAL
      })
    ).rejects.toThrow(/between 1 and 3600/)
    await expect(
      delayExecutor(node('d', 'delay', { seconds: 99999 }) as any, {
        config: { seconds: 99999 },
        input: null,
        upstream: new Map(),
        signal: SIGNAL
      })
    ).rejects.toThrow(/between 1 and 3600/)
  })

  it('delay cancellation clears the pending timer immediately and rejects', async () => {
    const pending = cancellableDelay(60_000, SIGNAL)
    await new Promise((resolve) => setTimeout(resolve, 20))
    SIGNAL.cancelled = true
    for (const listener of SIGNAL.listeners) listener()
    await expect(pending).rejects.toThrow(/cancelled/i)
    // The timer is gone: letting the event loop prove it. No crash and
    // the process does not hang on the 60s timer.
    expect(SIGNAL.listeners.size).toBe(0)
  }, 2_000)
})
