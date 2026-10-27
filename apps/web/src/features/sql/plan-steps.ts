import type { PlanAccess, PlanNode } from '@tsmyadmin/shared'
import type { OverlayStep, Tone } from '@/components/schema-diagram/overlay.ts'
import { locale } from '@/config/locale-screens.ts'

const t = locale.plan

/**
 * How a read is joined to the rows read before it, from the join above it (or, on MySQL 8's format, the table's own
 * join buffer): the outer and inner side of a nested loop, the inner side of a loop over a buffer of rows, the side
 * a hash join builds its table from and the side it probes it with, a hash join whose sides MySQL 8 does not say
 * (`hashBuffer`: the buffered table is probed in an inner join, hashed in an outer, semi or anti join), or a side of
 * a merge join.
 */
type JoinRole = 'loopOuter' | 'loopInner' | 'blockInner' | 'hashBuild' | 'hashProbe' | 'hashBuffer' | 'merge'

type Method = 'loop' | 'block' | 'hash' | 'buffer' | 'merge'

/** The join method an operation names, across the servers' words ("Nested Loop", "Inner hash join", "Hash semijoin"…). */
function joinMethod(op: string): Method | null {
  // Batched key access looks each row up by a key, a batch at a time: a loop, not a read of the whole table.
  if (/batched key/i.test(op)) return 'loop'
  if (/block hash join/i.test(op)) return 'hash'
  if (/join buffer \(hash join\)/i.test(op)) return 'buffer'
  if (/block nested loop|join buffer/i.test(op)) return 'block'
  if (/nested loop/i.test(op)) return 'loop'
  if (/hash (semi|anti)?\s?join/i.test(op)) return 'hash'
  if (/merge (semi|anti)?\s?join/i.test(op)) return 'merge'
  return null
}

/**
 * A plan of its own hung under a step (PostgreSQL): an InitPlan runs once, before; a SubPlan may run again for each
 * row of the step. Neither is an input of a join. MySQL and MariaDB name a subquery `Subquery`.
 */
function sidePlan(op: string): PlanRead['subquery'] {
  if (/\binitplan\b/i.test(op)) return 'once'
  if (/\bsubplan\b/i.test(op)) return 'perRow'
  return null
}

/** A node of the plan with where it sits in the tree (`0.1.0`: first child's second child's first), to point at. */
export interface PlanRead {
  node: PlanNode & { table: string }
  path: string
  /** How it is joined to the rows read before it; null where no join is above it. */
  join: JoinRole | null
  /**
   * Read inside a subquery: one run once before the rest (`once`, PostgreSQL's InitPlan), or one that may run again
   * for each row outside it (`perRow`: PostgreSQL's SubPlan, MySQL's and MariaDB's subqueries). Not a table in FROM
   * made of a SELECT (PostgreSQL's Subquery Scan), which is read once.
   */
  subquery: 'once' | 'perRow' | null
  /** Under the inner side of a nested loop further up: read again for each row of that loop's outer side. */
  repeated: boolean
}

/**
 * The role of a join's inputs: a loop's first input drives it, a hash join builds from its last. A join over one
 * input wraps the table it joins (MariaDB's join buffer), which is its inner side.
 */
function roleOf(method: Method, input: number, inputs: number): JoinRole {
  if (method === 'buffer') return 'hashBuffer'
  if (method === 'merge') return 'merge'
  if (method === 'hash') return inputs > 1 && input === inputs - 1 ? 'hashBuild' : 'hashProbe'
  const first = inputs > 1 && input === 0
  if (method === 'block') return first ? 'loopOuter' : 'blockInner'
  return first ? 'loopOuter' : 'loopInner'
}

interface Context {
  join: JoinRole | null
  subquery: PlanRead['subquery']
  repeated: boolean
}

/**
 * The nodes that read a table, in the order they run: children before their parent, left before right (a join reads
 * its outer input first), except a hash join, which reads the input it builds its table from (its last) first. These
 * are the steps of the story; joins, sorts and the like are the tree's to show.
 */
export function planReads(plan: PlanNode): PlanRead[] {
  const out: PlanRead[] = []
  const walk = (n: PlanNode, path: string, at: Context) => {
    const method = n.table === null ? joinMethod(n.op) : null
    // Kept once read (Materialize, Memoize): the loop above re-reads the rows kept, not what is under it.
    const kept = /^(materiali[sz]e|memoize)\b/i.test(n.op)
    const inputs = n.children.flatMap((c, i) => (sidePlan(c.op) ? [] : [i]))
    const order = n.children.map((_, i) => i)
    if (method === 'hash' && inputs.length > 1) {
      const build = inputs.at(-1) as number
      order.splice(order.indexOf(build), 1)
      order.splice(order.indexOf(inputs[0] as number), 0, build)
    }
    for (const i of order) {
      const c = n.children[i] as PlanNode
      const side = sidePlan(c.op) ?? (/^subquery$/i.test(n.op) ? 'perRow' : null)
      let next: Context
      if (side) next = { join: null, subquery: side, repeated: at.repeated }
      else if (method) {
        const join = roleOf(method, inputs.indexOf(i), inputs.length)
        // A join of its own under the inner side of a loop runs again for each outer row; a wrapper of one input
        // (MariaDB's join buffer) is that inner side itself.
        next = { join, subquery: at.subquery, repeated: at.repeated || (at.join === 'loopInner' && inputs.length > 1) }
      } else next = kept ? { join: null, subquery: at.subquery, repeated: false } : at
      walk(c, `${path}.${i}`, next)
    }
    if (n.table !== null && n.access !== null) {
      // MySQL 8 says the join buffer on the table it joins.
      const own = joinMethod(n.op)
      out.push({
        node: n as PlanRead['node'],
        path,
        join: own ? roleOf(own, 1, 1) : at.join,
        subquery: at.subquery,
        repeated: at.repeated,
      })
    }
  }
  walk(plan, '0', { join: null, subquery: null, repeated: false })
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
