import { describe, expect, it } from 'vitest'
import { rows, scripted } from '../test/scripted-conn.ts'
import { pgRoutineDetail, pgTriggerDetail } from './program-detail.ts'

/**
 * What the edit form can take back from the catalog: a routine or trigger it could have made itself. Anything else
 * must come back as null (the screen then sends the person to the SQL tab) rather than as a form that would, saved,
 * silently rewrite the routine as something else. The real servers give these answers only for the fixture routines.
 */
const NS = { database: 'db', schema: 'app' }
const ROUTINE = /FROM pg_proc/
const TRIGGER = /FROM pg_trigger/

/** A pg_proc row: arguments, result, body, language, volatility, security definer, comment. */
const proc = (args: string, over: Partial<Record<number, unknown>> = {}) => {
  const row: unknown[] = [args, 'integer', 'SELECT 1', 'sql', 'i', false, null]
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v
  return row
}
const routine = (args: string, over?: Partial<Record<number, unknown>>) =>
  pgRoutineDetail(scripted([[ROUTINE, rows([proc(args, over)])]]).conn, NS, 'f', 'function')

describe('pgRoutineDetail', () => {
  it('reads the parameters with their modes, names and types', async () => {
    const detail = await routine('IN a integer, OUT b text, INOUT c numeric(10,2)')
    expect(detail?.params).toEqual([
      { mode: 'IN', name: 'a', type: 'integer' },
      { mode: 'OUT', name: 'b', type: 'text' },
      { mode: 'INOUT', name: 'c', type: 'numeric(10,2)' },
    ])
  })

  it('does not split a type at the comma inside its parentheses, and unquotes a quoted name', async () => {
    const detail = await routine('"odd ""name""" numeric(10,2), n integer')
    expect(detail?.params).toEqual([
      { mode: 'IN', name: 'odd "name"', type: 'numeric(10,2)' },
      { mode: 'IN', name: 'n', type: 'integer' },
    ])
  })

  it('has no parameters for an empty list', async () => {
    expect((await routine(''))?.params).toEqual([])
  })

  it('gives what the form says about a function: result, body, volatility, security and comment', async () => {
    const detail = await routine('a integer', { 4: 'i', 5: true, 6: 'adds' })
    expect(detail).toMatchObject({
      kind: 'function',
      name: 'f',
      returns: 'integer',
      body: 'SELECT 1',
      language: 'sql',
      deterministic: true,
      sqlSecurity: 'DEFINER',
      comment: 'adds',
    })
    const plain = await routine('a integer', { 4: 'v' })
    expect(plain).toMatchObject({ deterministic: false, sqlSecurity: 'INVOKER' })
    expect(plain).not.toHaveProperty('comment')
  })

  it('has no result for a procedure', async () => {
    const detail = await pgRoutineDetail(
      scripted([[ROUTINE, rows([proc('a integer', { 1: null })])]]).conn,
      NS,
      'p',
      'procedure'
    )
    expect(detail).not.toHaveProperty('returns')
  })

  it.each([
    ['a default value', 'a integer DEFAULT 1'],
    ['VARIADIC', 'VARIADIC xs integer[]'],
    ['an unnamed parameter', 'integer'],
  ])('is null for what the form cannot say: %s', async (_name, args) => {
    expect(await routine(args)).toBeNull()
  })

  it('is null for a language the form does not offer', async () => {
    expect(await routine('a integer', { 3: 'plpython3u; DROP' })).toBeNull()
  })

  it('is null for a kind that is not a routine, without asking the server', async () => {
    const { conn, asked } = scripted([])
    expect(await pgRoutineDetail(conn, NS, 'x', 'aggregate' as never)).toBeNull()
    expect(asked).toEqual([])
  })

  describe('overloads', () => {
    const two = () => scripted([[ROUTINE, rows([proc('a integer'), proc('a text')])]]).conn

    it('is null when there are several and none was picked: the form cannot know which to edit', async () => {
      expect(await pgRoutineDetail(two(), NS, 'f', 'function')).toBeNull()
    })

    it('takes the one whose argument list was given', async () => {
      const detail = await pgRoutineDetail(two(), NS, 'f', 'function', 'a text')
      expect(detail?.params).toEqual([{ mode: 'IN', name: 'a', type: 'text' }])
    })

    it('says not found when none matches the argument list given', async () => {
      await expect(pgRoutineDetail(two(), NS, 'f', 'function', 'a bigint')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  it('says not found when there is no such routine, and asks in the schema given', async () => {
    const { conn, asked } = scripted([[ROUTINE, rows([])]])
    await expect(pgRoutineDetail(conn, NS, 'gone', 'function')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(asked[0]?.params).toEqual(['app', 'gone', 'f'])
  })
})

/** A pg_trigger row: type bits, function source, function name, argument count, has WHEN, column list. */
const BEFORE_ROW_INSERT = 1 | 2 | 4
const trg = (over: Partial<Record<number, unknown>> = {}) => {
  const row: unknown[] = [BEFORE_ROW_INSERT, 'BEGIN RETURN NEW; END', 'tg_fn', 0, false, '']
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v
  return row
}
const trigger = (over?: Partial<Record<number, unknown>>) =>
  pgTriggerDetail(scripted([[TRIGGER, rows([trg(over)])]]).conn, NS, 't', 'tg')

describe('pgTriggerDetail', () => {
  it('reads timing, the one event and the body of a trigger the form could have made', async () => {
    expect(await trigger()).toEqual({
      name: 'tg',
      table: 't',
      timing: 'BEFORE',
      event: 'INSERT',
      body: 'BEGIN RETURN NEW; END',
    })
  })

  it.each([
    ['AFTER UPDATE', 1 | 16, 'AFTER', 'UPDATE'],
    ['AFTER DELETE', 1 | 8, 'AFTER', 'DELETE'],
  ])('reads %s', async (_name, type, timing, event) => {
    expect(await trigger({ 0: type })).toMatchObject({ timing, event })
  })

  it.each([
    ['a statement-level trigger', { 0: 2 | 4 }],
    ['more than one event', { 0: 1 | 4 | 16 }],
    ['an INSTEAD OF trigger', { 0: 1 | 64 | 4 }],
    ['arguments', { 3: 2 }],
    ['a WHEN condition', { 4: true }],
    ['a column list', { 5: '1 2' }],
    ['a function this tool did not make for it', { 2: 'other_fn' }],
  ])('is null for what the form cannot say: %s', async (_name, over) => {
    expect(await trigger(over)).toBeNull()
  })

  it('says not found when there is no such trigger, and asks in the schema given', async () => {
    const { conn, asked } = scripted([[TRIGGER, rows([])]])
    await expect(pgTriggerDetail(conn, NS, 't', 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(asked[0]?.params).toEqual(['app', 't', 'gone'])
  })
})
