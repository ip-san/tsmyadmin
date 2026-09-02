import type { Namespace, ObjectDependency, RoutineInfo, RoutineKind, TriggerInfo } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'
import { pgLiteral } from '../sql/literal.ts'
import { quoteIdent } from '../sql/quote.ts'
import { AdapterError } from '../types.ts'

export async function pgListRoutines(conn: Conn, ns: Namespace): Promise<RoutineInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT p.proname, p.prokind, l.lanname, pg_get_function_result(p.oid), pg_get_function_arguments(p.oid),
              obj_description(p.oid, 'pg_proc')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
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
    sqlMode: null,
  }))
}

/** pg_get_functiondef of every overload with that name and kind, joined; NOT_FOUND when there is none. */
export async function pgRoutineDefinition(
  conn: Conn,
  ns: Namespace,
  name: string,
  kind: RoutineKind
): Promise<string | null> {
  if (kind !== 'procedure' && kind !== 'function') throw new AdapterError('NOT_FOUND', `Routine not found: ${name}`)
  const r = firstResult(
    await conn.query(
      `SELECT pg_get_functiondef(p.oid), obj_description(p.oid, 'pg_proc'), pg_get_function_identity_arguments(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
       ORDER BY p.oid`,
      [ns.schema ?? 'public', name, kind === 'procedure' ? 'p' : 'f']
    )
  )
  const defs: string[] = []
  for (const row of r.rows) {
    const def = strOrNull(row[0])
    if (def === null) continue
    defs.push(def)
    // The comment travels with its overload (identity arguments pick the right one).
    const comment = strOrNull(row[1])
    if (comment !== null) {
      const target = `${quoteIdent('postgres', ns.schema ?? 'public')}.${quoteIdent('postgres', name)}(${str(row[2])})`
      defs.push(`COMMENT ON ${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} ${target} IS ${pgLiteral(comment)}`)
    }
  }
  if (defs.length === 0) throw new AdapterError('NOT_FOUND', `Routine not found: ${name}`)
  // Every overload is a complete CREATE OR REPLACE statement; they are joined as statements.
  return defs.join(';\n\n')
}

const TRIGGER_SELECT = `SELECT t.tgname, c.relname, t.tgtype, pg_get_triggerdef(t.oid, true), t.tgenabled
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
    // tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead
    const type = Number(row[2])
    const events = [
      type & 4 ? 'INSERT' : null,
      type & 8 ? 'DELETE' : null,
      type & 16 ? 'UPDATE' : null,
      type & 32 ? 'TRUNCATE' : null,
    ].filter((x): x is string => !!x)
    return {
      name: str(row[0]),
      table: str(row[1]),
      timing: type & 64 ? 'INSTEAD OF' : type & 2 ? 'BEFORE' : 'AFTER',
      events: events.join(','),
      orientation: type & 1 ? 'ROW' : 'STATEMENT',
      definition: strOrNull(row[3]),
      sqlMode: null,
      definer: null,
      // 'D' = disabled; 'O' / 'A' / 'R' fire (always / replica: the session mode decides, the trigger exists).
      enabled: str(row[4]) !== 'D',
    }
  })
}

/**
 * View → relation / routine edges come from the view's rewrite rule; routine → relation / routine edges exist only
 * for SQL-standard bodies (string bodies are not parsed at CREATE time and record nothing).
 */
export async function pgListDependencies(conn: Conn, ns: Namespace): Promise<ObjectDependency[]> {
  const schema = ns.schema ?? 'public'
  const r = firstResult(
    await conn.query(
      `WITH objs AS (
         SELECT c.oid, 'pg_class'::regclass AS classid, c.relname AS name,
                CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         UNION ALL
         SELECT p.oid, 'pg_proc'::regclass, p.proname, 'routine'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
       )
       SELECT DISTINCT src.kind, src.name, ref.kind, ref.name
       FROM pg_depend d
       JOIN objs ref ON ref.classid = d.refclassid AND ref.oid = d.refobjid
       JOIN objs src ON src.classid = d.classid AND src.oid = d.objid AND src.kind = 'routine'
       WHERE d.deptype = 'n'
       UNION
       SELECT DISTINCT v.kind, v.name, ref.kind, ref.name
       FROM pg_rewrite rw
       JOIN objs v ON v.classid = 'pg_class'::regclass AND v.oid = rw.ev_class AND v.kind = 'view'
       JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
       JOIN objs ref ON ref.classid = d.refclassid AND ref.oid = d.refobjid
       ORDER BY 1, 2, 3, 4`,
      [schema]
    )
  )
  const byKey = new Map<string, ObjectDependency>()
  for (const row of r.rows) {
    const kind = str(row[0]) === 'view' ? 'view' : 'routine'
    const name = str(row[1])
    const refKind = str(row[2])
    const refName = str(row[3])
    if (kind === refKind && name === refName) continue
    const key = `${kind}:${name}`
    const entry = byKey.get(key) ?? { kind, name, dependsOn: [] }
    if (!byKey.has(key)) byKey.set(key, entry)
    entry.dependsOn.push({
      kind: refKind === 'view' ? 'view' : refKind === 'routine' ? 'routine' : 'table',
      name: refName,
    })
  }
  return [...byKey.values()]
}
