import { describe, expect, it } from 'vitest'
import { parsePgPlan } from '../postgres/explain.ts'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import { pgHypotheticalPlan } from './hypopg.ts'

const ns = { database: 'shop', schema: 'app' }
const index = { table: 'users', columns: ['age'], name: 'idx_users_age' }
const plan = [
  {
    Plan: {
      'Node Type': 'Index Scan',
      'Relation Name': 'users',
      Alias: 'users',
      'Index Name': '<13630>btree_users_age',
      'Index Cond': '(age = 5)',
      'Plan Rows': 3,
      'Total Cost': 8.3,
    },
  },
]
const installed: [RegExp, ReturnType<typeof rows>] = [/FROM pg_extension/, rows([['ext']])]

describe('pgHypotheticalPlan', () => {
  it('assumes each index from the CREATE INDEX the preview would show, passed as a value, then clears them', async () => {
    const { conn, asked } = scripted([
      installed,
      [/^BEGIN READ ONLY$/, rows([])],
      [/hypopg_create_index/, rows([['<13630>btree_users_age']])],
      [/^EXPLAIN/, rows([[plan]])],
      [/^ROLLBACK$/, rows([])],
      [/hypopg_reset/, rows([])],
    ])
    const r = await pgHypotheticalPlan(conn, ns, 'SELECT * FROM users WHERE age = 5', [index], parsePgPlan)
    expect(asked.map((a) => a.text)).toEqual([
      "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'hypopg'",
      'BEGIN READ ONLY',
      'SELECT indexname FROM "ext".hypopg_create_index($1)',
      'EXPLAIN (FORMAT JSON) SELECT * FROM users WHERE age = 5',
      'ROLLBACK',
      'SELECT "ext".hypopg_reset()',
    ])
    expect(asked[2]?.params).toEqual(['CREATE INDEX "idx_users_age" ON "app"."users" ("age")'])
    expect(r.plan.index).toBe('idx_users_age')
    expect(r.assumed).toEqual(['idx_users_age'])
    expect(r.raw).toContain('"Index Name": "idx_users_age"')
  })

  it('clears them after a statement the server refuses, the transaction first', async () => {
    const { conn, asked, discard } = scripted([
      installed,
      [/^BEGIN READ ONLY$/, rows([])],
      [/hypopg_create_index/, rows([['<1>btree_users_age']])],
      [/^EXPLAIN/, fail('QUERY_FAILED', '42703')],
      [/^ROLLBACK$/, rows([])],
      [/hypopg_reset/, rows([])],
    ])
    await expect(pgHypotheticalPlan(conn, ns, 'SELECT nope FROM users', [index], parsePgPlan)).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    })
    expect(asked.slice(-2).map((a) => a.text)).toEqual(['ROLLBACK', 'SELECT "ext".hypopg_reset()'])
    expect(discard).not.toHaveBeenCalled()
  })

  it('does not hand back a connection it could not clear: the next borrower would plan with them', async () => {
    const { conn, discard } = scripted([
      installed,
      [/^BEGIN READ ONLY$/, rows([])],
      [/hypopg_create_index/, rows([['<1>btree_users_age']])],
      [/^EXPLAIN/, rows([[plan]])],
      [/^ROLLBACK$/, rows([])],
      [/hypopg_reset/, fail('CONNECTION_FAILED')],
    ])
    await pgHypotheticalPlan(conn, ns, 'SELECT * FROM users WHERE age = 5', [index], parsePgPlan)
    expect(discard).toHaveBeenCalled()
  })

  it('does not count a built index that has the name given as one assumed', async () => {
    const built = [{ Plan: { ...plan[0]?.Plan, 'Index Name': 'idx_users_age' } }]
    const { conn } = scripted([
      installed,
      [/^BEGIN READ ONLY$/, rows([])],
      [/hypopg_create_index/, rows([['<7>btree_users_age']])],
      [/^EXPLAIN/, rows([[built]])],
      [/^ROLLBACK$/, rows([])],
      [/hypopg_reset/, rows([])],
    ])
    const r = await pgHypotheticalPlan(conn, ns, 'SELECT * FROM users WHERE age = 5', [index], parsePgPlan)
    expect(r.plan.index).toBe('idx_users_age')
    expect(r.assumed).toEqual([])
  })

  it('fails where HypoPG gives no index back, rather than say the plan does not use it', async () => {
    const { conn, asked } = scripted([
      installed,
      [/^BEGIN READ ONLY$/, rows([])],
      [/hypopg_create_index/, rows([])],
      [/^ROLLBACK$/, rows([])],
      [/hypopg_reset/, rows([])],
    ])
    await expect(
      pgHypotheticalPlan(conn, ns, 'SELECT * FROM users WHERE age = 5', [index], parsePgPlan)
    ).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    expect(asked.some((a) => a.text.startsWith('EXPLAIN'))).toBe(false)
    expect(asked.at(-1)?.text).toBe('SELECT "ext".hypopg_reset()')
  })

  it('refuses where HypoPG is not installed, before anything is assumed', async () => {
    const { conn, asked } = scripted([[/FROM pg_extension/, rows([])]])
    await expect(pgHypotheticalPlan(conn, ns, 'SELECT 1', [index], parsePgPlan)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
    expect(asked).toHaveLength(1)
  })
})
