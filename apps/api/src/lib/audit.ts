import { ADAPTER_METHOD_NAMES, type DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Namespace, RowKey, SessionInfo } from '@tsmyadmin/shared'
import { PASSWORD_MASK } from '@tsmyadmin/shared'
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
      const sql = String(args[1] ?? '')
      return {
        ...base,
        sql: sql.length > SQL_SUMMARY_MAX ? `${sql.slice(0, SQL_SUMMARY_MAX)}…` : sql,
        sqlLength: sql.length,
      }
    }
    case 'killProcess':
      return { processId: args[0] }
  }
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
          logger.log('warn', 'audit', {
            ...fields,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ms: Math.round(performance.now() - started),
          })
          throw err
        }
      }
    },
  })
}
