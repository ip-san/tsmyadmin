import type { EventInfo, Namespace, RoutineInfo, TriggerInfo } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'
import { quoteIdent } from '../sql/quote.ts'

/** Routine list; definitions come from SHOW CREATE (null when the account lacks the privilege). */
export async function mysqlListRoutines(conn: Conn, ns: Namespace): Promise<RoutineInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, EXTERNAL_LANGUAGE, DTD_IDENTIFIER, ROUTINE_COMMENT,
              (SELECT GROUP_CONCAT(CONCAT(COALESCE(p.PARAMETER_MODE, ''), ' ', p.PARAMETER_NAME, ' ', p.DTD_IDENTIFIER) ORDER BY p.ORDINAL_POSITION SEPARATOR ', ')
                 FROM information_schema.PARAMETERS p
                WHERE p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA AND p.SPECIFIC_NAME = r.SPECIFIC_NAME AND p.ORDINAL_POSITION > 0)
       FROM information_schema.ROUTINES r WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
      [ns.database]
    )
  )
  const out: RoutineInfo[] = []
  for (const row of r.rows) {
    const name = str(row[0])
    const kind = str(row[1]).toUpperCase() === 'FUNCTION' ? 'function' : 'procedure'
    let definition: string | null = null
    try {
      const show = firstResult(
        await conn.query(
          `SHOW CREATE ${kind.toUpperCase()} ${quoteIdent('mysql', ns.database)}.${quoteIdent('mysql', name)}`
        )
      )
      // Columns: Procedure|Function, sql_mode, Create Procedure|Create Function, ...
      definition = strOrNull(show.rows[0]?.[2])
    } catch {
      definition = null
    }
    out.push({
      name,
      kind,
      language: strOrNull(row[2]) ?? 'SQL',
      returns: kind === 'function' ? strOrNull(row[3]) : null,
      parameters: str(row[5]).trim(),
      definition,
      comment: strOrNull(row[4]) || null,
    })
  }
  return out
}

const TRIGGER_SELECT = `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION, ACTION_STATEMENT
  FROM information_schema.TRIGGERS`
const TRIGGER_ORDER = ' ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME'

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
  }))
}

export async function mysqlListEvents(conn: Conn, ns: Namespace): Promise<EventInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT EVENT_NAME, STATUS, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, STARTS, ENDS, LAST_EXECUTED,
              ON_COMPLETION, EVENT_COMMENT, EVENT_DEFINITION
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
    }
  })
}
