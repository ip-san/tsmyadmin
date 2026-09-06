import { ADAPTER_METHOD_NAMES, AdapterError, type DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ConnectRequest, Namespace, RowKey, SessionInfo } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
import { type AdapterFactory, sessionIdentity } from '../session/store.ts'
import type { Logger } from './logging.ts'
import { currentRequest } from './request-context.ts'

type Method = (typeof ADAPTER_METHOD_NAMES)[number]

/** Methods that change data, structure, accounts or server state. Everything else is read-only and not audited. */
export const AUDITED_METHODS = [
  'insertRow',
  'insertRows',
  'updateRow',
  'deleteRows',
  'executeSql',
  'cancelQuery',
  'killProcess',
] as const satisfies readonly Method[]
/** Read-only methods, listed explicitly so the spec-consistency test notices new adapter methods. */
export const PASSTHROUGH_METHODS = [
  'ping',
  'close',
  'listDatabases',
  'listSchemas',
  'listTables',
  'describeTable',
  'listRoutines',
  'routineDefinition',
  'listTriggers',
  'listEvents',
  'listDependencies',
  'browseRows',
  'showCreateTable',
  'iterateRows',
  'listUsers',
  'showGrants',
  'serverInfo',
  'listVariables',
  'listStatus',
  'listProcesses',
] as const satisfies readonly Method[]

export const SQL_SUMMARY_MAX = 500

type AuditedMethod = (typeof AUDITED_METHODS)[number]
const audited = new Set<string>(AUDITED_METHODS)

function keySummary(key: RowKey): string {
  return key.kind === 'ctid' ? 'ctid' : `${key.kind}(${Object.keys(key.values).join(',')})`
}

/** Compact, value-free description of a call: which table, how many rows, which key kind, statement text (truncated). */
export function summarise(method: AuditedMethod, args: unknown[]): Record<string, unknown> {
  const ns = args[0] as Namespace | undefined
  const base = ns ? { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) } : {}
  switch (method) {
    case 'insertRow':
      return { ...base, table: args[1], rows: 1, columns: Object.keys((args[2] as Record<string, unknown>) ?? {}) }
    case 'insertRows':
      return { ...base, table: args[1], rows: (args[3] as unknown[])?.length ?? 0, columns: args[2] }
    case 'updateRow':
      return {
        ...base,
        table: args[1],
        key: keySummary(args[2] as RowKey),
        columns: Object.keys((args[3] as Record<string, unknown>) ?? {}),
      }
    case 'deleteRows':
      return {
        ...base,
        table: args[1],
        rows: (args[2] as RowKey[])?.length ?? 0,
        key: (args[2] as RowKey[])?.[0] ? keySummary((args[2] as RowKey[])[0] as RowKey) : undefined,
      }
    case 'executeSql': {
      const full = String(args[1] ?? '')
      // A bulk load (an uploaded file) is data, not a statement the operator typed: only its size is logged.
      const label = (args[2] as { auditLabel?: string } | undefined)?.auditLabel
      if (label) return { ...base, sql: `<${label}>`, sqlLength: full.length }
      // Only the logged prefix is scanned (a 64 MB import would otherwise block the event loop on regexes);
      // a secret straddling the cut is truncated together with everything after it.
      const sql = redactSqlSecrets(full.slice(0, SQL_SUMMARY_MAX * 16))
      return {
        ...base,
        sql: sql.length > SQL_SUMMARY_MAX ? `${sql.slice(0, SQL_SUMMARY_MAX)}…` : sql,
        sqlLength: full.length,
      }
    }
    case 'cancelQuery':
      return { queryId: args[0] }
    case 'killProcess':
      return { processId: args[0] }
  }
}

/**
 * A SQL string literal: plain / doubled-quote / backslash-escaped, PostgreSQL `E'…'`, or dollar-quoted `$tag$…$tag$`.
 * `n` is the index the dollar tag capture group will have inside the enclosing pattern.
 */
const literal = (n: number) =>
  `(?:(?:[EeNnXxBb]|[Uu]&|_[A-Za-z0-9]+)?'(?:[^'\\\\]|\\\\.|'')*'|"(?:[^"\\\\]|\\\\.|"")*"|\\$([A-Za-z_]*)\\$[\\s\\S]*?\\$\\${n}\\$)`
/**
 * Password literals in account statements typed directly into the SQL console: IDENTIFIED BY / AS (plugin hash),
 * PASSWORD 'x', and MySQL 8 `REPLACE '<current password>'` (REPLACE INTO / REPLACE( never precede a bare literal).
 */
const SQL_SECRET = new RegExp(
  String.raw`\b(IDENTIFIED(?:\s+WITH\s+\S+)?\s+(?:BY|AS)|IDENTIFIED\s+VIA\s+\S+\s+USING|(?:\w+_)?PASSWORD|REPLACE)(\s*[=(]?\s*)(?:${literal(3)}|0x[0-9A-Fa-f]+)`,
  'gi'
)
/** `password=secret` inside a connection string (CREATE SUBSCRIPTION … CONNECTION, dblink, postgres_fdw options). */
const CONNECTION_PASSWORD = /(\bpassword\s*=\s*)[^\s'";]+/gi
/** MySQL `SET PASSWORD [FOR user] = 'x'`. */
const SET_PASSWORD = new RegExp(String.raw`(\bSET\s+PASSWORD\b[^=;]*=\s*)${literal(2)}`, 'gi')

/** Any string literal, for the coarse sweep over account statements. */
const ANY_LITERAL = new RegExp(literal(1), 'g')
/**
 * A statement's credential part: from the first IDENTIFIED / PASSWORD keyword on — wherever it sits, including
 * inside a string handed to PREPARE / EXECUTE / format() — everything between the first and the last quote is one
 * mask, so nested quoting (`''secret''`) cannot leave a fragment outside a literal. The account name before it
 * stays, and so does the tail after the last quote (`WITH GRANT OPTION`).
 */
const CREDENTIAL_PART = /^([\s\S]*?\b(?:\w+_)?(?:IDENTIFIED|PASSWORD)\b)([\s\S]*)$/i
const QUOTED_SPAN = /['"$][\s\S]*['"$]/

/**
 * Drops SQL comments while copying string literals verbatim (a comment between `IDENTIFIED` and `BY`, or between
 * `PASSWORD` and its literal, would otherwise defeat the patterns below). The summary is for reading, not for
 * replay, so losing comments is fine.
 */
function withoutComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') j += 2
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2
        else if (sql[j] === ch) break
        else j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (ch === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0] ?? '$$'
      const end = sql.indexOf(tag, i + tag.length)
      const stop = end < 0 ? sql.length : end + tag.length
      out += sql.slice(i, stop)
      i = stop
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
      out += ' '
    } else if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end
    } else {
      out += ch
      i++
    }
  }
  return out
}

function redactSqlSecrets(sql: string): string {
  const plain = withoutComments(sql)
    .replace(SQL_SECRET, (_m, kw: string, sep: string) => `${kw}${sep}'${PASSWORD_MASK}'`)
    .replace(SET_PASSWORD, (_m, head: string) => `${head}'${PASSWORD_MASK}'`)
    .replace(CONNECTION_PASSWORD, (_m, head: string) => `${head}${PASSWORD_MASK}`)
  // Statement by statement: after the credential keyword no literal survives.
  return plain
    .split(/(;)/)
    .map((part) => {
      const m = CREDENTIAL_PART.exec(part)
      if (!m) return part
      const tail = m[2] ?? ''
      const masked = QUOTED_SPAN.test(tail)
        ? tail.replace(QUOTED_SPAN, `'${PASSWORD_MASK}'`)
        : tail.replace(ANY_LITERAL, (lit) => (lit.includes(PASSWORD_MASK) ? lit : `'${PASSWORD_MASK}'`))
      return `${m[1]}${masked}`
    })
    .join('')
}

function scrub(fields: Record<string, unknown>, secrets: string[]): Record<string, unknown> {
  if (secrets.length === 0) return fields
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === 'string' ? secrets.reduce((acc, s) => acc.split(s).join(PASSWORD_MASK), v) : v
  }
  return out
}

/**
 * Wraps an adapter so every mutating call is written to the audit log with the session's identity, the request id,
 * the outcome and a value-free summary. Read-only methods pass through untouched.
 * Implemented as a Proxy keyed on ADAPTER_METHOD_NAMES so it cannot drift from the adapter contract.
 */
export function withAudit(adapter: DatabaseAdapter, who: SessionInfo, logger: Logger): DatabaseAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || !audited.has(prop) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value
      }
      const method = prop as AuditedMethod
      return async (...args: unknown[]) => {
        const started = performance.now()
        const ctx = currentRequest()
        const fields = {
          requestId: ctx?.requestId,
          action: method,
          dialect: who.dialect,
          dbHost: `${who.host}:${who.port}`,
          dbUser: who.user,
          ...scrub(summarise(method, args), ctx?.redact ?? []),
        }
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          const outcome =
            method === 'executeSql' && Array.isArray(result)
              ? { statements: result.length, errors: result.filter((r) => r?.kind === 'error').length }
              : {}
          logger.log('info', 'audit', { ...fields, ...outcome, ok: true, ms: Math.round(performance.now() - started) })
          return result
        } catch (err) {
          // Only the error class is logged: server messages quote the offending value ("Duplicate entry 'x'").
          const e = err instanceof AdapterError ? err : null
          logger.log('warn', 'audit', {
            ...fields,
            ok: false,
            error: e?.code ?? (err instanceof Error ? err.name : 'Error'),
            ...(e?.nativeCode ? { nativeCode: e.nativeCode } : {}),
            ms: Math.round(performance.now() - started),
          })
          throw err
        }
      }
    },
  })
}

/**
 * The one place adapters get their audit wrapper: every session store builds adapters through this factory,
 * on login and when resuming after a restart, so no code path can hand out an unaudited adapter.
 */
export function auditedAdapterFactory(
  base: (config: ConnectRequest) => DatabaseAdapter,
  logger: Logger
): AdapterFactory {
  return (config) => withAudit(base(config), sessionIdentity(config), logger)
}
