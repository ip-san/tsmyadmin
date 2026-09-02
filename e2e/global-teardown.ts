import { request } from '@playwright/test'
import { TARGETS } from './helpers.ts'

/**
 * Removes scratch objects that a timed-out or crashed test could not clean up itself: `e2e_%` tables, accounts and
 * databases in both dialects, plus `e2e_%` / `many_%` schemas on PostgreSQL. Runs through the API so no driver is
 * needed here.
 */
export default async function globalTeardown(): Promise<void> {
  const port = process.env.E2E_PORT ?? '3199'
  const api = await request.newContext({ baseURL: `http://127.0.0.1:${port}` })
  try {
    for (const t of TARGETS) {
      const login = await api.post('/api/session', {
        data: {
          dialect: t.dialect,
          host: t.host,
          port: t.port,
          user: t.user,
          password: t.password,
          database: t.database,
        },
      })
      if (!login.ok()) continue
      const sql = async (statement: string) =>
        api.post(`/api/databases/${t.database}/sql`, {
          data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}), stopOnError: false },
        })
      const listSql =
        t.dialect === 'mysql'
          ? `SELECT table_name FROM information_schema.tables WHERE table_schema = '${t.database}' AND table_name LIKE 'e2e\\_%'`
          : `SELECT tablename FROM pg_tables WHERE schemaname = '${t.schema ?? 'public'}' AND tablename LIKE 'e2e\\_%'`
      const names = async (query: string): Promise<string[]> => {
        const res = await sql(query)
        const body = (await res.json()) as { kind: string; result?: { rows: unknown[][] } }[]
        return (body[0]?.result?.rows ?? []).map((r) => String(r[0]))
      }
      for (const name of await names(listSql)) await sql(`DROP TABLE IF EXISTS ${name}`)
      if (t.dialect === 'postgres') {
        for (const s of await names(
          "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'many\\_%' OR nspname LIKE 'e2e\\_schema\\_%'"
        ))
          await sql(`DROP SCHEMA IF EXISTS ${s} CASCADE`)
        for (const d of await names("SELECT datname FROM pg_database WHERE datname LIKE 'e2e\\_db\\_%'"))
          await sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
        for (const u of await names("SELECT rolname FROM pg_roles WHERE rolname LIKE 'e2e\\_user\\_%'"))
          await sql(`DROP OWNED BY ${u}; DROP ROLE IF EXISTS ${u}`)
      } else {
        for (const d of await names(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'e2e\\_db\\_%'"
        ))
          await sql(`DROP DATABASE IF EXISTS ${d}`)
        for (const u of await names("SELECT user FROM mysql.user WHERE user LIKE 'e2e\\_user\\_%'"))
          await sql(`DROP USER IF EXISTS '${u}'@'%'`)
      }
      await api.delete('/api/session')
    }
  } finally {
    await api.dispose()
  }
}
