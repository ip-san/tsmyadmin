import { describe, expect, it } from 'vitest'
import type { Conn } from '../driver.ts'
import { type Answer, rows, scripted } from '../test/scripted-conn.ts'
import { PostgresAdapter } from './adapter.ts'

/**
 * `explainPlan` for a statement whose values are not given (`generic`): planned for any value on PostgreSQL 16 and
 * later, refused before (the option is a syntax error there), with the connection scripted.
 */

const config = { dialect: 'postgres' as const, host: 'h', port: 1, user: 'u', password: 'p' }
const ns = { database: 'd' }
const PLAN = JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Plan Rows': 10 } }])

const explain = async (version: string, generic: boolean) => {
  const adapter = new PostgresAdapter(config)
  const rules: [RegExp, Answer][] = [
    [/^SELECT current_setting\('server_version_num'\)$/, rows([[version]])],
    [/^EXPLAIN /, rows([[PLAN]])],
    [/^(BEGIN READ ONLY|ROLLBACK)$/, rows([])],
    [/hypopg/i, rows([])],
  ]
  const s = scripted(rules)
  ;(adapter as unknown as { withConn: (n: unknown, fn: (c: Conn) => unknown) => unknown }).withConn = async (_n, fn) =>
    await fn(s.conn)
  const run = adapter.explainPlan(ns, 'SELECT * FROM users WHERE id = $1', { generic })
  return { run, asked: s.asked }
}

describe('PostgresAdapter.explainPlan, for any value', () => {
  it('asks the server for a plan for any value on PostgreSQL 16', async () => {
    const { run, asked } = await explain('160000', true)
    expect((await run).plan.table).toBe('users')
    expect(asked.map((a) => a.text)).toContain('EXPLAIN (GENERIC_PLAN, FORMAT JSON) SELECT * FROM users WHERE id = $1')
  })

  it('refuses before PostgreSQL 16, asking nothing more of the server', async () => {
    const { run, asked } = await explain('150007', true)
    await expect(run).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(asked.map((a) => a.text)).toEqual(["SELECT current_setting('server_version_num')"])
  })

  it('asks no version of a plain estimate', async () => {
    const { run, asked } = await explain('150007', false)
    await run
    expect(asked.map((a) => a.text)).toContain('EXPLAIN (FORMAT JSON) SELECT * FROM users WHERE id = $1')
    expect(asked.some((a) => /server_version_num/.test(a.text))).toBe(false)
  })
})
