import type { Dialect } from '@tsmyadmin/shared'

/** A complete single-quoted literal, quotes doubled — never interpolated next to a quote in a template. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Identifier quoting mirrors packages/adapter/src/sql/quote.ts. */
function quote(dialect: Dialect, name: string): string {
  return dialect === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`
}

/** What is being edited; each needs a different way of putting the new definition in place. */
type DefinitionKind = 'procedure' | 'function' | 'trigger' | 'view'

export interface EditDefinitionOptions {
  dialect: Dialect
  kind: DefinitionKind
  name: string
  /** The statement the server printed for the object. */
  definition: string
  /** MySQL: the sql_mode the routine was created under — the body may not parse under another one. */
  sqlMode?: string | null
  /** Triggers: MySQL drops by name alone, PostgreSQL needs the table. */
  table?: string | undefined
  schema?: string | undefined
}

/**
 * A runnable script that replaces an object's definition, for the user to edit and run in the SQL tab.
 *
 * There is deliberately no structured editor: a routine body is arbitrary code in the server's own dialect, and
 * the console already previews exactly what will run. PostgreSQL replaces in place; MySQL has no
 * `CREATE OR REPLACE` for routines and triggers, so the old one is dropped first — which is why the whole thing
 * is shown to the user before anything runs.
 */
export function editDefinitionSql(o: EditDefinitionOptions): string {
  const q = (n: string) => quote(o.dialect, n)
  const body = o.definition.trim().replace(/;\s*$/, '')
  if (o.dialect === 'postgres') {
    // pg_get_functiondef / pg_get_viewdef already produce a replaceable statement; a trigger has to be dropped.
    if (o.kind === 'trigger') {
      const on = o.table ? ` ON ${o.schema ? `${q(o.schema)}.` : ''}${q(o.table)}` : ''
      return `DROP TRIGGER IF EXISTS ${q(o.name)}${on};\n${body};\n`
    }
    if (o.kind === 'view' && !/^\s*CREATE\s+OR\s+REPLACE/i.test(body)) {
      return `${body.replace(/^\s*CREATE\s+/i, 'CREATE OR REPLACE ')};\n`
    }
    return `${body};\n`
  }
  // MySQL / MariaDB.
  if (o.kind === 'view') {
    return `${body.replace(/^\s*CREATE\s+/i, 'CREATE OR REPLACE ')};\n`
  }
  const drop =
    o.kind === 'trigger'
      ? `DROP TRIGGER IF EXISTS ${q(o.name)};`
      : `DROP ${o.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} IF EXISTS ${q(o.name)};`
  // The body runs between DELIMITER lines because it contains its own `;`, and under the sql_mode it was
  // written for — restored afterwards so the rest of the session is unaffected.
  const lines: string[] = []
  if (o.sqlMode) {
    lines.push(`SET @tsmyadmin_sql_mode = @@session.sql_mode;`)
    lines.push(`SET SESSION sql_mode = ${literal(o.sqlMode)};`)
  }
  lines.push(drop)
  lines.push('DELIMITER ;;')
  lines.push(`${body} ;;`)
  lines.push('DELIMITER ;')
  if (o.sqlMode) lines.push(`SET SESSION sql_mode = @tsmyadmin_sql_mode;`)
  return `${lines.join('\n')}\n`
}
