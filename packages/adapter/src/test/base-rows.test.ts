import { describe, expect, it } from 'vitest'
import { READ_CELL_MAX_BYTES } from '../base.ts'
import { affecting, column, type Dialect, ns, rig } from './base-rig.ts'
import { type Answer, rows } from './scripted-conn.ts'

/**
 * `updateRow`, `deleteRows`, `countRows` and `readCell` for both dialects, with the connection scripted: the key's
 * WHERE, the one-row guard that rolls a wrong match back, and the size check before a cell is read into memory.
 */

type Rule = [RegExp, Answer]
const adapterFor = (dialect: Dialect, script: Rule[], types: Record<string, string> = {}) =>
  rig(dialect, { rules: script, table: { columns: Object.entries(types).map(([n, t]) => column(n, t)) } })
const pk = (values: Record<string, unknown>) => ({ kind: 'pk', values }) as never
const all = (values: Record<string, unknown>) => ({ kind: 'all-columns', values }) as never
const SET_TIMEOUT = 'SET SESSION max_execution_time = 30000'

describe('updateRow', () => {
  it('sets the values of the row with that key, as parameters, inside a transaction', async () => {
    const m = adapterFor('mysql', [[/^UPDATE/, affecting(1)]], { id: 'varchar(10)' })
    expect(await m.adapter.updateRow(ns, 't', pk({ id: 'a' }), { name: 'x', note: null })).toEqual({ affectedRows: 1 })
    expect(m.asked[0]).toEqual({
      text: 'UPDATE `d`.`t` SET `name` = ?, `note` = ? WHERE `id` = ?',
      params: ['x', null, 'a'],
    })
    expect(m.statements()).toEqual([SET_TIMEOUT, 'BEGIN', m.asked[0]?.text, 'COMMIT'])
    const p = adapterFor('postgres', [[/^UPDATE/, affecting(1)]])
    await p.adapter.updateRow(ns, 't', pk({ id: 1 }), { name: 'x' })
    expect(p.asked[0]).toEqual({ text: 'UPDATE "sales"."t" SET "name" = $1 WHERE "id" = $2', params: ['x', 1] })
  })

  it('changes nothing, and sends nothing, when there are no values', async () => {
    const m = adapterFor('mysql', [])
    expect(await m.adapter.updateRow(ns, 't', pk({ id: 1 }), {})).toEqual({ affectedRows: 0 })
    expect(m.sent).toHaveLength(0)
  })

  it('limits a MySQL update by every column to one row, and no other update', async () => {
    const m = adapterFor('mysql', [[/^UPDATE/, affecting(1)]], { a: 'varchar(5)' })
    await m.adapter.updateRow(ns, 't', all({ a: 'x' }), { b: 1 })
    expect(m.asked[0]?.text).toMatch(/ LIMIT 1$/)
    const byKey = adapterFor('mysql', [[/^UPDATE/, affecting(1)]])
    await byKey.adapter.updateRow(ns, 't', pk({ id: 1 }), { b: 1 })
    expect(byKey.asked[0]?.text).not.toContain('LIMIT')
  })

  it('fails, so the transaction is rolled back, when the key matched none or more than one row', async () => {
    for (const matched of [0, 2]) {
      const m = adapterFor('mysql', [[/^UPDATE/, affecting(matched)]])
      await expect(m.adapter.updateRow(ns, 't', pk({ id: 1 }), { a: 1 })).rejects.toMatchObject({
        code: 'KEY_MISMATCH',
        message: `Expected to update exactly 1 row but matched ${matched}; rolled back`,
      })
      expect(m.statements().at(-1), String(matched)).toBe('ROLLBACK')
      expect(m.statements()).not.toContain('COMMIT')
    }
  })
})

describe('deleteRows', () => {
  it('deletes each key in turn, one row each, in one transaction, and adds them up', async () => {
    const m = adapterFor('mysql', [[/^DELETE/, affecting(1)]])
    expect(await m.adapter.deleteRows(ns, 't', [pk({ id: 1 }), pk({ id: 2 })])).toEqual({ affectedRows: 2 })
    expect(m.asked.map((q) => [q.text, q.params])).toEqual([
      ['DELETE FROM `d`.`t` WHERE `id` = ?', [1]],
      ['DELETE FROM `d`.`t` WHERE `id` = ?', [2]],
    ])
    expect(m.transactions()).toBe(1)
    expect(m.statements().at(-1)).toBe('COMMIT')
    expect(await adapterFor('mysql', []).adapter.deleteRows(ns, 't', [])).toEqual({ affectedRows: 0 })
  })

  it('limits a MySQL delete by every column to one row, but not by a key and not on PostgreSQL', async () => {
    const m = adapterFor('mysql', [[/^DELETE/, affecting(1)]], { a: 'varchar(5)' })
    await m.adapter.deleteRows(ns, 't', [all({ a: 'x' })])
    expect(m.asked[0]?.text).toMatch(/ LIMIT 1$/)
    const byKey = adapterFor('mysql', [[/^DELETE/, affecting(1)]])
    await byKey.adapter.deleteRows(ns, 't', [pk({ id: 1 })])
    expect(byKey.asked[0]?.text).not.toContain('LIMIT')
    const p = adapterFor('postgres', [[/^DELETE/, affecting(1)]])
    await p.adapter.deleteRows(ns, 't', [pk({ id: 1 })])
    expect(p.asked[0]?.text).toBe('DELETE FROM "sales"."t" WHERE "id" = $1')
  })

  it('fails, so the transaction is rolled back, when a key matched none or more than one row', async () => {
    for (const matched of [0, 3]) {
      const m = adapterFor('mysql', [[/^DELETE/, affecting(matched)]])
      await expect(m.adapter.deleteRows(ns, 't', [pk({ id: 1 }), pk({ id: 2 })])).rejects.toMatchObject({
        code: 'KEY_MISMATCH',
        message: `Expected to delete exactly 1 row but matched ${matched}; rolled back`,
      })
      // The first key already fails: the second is never sent.
      expect(m.statements(), String(matched)).toEqual([
        SET_TIMEOUT,
        'BEGIN',
        'DELETE FROM `d`.`t` WHERE `id` = ?',
        'ROLLBACK',
      ])
    }
  })
})

describe('countRows', () => {
  it('counts the rows of the table', async () => {
    const m = adapterFor('mysql', [[/COUNT/, rows([[42]])]])
    expect(await m.adapter.countRows(ns, 't')).toBe(42)
    expect(m.asked[0]?.text).toBe('SELECT COUNT(*) FROM `d`.`t`')
    expect(await adapterFor('postgres', [[/COUNT/, rows([['7']])]]).adapter.countRows(ns, 't')).toBe(7)
    expect(await adapterFor('mysql', [[/COUNT/, rows([])]]).adapter.countRows(ns, 't')).toBe(0)
    expect(await adapterFor('mysql', [[/COUNT/, rows([[null]])]]).adapter.countRows(ns, 't')).toBe(0)
  })
})

describe('readCell', () => {
  const sizeThenValue = (size: unknown[][], value: unknown[][]): Rule[] => [
    [/OCTET_LENGTH/, rows(size)],
    [/^SELECT [^O]/, rows(value)],
  ]

  it('measures the cell first, then reads it, both for the row with that key', async () => {
    const m = adapterFor('mysql', sizeThenValue([[5]], [['hello']]), { id: 'varchar(10)', body: 'text' })
    expect(await m.adapter.readCell(ns, 't', pk({ id: 'a' }), 'body')).toBe('hello')
    expect(m.asked.map((q) => q.text)).toEqual([
      'SELECT OCTET_LENGTH(`body`) FROM `d`.`t` WHERE `id` = ? LIMIT 2',
      'SELECT `body` FROM `d`.`t` WHERE `id` = ? LIMIT 2',
    ])
  })

  it('returns null for a null cell', async () => {
    const m = adapterFor('mysql', sizeThenValue([[null]], [[null]]), { id: 'int', body: 'text' })
    expect(await m.adapter.readCell(ns, 't', pk({ id: 1 }), 'body')).toBeNull()
  })

  it('measures a PostgreSQL value that octet_length does not take by its text form', async () => {
    const types = {
      id: 'integer',
      a: 'bytea',
      b: 'text',
      c: 'character varying',
      d: 'integer',
      e: 'BIT(3)',
      f: 'jsonb',
      g: 'varchar(5)',
    }
    const measured = async (name: string) => {
      const p = adapterFor('postgres', sizeThenValue([[1]], [['x']]), types)
      await p.adapter.readCell(ns, 't', pk({ id: 1 }), name)
      return p.asked[0]?.text ?? ''
    }
    expect(await measured('a')).toContain('OCTET_LENGTH("a")')
    expect(await measured('b')).toContain('OCTET_LENGTH("b")')
    expect(await measured('c')).toContain('OCTET_LENGTH("c")')
    expect(await measured('e')).toContain('OCTET_LENGTH("e")')
    expect(await measured('g')).toContain('OCTET_LENGTH("g")')
    expect(await measured('d')).toContain('OCTET_LENGTH("d"::text)')
    expect(await measured('f')).toContain('OCTET_LENGTH("f"::text)')
    const typeThatEndsLikeText = adapterFor('postgres', sizeThenValue([[1]], [['x']]), { id: 'integer', z: 'context' })
    await typeThatEndsLikeText.adapter.readCell(ns, 't', pk({ id: 1 }), 'z')
    expect(typeThatEndsLikeText.asked[0]?.text).toContain('"z"::text')
  })

  it('never measures a MySQL value by its text form', async () => {
    const m = adapterFor('mysql', sizeThenValue([[1]], [['x']]), { id: 'int', n: 'int' })
    await m.adapter.readCell(ns, 't', pk({ id: 1 }), 'n')
    expect(m.asked[0]?.text).not.toContain('::text')
  })

  it('refuses a column the table does not have, before asking the server anything', async () => {
    const m = adapterFor('mysql', [], { id: 'int' })
    await expect(m.adapter.readCell(ns, 't', pk({ id: 1 }), 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Unknown column: nope',
    })
    expect(m.asked).toHaveLength(0)
  })

  it('refuses a cell above the limit without reading it, and reads one exactly at the limit', async () => {
    const over = adapterFor('mysql', sizeThenValue([[READ_CELL_MAX_BYTES + 1]], [['x']]), { id: 'int', body: 'text' })
    await expect(over.adapter.readCell(ns, 't', pk({ id: 1 }), 'body')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: `The value is larger than ${READ_CELL_MAX_BYTES} bytes`,
    })
    expect(over.asked).toHaveLength(1)
    const at = adapterFor('mysql', sizeThenValue([[READ_CELL_MAX_BYTES]], [['x']]), { id: 'int', body: 'text' })
    expect(await at.adapter.readCell(ns, 't', pk({ id: 1 }), 'body')).toBe('x')
    const unmeasured = adapterFor('mysql', sizeThenValue([[null]], [['x']]), { id: 'int', body: 'text' })
    expect(await unmeasured.adapter.readCell(ns, 't', pk({ id: 1 }), 'body')).toBe('x')
  })

  it('fails when the key matches no row or more than one, at either step', async () => {
    const types = { id: 'int', body: 'text' }
    for (const size of [[], [[1], [2]]]) {
      const m = adapterFor('mysql', sizeThenValue(size, [['x']]), types)
      await expect(m.adapter.readCell(ns, 't', pk({ id: 1 }), 'body')).rejects.toMatchObject({
        code: 'KEY_MISMATCH',
        message: `Expected exactly 1 row but matched ${size.length}`,
      })
    }
    for (const value of [[], [['a'], ['b']]]) {
      const m = adapterFor('mysql', sizeThenValue([[1]], value), types)
      await expect(m.adapter.readCell(ns, 't', pk({ id: 1 }), 'body')).rejects.toMatchObject({
        code: 'KEY_MISMATCH',
        message: `Expected exactly 1 row but matched ${value.length}`,
      })
    }
  })
})
