/**
 * `EXPLAIN FORMAT=JSON` of MySQL and MariaDB, read into the plan tree both servers share. Three shapes come back:
 * MySQL's format 1 (8.0, and 8.4 by default), MariaDB's (format 1's keys with other names around them), and MySQL's
 * format 2 (`explain_json_format_version = 2`, the default from 9.x), which nests `inputs` and names tables properly.
 */
import type { PlanAccess, PlanNode } from '@tsmyadmin/shared'
import { tableAliases } from '../sql/table-aliases.ts'

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Format 2 has nothing to say for an UPDATE or DELETE on MySQL 9: the statement is asked again in format 1. */
export function needsFormat1(raw: unknown): boolean {
  return (
    isObject(raw) && isObject(raw.query_plan) && raw.query_plan.operation === '<not executable by iterator executor>'
  )
}

export function parseMysqlPlan(raw: unknown, sql: string): PlanNode {
  if (isObject(raw) && isObject(raw.query_plan)) return format2(raw.query_plan)
  const aliases = tableAliases(sql, 'mysql')
  const top = isObject(raw) && isObject(raw.query_block) ? nodesOf(raw.query_block, aliases) : []
  return top.length === 1 && top[0] ? top[0] : node('Query', top)
}

function node(op: string, children: PlanNode[] = [], extra: Partial<PlanNode> = {}): PlanNode {
  return {
    op,
    table: null,
    alias: null,
    index: null,
    indexColumns: [],
    access: null,
    covering: false,
    estRows: null,
    cost: null,
    detail: null,
    children,
    ...extra,
  }
}

// ---- format 1 (MySQL ≤ 8.4) and MariaDB ----

/** What the wrapping keys mean; any other key with tables inside is shown by its own name. */
const WRAPPERS: Record<string, string> = {
  nested_loop: 'Nested loop',
  'block-nl-join': 'Block nested loop',
  ordering_operation: 'Sort',
  filesort: 'Sort',
  read_sorted_file: 'Sort',
  grouping_operation: 'Group',
  duplicates_removal: 'Distinct',
  temporary_table: 'Temporary table',
  windowing: 'Window',
  union_result: 'Union',
  materialized: 'Materialize',
  materialized_from_subquery: 'Materialize',
  subquery_cache: 'Subquery cache',
  expression_cache: 'Subquery cache',
}
/** Keys that hold facts about a step, never steps. */
const FACTS = new Set(['cost_info', 'possible_keys', 'used_key_parts', 'used_columns', 'ref', 'r_loops', 'buffer'])

const label = (key: string) => WRAPPERS[key] ?? (key.endsWith('subqueries') ? 'Subquery' : key.replaceAll('_', ' '))

/** The steps an object of the plan holds, in the order of its keys. */
function nodesOf(o: Json, aliases: Map<string, string>): PlanNode[] {
  const out: PlanNode[] = []
  for (const [key, value] of Object.entries(o)) {
    if (FACTS.has(key)) continue
    if (key === 'table' && isObject(value)) {
      out.push(tableNode(value, aliases))
    } else if (key === 'query_block' && isObject(value)) {
      out.push(...nodesOf(value, aliases))
    } else if (key === 'nested_loop' && Array.isArray(value)) {
      const children = value.filter(isObject).flatMap((v) => nodesOf(v, aliases))
      // A loop over one table joins nothing (MariaDB writes one round every single-table plan).
      out.push(...(children.length === 1 ? children : [node(label(key), children)]))
    } else if (Array.isArray(value)) {
      const children = value.filter(isObject).flatMap((v) => nodesOf(v, aliases))
      if (children.length > 0) out.push(node(label(key), children))
    } else if (isObject(value)) {
      const children = nodesOf(value, aliases)
      const [only] = children
      const op = wrapperLabel(key, value)
      // MariaDB's read_sorted_file around its filesort: one sort, said twice.
      if (children.length === 1 && only?.op === op) out.push(only)
      else if (children.length > 0) out.push(node(op, children, { detail: wrapperDetail(value) }))
    }
  }
  return out
}

/** A step under `o` sorts or puts its rows in a temporary table: the order comes from there. */
function sortsBelow(o: unknown): boolean {
  if (!isObject(o)) return Array.isArray(o) && o.some(sortsBelow)
  return o.using_filesort === true || o.using_temporary_table === true || Object.values(o).some(sortsBelow)
}

/**
 * A wrapper's name, where its facts change what it does: an ORDER BY that nothing sorts is read in the index's order,
 * and MariaDB's join buffer may hash the rows (BNLH) or look them up by a key a batch at a time (BKA, BKAH) instead
 * of reading the table for each buffer (BNL).
 */
function wrapperLabel(key: string, o: Json): string {
  if (key === 'ordering_operation' && o.using_filesort === false && !sortsBelow(o)) return 'Ordered by index'
  if (key === 'block-nl-join' && typeof o.join_type === 'string') {
    if (o.join_type.startsWith('BKA')) return 'Batched key access'
    if (o.join_type === 'BNLH') return 'Block hash join'
  }
  return label(key)
}

function wrapperDetail(o: Json): string | null {
  const notes = [
    str(o.sort_key),
    o.using_filesort === true ? 'filesort' : null,
    o.using_temporary_table === true ? 'temporary' : null,
  ]
  return notes.filter(Boolean).join(', ') || null
}

/** MySQL's access types, by how much of the table they read. */
function access1(type: unknown): PlanAccess {
  switch (type) {
    case 'ALL':
      return 'fullScan'
    case 'index':
      return 'fullIndexScan'
    case 'range':
    case 'index_merge':
      return 'range'
    case 'system':
    case 'const':
    case 'eq_ref':
    case 'ref':
    case 'ref_or_null':
    case 'fulltext':
    case 'unique_subquery':
    case 'index_subquery':
      return 'lookup'
    default:
      return 'other'
  }
}

function tableNode(t: Json, aliases: Map<string, string>): PlanNode {
  const named = str(t.table_name)
  // `<subquery3>`, `<derived2>`: a table the server makes for itself, not one of the schema's.
  const own = named !== null && !named.startsWith('<')
  const table = own ? (aliases.get(named) ?? named) : null
  const cost = isObject(t.cost_info) ? num(t.cost_info.prefix_cost ?? t.cost_info.read_cost) : num(t.cost)
  const kind = t.update ? 'Update' : t.delete ? 'Delete' : t.insert ? 'Insert' : 'Table'
  // How MySQL joins the table to the rows before it, where not one row at a time: `hash join`, `Block Nested Loop`.
  const buffer = str(t.using_join_buffer)
  return node(own ? `${kind}${buffer ? `, join buffer (${buffer})` : ''}` : (named ?? kind), nodesOf(t, aliases), {
    table,
    alias: own && named !== table ? named : null,
    index: own ? str(t.key) : null,
    indexColumns: own ? strings(t.used_key_parts) : [],
    access: own ? access1(t.access_type) : null,
    covering: t.using_index === true,
    estRows: num(t.rows_examined_per_scan ?? t.rows),
    cost,
    detail: str(t.index_condition) ?? str(t.attached_condition),
  })
}

// ---- format 2 (MySQL 8.3+, the default from 9.x) ----

function access2(n: Json): PlanAccess | null {
  if (n.access_type === 'table') return 'fullScan'
  switch (n.index_access_type) {
    case 'index_scan':
      return 'fullIndexScan'
    case 'index_range_scan':
      return 'range'
    case 'index_lookup':
      return 'lookup'
    default:
      return n.access_type === 'index' ? 'other' : null
  }
}

function format2(n: Json): PlanNode {
  const named = str(n.table_name)
  // A temporary table is the server's own, not one of the schema's.
  const table = named && !named.startsWith('<') ? named : null
  const children = Object.entries(n)
    .filter(([key, v]) => key.startsWith('inputs') && Array.isArray(v))
    .flatMap(([, v]) => (v as unknown[]).filter(isObject).map(format2))
  return node(str(n.operation) ?? 'Step', children, {
    table,
    alias: table ? str(n.alias) : null,
    index: str(n.index_name),
    indexColumns: strings(n.key_columns),
    access: table ? access2(n) : null,
    covering: n.covering === true,
    estRows: num(n.estimated_rows),
    cost: num(n.estimated_total_cost),
    detail: str(n.lookup_condition) ?? str(n.condition),
  })
}
