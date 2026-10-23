import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowGraph, WorkflowNode, WorkflowRecord } from '../../src/shared/contracts'
import { WORKFLOW_SCHEMA_VERSION } from '../../src/shared/nodeSchema'
import { WorkflowService } from '../../src/main/services/workflows'

/* A quiet logger keeps test output clean while letting failures surface. */
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

let dir: string
let service: WorkflowService

function graphEmpty(): WorkflowGraph {
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] }
}

function node(id: string, type: WorkflowNode['type'] | string, x = 0, y = 0, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x, y }, config } as unknown as WorkflowNode
}

function edge(id: string, source: string, target: string, sourceHandle?: string) {
  return sourceHandle ? { id, source, target, sourceHandle } : { id, source, target }
}

/** Builds a valid trigger → browser chain used by several cases. */
function chainGraph(): WorkflowGraph {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    nodes: [
      node('trig1', 'trigger', 40, 80, { kind: 'manual' }),
      node('brws1', 'browserAction', 280, 80, { name: 'Open example', action: 'navigate', url: 'https://example.com' })
    ],
    edges: [edge('edge1', 'trig1', 'brws1')]
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowloom-wf-'))
  service = new WorkflowService(dir, logger)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('workflow records', () => {
  it('creates a record with a real id, name, timestamps and an empty typed graph', () => {
    const record = service.create({ name: 'Morning scrape' })
    expect(record.id).toMatch(/^wf_[a-z0-9]+$/)
    expect(record.name).toBe('Morning scrape')
    expect(record.createdAt).toBeTruthy()
    expect(record.updatedAt).toBeTruthy()
    expect(record.graph).toEqual(graphEmpty())
  })

  it('saves and reopens a workflow with nodes, positions and edges preserved', () => {
    const created = service.create({ name: 'Round trip' })
    const saved = service.save({ id: created.id, name: 'Round trip', graph: chainGraph() })
    expect(saved.ok).toBe(true)

    const reopened = service.get(created.id)
    expect(reopened).not.toBeNull()
    expect(reopened?.graph.nodes).toHaveLength(2)
    expect(reopened?.graph.edges).toHaveLength(1)
    const browserNode = reopened?.graph.nodes.find((n) => n.id === 'brws1')
    expect(browserNode?.position).toEqual({ x: 280, y: 80 })
    expect(browserNode?.config).toEqual({
      name: 'Open example',
      action: 'navigate',
      url: 'https://example.com'
    })
    expect(reopened?.graph.edges[0]).toMatchObject({ source: 'trig1', target: 'brws1' })
  })

  it('saves the canvas view and reopens with it unchanged', () => {
    const created = service.create({ name: 'Kept view' })
    const saved = service.save({
      id: created.id,
      name: 'Kept view',
      graph: chainGraph(),
      view: { zoom: 0.85, x: -140, y: 77.25 }
    })
    expect(saved.ok).toBe(true)
    const reopened = service.get(created.id)
    expect(reopened?.view).toEqual({ zoom: 0.85, x: -140, y: 77.25 })

    // Saving new content without a view keeps the previous stored view.
    service.save({ id: created.id, name: 'Kept view', graph: chainGraph() })
    expect(service.get(created.id)?.view).toEqual({ zoom: 0.85, x: -140, y: 77.25 })
  })

  it('rejects nonsensical view payloads instead of storing them', () => {
    const created = service.create({ name: 'Bad view' })
    const saved = service.save({
      id: created.id,
      name: 'Bad view',
      graph: graphEmpty(),
      view: { zoom: -3, x: 0, y: 0 } as unknown as WorkflowRecord['view']
    })
    expect(saved.ok).toBe(true)
    expect(service.get(created.id)?.view).toBeNull()
  })

  it('renames through save while keeping id and creation time', () => {
    const created = service.create({ name: 'First name' })
    const saved = service.save({ id: created.id, name: 'Renamed', graph: graphEmpty() })
    expect(saved.ok).toBe(true)
    const reopened = service.get(created.id)
    expect(reopened?.name).toBe('Renamed')
    expect(reopened?.id).toBe(created.id)
    expect(reopened?.createdAt).toBe(created.createdAt)
  })

  it('duplicates a workflow as a new record with copied graph', () => {
    const created = service.create({ name: 'Original' })
    service.save({ id: created.id, name: 'Original', graph: chainGraph() })

    const copy = service.duplicate(created.id)
    expect(copy).not.toBeNull()
    expect(copy?.id).not.toBe(created.id)
    expect(copy?.name).toBe('Original (copy)')
    expect(copy?.graph.nodes).toHaveLength(2)
    expect(copy?.graph.edges).toHaveLength(1)
    expect((copy?.createdAt ?? '') >= created.createdAt).toBe(true)

    // The copy exists as its own record.
    expect(service.get(copy!.id)?.graph.nodes).toHaveLength(2)
  })

  it('deletes a workflow and drops it from the list', () => {
    const a = service.create({ name: 'A' })
    const b = service.create({ name: 'B' })
    expect(service.delete(a.id)).toBe(true)
    expect(service.get(a.id)).toBeNull()
    expect(service.list().map((wf) => wf.id)).toEqual([b.id])
  })

  it('lists summaries sorted by most recently updated', () => {
    const a = service.create({ name: 'A' })
    const b = service.create({ name: 'B' })
    service.save({ id: a.id, name: 'A updated', graph: graphEmpty() })
    const list = service.list()
    expect(list[0].id).toBe(a.id)
    expect(list[list.length - 1].id).toBe(b.id)
  })

  it('refuses to save a workflow id that does not exist', () => {
    const saved = service.save({ id: 'wf_missing000', name: 'Ghost', graph: graphEmpty() })
    expect(saved.ok).toBe(false)
  })

  it('normalizes description and long names on save', () => {
    const created = service.create({ name: 'X' })
    const saved = service.save({
      id: created.id,
      name: '  '.concat('n'.repeat(400)),
      description: '  '.concat('d'.repeat(600)),
      graph: graphEmpty()
    })
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.record.name.length).toBe(120)
      expect(saved.record.description.length).toBe(400)
    }
  })
})

describe('graph validation on save', () => {
  it('rejects an unsupported schema version', () => {
    const created = service.create({ name: 'V' })
    const saved = service.save({
      id: created.id,
      name: 'V',
      graph: { schemaVersion: 99, nodes: [], edges: [] }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.errors.join(' ')).toMatch(/schema version 99/i)
  })

  it('rejects duplicate node ids and duplicate edge ids', () => {
    const created = service.create({ name: 'Dupes' })
    const saved = service.save({
      id: created.id,
      name: 'Dupes',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [node('n1', 'trigger', 0, 0, { kind: 'manual' }), node('n1', 'delay', 100, 0, { seconds: 30 })],
        edges: [edge('e1', 'n1', 'n1'), edge('e1', 'n1', 'n1')]
      }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) {
      expect(saved.errors.join(' ')).toMatch(/more than once/)
    }
  })

  it('rejects edges pointing at nodes that do not exist', () => {
    const created = service.create({ name: 'Dangling' })
    const saved = service.save({
      id: created.id,
      name: 'Dangling',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [node('trig1', 'trigger', 0, 0, { kind: 'manual' })],
        edges: [edge('e1', 'trig1', 'ghost')]
      }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.errors.join(' ')).toMatch(/no longer exists/)
  })

  it('rejects self-connections', () => {
    const created = service.create({ name: 'SelfLoop' })
    const saved = service.save({
      id: created.id,
      name: 'SelfLoop',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [node('n1', 'delay', 0, 0, { seconds: 30 })],
        edges: [edge('e1', 'n1', 'n1')]
      }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.errors.join(' ')).toMatch(/cannot connect to itself/)
  })

  it('rejects directed cycles that would loop the flow forever', () => {
    const created = service.create({ name: 'Cycle' })
    const saved = service.save({
      id: created.id,
      name: 'Cycle',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('n1', 'delay', 0, 0, { seconds: 30 }),
          node('n2', 'data', 100, 0, { value: 'x' }),
          node('n3', 'join', 200, 0, { behavior: 'all' })
        ],
        edges: [edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n3'), edge('e3', 'n3', 'n1')]
      }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.errors.join(' ')).toMatch(/loop/)
  })

  it('rejects unsupported node types', () => {
    const created = service.create({ name: 'Alien' })
    const saved = service.save({
      id: created.id,
      name: 'Alien',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [node('n1', 'sentientToast', 0, 0, {})],
        edges: []
      }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.errors.join(' ')).toMatch(/unsupported type/)
  })

  it('rejects edges onto nodes that accept no input, and bad handles', () => {
    const created = service.create({ name: 'Wrong direction' })
    const saved = service.save({
      id: created.id,
      name: 'Wrong direction',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', 0, 0, { kind: 'manual' }),
          node('data1', 'data', 100, 0, { value: 'x' })
        ],
        edges: [edge('e1', 'data1', 'trig1')]
      }
    })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.errors.join(' ')).toMatch(/trigger/)

    const created2 = service.create({ name: 'Bad handle' })
    const saved2 = service.save({
      id: created2.id,
      name: 'Bad handle',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', 0, 0, { kind: 'manual' }),
          node('data1', 'data', 100, 0, { value: 'x' })
        ],
        edges: [edge('e1', 'trig1', 'data1', 'missing-handle')]
      }
    })
    expect(saved2.ok).toBe(false)
    if (!saved2.ok) expect(saved2.errors.join(' ')).toMatch(/output does not exist/)
  })

  it('saves structurally valid workflows with incomplete configuration and reports the gaps', () => {
    const created = service.create({ name: 'Half built' })
    const saved = service.save({
      id: created.id,
      name: 'Half built',
      graph: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          node('trig1', 'trigger', 0, 0, { kind: 'manual' }),
          node('brws1', 'browserAction', 100, 0, { name: '', action: 'navigate', url: '' })
        ],
        edges: [edge('e1', 'trig1', 'brws1')]
      }
    })
    // Incomplete configuration is not a structural failure.
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      const brwsIssue = saved.configIssues.find((issue) => issue.nodeId === 'brws1')
      expect(brwsIssue?.message).toBeTruthy()
      expect(saved.record.graph.nodes).toHaveLength(2)
    }
  })

  it('reports no config issues for a fully configured workflow', () => {
    const created = service.create({ name: 'Complete' })
    const saved = service.save({ id: created.id, name: 'Complete', graph: chainGraph() })
    expect(saved.ok).toBe(true)
    if (saved.ok) expect(saved.configIssues).toEqual([])
  })
})

describe('main-process payload defense', () => {
  it('sanitizes malformed node payloads into a structurally rejected form, not a crash', () => {
    const created = service.create({ name: 'Garbage in' })
    const garbage = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [null, undefined, { id: 'x', type: 'trigger' }],
      edges: 'not-a-list'
    } as unknown as WorkflowRecord['graph']
    const saved = service.save({ id: created.id, name: 'Garbage in', graph: garbage })
    expect(saved.ok).toBe(false)
  })
})
