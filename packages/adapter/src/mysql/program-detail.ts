import type { EventDetail, Namespace, RoutineDetail, RoutineKind, TriggerDetail } from '@tsmyadmin/shared'
import { DATA_ACCESS, EVENT_INTERVAL_UNITS } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'
import { AdapterError } from '../types.ts'
import { mysqlRoutineDefinition, showCreateProgram } from './routines.ts'

/**
 * The text after the first match of `pattern` that is outside quotes and backticks — how the body is cut from a
 * SHOW CREATE statement: `information_schema` hands the body out with its escapes processed (`'a\'b'` comes back as
 * `'a'b'`), which does not restore, so the statement as written is the only faithful source.
 */
function afterOutsideQuotes(text: string, pattern: RegExp): string | null {
  const re = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}y`)
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (quote) {
      // A backslash escapes the next character in a string; a doubled quote is one quote. Backticks only double.
      if (ch === '\\' && quote !== '`') i++
      else if (ch === quote) {
        if (text[i + 1] === quote) i++
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    re.lastIndex = i
    const m = re.exec(text)
    if (m) return text.slice(i + m[0].length)
  }
  return null
}

/** `user@host` as the catalog prints a DEFINER; the host is what follows the last `@`. */
function definerOf(value: string | null): { user: string; host: string } | undefined {
  if (!value) return undefined
  const at = value.lastIndexOf('@')
  return at > 0 && at < value.length - 1 ? { user: value.slice(0, at), host: value.slice(at + 1) } : undefined
}

/**
 * A stored routine as the create form takes it, to edit it. The body is cut from SHOW CREATE: the header lines all
 * start with four spaces (`    DETERMINISTIC`), the body starts at the first line that does not. null when the
 * account may not read the definition.
 */
export async function mysqlRoutineDetail(
  conn: Conn,
  ns: Namespace,
  name: string,
  kind: RoutineKind
): Promise<RoutineDetail | null> {
  if (kind !== 'procedure' && kind !== 'function') return null
  const routine = firstResult(
    await conn.query(
      `SELECT DTD_IDENTIFIER, IS_DETERMINISTIC, SQL_DATA_ACCESS, SECURITY_TYPE, ROUTINE_COMMENT, DEFINER, SPECIFIC_NAME
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?`,
      [ns.database, name, kind.toUpperCase()]
    )
  ).rows[0]
  if (!routine) throw new AdapterError('NOT_FOUND', `Routine not found: ${name}`)
  const shown = await mysqlRoutineDefinition(conn, ns, name, kind)
  if (shown === null) return null
  const lines = shown.split('\n')
  let start = 1
  while (start < lines.length && (lines[start] as string).startsWith('    ')) start++
  const body = lines.slice(start).join('\n').trim()
  if (body === '') return null
  const params = firstResult(
    await conn.query(
      `SELECT PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER FROM information_schema.PARAMETERS
       WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ORDINAL_POSITION > 0 ORDER BY ORDINAL_POSITION`,
      [ns.database, str(routine[6])]
    )
  )
  const access = (DATA_ACCESS as readonly string[]).find((a) => a === str(routine[2]).replaceAll('_', ' '))
  const security = str(routine[3])
  const definer = definerOf(strOrNull(routine[5]))
  return {
    kind,
    name,
    params: params.rows.map((r) => ({
      mode: (['IN', 'OUT', 'INOUT'].includes(str(r[0])) ? str(r[0]) : 'IN') as 'IN' | 'OUT' | 'INOUT',
      name: str(r[1]),
      type: str(r[2]),
    })),
    ...(kind === 'function' && strOrNull(routine[0]) ? { returns: str(routine[0]) } : {}),
    body,
    language: 'sql',
    deterministic: str(routine[1]) === 'YES',
    ...(strOrNull(routine[4]) ? { comment: str(routine[4]) } : {}),
    ...(definer ? { definer } : {}),
    ...(security === 'DEFINER' || security === 'INVOKER' ? { sqlSecurity: security } : {}),
    ...(access ? { dataAccess: access as (typeof DATA_ACCESS)[number] } : {}),
  }
}

/** A trigger as the create form takes it; null when the account may not read the statement. */
export async function mysqlTriggerDetail(
  conn: Conn,
  ns: Namespace,
  table: string,
  name: string
): Promise<TriggerDetail | null> {
  const row = firstResult(
    await conn.query(
      `SELECT ACTION_TIMING, EVENT_MANIPULATION, DEFINER FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?`,
      [ns.database, table, name]
    )
  ).rows[0]
  if (!row) throw new AdapterError('NOT_FOUND', `Trigger not found: ${name}`)
  const shown = await showCreateProgram(conn, ns, 'TRIGGER', name)
  if (shown === null) return null
  // After FOR EACH ROW, and the FOLLOWS / PRECEDES clause a trigger of the same table and event may carry.
  const body = afterOutsideQuotes(shown, /FOR\s+EACH\s+ROW\b(?:\s+(?:FOLLOWS|PRECEDES)\s+`(?:[^`]|``)+`)?\s*/i)?.trim()
  const timing = str(row[0])
  const event = str(row[1])
  if (!body || (timing !== 'BEFORE' && timing !== 'AFTER') || !['INSERT', 'UPDATE', 'DELETE'].includes(event))
    return null
  const definer = definerOf(strOrNull(row[2]))
  return { name, table, timing, event: event as 'INSERT' | 'UPDATE' | 'DELETE', body, ...(definer ? { definer } : {}) }
}

/**
 * An event as the create form takes it. An interval the form has no unit for (`DAY_HOUR`) or an event with no
 * schedule the statement gives back is null: it is edited in the SQL tab.
 */
export async function mysqlEventDetail(conn: Conn, ns: Namespace, name: string): Promise<EventDetail | null> {
  const row = firstResult(
    await conn.query(
      `SELECT EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE, INTERVAL_FIELD, STARTS, ENDS, STATUS, ON_COMPLETION,
              EVENT_COMMENT, DEFINER
       FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?`,
      [ns.database, name]
    )
  ).rows[0]
  if (!row) throw new AdapterError('NOT_FOUND', `Event not found: ${name}`)
  const shown = await showCreateProgram(conn, ns, 'EVENT', name)
  if (shown === null) return null
  const body = afterOutsideQuotes(shown, /\sDO\s/i)?.trim()
  if (!body) return null
  const moment = (v: unknown) => {
    const text = strOrNull(v)
    return text && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text : undefined
  }
  let schedule: EventDetail['schedule']
  if (str(row[0]) === 'ONE TIME') {
    const at = moment(row[1])
    if (!at) return null
    schedule = { kind: 'at', at }
  } else {
    const unit = str(row[3])
    const interval = Number(str(row[2]))
    if (!(EVENT_INTERVAL_UNITS as readonly string[]).includes(unit) || !Number.isInteger(interval) || interval < 1)
      return null
    const starts = moment(row[4])
    const ends = moment(row[5])
    schedule = {
      kind: 'every',
      interval,
      unit: unit as (typeof EVENT_INTERVAL_UNITS)[number],
      ...(starts ? { starts } : {}),
      ...(ends ? { ends } : {}),
    }
  }
  const definer = definerOf(strOrNull(row[9]))
  return {
    name,
    schedule,
    body,
    enabled: str(row[6]) === 'ENABLED',
    ...(strOrNull(row[8]) ? { comment: str(row[8]) } : {}),
    preserve: str(row[7]) === 'PRESERVE',
    ...(definer ? { definer } : {}),
  }
}
