import { useCallback } from 'react'
import { Background, BackgroundVariant, ReactFlow, useReactFlow, type Connection, type Edge, type EdgeChange, type NodeChange, type OnConnect } from '@xyflow/react'
import type { NodeTypeId, WorkflowNode } from '../../../../shared/nodeSchema'
import { explainConnection, getNodeType } from '../../../../shared/nodeSchema'
import { flowNodeTypes, type FlowNode } from './nodeTypes'
import { ZoomControls } from './ZoomControls'
import { cn } from '../../lib/cn'

/**
 * The interactive canvas: a dotted grid, nodes with typed handles, and
 * curved bezier connections like the reference. Connection rules come
 * from the shared registry — impossible lines cannot even be drawn,
 * and an invalid drop is refused with an honest explanation.
 */
export function WorkflowCanvas({
  nodes,
  edges,
  readOnly,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onDragStart,
  onDragStop,
  onMoveEnd,
  onNodeClick,
  onEdgeClick,
  onPaneInteraction,
  onDropType,
  onInvalidDrop,
  onDeleteSelection,
  zoomIn,
  zoomOut,
  fitView
}: {
  nodes: FlowNode[]
  edges: Edge[]
  readOnly: boolean
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: OnConnect
  /** Drag of a node started — capture the pre-drag history snapshot. */
  onDragStart: () => void
  /** Drag of a node finished — persist the new positions. */
  onDragStop: () => void
  /** Pan/zoom finished — the view is persisted so reopenings match. */
  onMoveEnd: () => void
  onNodeClick: (nodeId: string) => void
  onEdgeClick: (edgeId: string) => void
  onPaneInteraction: () => void
  /** A library item was dropped at a flow position. */
  onDropType: (typeId: NodeTypeId, flowPosition: { x: number; y: number }) => void
  onInvalidDrop: (reason: string) => void
  onDeleteSelection: () => void
  zoomIn: () => void
  zoomOut: () => void
  fitView: () => void
}) {
  const { screenToFlowPosition } = useReactFlow()

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const typeId = event.dataTransfer.getData('application/flowloom-node')
      if (!typeId) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      onDropType(typeId as NodeTypeId, { x: position.x - 104, y: position.y - 24 })
    },
    [screenToFlowPosition, onDropType]
  )

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Guard against deleting a node while typing in a text field.
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        onDeleteSelection()
      }
    },
    [onDeleteSelection]
  )

  const isValidCandidate = useCallback(
    (candidate: Connection | Edge): boolean => {
      const { source, target, sourceHandle } = candidate
      if (!source || !target) return false
      if (source === target) return false
      const sourceNode = nodes.find((n) => n.id === source)
      const targetNode = nodes.find((n) => n.id === target)
      if (!sourceNode || !targetNode) return false
      if (!getNodeType(targetNode.data.typeId).acceptsInput) return false
      const sourceDef = getNodeType(sourceNode.data.typeId)
      if (sourceHandle && !sourceDef.outputs.some((out) => out.id === sourceHandle)) return false
      const duplicate = edges.some(
        (edge) => edge.source === source && edge.target === target && edge.sourceHandle === sourceHandle
      )
      return !duplicate
    },
    [nodes, edges]
  )

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      const reason = explainConnection(
        asWorkflowNodes(nodes),
        edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {})
        })),
        connection.source,
        connection.target,
        connection.sourceHandle ?? undefined
      )
      if (reason) {
        onInvalidDrop(reason)
        return
      }
      onConnect(connection)
    },
    [nodes, edges, onConnect, onInvalidDrop]
  )

  return (
    <div
      className="relative h-full min-h-0 w-full outline-none"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={flowNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeDragStart={onDragStart}
        onNodeDragStop={onDragStop}
        onNodeClick={(_, node) => onNodeClick(node.id)}
        onEdgeClick={(_, edge) => onEdgeClick(edge.id)}
        onPaneClick={onPaneInteraction}
        onMoveStart={onPaneInteraction}
        onMoveEnd={onMoveEnd}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        deleteKeyCode={null}
        isValidConnection={isValidCandidate}
        minZoom={0.25}
        maxZoom={2.5}
        defaultEdgeOptions={{
          type: 'default',
          style: { stroke: '#d3d4da', strokeWidth: 1.6 }
        }}
        className={cn(
          '[&_.react-flow__edge.selected_.react-flow__edge-path]:!stroke-[#5c66e0]',
          '[&_.react-flow__edge_.react-flow__edge-path:hover]:!stroke-[#b9bdd6]'
        )}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#dcdce2" />
      </ReactFlow>
      <ZoomControls onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitView} />
    </div>
  )
}

/** Converts renderer nodes to the persisted graph shape. */
function asWorkflowNodes(nodes: FlowNode[]): WorkflowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.data.typeId,
    position: node.position,
    config: node.data.config
  }))
}
