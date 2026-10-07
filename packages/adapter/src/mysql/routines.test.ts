import { describe, expect, it } from 'vitest'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import {
  mysqlListDependencies,
  mysqlListEvents,
  mysqlListRoutines,
  mysqlListTriggers,
  mysqlRoutineDefinition,
  showCreateProgram,
} from './routines.ts'

/**
 * What MySQL and MariaDB give back from information_schema and SHOW CREATE, in the shapes a real server answers only for
 * the fixture objects: a function parameter with no mode, a MariaDB package, an account that may not read a definition,
 * a server with no VIEW_TABLE_USAGE. Scripted here, as the server would answer.
 */
const NS = { database: 'shop' }
const denied = () => fail('PERMISSION_DENIED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR')

describe('mysqlListRoutines', () => {
  const list = (routines: unknown[][], params: unknown[][] = []) =>
    mysqlListRoutines(
      scripted([
        [/information_schema\.ROUTINES/, rows(routines)],
        [/information_schema\.PARAMETERS/, rows(params)],
      ]).conn,
      NS
    )

  it('lists a procedure and a function with their parameters, the result type only for the function', async () => {
    const out = await list(
      [
        ['calc', 'FUNCTION', null, 'int(11)', 'adds', 'calc', 'STRICT'],
        // The type column holds a value here too, to show that only a function has a result type.
        ['reset', 'PROCEDURE', 'SQL', 'int(11)', '', 'reset', null],
      ],
      [
        ['calc', null, 'a', 'int(11)'],
        ['calc', null, 'b', 'int(11)'],
        ['reset', 'INOUT', 'n', 'int(11)'],
      ]
    )
    expect(out).toEqual([
      {
        name: 'calc',
        kind: 'function',
        language: 'SQL',
        returns: 'int(11)',
        parameters: 'a int(11), b int(11)',
        comment: 'adds',
        sqlMode: 'STRICT',
      },
      {
        name: 'reset',
        kind: 'procedure',
        language: 'SQL',
        returns: null,
        parameters: 'INOUT n int(11)',
        comment: null,
        sqlMode: '',
      },
    ])
  })

  it('names a MariaDB package and its body as such, and takes an unknown type for a procedure', async () => {
    const out = await list([
      ['pkg', 'PACKAGE', null, null, null, 'pkg', null],
      ['pkg', 'PACKAGE BODY', null, null, null, 'pkg', null],
      ['odd', 'SOMETHING', null, null, null, 'odd', null],
    ])
    expect(out.map((r) => r.kind)).toEqual(['package', 'package body', 'procedure'])
  })

  it('keeps an external language as the catalog gives it, and has no parameters for a routine with none', async () => {
    const [r] = await list([['f', 'FUNCTION', 'C', 'int', null, 'f', null]])
    expect(r).toMatchObject({ language: 'C', parameters: '' })
  })
})

describe('mysqlRoutineDefinition', () => {
  const def = (answer: ReturnType<typeof rows> | Error) =>
    mysqlRoutineDefinition(scripted([[/SHOW CREATE/, answer]]).conn, NS, 'f', 'function')

  it('is the third column of SHOW CREATE, the statement as written', async () => {
    expect(await def(rows([['f', 'STRICT', 'CREATE FUNCTION f() RETURNS int RETURN 1']]))).toBe(
      'CREATE FUNCTION f() RETURNS int RETURN 1'
    )
  })

  it('is null when there is no row, or when the account may not read it', async () => {
    expect(await def(rows([]))).toBeNull()
    expect(await def(denied())).toBeNull()
  })

  it('does not hide another error', async () => {
    await expect(def(fail('QUERY_FAILED', 'ER_PARSE_ERROR'))).rejects.toMatchObject({ nativeCode: 'ER_PARSE_ERROR' })
  })
})

describe('showCreateProgram', () => {
  const show = (kind: 'TRIGGER' | 'EVENT', answer: ReturnType<typeof rows> | Error) =>
    showCreateProgram(scripted([[/SHOW CREATE/, answer]]).conn, NS, kind, 'x')

  it('reads the statement from the column the kind has it in: the third for a trigger, the fourth for an event', async () => {
    expect(await show('TRIGGER', rows([['t', '', 'CREATE TRIGGER …']]))).toBe('CREATE TRIGGER …')
    expect(await show('EVENT', rows([['e', '', 'UTC', 'CREATE EVENT …']]))).toBe('CREATE EVENT …')
  })

  it('is null when the account may not read it, or when it was dropped since it was listed', async () => {
    expect(await show('TRIGGER', denied())).toBeNull()
    expect(await show('EVENT', fail('NOT_FOUND', 'ER_SP_DOES_NOT_EXIST'))).toBeNull()
  })

  it('does not hide another error', async () => {
    await expect(show('EVENT', fail('CONNECTION_FAILED', 'PROTOCOL_CONNECTION_LOST'))).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    })
  })
})

describe('mysqlListTriggers', () => {
  const row = ['t1', 'orders', 'BEFORE', 'INSERT', 'ROW', 'SET NEW.a = 1', 'STRICT', 'root@localhost']
  const list = (show: ReturnType<typeof rows> | Error, table?: string) => {
    const s = scripted([
      [/information_schema\.TRIGGERS/, rows([row])],
      [/SHOW CREATE TRIGGER/, show],
    ])
    return mysqlListTriggers(s.conn, NS, table).then((out) => ({ out, asked: s.asked }))
  }

  it('prefers the original statement of SHOW CREATE over the processed body of information_schema', async () => {
    const { out } = await list(rows([['t1', '', 'CREATE TRIGGER t1 … SET NEW.a = 1']]))
    expect(out[0]).toMatchObject({
      name: 't1',
      table: 'orders',
      definition: 'CREATE TRIGGER t1 … SET NEW.a = 1',
      definer: 'root@localhost',
      fireMode: 'origin',
    })
  })

  it('keeps the body of information_schema when the account may not read the statement', async () => {
    const { out } = await list(denied())
    expect(out[0]?.definition).toBe('SET NEW.a = 1')
  })

  it('asks for one table only when one is given, binding it', async () => {
    const all = await list(rows([]))
    const one = await list(rows([]), 'orders')
    expect(all.asked[0]?.params).toEqual(['shop'])
    expect(one.asked[0]?.params).toEqual(['shop', 'orders'])
  })

  it('has an empty sql_mode, and no definer, where the catalog gives none', async () => {
    const s = scripted([
      [/information_schema\.TRIGGERS/, rows([['t1', 'orders', 'AFTER', 'DELETE', 'ROW', 'x', null, null]])],
      [/SHOW CREATE TRIGGER/, rows([])],
    ])
    const [t] = await mysqlListTriggers(s.conn, NS)
    expect(t).toMatchObject({ sqlMode: '', definer: null })
  })
})

describe('mysqlListEvents', () => {
  const ev = (over: Partial<Record<number, unknown>>) => {
    const r: unknown[] = [
      'e1',
      'ENABLED',
      'RECURRING',
      null,
      '1',
      'DAY',
      '2024-01-01 00:00:00',
      null,
      null,
      'PRESERVE',
      '',
      'DELETE FROM t',
      null,
      'UTC',
      'root@%',
    ]
    for (const [i, v] of Object.entries(over)) r[Number(i)] = v
    return r
  }
  const list = (row: unknown[], show: ReturnType<typeof rows> | Error) =>
    mysqlListEvents(
      scripted([
        [/information_schema\.EVENTS/, rows([row])],
        [/SHOW CREATE EVENT/, show],
      ]).conn,
      NS
    )

  it('says when a recurring event runs, and when a one-time event does', async () => {
    expect((await list(ev({}), rows([])))[0]?.schedule).toBe('EVERY 1 DAY')
    expect((await list(ev({ 2: 'ONE TIME', 3: '2030-01-01 00:00:00' }), rows([])))[0]?.schedule).toBe(
      'AT 2030-01-01 00:00:00'
    )
  })

  it('prefers the original statement, and falls back to the definition of information_schema', async () => {
    expect((await list(ev({}), rows([['e1', '', 'UTC', 'CREATE EVENT e1 …']])))[0]?.definition).toBe(
      'CREATE EVENT e1 …'
    )
    expect((await list(ev({}), denied()))[0]?.definition).toBe('DELETE FROM t')
  })

  it('has an empty comment as none, and an empty sql_mode', async () => {
    const [e] = await list(ev({ 10: '', 12: null }), rows([]))
    expect(e).toMatchObject({ comment: null, sqlMode: '', timeZone: 'UTC', definer: 'root@%' })
  })
})

describe('mysqlListDependencies', () => {
  it('is what each view reads: a table, another view, or a routine', async () => {
    const out = await mysqlListDependencies(
      scripted([
        [
          /VIEW_TABLE_USAGE/,
          rows([
            ['v1', 't1', 'BASE TABLE'],
            ['v1', 'v0', 'VIEW'],
            ['v1', 'gone', null],
          ]),
        ],
        [/VIEW_ROUTINE_USAGE/, rows([['v1', 'f1']])],
      ]).conn,
      NS
    )
    expect(out).toEqual([
      {
        kind: 'view',
        name: 'v1',
        dependsOn: expect.arrayContaining([
          { kind: 'table', name: 't1' },
          { kind: 'view', name: 'v0' },
          { kind: 'table', name: 'gone' },
          { kind: 'routine', name: 'f1' },
        ]),
      },
    ])
  })

  it('is null on a server that has no VIEW_TABLE_USAGE (MariaDB), and does not hide another error', async () => {
    const unknown = scripted([[/VIEW_TABLE_USAGE/, fail('QUERY_FAILED', 'ER_UNKNOWN_TABLE')]])
    expect(await mysqlListDependencies(unknown.conn, NS)).toBeNull()
    const other = scripted([[/VIEW_TABLE_USAGE/, fail('QUERY_FAILED', 'ER_PARSE_ERROR')]])
    await expect(mysqlListDependencies(other.conn, NS)).rejects.toMatchObject({ nativeCode: 'ER_PARSE_ERROR' })
  })
})
