import type { Namespace, RoutineDetail, RoutineKind, TriggerDetail } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'
import { AdapterError } from '../types.ts'

/**
 * `IN a integer, OUT b text` as the catalog prints it, split at the commas that are not inside parentheses
 * (`numeric(10,2)`). Null when a parameter has no name (the create form needs one) or carries a default.
 */
function parseArguments(list: string): RoutineDetail['params'] | null {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  const params: RoutineDetail['params'] = []
  for (const part of parts) {
    if (/\sDEFAULT\s/i.test(part) || /^VARIADIC\s/i.test(part)) return null
    const m = /^(?:(IN|OUT|INOUT)\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+(.+)$/i.exec(part)
    if (!m) return null
    const name = (m[2] as string).startsWith('"')
      ? (m[2] as string).slice(1, -1).replaceAll('""', '"')
      : (m[2] as string)
    params.push({ mode: (m[1] ?? 'IN').toUpperCase() as 'IN' | 'OUT' | 'INOUT', name, type: m[3] as string })
  }
  return params
}

/**
 * A routine as the create form takes it, to edit it. `parameters` (as the list prints them) picks one of several
 * overloads; without it there has to be exactly one. null for what the form cannot say: unnamed parameters,
 * defaults, VARIADIC, a language the form does not offer, or a security setting it cannot read.
 */
export async function pgRoutineDetail(
  conn: Conn,
  ns: Namespace,
  name: string,
  kind: RoutineKind,
  parameters?: string
): Promise<RoutineDetail | null> {
  if (kind !== 'procedure' && kind !== 'function') return null
  const r = firstResult(
    await conn.query(
      `SELECT pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), p.prosrc, l.lanname, p.provolatile,
              p.prosecdef, obj_description(p.oid, 'pg_proc')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
       ORDER BY p.oid`,
      [ns.schema ?? 'public', name, kind === 'procedure' ? 'p' : 'f']
    )
  )
  const matches = parameters === undefined ? r.rows : r.rows.filter((row) => str(row[0]) === parameters)
  if (matches.length === 0) throw new AdapterError('NOT_FOUND', `Routine not found: ${name}`)
  if (matches.length > 1) return null
  const row = matches[0] as unknown[]
  const params = parseArguments(str(row[0]))
  const language = str(row[3])
  if (!params || !/^[A-Za-z][A-Za-z0-9_]*$/.test(language)) return null
  return {
    kind,
    name,
    params,
    ...(kind === 'function' && strOrNull(row[1]) ? { returns: str(row[1]) } : {}),
    body: str(row[2]),
    language,
    deterministic: str(row[4]) === 'i',
    ...(strOrNull(row[6]) ? { comment: str(row[6]) } : {}),
    sqlSecurity: row[5] === true ? 'DEFINER' : 'INVOKER',
  }
}

/**
 * A trigger as the create form takes it: row-level, one event, BEFORE or AFTER, no WHEN or column list, and running
 * a function this tool made for it (`<trigger>_fn`, no arguments) — anything else is edited in the SQL tab (null).
 */
export async function pgTriggerDetail(
  conn: Conn,
  ns: Namespace,
  table: string,
  name: string
): Promise<TriggerDetail | null> {
  const row = firstResult(
    await conn.query(
      `SELECT t.tgtype, p.prosrc, p.proname, t.tgnargs, t.tgqual IS NOT NULL, t.tgattr::text
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`,
      [ns.schema ?? 'public', table, name]
    )
  ).rows[0]
  if (!row) throw new AdapterError('NOT_FOUND', `Trigger not found: ${name}`)
  const type = Number(row[0])
  const events = [
    (type & 4) !== 0 ? 'INSERT' : '',
    (type & 16) !== 0 ? 'UPDATE' : '',
    (type & 8) !== 0 ? 'DELETE' : '',
  ].filter(Boolean)
  const before = (type & 2) !== 0
  const insteadOf = (type & 64) !== 0
  if (
    (type & 1) === 0 ||
    events.length !== 1 ||
    insteadOf ||
    Number(row[3]) !== 0 ||
    row[4] === true ||
    str(row[5]).trim() !== '' ||
    str(row[2]) !== `${name}_fn`
  )
    return null
  return {
    name,
    table,
    timing: before ? 'BEFORE' : 'AFTER',
    event: events[0] as 'INSERT' | 'UPDATE' | 'DELETE',
    body: str(row[1]),
  }
}
