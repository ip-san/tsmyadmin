import type { Namespace, RoutineInfo, RoutineKind, TriggerInfo } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'

export async function pgListRoutines(conn: Conn, ns: Namespace): Promise<RoutineInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT p.proname, p.prokind, l.lanname, pg_get_function_result(p.oid), pg_get_function_arguments(p.oid),
              obj_description(p.oid, 'pg_proc')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
       ORDER BY p.proname`,
      [ns.schema ?? 'public']
    )
  )
  return r.rows.map((row) => ({
    name: str(row[0]),
    kind: str(row[1]) === 'p' ? 'procedure' : 'function',
    language: strOrNull(row[2]),
    returns: str(row[1]) === 'p' ? null : strOrNull(row[3]),
    parameters: str(row[4]),
    comment: strOrNull(row[5]),
  }))
}

/** pg_get_functiondef of every overload with that name and kind, joined; null when none is visible. */
export async function pgRoutineDefinition(
  conn: Conn,
  ns: Namespace,
  name: string,
  kind: RoutineKind
): Promise<string | null> {
  const r = firstResult(
    await conn.query(
      `SELECT pg_get_functiondef(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
       ORDER BY p.oid`,
      [ns.schema ?? 'public', name, kind === 'procedure' ? 'p' : 'f']
    )
  )
  const defs = r.rows.map((row) => strOrNull(row[0])).filter((d): d is string => d !== null)
  return defs.length > 0 ? defs.join('\n\n') : null
}

const TRIGGER_SELECT = `SELECT t.tgname, c.relname, t.tgtype, pg_get_triggerdef(t.oid, true)
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND n.nspname = $1`
const TRIGGER_ORDER = ' ORDER BY c.relname, t.tgname'

export async function pgListTriggers(conn: Conn, ns: Namespace, table?: string): Promise<TriggerInfo[]> {
  const schema = ns.schema ?? 'public'
  const r = firstResult(
    table
      ? await conn.query(`${TRIGGER_SELECT} AND c.relname = $2${TRIGGER_ORDER}`, [schema, table])
      : await conn.query(`${TRIGGER_SELECT}${TRIGGER_ORDER}`, [schema])
  )
  return r.rows.map((row) => {
    // tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 64 instead
    const type = Number(row[2])
    const events = [type & 4 ? 'INSERT' : null, type & 8 ? 'DELETE' : null, type & 16 ? 'UPDATE' : null].filter(
      (x): x is string => !!x
    )
    return {
      name: str(row[0]),
      table: str(row[1]),
      timing: type & 64 ? 'INSTEAD OF' : type & 2 ? 'BEFORE' : 'AFTER',
      events: events.join(','),
      orientation: type & 1 ? 'ROW' : 'STATEMENT',
      definition: strOrNull(row[3]),
    }
  })
}
