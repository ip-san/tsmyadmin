import { describe, expect, it } from 'vitest'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import { mysqlEventDetail, mysqlRoutineDetail, mysqlTriggerDetail } from './program-detail.ts'

/**
 * What the edit form takes back from the catalog, and above all how it cuts the body out of the SHOW CREATE statement
 * as written: not from information_schema, which hands the body out with its escapes processed (`'a\'b'` comes back as
 * `'a'b'`) and so would restore a different routine. A real server gives these statements only for the fixture
 * routines; here they are scripted, with the awkward bodies: a keyword inside a string, an escaped quote, a backtick.
 */
const NS = { database: 'db' }
const SHOW_ROUTINE = /SHOW CREATE (PROCEDURE|FUNCTION)/
const SHOW_TRIGGER = /SHOW CREATE TRIGGER/
const SHOW_EVENT = /SHOW CREATE EVENT/

/** information_schema.ROUTINES: DTD_IDENTIFIER, IS_DETERMINISTIC, SQL_DATA_ACCESS, SECURITY_TYPE, comment, DEFINER, SPECIFIC_NAME */
const routineRow = (over: Partial<Record<number, unknown>> = {}) => {
  const row: unknown[] = ['int(11)', 'YES', 'READS_SQL_DATA', 'DEFINER', 'adds', 'root@localhost', 'f']
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v
  return row
}

const routine = (show: string | null | Error, over?: Partial<Record<number, unknown>>, params: unknown[][] = []) =>
  mysqlRoutineDetail(
    scripted([
      [/information_schema\.ROUTINES/, rows([routineRow(over)])],
      [SHOW_ROUTINE, show instanceof Error ? show : rows(show === null ? [] : [['f', '', show]])],
      [/information_schema\.PARAMETERS/, rows(params)],
    ]).conn,
    NS,
    'f',
    'function'
  )

const DEF = 'CREATE DEFINER=`root`@`localhost` FUNCTION `f`(a int)\n    RETURNS int(11)\n    DETERMINISTIC\n'

describe('mysqlRoutineDetail', () => {
  it('cuts the body after the header lines, which all start with four spaces', async () => {
    const detail = await routine(`${DEF}BEGIN\n  RETURN a + 1;\nEND`, {}, [['IN', 'a', 'int(11)']])
    expect(detail).toMatchObject({
      kind: 'function',
      name: 'f',
      body: 'BEGIN\n  RETURN a + 1;\nEND',
      language: 'sql',
      returns: 'int(11)',
      deterministic: true,
      comment: 'adds',
      definer: { user: 'root', host: 'localhost' },
      sqlSecurity: 'DEFINER',
      dataAccess: 'READS SQL DATA',
      params: [{ mode: 'IN', name: 'a', type: 'int(11)' }],
    })
  })

  it('keeps the body as written, an escaped quote included', async () => {
    const detail = await routine(`${DEF}RETURN 'it\\'s'`)
    expect(detail?.body).toBe("RETURN 'it\\'s'")
  })

  it('takes the parameter mode IN for one the catalog gives no mode (a function), and OUT / INOUT as given', async () => {
    const detail = await routine(`${DEF}RETURN 1`, {}, [
      [null, 'a', 'int'],
      ['OUT', 'b', 'int'],
      ['INOUT', 'c', 'int'],
    ])
    expect(detail?.params.map((p) => p.mode)).toEqual(['IN', 'OUT', 'INOUT'])
  })

  it('leaves out what the catalog does not say: no definer, no comment, an unknown security or access', async () => {
    const detail = await routine(`${DEF}RETURN 1`, { 4: '', 5: 'broken', 3: 'WHATEVER', 2: 'SOMETHING ELSE', 1: 'NO' })
    expect(detail).not.toHaveProperty('comment')
    expect(detail).not.toHaveProperty('definer')
    expect(detail).not.toHaveProperty('sqlSecurity')
    expect(detail).not.toHaveProperty('dataAccess')
    expect(detail?.deterministic).toBe(false)
  })

  it('takes the host from after the last @ of a definer, and no definer from one that is not user@host', async () => {
    expect((await routine(`${DEF}RETURN 1`, { 5: 'ro@ot@localhost' }))?.definer).toEqual({
      user: 'ro@ot',
      host: 'localhost',
    })
    for (const odd of ['nohost', '@localhost', 'user@']) {
      expect(await routine(`${DEF}RETURN 1`, { 5: odd }), odd).not.toHaveProperty('definer')
    }
  })

  it('is null when the account may not read the definition, or when there is no body to take', async () => {
    expect(await routine(fail('PERMISSION_DENIED', 'ER_SPECIFIC_ACCESS_DENIED_ERROR'))).toBeNull()
    expect(await routine(null)).toBeNull()
    expect(await routine(`${DEF}`)).toBeNull()
  })

  it('is null for a kind that is not a routine, without asking the server', async () => {
    const { conn, asked } = scripted([])
    expect(await mysqlRoutineDetail(conn, NS, 'x', 'package' as never)).toBeNull()
    expect(asked).toEqual([])
  })

  it('says not found when there is no such routine', async () => {
    const { conn } = scripted([[/information_schema\.ROUTINES/, rows([])]])
    await expect(mysqlRoutineDetail(conn, NS, 'gone', 'function')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

const trigger = (statement: string | null, row: unknown[] = ['BEFORE', 'INSERT', 'root@localhost']) =>
  mysqlTriggerDetail(
    scripted([
      [/information_schema\.TRIGGERS/, rows([row])],
      [SHOW_TRIGGER, rows(statement === null ? [] : [['tg', '', statement]])],
    ]).conn,
    NS,
    't',
    'tg'
  )
const TRG = 'CREATE DEFINER=`root`@`localhost` TRIGGER `tg` BEFORE INSERT ON `t` FOR EACH ROW '

describe('mysqlTriggerDetail', () => {
  it('cuts the body after FOR EACH ROW', async () => {
    expect(await trigger(`${TRG}SET NEW.n = 1`)).toEqual({
      name: 'tg',
      table: 't',
      timing: 'BEFORE',
      event: 'INSERT',
      body: 'SET NEW.n = 1',
      definer: { user: 'root', host: 'localhost' },
    })
  })

  it('skips the FOLLOWS / PRECEDES clause of a trigger that is ordered among others', async () => {
    const detail = await trigger(`${TRG.trim()}\n    FOLLOWS \`other\` SET NEW.n = 2`)
    expect(detail?.body).toBe('SET NEW.n = 2')
  })

  it('does not take FOR EACH ROW from inside a string or a backticked name', async () => {
    const statement = "CREATE TRIGGER `a FOR EACH ROW b` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.s = 'FOR EACH ROW x'"
    expect((await trigger(statement))?.body).toBe("SET NEW.s = 'FOR EACH ROW x'")
  })

  it('reads past an escaped quote and a doubled quote before the keyword', async () => {
    const statement = "CREATE TRIGGER `tg` BEFORE INSERT ON `t` COMMENT 'it\\'s ''x''' FOR EACH ROW SET NEW.n = 1"
    expect((await trigger(statement))?.body).toBe('SET NEW.n = 1')
  })

  it('is null when there is no FOR EACH ROW to cut after, or nothing after it', async () => {
    expect(await trigger('CREATE TRIGGER tg BEFORE INSERT ON t SET NEW.n = 1')).toBeNull()
    expect(await trigger(`${TRG}   `)).toBeNull()
  })

  it.each([
    ['a timing the form has no choice for', ['INSTEAD OF', 'INSERT', null]],
    ['an event the form has no choice for', ['AFTER', 'TRUNCATE', null]],
  ])('is null for %s', async (_name, row) => {
    expect(await trigger(`${TRG}SET NEW.n = 1`, row)).toBeNull()
  })

  it('is null when the account may not read the statement, and says not found for a missing trigger', async () => {
    expect(await trigger(null)).toBeNull()
    const { conn } = scripted([[/information_schema\.TRIGGERS/, rows([])]])
    await expect(mysqlTriggerDetail(conn, NS, 't', 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

/** information_schema.EVENTS: type, execute at, interval value, interval field, starts, ends, status, on completion, comment, definer */
const eventRow = (over: Partial<Record<number, unknown>> = {}) => {
  const row: unknown[] = [
    'RECURRING',
    null,
    '1',
    'DAY',
    '2024-01-02 03:04:05',
    null,
    'ENABLED',
    'NOT PRESERVE',
    'purges',
    'root@localhost',
  ]
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v
  return row
}
const event = (
  over?: Partial<Record<number, unknown>>,
  statement: string | null = 'CREATE EVENT `e` ON SCHEDULE EVERY 1 DAY DO DELETE FROM t'
) =>
  mysqlEventDetail(
    scripted([
      [/information_schema\.EVENTS/, rows([eventRow(over)])],
      [SHOW_EVENT, rows(statement === null ? [] : [['e', '', 'UTC', statement]])],
    ]).conn,
    NS,
    'e'
  )

describe('mysqlEventDetail', () => {
  it('reads a recurring event: the interval, when it starts, its state and where the body begins (after DO)', async () => {
    expect(await event()).toEqual({
      name: 'e',
      schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2024-01-02 03:04:05' },
      body: 'DELETE FROM t',
      enabled: true,
      comment: 'purges',
      preserve: false,
      definer: { user: 'root', host: 'localhost' },
    })
  })

  it('reads a one-time event, a disabled one that is kept after it ran, and an end time', async () => {
    const once = await event({
      0: 'ONE TIME',
      1: '2030-05-06 07:08:09',
      6: 'DISABLED',
      7: 'PRESERVE',
      5: '2031-01-01 00:00:00',
    })
    expect(once).toMatchObject({ schedule: { kind: 'at', at: '2030-05-06 07:08:09' }, enabled: false, preserve: true })
    const bounded = await event({ 5: '2031-01-01 00:00:00' })
    expect(bounded?.schedule).toMatchObject({ kind: 'every', ends: '2031-01-01 00:00:00' })
  })

  it('does not take DO from inside a string', async () => {
    const statement = "CREATE EVENT `e` ON SCHEDULE EVERY 1 DAY COMMENT ' DO not ' DO UPDATE t SET s = ' DO '"
    expect((await event({}, statement))?.body).toBe("UPDATE t SET s = ' DO '")
  })

  it.each([
    ['an interval unit the form has no choice for', { 3: 'DAY_HOUR' }],
    ['an interval that is not a whole number of at least 1', { 2: '0' }],
    ['an interval that is not a number', { 2: 'x' }],
    ['a one-time event without a usable time', { 0: 'ONE TIME', 1: 'not a time' }],
  ])('is null for %s', async (_name, over) => {
    expect(await event(over)).toBeNull()
  })

  it('leaves out a start time that is not a plain timestamp', async () => {
    const detail = await event({ 4: '0000-00-00' })
    expect(detail?.schedule).not.toHaveProperty('starts')
  })

  it('is null when the account may not read the statement or the statement has no DO', async () => {
    expect(await event({}, null)).toBeNull()
    expect(await event({}, 'CREATE EVENT e ON SCHEDULE EVERY 1 DAY')).toBeNull()
  })

  it('says not found for a missing event', async () => {
    const { conn } = scripted([[/information_schema\.EVENTS/, rows([])]])
    await expect(mysqlEventDetail(conn, NS, 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
