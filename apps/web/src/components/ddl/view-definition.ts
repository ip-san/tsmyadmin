import type { Definer, SqlSecurity } from '@tsmyadmin/shared'

export interface ParsedView {
  select: string
  algorithm?: 'UNDEFINED' | 'MERGE' | 'TEMPTABLE'
  definer?: Definer
  sqlSecurity?: SqlSecurity
  checkOption?: 'CASCADED' | 'LOCAL'
}

const QUOTED = '`(?:[^`]|``)*`|\'(?:[^\']|\'\')*\'|"(?:[^"]|"")*"'
const unquote = (s: string) => (/^[`'"]/.test(s) ? s.slice(1, -1).replaceAll(s[0]?.repeat(2) ?? '', s[0] ?? '') : s)

/**
 * A view as the server printed it (`CREATE ALGORITHM=… DEFINER=… SQL SECURITY … VIEW v AS select …` on MySQL,
 * `CREATE VIEW v AS\n select …` on PostgreSQL, either followed by a CHECK OPTION), back into the parts the view
 * form edits. Null when it does not read as a view.
 */
export function parseViewDefinition(definition: string): ParsedView | null {
  // The first statement only: a PostgreSQL view's COMMENT comes after it.
  const statement = (definition.trim().split(/;[ \t]*\n[ \t]*\n/)[0] ?? '').replace(/;\s*$/, '')
  const head = /^CREATE\b[\s\S]*?\bVIEW\b[\s\S]*?\bAS\b\s*/i.exec(statement)
  if (!head) return null
  const header = head[0]
  // security_invoker / security_barrier: the form cannot express them, and replacing the view would drop them.
  if (/\bVIEW\b[\s\S]*?\bWITH\s*\(/i.test(header)) return null
  let select = statement.slice(head[0].length).trim()
  const out: ParsedView = { select }
  const check = /\s*\bWITH(?:\s+(CASCADED|LOCAL))?\s+CHECK\s+OPTION\s*$/i.exec(select)
  if (check) {
    select = select.slice(0, check.index).trim()
    out.select = select
    out.checkOption = (check[1]?.toUpperCase() as 'CASCADED' | 'LOCAL' | undefined) ?? 'CASCADED'
  }
  const algorithm = /\bALGORITHM\s*=\s*(UNDEFINED|MERGE|TEMPTABLE)\b/i.exec(header)?.[1]
  if (algorithm) out.algorithm = algorithm.toUpperCase() as NonNullable<ParsedView['algorithm']>
  const security = /\bSQL\s+SECURITY\s+(DEFINER|INVOKER)\b/i.exec(header)?.[1]
  if (security) out.sqlSecurity = security.toUpperCase() as SqlSecurity
  const definer = new RegExp(`\\bDEFINER\\s*=\\s*(${QUOTED}|[^\\s@\`'"]+)@(${QUOTED}|[^\\s\`'"]+)`, 'i').exec(header)
  if (definer?.[1] && definer[2]) out.definer = { user: unquote(definer[1]), host: unquote(definer[2]) }
  return select === '' ? null : out
}
