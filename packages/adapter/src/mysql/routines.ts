import type { Namespace, RoutineInfo, TriggerInfo } from '@tsmyadmin/shared'
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
