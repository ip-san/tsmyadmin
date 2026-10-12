import { describe, expect, it } from 'vitest'
import type { Conn } from '../driver.ts'
import { rows, scripted } from '../test/scripted-conn.ts'
import { MysqlAdapter } from './adapter.ts'

/**
 * `showCreateTable` with its connection scripted: the plain table, the database-qualified sequence defaults MariaDB
 * prints, and the MariaDB sequence, whose branch no MySQL server ever reaches.
 */

const config = { dialect: 'mysql' as const, host: 'h', port: 1, user: 'u', password: 'p' }
const ns = { database: 'shop' }

const show = async (
  answers: [RegExp, ReturnType<typeof rows>][],
  known?: Parameters<MysqlAdapter['showCreateTable']>[2],
  table = 't'
) => {
  const adapter = new MysqlAdapter(config)
  const s = scripted(answers)
  ;(adapter as unknown as { withConn: (n: unknown, fn: (c: Conn) => unknown) => unknown }).withConn = async (_ns, fn) =>
    await fn(s.conn)
  return { out: await adapter.showCreateTable(ns, table, known), asked: s.asked.map((q) => q.text) }
}

describe('MysqlAdapter.showCreateTable', () => {
  it('returns the statement the server prints, asking for the table by its qualified name', async () => {
    const { out, asked } = await show([[/SHOW CREATE TABLE/, rows([['t', 'CREATE TABLE `t` (\n  `id` int\n)']])]])
    expect(out).toEqual(['CREATE TABLE `t` (\n  `id` int\n)'])
    expect(asked).toEqual(['SHOW CREATE TABLE `shop`.`t`'])
  })

  it('says the table is not there, naming it, when the server returns no row', async () => {
    await expect(show([[/SHOW CREATE TABLE/, rows([])]], undefined, 'gone')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Table not found: shop.gone',
    })
  })

  it('takes the database out of the sequence defaults MariaDB qualifies, and only where a default is', async () => {
    const create =
      "CREATE TABLE `t` (\n  `id` int DEFAULT nextval(`shop`.`seq`) COMMENT 'was DEFAULT nextval(`shop`.`seq`) once',\n  `b` int DEFAULT nextval(`shop`.`s2`)\n)"
    const { out } = await show([[/SHOW CREATE TABLE/, rows([['t', create]])]])
    expect(out).toEqual([
      "CREATE TABLE `t` (\n  `id` int DEFAULT nextval(`seq`) COMMENT 'was DEFAULT nextval(`seq`) once',\n  `b` int DEFAULT nextval(`s2`)\n)",
    ])
    const other = 'CREATE TABLE `t` (\n  `id` int DEFAULT nextval(`other`.`seq`)\n)'
    expect((await show([[/SHOW CREATE TABLE/, rows([['t', other]])]])).out).toEqual([other])
  })

  it('treats a missing statement text as empty', async () => {
    expect((await show([[/SHOW CREATE TABLE/, rows([['t', null]])]])).out).toEqual([''])
  })

  const SEQUENCE =
    'CREATE SEQUENCE `s` start with 1 minvalue 1 maxvalue 9223372036854775806 increment by 1 cache 1000 nocycle ENGINE=InnoDB'
  const asTable = 'CREATE TABLE `s` (\n  `next_not_cached_value` bigint(21) NOT NULL\n) ENGINE=InnoDB SEQUENCE=1'

  it('dumps a MariaDB sequence as its definition and the value it would hand out next, so a restore continues', async () => {
    const { out, asked } = await show([
      [/SHOW CREATE TABLE/, rows([['s', asTable]])],
      [/SHOW CREATE SEQUENCE/, rows([['s', SEQUENCE]])],
      [/SELECT next_not_cached_value/, rows([[1001]])],
    ])
    expect(out).toEqual([SEQUENCE, 'ALTER SEQUENCE `t` RESTART WITH 1001'])
    expect(asked).toEqual([
      'SHOW CREATE TABLE `shop`.`t`',
      'SHOW CREATE SEQUENCE `shop`.`t`',
      'SELECT next_not_cached_value FROM `shop`.`t`',
    ])
  })

  it('writes the restart value as digits only, a negative one with its sign, and none when the sequence has no value', async () => {
    const run = async (value: unknown) =>
      (
        await show([
          [/SHOW CREATE TABLE/, rows([['s', asTable]])],
          [/SHOW CREATE SEQUENCE/, rows([['s', SEQUENCE]])],
          [/SELECT next_not_cached_value/, rows([[value]])],
        ])
      ).out
    expect(await run('12345678901234567890')).toEqual([
      SEQUENCE,
      'ALTER SEQUENCE `t` RESTART WITH 12345678901234567890',
    ])
    expect(await run(-5)).toEqual([SEQUENCE, 'ALTER SEQUENCE `t` RESTART WITH -5'])
    expect(await run('1,0.5e')).toEqual([SEQUENCE, 'ALTER SEQUENCE `t` RESTART WITH 105'])
    expect(await run(null)).toEqual([SEQUENCE])
    expect(await run(undefined)).toEqual([SEQUENCE])
    expect(await run(0)).toEqual([SEQUENCE, 'ALTER SEQUENCE `t` RESTART WITH 0'])
    const noRow = await show([
      [/SHOW CREATE TABLE/, rows([['s', asTable]])],
      [/SHOW CREATE SEQUENCE/, rows([['s', SEQUENCE]])],
      [/SELECT next_not_cached_value/, rows([])],
    ])
    expect(noRow.out).toEqual([SEQUENCE])
  })

  it("takes the kind from the caller's schema when it is given, without reading the statement for the sequence option", async () => {
    const answers = (): [RegExp, ReturnType<typeof rows>][] => [
      [/SHOW CREATE TABLE/, rows([['s', asTable]])],
      [/SHOW CREATE SEQUENCE/, rows([['s', SEQUENCE]])],
      [/SELECT next_not_cached_value/, rows([[7]])],
    ]
    const known = (kind: string) => ({ kind }) as Parameters<MysqlAdapter['showCreateTable']>[2]
    expect((await show(answers(), known('table'))).out).toEqual([asTable])
    expect((await show(answers(), known('sequence'))).out).toEqual([SEQUENCE, 'ALTER SEQUENCE `t` RESTART WITH 7'])
    expect((await show(answers())).out).toEqual([SEQUENCE, 'ALTER SEQUENCE `t` RESTART WITH 7'])
  })

  it('does not take a table for a sequence because its text mentions the option', async () => {
    for (const text of [
      "CREATE TABLE `t` (\n  `a` int COMMENT 'SEQUENCE=1'\n) ENGINE=InnoDB",
      "CREATE TABLE `t` (\n  `a` int\n) ENGINE=InnoDB COMMENT='x' ",
      'CREATE TABLE `t` (\n  `a` int\n) ENGINE=InnoDB SEQUENCE=10',
    ]) {
      expect((await show([[/SHOW CREATE TABLE/, rows([['t', text]])]])).out).toEqual([text])
    }
  })
})
