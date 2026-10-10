import type { RoutineKind } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { rows, scripted } from '../test/scripted-conn.ts'
import { pgListDependencies, pgListRoutines, pgListTriggers, pgRoutineDefinition } from './routines.ts'

/** What the PostgreSQL readers make of the rows the catalog returns (a scripted connection answers). */

const ns = { database: 'db', schema: 'app' }
const refuses = async (run: () => Promise<unknown>, code: string, message: RegExp) =>
  await expect(run()).rejects.toMatchObject({ code, message: expect.stringMatching(message) })

describe('pgListRoutines', () => {
  it('lists functions and procedures of a schema, a procedure with no return type', async () => {
    const { conn, asked } = scripted([
      [
        /FROM pg_proc p/,
        rows([
          ['f', 'f', 'sql', 'integer', 'a integer', 'adds'],
          ['p', 'p', 'plpgsql', null, 'IN x text', null],
          ['u', 'f', null, null, null, undefined],
        ]),
      ],
    ])
    expect(await pgListRoutines(conn, ns)).toEqual([
      {
        name: 'f',
        kind: 'function',
        language: 'sql',
        returns: 'integer',
        parameters: 'a integer',
        comment: 'adds',
        sqlMode: null,
      },
      {
        name: 'p',
        kind: 'procedure',
        language: 'plpgsql',
        returns: null,
        parameters: 'IN x text',
        comment: null,
        sqlMode: null,
      },
      { name: 'u', kind: 'function', language: null, returns: null, parameters: '', comment: null, sqlMode: null },
    ])
    expect(asked[0]?.params).toEqual(['app'])
  })

  it('reads the public schema when none is named, and a procedure never has a result even if one is printed', async () => {
    const { conn, asked } = scripted([[/FROM pg_proc p/, rows([['p', 'p', 'sql', 'void', '', null]])]])
    expect((await pgListRoutines(conn, { database: 'db' }))[0]?.returns).toBeNull()
    expect(asked[0]?.params).toEqual(['public'])
  })
})

describe('pgRoutineDefinition', () => {
  const script = (data: unknown[][]) => scripted([[/pg_get_functiondef/, rows(data)]])

  it('joins the definition of every overload as statements, asking for the kind by its letter', async () => {
    const { conn, asked } = script([
      ['CREATE OR REPLACE FUNCTION app.f(a integer) ...', null, 'a integer'],
      ['CREATE OR REPLACE FUNCTION app.f(a text) ...', null, 'a text'],
    ])
    expect(await pgRoutineDefinition(conn, ns, 'f', 'function')).toBe(
      'CREATE OR REPLACE FUNCTION app.f(a integer) ...;\n\nCREATE OR REPLACE FUNCTION app.f(a text) ...'
    )
    expect(asked[0]?.params).toEqual(['app', 'f', 'f'])
    const proc = script([['CREATE PROCEDURE ...', null, '']])
    await pgRoutineDefinition(proc.conn, { database: 'db' }, 'p', 'procedure')
    expect(proc.asked[0]?.params).toEqual(['public', 'p', 'p'])
  })

  it('carries the comment of each overload with it, naming the overload by its identity arguments', async () => {
    const { conn } = script([
      ['DEF1', "it's", 'a integer'],
      ['DEF2', null, 'a text'],
      ['DEF3', '', ''],
    ])
    expect(await pgRoutineDefinition(conn, ns, 'we"ird', 'function')).toBe(
      [
        'DEF1',
        `COMMENT ON FUNCTION "app"."we""ird"(a integer) IS 'it''s'`,
        'DEF2',
        'DEF3',
        `COMMENT ON FUNCTION "app"."we""ird"() IS ''`,
      ].join(';\n\n')
    )
    const proc = script([['P', 'c', 'x int']])
    expect(await pgRoutineDefinition(proc.conn, ns, 'p', 'procedure')).toBe(
      `P;\n\nCOMMENT ON PROCEDURE "app"."p"(x int) IS 'c'`
    )
  })

  it('skips an overload the account may not read, and refuses when none is left or the kind is not one PostgreSQL has', async () => {
    const { conn } = script([
      [null, 'orphan comment', 'x'],
      ['OK', null, ''],
    ])
    expect(await pgRoutineDefinition(conn, ns, 'f', 'function')).toBe('OK')
    await refuses(
      () => pgRoutineDefinition(script([]).conn, ns, 'gone', 'function'),
      'NOT_FOUND',
      /Routine not found: gone/
    )
    refuses(
      () => pgRoutineDefinition(script([[null, null, '']]).conn, ns, 'hidden', 'function'),
      'NOT_FOUND',
      /Routine not found: hidden/
    )
    const other = scripted([])
    refuses(
      () => pgRoutineDefinition(other.conn, ns, 'x', 'package' as RoutineKind),
      'NOT_FOUND',
      /Routine not found: x/
    )
    expect(other.asked).toHaveLength(0)
  })
})

describe('pgListTriggers', () => {
  // tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead of
  const listed = async (type: number, mode = 'O') => {
    const { conn } = scripted([[/FROM pg_trigger t/, rows([['tg', 'tbl', type, 'CREATE TRIGGER ...', mode]])]])
    return (await pgListTriggers(conn, ns))[0]
  }

  it('reads the timing, events and orientation from the bits of the trigger type', async () => {
    expect(await listed(1 | 2 | 4)).toMatchObject({ timing: 'BEFORE', events: 'INSERT', orientation: 'ROW' })
    expect(await listed(1 | 4 | 8 | 16)).toMatchObject({
      timing: 'AFTER',
      events: 'INSERT,DELETE,UPDATE',
      orientation: 'ROW',
    })
    expect(await listed(32)).toMatchObject({ timing: 'AFTER', events: 'TRUNCATE', orientation: 'STATEMENT' })
    expect(await listed(1 | 64 | 16)).toMatchObject({ timing: 'INSTEAD OF', events: 'UPDATE' })
    expect(await listed(64 | 2)).toMatchObject({ timing: 'INSTEAD OF' })
    expect(await listed(8)).toMatchObject({ events: 'DELETE' })
    expect(await listed(0)).toMatchObject({ events: '', timing: 'AFTER', orientation: 'STATEMENT' })
  })

  it("reads how it fires, an unknown letter as the default, and carries the server's text and no MySQL fields", async () => {
    expect((await listed(1, 'O'))?.fireMode).toBe('origin')
    expect((await listed(1, 'A'))?.fireMode).toBe('always')
    expect((await listed(1, 'R'))?.fireMode).toBe('replica')
    expect((await listed(1, 'D'))?.fireMode).toBe('disabled')
    expect((await listed(1, 'Z'))?.fireMode).toBe('origin')
    expect(await listed(1)).toMatchObject({
      name: 'tg',
      table: 'tbl',
      definition: 'CREATE TRIGGER ...',
      sqlMode: null,
      definer: null,
    })
  })

  it("lists the schema's triggers, or those of one table when one is named", async () => {
    const all = scripted([[/FROM pg_trigger t/, rows([])]])
    await pgListTriggers(all.conn, { database: 'db' })
    expect(all.asked[0]?.params).toEqual(['public'])
    expect(all.asked[0]?.text).not.toContain('c.relname = $2')
    const one = scripted([[/FROM pg_trigger t/, rows([])]])
    await pgListTriggers(one.conn, ns, 'tbl')
    expect(one.asked[0]?.params).toEqual(['app', 'tbl'])
    expect(one.asked[0]?.text).toContain('AND c.relname = $2 ORDER BY c.relname, t.tgname')
  })
})

describe('pgListDependencies', () => {
  it('groups what each view and routine depends on, reading the kinds, and drops an object depending on itself', async () => {
    const { conn, asked } = scripted([
      [
        /WITH objs AS/,
        rows([
          ['view', 'v', 'table', 't'],
          ['view', 'v', 'view', 'w'],
          ['routine', 'f', 'routine', 'g'],
          ['routine', 'f', 'table', 'anything'],
          ['routine', 'f', 'routine', 'f'],
          ['view', 'x', 'view', 'x'],
        ]),
      ],
    ])
    expect(await pgListDependencies(conn, ns)).toEqual([
      {
        kind: 'view',
        name: 'v',
        dependsOn: [
          { kind: 'table', name: 't' },
          { kind: 'view', name: 'w' },
        ],
      },
      {
        kind: 'routine',
        name: 'f',
        dependsOn: [
          { kind: 'routine', name: 'g' },
          { kind: 'table', name: 'anything' },
        ],
      },
    ])
    expect(asked[0]?.params).toEqual(['app'])
    const none = scripted([[/WITH objs AS/, rows([])]])
    expect(await pgListDependencies(none.conn, { database: 'db' })).toEqual([])
    expect(none.asked[0]?.params).toEqual(['public'])
  })
})
