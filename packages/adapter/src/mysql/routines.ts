import type { EventInfo, Namespace, ObjectDependency, RoutineInfo, RoutineKind, TriggerInfo } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'
import { quoteIdent } from '../sql/quote.ts'
import { AdapterError } from '../types.ts'

/** Routine list: two catalog queries regardless of routine count (parameters are grouped here, not by GROUP_CONCAT,
 * whose output is silently truncated at group_concat_max_len). */
export async function mysqlListRoutines(conn: Conn, ns: Namespace): Promise<RoutineInfo[]> {
  const routines = firstResult(
    await conn.query(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, EXTERNAL_LANGUAGE, DTD_IDENTIFIER, ROUTINE_COMMENT, SPECIFIC_NAME, SQL_MODE
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY')
       ORDER BY ROUTINE_NAME, ROUTINE_TYPE`,
      [ns.database]
    )
  )
  const params = firstResult(
    await conn.query(
      `SELECT SPECIFIC_NAME, PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER
       FROM information_schema.PARAMETERS
       WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0 ORDER BY SPECIFIC_NAME, ORDINAL_POSITION`,
      [ns.database]
    )
  )
  const bySpecific = new Map<string, string[]>()
  for (const row of params.rows) {
    const key = str(row[0])
    const list = bySpecific.get(key) ?? []
    list.push(`${strOrNull(row[1]) ?? ''} ${str(row[2])} ${str(row[3])}`.trim())
    bySpecific.set(key, list)
  }
  return routines.rows.map((row) => {
    // MariaDB (Oracle mode) packages are listed with their specification before their body (name, then type).
    const kind = ROUTINE_KINDS[str(row[1]).toUpperCase()] ?? 'procedure'
    return {
      name: str(row[0]),
      kind,
      language: strOrNull(row[2]) ?? 'SQL',
      returns: kind === 'function' ? strOrNull(row[3]) : null,
      parameters: (bySpecific.get(str(row[5])) ?? []).join(', '),
      comment: strOrNull(row[4]) || null,
      sqlMode: strOrNull(row[6]) ?? '',
    }
  })
}

const ROUTINE_KINDS: Record<string, RoutineKind> = {
  PROCEDURE: 'procedure',
  FUNCTION: 'function',
  PACKAGE: 'package',
  'PACKAGE BODY': 'package body',
}

/** SHOW CREATE PROCEDURE|FUNCTION|PACKAGE|PACKAGE BODY; null when the account may not read it; NOT_FOUND when gone. */
export async function mysqlRoutineDefinition(
  conn: Conn,
  ns: Namespace,
  name: string,
  kind: RoutineKind
): Promise<string | null> {
  try {
    const show = firstResult(
      await conn.query(
        `SHOW CREATE ${kind.toUpperCase()} ${quoteIdent('mysql', ns.database)}.${quoteIdent('mysql', name)}`
      )
    )
    // Columns: Procedure|Function, sql_mode, Create Procedure|Create Function, ...
    return strOrNull(show.rows[0]?.[2])
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'PERMISSION_DENIED') return null
    throw err
  }
}

const TRIGGER_SELECT = `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION, ACTION_STATEMENT, SQL_MODE, DEFINER
  FROM information_schema.TRIGGERS`
// Creation order reproduces the execution order (FOLLOWS / PRECEDES) when a dump is restored.
const TRIGGER_ORDER = ' ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER, TRIGGER_NAME'

export async function mysqlListTriggers(conn: Conn, ns: Namespace, table?: string): Promise<TriggerInfo[]> {
  const r = firstResult(
    table
      ? await conn.query(`${TRIGGER_SELECT} WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?${TRIGGER_ORDER}`, [
          ns.database,
          table,
        ])
      : await conn.query(`${TRIGGER_SELECT} WHERE TRIGGER_SCHEMA = ?${TRIGGER_ORDER}`, [ns.database])
  )
  return r.rows.map((row) => ({
    name: str(row[0]),
    table: str(row[1]),
    timing: str(row[2]),
    events: str(row[3]),
    orientation: str(row[4]),
    definition: strOrNull(row[5]),
    sqlMode: strOrNull(row[6]) ?? '',
    definer: strOrNull(row[7]),
    enabled: true,
  }))
}

export async function mysqlListEvents(conn: Conn, ns: Namespace): Promise<EventInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT EVENT_NAME, STATUS, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, STARTS, ENDS, LAST_EXECUTED,
              ON_COMPLETION, EVENT_COMMENT, EVENT_DEFINITION, SQL_MODE, TIME_ZONE, DEFINER
       FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
      [ns.database]
    )
  )
  return r.rows.map((row) => {
    const type = str(row[2])
    const schedule = type === 'ONE TIME' ? `AT ${str(row[3])}` : `EVERY ${str(row[4])} ${str(row[5])}`
    return {
      name: str(row[0]),
      status: str(row[1]),
      type,
      schedule,
      starts: strOrNull(row[6]),
      ends: strOrNull(row[7]),
      lastExecuted: strOrNull(row[8]),
      onCompletion: strOrNull(row[9]),
      comment: strOrNull(row[10]) || null,
      definition: strOrNull(row[11]),
      sqlMode: strOrNull(row[12]) ?? '',
      timeZone: strOrNull(row[13]),
      definer: strOrNull(row[14]),
    }
  })
}

/**
 * MySQL 8 records what each view reads in VIEW_TABLE_USAGE / VIEW_ROUTINE_USAGE; MariaDB has neither table, so
 * it reports null and the caller falls back to reading the definitions.
 */
export async function mysqlListDependencies(conn: Conn, ns: Namespace): Promise<ObjectDependency[] | null> {
  let tables: ReturnType<typeof firstResult>
  let routines: ReturnType<typeof firstResult>
  try {
    tables = firstResult(
      await conn.query(
        `SELECT u.VIEW_NAME, u.TABLE_NAME, t.TABLE_TYPE FROM information_schema.VIEW_TABLE_USAGE u
         LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = u.TABLE_SCHEMA AND t.TABLE_NAME = u.TABLE_NAME
         WHERE u.VIEW_SCHEMA = ? AND u.TABLE_SCHEMA = ? ORDER BY u.VIEW_NAME, u.TABLE_NAME`,
        [ns.database, ns.database]
      )
    )
    routines = firstResult(
      await conn.query(
        `SELECT TABLE_NAME, SPECIFIC_NAME FROM information_schema.VIEW_ROUTINE_USAGE
         WHERE TABLE_SCHEMA = ? AND SPECIFIC_SCHEMA = ? ORDER BY TABLE_NAME, SPECIFIC_NAME`,
        [ns.database, ns.database]
      )
    )
  } catch (err) {
    if (err instanceof AdapterError && err.nativeCode === 'ER_UNKNOWN_TABLE') return null
    throw err
  }
  const byView = new Map<string, ObjectDependency>()
  const entry = (view: string) => {
    const e = byView.get(view) ?? { kind: 'view' as const, name: view, dependsOn: [] }
    byView.set(view, e)
    return e
  }
  for (const row of tables.rows) {
    const kind = String(row[2] ?? '').includes('VIEW') ? 'view' : 'table'
    entry(str(row[0])).dependsOn.push({ kind, name: str(row[1]) })
  }
  for (const row of routines.rows) entry(str(row[0])).dependsOn.push({ kind: 'routine', name: str(row[1]) })
  return [...byView.values()]
}
