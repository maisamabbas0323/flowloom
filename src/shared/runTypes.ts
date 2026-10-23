import type { NodeTypeId } from './nodeSchema'

/**
 * Typed run lifecycle shared by the engine (main), the opening IPC
 * surface (preload), and the renderer (editor + run history).
 *
 * Run states form a strict progression:
 *   queued → validating → running → (cancelling) → terminal
 * with exactly one terminal state: succeeded | failed | cancelled.
 * A run never leaves a terminal state.
 */

export type RunStatus =
  | 'queued'
  | 'validating'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'

export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'validating',
  'running',
  'cancelling'
]

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export interface NodeRunRecord {
  nodeId: string
  nodeType: NodeTypeId
  title: string
  status: NodeRunStatus
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  /** Redacted, human-readable failure explanation. */
  error: string | null
  /** Redacted, size-capped output summary. */
  outputSummary: string | null
  /**
   * Structured, size-capped, secret-free per-node metadata (never node
   * output content) for the node kinds that publish it. Browser-action
   * nodes carry the operation shape; Paper Instruments nodes carry the
   * generation shape (usage tokens come from the provider, never
   * estimated locally).
   */
  meta?: BrowserOperationMeta | PaperGenerationMeta
}

/** Browser-action node metadata (bounded before persistence). */
export interface BrowserOperationMeta {
  operation: string
  finalUrl: string | null
  pageTitle: string | null
  textChars: number | null
  textTruncated: boolean
  screenshotId: string | null
  sessionId: string | null
  durationMs: number | null
}

/** Paper Instruments generation metadata. `model` marks the shape. */
export interface PaperGenerationMeta {
  model: string
  finishReason: string | null
  truncated: boolean
  /** Whether the configured structured-output validation ran. */
  structuredOutput: boolean
  /** Real token counts from the provider's usage block, never estimated. */
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  durationMs: number | null
  /** The prepaid balance the provider reported before the call, if checked. */
  balanceAvailableUsd: number | null
}

export interface RunRecord {
  id: string
  workflowId: string
  workflowName: string
  /** Schema version snapshot taken from the persisted workflow graph. */
  schemaVersion: number
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  nodes: NodeRunRecord[]
  /** Run-level failure reason (none for succeeded/cancelled). */
  error: string | null
  /** Set when the user asked to cancel, even before cleanup finishes. */
  cancelRequestedAt: string | null
}

export interface RunSummary {
  id: string
  workflowId: string
  workflowName: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  error: string | null
}

/**
 * Pushed from main to all open windows over the `runs:event` channel.
 * Every event carries its runId so the renderer can ignore stale runs.
 */
export type RunEvent =
  | { type: 'workflow'; runId: string; workflowId: string; status: RunStatus; at: string; message?: string }
  | {
      type: 'node'
      runId: string
      workflowId: string
      nodeId: string
      status: NodeRunStatus
      at: string
      /**
       * Latest real execution stage for the node (e.g. "Navigating to…"),
       * redacted and size-capped — never a simulated progress value.
       */
      message?: string
      /**
       * Node type and title (≤80 chars, never page content) so listeners
       * such as the narration service and the editor can name the step.
       */
      nodeType?: NodeTypeId
      nodeTitle?: string
    }

/** Result of the `runs:start` IPC call. */
export type RunStartResult =
  | { ok: true; runId: string }
  | { ok: false; errors: string[] }

/**
 * Pushed from main to open windows over `voice:narration` when optional
 * voice feedback generated real audio. Narration text uses fixed safe
 * templates — counts, statuses, and node titles only, never page
 * content or secrets.
 */
export interface NarrationPayload {
  /** Stable key so repeated pushes of one announcement can be dropped. */
  eventKey: string
  text: string
  mimeType: string
  base64: string
  /** Playback rate recommendation from the user's narration settings. */
  speed: number
}
