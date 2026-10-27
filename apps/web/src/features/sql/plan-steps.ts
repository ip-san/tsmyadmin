import type { PlanAccess, PlanNode } from '@tsmyadmin/shared'
import type { OverlayStep, Tone } from '@/components/schema-diagram/overlay.ts'
import { locale } from '@/config/locale-screens.ts'

const t = locale.plan

/**
 * How a read is joined to the rows read before it, from the join above it (or, on MySQL 8's format, the table's own
 * join buffer): the outer and inner side of a nested loop, the inner side of a loop over a buffer of rows, the side
 * a hash join builds its table from and the side it probes it with, or a side of a merge join.
 */
export type JoinRole = 'loopOuter' | 'loopInner' | 'blockInner' | 'hashBuild' | 'hashProbe' | 'merge'

type Method = 'loop' | 'block' | 'hash' | 'merge'

/** The join method an operation names, across the servers' words ("Nested Loop", "Inner hash join", "Hash semijoin"…). */
function joinMethod(op: string): Method | null {
  if (/block (nested loop|hash join)|join buffer/i.test(op))
    return /hash/i.test(op) ? 'hash' : /batched key/i.test(op) ? 'loop' : 'block'
  if (/nested loop/i.test(op)) return 'loop'
  if (/hash (semi|anti)?\s?join/i.test(op)) return 'hash'
  if (/merge (semi|anti)?\s?join/i.test(op)) return 'merge'
  return null
}

/** A node of the plan with where it sits in the tree (`0.1.0`: first child's second child's first), to point at. */
export interface PlanRead {
  node: PlanNode & { table: string }
  path: string
  /** How it is joined to the rows read before it; null where no join is above it. */
  join: JoinRole | null
  /**
   * Read inside a subquery that may run again for each row outside it: PostgreSQL's SubPlan, MySQL's and MariaDB's
   * subqueries. Not a table in FROM made of a SELECT (PostgreSQL's Subquery Scan), which is read once.
   */
  subquery: boolean
}

/** The role of a join's children: a loop's first input drives it, a hash join builds from its last. */
function roleOf(method: Method, child: number, children: number): JoinRole {
  switch (method) {
    case 'loop':
      return child === 0 ? 'loopOuter' : 'loopInner'
    case 'block':
      return child === 0 && children > 1 ? 'loopOuter' : 'blockInner'
    case 'hash':
      return child === children - 1 ? 'hashBuild' : 'hashProbe'
    case 'merge':
      return 'merge'
  }
}

/**
 * The nodes that read a table, in the order they run: children before their parent, left before right (a join reads
 * its outer input first), except a hash join, which reads the input it builds its table from (its last) first. These
 * are the steps of the story; joins, sorts and the like are the tree's to show.
 */
export function planReads(plan: PlanNode): PlanRead[] {
  const out: PlanRead[] = []
  const walk = (n: PlanNode, path: string, join: JoinRole | null, subquery: boolean) => {
    const method = joinMethod(n.op)
    const inner = subquery || /\bsubplan\b|^subquery$/i.test(n.op)
    // Kept once read: the loop above re-reads the rows kept, not the table under it.
    const kept = /^(materiali[sz]e|memoize)\b/i.test(n.op)
    const order = n.children.map((c, i) => [c, i] as const)
    if (method === 'hash' && order.length > 1) order.unshift(...order.splice(-1))
    for (const [c, i] of order)
      walk(
        c,
        `${path}.${i}`,
        method && n.table === null ? roleOf(method, i, n.children.length) : kept ? null : join,
        inner
      )
    if (n.table !== null && n.access !== null) {
      // MySQL 8 says the join buffer on the table it joins: the rows before it are buffered (or hashed).
      const own = method === 'hash' ? 'hashProbe' : method === 'block' ? 'blockInner' : join
      out.push({ node: n as PlanRead['node'], path, join: own, subquery })
    }
  }
  walk(plan, '0', null, false)
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
