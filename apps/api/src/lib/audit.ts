import {
  ADAPTER_METHOD_NAMES,
  AdapterError,
  type DatabaseAdapter,
  splitStatements,
  stripComments,
} from '@tsmyadmin/adapter'
import type { ConnectRequest, Namespace, RowKey, SessionInfo } from '@tsmyadmin/shared'
import {
  type Dialect,
  maskConnectionPassword,
  maskCredentialPart,
  PASSWORD_MASK,
  sqlLiteralPattern,
} from '@tsmyadmin/shared'
import { type AdapterFactory, sessionIdentity } from '../session/store.ts'
import type { Logger } from './logging.ts'
import { currentRequest } from './request-context.ts'

type Method = (typeof ADAPTER_METHOD_NAMES)[number]

/**
 * Methods that change data, structure, accounts or server state, and `analyzePlan`, which runs the operator's statement
 * (a read, rolled back, but it takes the server's time). Everything else is read-only and not audited.
 */
export const AUDITED_METHODS = [
  'insertRow',
  'insertRows',
  'updateRow',
  'deleteRows',
  'executeSql',
  'analyzePlan',
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
  'tableStats',
  'countRows',
  'databaseGrants',
  'listPartitions',
  'listRoutines',
  'routineDefinition',
  'routineDetail',
  'triggerDetail',
  'eventDetail',
  'listTriggers',
  'listEvents',
  'listDependencies',
  'browseRows',
  'readCell',
  'searchTable',
  'distinctValues',
  'columnProfile',
  'insertPreview',
  'checkReferences',
  'tableUsage',
  'deleteImpact',
  'explainPlan',
  'hypotheticalPlan',
  'prepareDdl',
  'buildQuery',
  'listForeignKeys',
  'showCreateTable',
  'iterateRows',
  'listUsers',
  'canManageAccount',
  'showGrants',
  'serverInfo',
  'listVariables',
  'serverCatalog',
  'replicationInfo',
  'diagnostics',
  'listStatus',
  'listProcesses',
  'lockWaits',
] as const satisfies readonly Method[]

export const SQL_SUMMARY_MAX = 500

type AuditedMethod = (typeof AUDITED_METHODS)[number]
const audited = new Set<string>(AUDITED_METHODS)

function keySummary(key: RowKey): string {
  return key.kind === 'ctid' ? 'ctid' : `${key.kind}(${Object.keys(key.values).join(',')})`
}

/** Compact, value-free description of a call: which table, how many rows, which key kind, statement text (truncated). */
export function summarise(
  method: AuditedMethod,
  args: unknown[],
  dialect: Dialect = 'postgres'
): Record<string, unknown> {
  const ns = args[0] as Namespace | undefined
  const base = ns ? { database: ns.database, ...(ns.schema ? { schema: ns.schema } : {}) } : {}
  switch (method) {
    case 'insertRow':
      return { ...base, table: args[1], rows: 1, columns: Object.keys((args[2] as Record<string, unknown>) ?? {}) }
    case 'insertRows':
      // The rows may be a generator (CSV import): only an array has a count up front; the outcome carries it.
      return { ...base, table: args[1], ...(Array.isArray(args[3]) ? { rows: args[3].length } : {}), columns: args[2] }
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
      const sql = redactSqlSecrets(full.slice(0, SQL_SUMMARY_MAX * 16), dialect)
      return {
        ...base,
        sql: sql.length > SQL_SUMMARY_MAX ? `${sql.slice(0, SQL_SUMMARY_MAX)}…` : sql,
        sqlLength: full.length,
      }
    }
    case 'analyzePlan':
      // A read run to time it: how long it may run is the fact; the statement is the SQL tab's, recorded there.
      return { ...base, sqlLength: String(args[1] ?? '').length, timeoutMs: args[2] }
    case 'cancelQuery':
      return { queryId: args[0] }
    case 'killProcess':
      // Which of the two a KILL was matters after the fact: one ended a statement, the other a session.
      return { processId: args[0], killMode: (args[1] as string | undefined) ?? 'connection' }
  }
}

/**
 * Password literals in account statements typed directly into the SQL console: IDENTIFIED BY / AS (plugin hash),
 * PASSWORD 'x', and MySQL 8 `REPLACE '<current password>'` (REPLACE INTO / REPLACE( never precede a bare literal).
 */
const SQL_SECRET = new RegExp(
  String.raw`\b(IDENTIFIED(?:\s+WITH\s+\S+)?\s+(?:BY|AS)|IDENTIFIED\s+VIA\s+\S+\s+USING|(?:\w+_)?PASSWORD|REPLACE)(\s*(?:[=(]\s*)?)(?:${sqlLiteralPattern(3, true)}|0x[0-9A-Fa-f]+)`,
  'gi'
)
/** MySQL `SET PASSWORD [FOR user] = 'x'`. */
const SET_PASSWORD = new RegExp(String.raw`(\bSET\s+PASSWORD\b[^=;]*=\s*)${sqlLiteralPattern(2, true)}`, 'gi')

function redactSqlSecrets(sql: string, dialect: Dialect): string {
  const plain = maskConnectionPassword(
    stripComments(sql, dialect)
      .replace(SQL_SECRET, (_m, kw: string, sep: string) => `${kw}${sep}'${PASSWORD_MASK}'`)
      .replace(SET_PASSWORD, (_m, head: string) => `${head}'${PASSWORD_MASK}'`)
  )
  // Statement by statement (the adapter's own splitter, so a `;` inside any literal the server would accept never
  // starts a new part): after the credential keyword no literal survives — not even an unterminated one (the rule
  // itself is shared with the browser's debug panel, see `maskCredentialPart`).
  return splitStatements(plain, dialect)
    .map((st) => maskCredentialPart(st.sql))
    .join(';\n')
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
          ...scrub(summarise(method, args, who.dialect), ctx?.redact ?? []),
        }
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          const outcome =
            method === 'executeSql' && Array.isArray(result)
              ? { statements: result.length, errors: result.filter((r) => r?.kind === 'error').length }
              : method === 'insertRows' && result && typeof result === 'object' && 'affectedRows' in result
                ? { rows: (result as { affectedRows: number }).affectedRows }
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
