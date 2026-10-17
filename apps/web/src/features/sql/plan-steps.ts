import type { PlanAccess, PlanNode } from '@tsmyadmin/shared'
import type { OverlayStep, Tone } from '@/components/schema-diagram/overlay.ts'
import { locale } from '@/config/locale.ts'

const t = locale.plan

/** A node of the plan with where it sits in the tree (`0.1.0`: first child's second child's first), to point at. */
export interface PlanRead {
  node: PlanNode & { table: string }
  path: string
}

/**
 * The nodes that read a table, in the order they run: children before their parent, left before right (a join reads
 * its outer input first). These are the steps of the story; joins, sorts and the like are the tree's to show.
 */
export function planReads(plan: PlanNode): PlanRead[] {
  const out: PlanRead[] = []
  const walk = (n: PlanNode, path: string) => {
    n.children.forEach((c, i) => walk(c, `${path}.${i}`))
    if (n.table !== null && n.access !== null) out.push({ node: n as PlanRead['node'], path })
  }
  walk(plan, '0')
  return out
}

/** Reading every row (of the table or of an index) is what a plan is looked at for; a range or a lookup is the index at work. */
export const toneOf = (access: PlanAccess | null): Tone =>
  access === 'fullScan' || access === 'fullIndexScan'
    ? 'scan'
    : access === 'range' || access === 'lookup'
      ? 'index'
      : 'focus'

function how(n: PlanNode): string {
  const index = n.index ?? ''
  switch (n.access) {
    case 'fullScan':
      return t.how.fullScan
    case 'fullIndexScan':
      return t.how.fullIndexScan(index)
    case 'range':
      return t.how.range(index)
    case 'lookup':
      return t.how.lookup(index)
    default:
      return t.how.other
  }
}

/** One sentence for one read: which table, how, and how many rows the server expects. */
export function readSentence(n: PlanNode & { table: string }): string {
  const rows = n.estRows === null ? '' : t.rows(Math.round(n.estRows))
  return `${t.read(n.table, how(n), rows)}${n.covering ? t.covering : ''}`
}

/**
 * The story told on the diagram: each read lights its table (with the index as its badge, or "full" for a full scan)
 * and the index's columns. `indexColumns` gives them where the plan does not (PostgreSQL names the index only).
 */
export function planSteps(
  reads: readonly PlanRead[],
  indexColumns: (table: string, index: string) => readonly string[] = () => []
): OverlayStep[] {
  return reads.map(({ node }) => {
    const columns = node.index
      ? node.indexColumns.length > 0
        ? node.indexColumns
        : indexColumns(node.table, node.index)
      : []
    return {
      text: readSentence(node),
      tables: [{ name: node.table, tone: toneOf(node.access), badge: node.index ?? t.full }],
      columns: columns.map((column) => ({ table: node.table, column })),
    }
  })
}
