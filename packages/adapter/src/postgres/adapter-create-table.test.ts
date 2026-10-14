import type { Namespace, TableSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import type { Conn } from '../driver.ts'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import { PostgresAdapter } from './adapter.ts'

/**
 * `showCreateTable` of PostgreSQL for the objects the catalog prints by hand: a view or materialized view (body,
 * options, comment, indexes) and a standalone sequence (definition, owner, comment, position), with the connection
 * scripted.
 */

const config = { dialect: 'postgres' as const, host: 'h', port: 1, user: 'u', password: 'p' }
const ns = { database: 'd', schema: 'sales' }
type Kind = 'view' | 'materialized_view' | 'sequence'
type Answers = [RegExp, ReturnType<typeof rows> | Error][]

/** The description of `name` as the caller already has it: only the kind matters to showCreateTable. */
const schemaOf = (name: string, kind: Kind): TableSchema => ({
  name,
  kind,
  comment: null,
  engine: null,
  rowEstimate: null,
  partitioned: false,
  hasChildren: false,
  inherits: [],
  collation: null,
  autoIncrement: null,
  columns: [],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
})

const show = async (kind: Kind, answers: Answers, name = 'thing', schema: Namespace = ns) => {
  const adapter = new PostgresAdapter(config)
  const s = scripted(answers)
  ;(adapter as unknown as { withConn: (n: unknown, fn: (c: Conn) => unknown) => unknown }).withConn = async (_n, fn) =>
    await fn(s.conn)
  return { out: await adapter.showCreateTable(schema, name, schemaOf(name, kind)), asked: s.asked }
}

const VIEW = /pg_get_viewdef/
const viewRow = (def: unknown, options: unknown = null, comment: unknown = null) => rows([[def, options, comment]])

describe('PostgresAdapter.showCreateTable: a view', () => {
  it('writes CREATE VIEW over the qualified name with the body the server prints, without its closing semicolon', async () => {
    const { out, asked } = await show('view', [[VIEW, viewRow(' SELECT 1 AS a;')]])
    expect(out).toEqual(['CREATE VIEW "sales"."thing" AS\n SELECT 1 AS a'])
    expect(asked[0]?.params).toEqual(['"sales"."thing"'])
    expect((await show('view', [[VIEW, viewRow('SELECT 1 ;  \n')]])).out[0]).toBe(
      'CREATE VIEW "sales"."thing" AS\nSELECT 1 '
    )
    expect((await show('view', [[VIEW, viewRow('SELECT 1; SELECT 2')]])).out[0]).toBe(
      'CREATE VIEW "sales"."thing" AS\nSELECT 1; SELECT 2'
    )
  })

  it('keeps security_barrier and security_invoker as WITH (…), and check_option as WITH … CHECK OPTION after the body', async () => {
    const out = (
      await show('view', [
        [VIEW, viewRow('SELECT 1;', '{security_barrier=true,security_invoker=on, check_option=local}')],
      ])
    ).out
    expect(out).toEqual([
      'CREATE VIEW "sales"."thing" WITH (security_barrier=true, security_invoker=on) AS\nSELECT 1\nWITH LOCAL CHECK OPTION',
    ])
    const cascaded = (await show('view', [[VIEW, viewRow('SELECT 1;', '{check_option=cascaded}')]])).out
    expect(cascaded).toEqual(['CREATE VIEW "sales"."thing" AS\nSELECT 1\nWITH CASCADED CHECK OPTION'])
    const other = (await show('view', [[VIEW, viewRow('SELECT 1;', '{fillfactor=70,xsecurity_barrier=true}')]])).out
    expect(other).toEqual(['CREATE VIEW "sales"."thing" AS\nSELECT 1'])
  })

  it('adds the comment as COMMENT ON VIEW, quoted, only when there is one', async () => {
    expect((await show('view', [[VIEW, viewRow('SELECT 1;', null, "it's a view")]])).out).toEqual([
      'CREATE VIEW "sales"."thing" AS\nSELECT 1',
      `COMMENT ON VIEW "sales"."thing" IS 'it''s a view'`,
    ])
    expect((await show('view', [[VIEW, viewRow('SELECT 1;', null, '')]])).out).toHaveLength(1)
    expect((await show('view', [[VIEW, viewRow('SELECT 1;', null, 5)]])).out).toHaveLength(1)
  })

  it('writes what the server gave as empty when it gave nothing', async () => {
    expect((await show('view', [[VIEW, rows([])]])).out).toEqual(['CREATE VIEW "sales"."thing" AS\n'])
    expect((await show('view', [[VIEW, viewRow(null, null)]])).out).toEqual(['CREATE VIEW "sales"."thing" AS\n'])
  })

  it('does not read the indexes of a plain view', async () => {
    const { asked } = await show('view', [[VIEW, viewRow('SELECT 1;')]])
    expect(asked).toHaveLength(1)
  })
})

describe('PostgresAdapter.showCreateTable: a materialized view', () => {
  const INDEXES = /pg_indexes/

  it('writes CREATE MATERIALIZED VIEW with a comment on the materialized view, then its indexes in name order', async () => {
    const { out, asked } = await show('materialized_view', [
      [VIEW, viewRow('SELECT 1;', null, 'c')],
      [INDEXES, rows([['CREATE UNIQUE INDEX a ON x (id)'], ['CREATE INDEX b ON x (n)'], [null]])],
    ])
    expect(out).toEqual([
      'CREATE MATERIALIZED VIEW "sales"."thing" AS\nSELECT 1',
      `COMMENT ON MATERIALIZED VIEW "sales"."thing" IS 'c'`,
      'CREATE UNIQUE INDEX a ON x (id)',
      'CREATE INDEX b ON x (n)',
      '',
    ])
    expect(asked[1]?.text).toContain('ORDER BY indexname')
    expect(asked[1]?.params).toEqual(['sales', 'thing'])
  })

  it('looks for the indexes in public when the namespace names no schema', async () => {
    const { asked } = await show(
      'materialized_view',
      [
        [VIEW, viewRow('SELECT 1;')],
        [INDEXES, rows([])],
      ],
      'mv',
      { database: 'd' }
    )
    expect(asked[1]?.params).toEqual(['public', 'mv'])
  })
})

describe('PostgresAdapter.showCreateTable: a sequence', () => {
  const SEQ = /FROM pg_sequence s/
  // type, start, increment, min, max, cache, cycle, owner table, owner column, last value, is_called, comment
  const seqRow = (over: Record<number, unknown> = {}) => {
    const row: unknown[] = ['bigint', 1, 1, 1, 9223372036854775807n, 1, false, null, null, 41, true, null]
    for (const [i, v] of Object.entries(over)) row[Number(i)] = v
    return rows([row])
  }

  it('writes the definition and then the position it stands at, as pg_dump does', async () => {
    const { out, asked } = await show('sequence', [[SEQ, seqRow()]])
    expect(out).toEqual([
      'CREATE SEQUENCE "sales"."thing" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1',
      `SELECT pg_catalog.setval('"sales"."thing"', 41, true)`,
    ])
    expect(asked[0]?.params).toEqual(['"sales"."thing"'])
  })

  it('writes CYCLE only for a sequence that cycles, and false when the position was never used', async () => {
    const out = (await show('sequence', [[SEQ, seqRow({ 6: true, 10: false, 2: -5, 3: -100, 4: -1, 1: -1, 5: 20 })]]))
      .out
    expect(out[0]).toBe(
      'CREATE SEQUENCE "sales"."thing" AS bigint INCREMENT BY -5 MINVALUE -100 MAXVALUE -1 START WITH -1 CACHE 20 CYCLE'
    )
    expect(out.at(-1)).toBe(`SELECT pg_catalog.setval('"sales"."thing"', 41, false)`)
    expect((await show('sequence', [[SEQ, seqRow({ 6: 'true' })]])).out[0]).not.toContain('CYCLE')
    expect((await show('sequence', [[SEQ, seqRow({ 10: 't' })]])).out.at(-1)).toContain(', false)')
  })

  it('links the sequence to the column that owns it, in the schema of the table, quoting every name', async () => {
    const out = (await show('sequence', [[SEQ, seqRow({ 7: 'or"ders', 8: 'id' })]])).out
    expect(out[1]).toBe('ALTER SEQUENCE "sales"."thing" OWNED BY "sales"."or""ders"."id"')
    expect((await show('sequence', [[SEQ, seqRow({ 7: 'orders', 8: null })]])).out).toHaveLength(2)
    expect((await show('sequence', [[SEQ, seqRow({ 7: null, 8: 'id' })]])).out).toHaveLength(2)
  })

  it('adds the comment before the position, only when there is one', async () => {
    const out = (await show('sequence', [[SEQ, seqRow({ 7: 'orders', 8: 'id', 11: "it's" })]])).out
    expect(out.map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual([
      'CREATE SEQUENCE "sales"."thing"',
      'ALTER SEQUENCE "sales"."thing"',
      'COMMENT ON SEQUENCE',
      'SELECT pg_catalog.setval(\'"sales"."thing"\', 41,',
    ])
    expect(out[2]).toBe(`COMMENT ON SEQUENCE "sales"."thing" IS 'it''s'`)
    expect((await show('sequence', [[SEQ, seqRow({ 11: '' })]])).out).toHaveLength(2)
    expect((await show('sequence', [[SEQ, seqRow({ 11: 3 })]])).out).toHaveLength(2)
  })

  it('starts the position at 1 when the sequence has no value to report, and says the sequence is not there when it has no row', async () => {
    expect((await show('sequence', [[SEQ, seqRow({ 9: null })]])).out.at(-1)).toBe(
      `SELECT pg_catalog.setval('"sales"."thing"', 1, true)`
    )
    await expect(show('sequence', [[SEQ, rows([])]], 'gone')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Sequence not found: gone',
    })
  })

  it('lets a failure of the server through', async () => {
    await expect(show('sequence', [[SEQ, fail('QUERY_FAILED', '42P01')]])).rejects.toMatchObject({
      code: 'QUERY_FAILED',
    })
  })
})
