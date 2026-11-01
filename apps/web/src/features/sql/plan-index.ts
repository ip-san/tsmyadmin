import type { PlanNode } from '@tsmyadmin/shared'
import { type PlanRead, planReads } from './plan-steps.ts'

/** What is known of a table read: its columns, and the columns of each index it has (in order). */
export interface TableShape {
  columns: readonly string[]
  indexes: readonly { name: string; columns: readonly string[] }[]
  /** Names of indexes a build left unusable: not indexes to read through, but names taken all the same. */
  unusable?: readonly string[]
}

/** An index worth trying: on these columns of a table the plan reads in full, and why. */
export interface IndexCandidate {
  table: string
  columns: string[]
  /** A name for it, not taken by the table's indexes. */
  name: string
  /**
   * Why: the table is read again per row of another (`perRow`), a join keeps few of the rows read in full (`waste`),
   * or a condition on the table alone throws most of them away (`filter`).
   */
  reason: 'perRow' | 'waste' | 'filter'
}

/** More than this many columns is a guess no longer: the first ones are the ones that narrow. */
const MAX_COLUMNS = 3
/** A join that keeps fewer than one in this many of the rows read throws most of the read away. */
const JOIN_WASTE = 10
/** Index names are cut to this: MySQL allows 64 characters, PostgreSQL 63. */
const NAME_CHARS = 60

/** The nodes above the one at a path (`0.1.0`), nearest first. */
function ancestors(plan: PlanNode, path: string): PlanNode[] {
  const out: PlanNode[] = []
  let node = plan
  for (const i of path.split('.').slice(1).map(Number)) {
    out.unshift(node)
    const next = node.children[i]
    if (!next) break
    node = next
  }
  return out
}

/**
 * Read again per row of another table: the inner side of a loop, a table looked up per buffer of rows, or a subquery
 * run once per row outside it.
 */
const perRow = (read: PlanRead) =>
  read.join === 'loopInner' ||
  read.join === 'blockInner' ||
  read.join === 'hashBuffer' ||
  read.repeated ||
  read.subquery === 'perRow'

/** The condition part of a step's name (`Inner hash join (t.id = u.x)`, `Filter: (…)`): its words are not columns. */
const opCondition = (op: string) => (op.includes('(') ? op.slice(op.indexOf('(')) : null)

/**
 * The conditions that bear on a read: its own, a `Filter:` step that wraps it alone (MySQL 9 hangs one above a scan;
 * other wrappers say a sort key, which is no condition), and the join's where the read is looked up per row or where
 * the join keeps few of the rows read (a hash or merge join over a table read in full: an index could find those
 * rows instead). Which of these brought the join's condition in says why the index is tried.
 */
function conditions(plan: PlanNode, read: PlanRead): { texts: string[]; reason: IndexCandidate['reason'] } {
  const texts = read.node.detail ? [read.node.detail] : []
  let reason: IndexCandidate['reason'] = perRow(read) ? 'perRow' : 'filter'
  for (const up of ancestors(plan, read.path)) {
    if (up.access !== null) break
    const own = [opCondition(up.op), up.detail].filter((t): t is string => !!t)
    if (up.children.length > 1) {
      const rows = read.node.estRows
      const wasteful = rows !== null && up.estRows !== null && rows >= JOIN_WASTE && up.estRows * JOIN_WASTE <= rows
      if (perRow(read)) texts.push(...own)
      else if (wasteful) {
        texts.push(...own)
        reason = 'waste'
      }
      break
    }
    if (/^filter\b/i.test(up.op)) texts.push(...own)
  }
  return { texts, reason }
}

/** What a condition does with a column: finds rows equal to a value, a range of them, or nothing an index helps. */
type Use = 'equal' | 'range' | 'none'

/**
 * The columns of a table a condition names, with what it does with each. A name qualified by another table (`u.id`)
 * is that table's; an unqualified one is this table's where it has such a column. Quoted names, values and casts are
 * read past (`'A%'`, `::text`). A LIKE whose pattern starts with a wildcard is no use to an index.
 */
export function conditionColumns(
  text: string,
  table: string,
  alias: string | null,
  columns: readonly string[]
): { column: string; use: Use }[] {
  const own = new Map(columns.map((c) => [c.toLowerCase(), c]))
  const names = new Set([table, alias].filter((n): n is string => !!n).map((n) => n.toLowerCase()))
  // Values out first (a literal may hold any word), as marks no column can be named: a LIKE needs its pattern's start.
  const plain = text
    .replace(/'(?:[^']|'')*'/g, (v) => (v.startsWith("'%") ? ` ${WILD} ` : ` ${VALUE} `))
    .replace(/[`"]/g, '')
  const cast = /::[a-z_]+(?: varying| precision| with(?:out)? time zone)?(?:\[\])?/gi
  const clean = plain.replace(cast, '')
  // Either side of an OR is enough: an index on both together does not find the rows.
  const ored = /\bor\b/i.test(clean)
  const out = new Map<string, Use>()
  for (const m of clean.matchAll(/[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*/g)) {
    const parts = m[0].split('.')
    const column = own.get((parts.at(-1) ?? '').toLowerCase())
    const qualifier = parts.at(-2)?.toLowerCase()
    if (!column || (qualifier !== undefined && !names.has(qualifier))) continue
    const rawBefore = clean.slice(0, m.index)
    const rawAfter = clean.slice(m.index + m[0].length)
    // A function's name (`date(…)`) or a type before a value (`DATE '2020-01-01'`) is no column.
    if (/^\s*\(/.test(rawAfter) || rawAfter.trimStart().startsWith(VALUE)) continue
    const before = rawBefore.replace(/[\s()]+$/, '')
    const after = rawAfter.replace(/^[\s)]+/, '')
    // Inside a function (`lower((name)::text)`) or a sum (`id + 1`): a plain index on the column does not find it.
    const opener = rawBefore.replace(/[\s(]+$/, '')
    const wrapped = /\(\s*$/.test(rawBefore) && /[A-Za-z_]\w*$/.test(opener) && !KEYWORDS.test(opener)
    const computed = /^[-+*/%|]/.test(after) || /[-+*/%|]$/.test(before)
    const use = ored || wrapped || computed ? 'none' : howUsed(before, after)
    // A column said twice is as good as its best use.
    const was = out.get(column)
    if (was === undefined || rank(use) < rank(was)) out.set(column, use)
  }
  return [...out].map(([column, use]) => ({ column, use }))
}

/** Where a value was, and a pattern starting with a wildcard: marks no name can be. */
const VALUE = '\u0001'
const WILD = '\u0002'
/** A LIKE whose pattern starts with a wildcard. */
const STARTS_WILD = new RegExp(`^(?:not\\s+)?(?:like|~~|!~~)\\s+${WILD}`, 'i')
/** Words before a bracket that open a group, not a function. */
const KEYWORDS = /(?:^|[^\w$])(?:and|or|not|in|any|all|exists|on|where|when|then|else|case|filter)$/i

/** How a condition uses a name, from the text right before and after it (values already read past). */
function howUsed(before: string, after: string): Use {
  // A pattern starting with a wildcard, or a match that ignores case (PostgreSQL), is no use to a plain index.
  if (STARTS_WILD.test(after)) return 'none'
  if (/^(?:not\s+)?(?:ilike|~~\*|!~~\*)/i.test(after)) return 'none'
  // Not equal is no narrowing: nearly every row is not that value.
  if (/^(?:<>|!=)/.test(after) || /(?:<>|!=)$/.test(before)) return 'none'
  if (/^=(?!=)|^in\s*\(/i.test(after)) return 'equal'
  if (/=$/.test(before) && !/[<>!]=$/.test(before)) return 'equal'
  return 'range'
}

const rank = (u: Use) => (u === 'equal' ? 0 : u === 'range' ? 1 : 2)

/**
 * The columns in index order: the equal ones first, then one range (an index stops narrowing past a range). A column
 * named by more than one condition (MySQL writes a filter both as the step's name and as its condition) is counted
 * once, at its best use.
 */
function indexOrder(found: { column: string; use: Use }[]): string[] {
  const best = new Map<string, Use>()
  for (const { column, use } of found) {
    const was = best.get(column)
    if (was === undefined || rank(use) < rank(was)) best.set(column, use)
  }
  const of = (u: Use) => [...best].filter(([, use]) => use === u).map(([column]) => column)
  return [...of('equal'), ...of('range').slice(0, 1)].slice(0, MAX_COLUMNS)
}

/** An index already starts with these columns: one to add would not be new. */
function covered(columns: readonly string[], shape: TableShape): boolean {
  const want = columns.map((c) => c.toLowerCase())
  return shape.indexes.some((i) => want.every((c, k) => i.columns[k]?.toLowerCase() === c))
}

/** A name for the index, short enough for both servers and not one the table has. */
export function indexName(table: string, columns: readonly string[], taken: readonly string[]): string {
  const base = `idx_${table}_${columns.join('_')}`.replace(/[^\w$]/g, '_').slice(0, NAME_CHARS)
  const used = new Set(taken.map((n) => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, NAME_CHARS - String(n).length - 1)}_${n}`
    if (!used.has(name.toLowerCase())) return name
  }
}

/**
 * The indexes worth trying for a plan: for each table it reads in full where a condition names the table's columns,
 * an index on those columns (equal ones first, then one range), unless an index already starts with them. Read from
 * the plan's conditions as the server wrote them, against the table's own columns, so a name is never guessed.
 */
export function indexCandidates(plan: PlanNode, shapeOf: (table: string) => TableShape | undefined): IndexCandidate[] {
  const out: IndexCandidate[] = []
  for (const read of planReads(plan)) {
    const { node } = read
    if (node.access !== 'fullScan') continue
    const shape = shapeOf(node.table)
    if (!shape) continue
    const { texts, reason } = conditions(plan, read)
    const columns = indexOrder(texts.flatMap((t) => conditionColumns(t, node.table, node.alias, shape.columns)))
    if (columns.length === 0 || covered(columns, shape)) continue
    if (out.some((c) => c.table === node.table && c.columns.join('\0') === columns.join('\0'))) continue
    const taken = [
      ...shape.indexes.map((i) => i.name),
      ...(shape.unusable ?? []),
      ...out.filter((c) => c.table === node.table).map((c) => c.name),
    ]
    out.push({
      table: node.table,
      columns,
      name: indexName(node.table, columns, taken),
      reason,
    })
  }
  return out
}
