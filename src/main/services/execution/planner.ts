import type {
  NodeRunRecord,
  RunRecord
} from '../../../shared/runTypes'
import type { WorkflowNode } from '../../../shared/nodeSchema'
import { getNodeType, validateWorkflowGraph } from '../../../shared/nodeSchema'
import type { WorkflowGraph, WorkflowRecord } from '../../../shared/contracts'
import type { Logger } from '../../lib/log'

/**
 * The planner turns a persisted workflow into an execution-ready run
 * record *before* anything is executed. It is the main-process
 * validation boundary — it never trusts renderer checks:
 *
 * - revalidates the persisted graph (schema version, ids, endpoints);
 * - requires at least one executable entry (a trigger);
 * - refuses node types whose executors do not exist yet (Prompt 4);
 * - requires every step's configuration to be complete — an
 *   "unfinished" workflow is saved in the editor but refused to run,
 *   with actionable per-node errors.
 *
 * Nothing is modified silently: whatever is in the record is planned
 * as-is or rejected with clear messages.
 */

export interface PlannedGraph {
  nodes: WorkflowNode[]
  /** incoming edge ids per node id */
  incomingByTarget: Map<string, string[]>
  /** outgoing edges per node id */
  outgoingBySource: Map<string, { id: string; target: string; sourceHandle?: string }[]>
  /** edges keyed by id */
  edgeById: Map<string, { source: string; target: string; sourceHandle?: string }>
  triggers: string[]
}

export interface PlanOutcome {
  ok: boolean
  errors: string[]
  graph: PlannedGraph | null
}

/** Failure to run: the workflow's data itself did not satisfy the rules. */
function planFailure(errors: string[]): PlanOutcome {
  return { ok: false, errors, graph: null }
}

export function plan(record: WorkflowRecord, _logger: Logger | null): PlanOutcome {
  const errors: string[] = []
  const graph: WorkflowGraph = record.graph
  const validation = validateWorkflowGraph(graph)
  if (!validation.structural) {
    return planFailure([...validation.structuralErrors])
  }

  const nodes = graph.nodes
  const edges = graph.edges

  // Configuration completeness — honest and actionable, per node.
  const configIssues = new Map<string, string>()
  for (const node of nodes) {
    const definition = getNodeType(node.type)
    const fieldErrors = definition.validateConfig(node.config)
    for (const message of Object.values(fieldErrors)) {
      configIssues.set(node.id, `${definition.label} "${nodeTitle(node)}" — ${message}`)
      break
    }
  }
  if (configIssues.size > 0) {
    errors.push('Finish the configuration before running:')
    for (const issue of configIssues.values()) errors.push(`• ${issue}`)
    return planFailure(errors)
  }

  // Entry points: this phase supports the manual trigger only.
  const triggerNodes = nodes.filter((node) => node.type === 'trigger')
  if (triggerNodes.length === 0) {
    errors.push('This workflow has no trigger — add a manual trigger and connect your first step to it.')
    return planFailure(errors)
  }
  for (const trigger of triggerNodes) {
    const hasOutgoing = edges.some((edge) => edge.source === trigger.id)
    if (!hasOutgoing) {
      errors.push('The trigger is not connected to any step — connect it to where the workflow should start.')
      return planFailure(errors)
    }
  }

  // Every registered node type must have an explicit execution
  // capability; unsupported types refuse to run instead of no-oping.
  const unsupported = nodes.filter((node) => !getNodeType(node.type).executable)
  if (unsupported.length > 0) {
    for (const node of unsupported) {
      const definition = getNodeType(node.type)
      errors.push(
        `"${nodeTitle(node)}" is a ${definition.label.toLowerCase()} — this node type is not executable yet and arrives in a later phase. Remove or replace it to run the rest.`
      )
    }
    return planFailure(errors)
  }

  const unknownEntrypoints = triggerNodes.filter((t) => !nodes.some((n) => n.id === t.id))
  if (unknownEntrypoints.length > 0) {
    errors.push('A trigger references a node that no longer exists.')
    return planFailure(errors)
  }

  // Reachability: every node must be drawable from a trigger (otherwise
  // it would dead-lock waiting for an input that never resolves).
  const reachable = new Set<string>(triggerNodes.map((t) => t.id))
  const frontier = [...reachable]
  while (frontier.length > 0) {
    const current = frontier.pop()
    for (const edge of edges) {
      if (edge.source === current && !reachable.has(edge.target)) {
        reachable.add(edge.target)
        frontier.push(edge.target)
      }
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      errors.push(
        `"${nodeTitle(node)}" is not reachable from a trigger — it can never run. Connect it to the flow or remove it`
      )
    }
  }
  if (errors.length > 0) return planFailure(errors)

  const incomingByTarget = new Map<string, string[]>()
  const outgoingBySource = new Map<string, { id: string; target: string; sourceHandle?: string }[]>()
  const edgeById = new Map<string, { source: string; target: string; sourceHandle?: string }>()
  for (const edge of edges) {
    incomingByTarget.set(edge.target, [...(incomingByTarget.get(edge.target) ?? []), edge.id])
    outgoingBySource.set(edge.source, [
      ...(outgoingBySource.get(edge.source) ?? []),
      { id: edge.id, target: edge.target, sourceHandle: edge.sourceHandle }
    ])
    edgeById.set(edge.id, { source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle })
  }

  return {
    ok: true,
    errors: [],
    graph: { nodes, incomingByTarget, outgoingBySource, edgeById, triggers: triggerNodes.map((t) => t.id) }
  }
}

export function nodeTitle(node: WorkflowNode): string {
  const config = node.config ?? {}
  if (typeof config['name'] === 'string' && config['name']) return config['name']
  try {
    return getNodeType(node.type).defaultTitle
  } catch {
    return node.id
  }
}

/** Initial node records for a planned run, all pending. */
export function initialNodeRecords(nodes: WorkflowNode[]): NodeRunRecord[] {
  return nodes.map((node) => {
    return {
      nodeId: node.id,
      nodeType: node.type,
      title: nodeTitle(node),
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      outputSummary: null
    }
  })
}

/** Defensive re-check of a run record read back from history. */
export function isRunRecordShape(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false
  const run = value as RunRecord
  return (
    typeof run.id === 'string' &&
    typeof run.workflowId === 'string' &&
    typeof run.status === 'string' &&
    typeof run.startedAt === 'string' &&
    Array.isArray(run.nodes) &&
    run.nodes.every(
      (node) =>
        typeof node === 'object' &&
        node !== null &&
        typeof (node as NodeRunRecord).nodeId === 'string' &&
        typeof (node as NodeRunRecord).status === 'string'
    )
  )
}
