import {
  Zap as TriggerIcon,
  MousePointerClick as BrowserActionIcon,
  PenLine as PaperInstrumentsIcon,
  Timer as DelayIcon,
  Split as ConditionIcon,
  Type as DataIcon,
  Combine as JoinIcon
} from 'lucide-react'
import type { NodeTypeId } from '../../../../shared/nodeSchema'

/**
 * Display metadata for node cards and the library. Colors are muted by
 * design: soft tinted icon chips, neutral surfaces, one indigo accent
 * for selection — matching the reference's quiet visual hierarchy.
 */
export interface NodeDisplayMeta {
  icon: typeof TriggerIcon
  tint: { text: string; bg: string; border: string }
}

export const nodeDisplay: Record<NodeTypeId, NodeDisplayMeta> = {
  trigger: {
    icon: TriggerIcon,
    tint: { text: 'text-[#157f3d]', bg: 'bg-[#eef7f1]', border: 'border-[#dcebe0]' }
  },
  browserAction: {
    icon: BrowserActionIcon,
    tint: { text: 'text-[#3f4cc0]', bg: 'bg-[#eef0fb]', border: 'border-[#dde0f4]' }
  },
  delay: {
    icon: DelayIcon,
    tint: { text: 'text-[#a05a12]', bg: 'bg-[#fbf6ec]', border: 'border-[#f0e5cf]' }
  },
  condition: {
    icon: ConditionIcon,
    tint: { text: 'text-[#7743c6]', bg: 'bg-[#f4f0fb]', border: 'border-[#e7dff4]' }
  },
  data: {
    icon: DataIcon,
    tint: { text: 'text-[#0f766e]', bg: 'bg-[#eef7f6]', border: 'border-[#d9ebe9]' }
  },
  join: {
    icon: JoinIcon,
    tint: { text: 'text-[#5d5e66]', bg: 'bg-[#f0f0f3]', border: 'border-[#e3e4e8]' }
  },
  paperInstruments: {
    icon: PaperInstrumentsIcon,
    tint: { text: 'text-[#5b7a8c]', bg: 'bg-[#eff5f8]', border: 'border-[#dfe9ee]' }
  }
}
