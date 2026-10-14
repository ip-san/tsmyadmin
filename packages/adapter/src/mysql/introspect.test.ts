import type { Namespace } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { rejectsWith } from '../test/ddl-helpers.ts'
import { fail, rows, scripted } from '../test/scripted-conn.ts'
import {
  mysqlDatabaseGrants,
  mysqlDescribeTable,
  mysqlListForeignKeys,
  mysqlListPartitions,
  mysqlListTables,
  mysqlTableStats,
} from './introspect.ts'

/**
 * What the MySQL and MariaDB readers make of the rows information_schema returns: kinds, defaults in each server's
 * own form, keys and sizes. A real server answers one way; these answer every way (found by mutation testing the
 * readers with the integration tests on).
 */

const ns: Namespace = { database: 'db' }
/** The bytes of UTF-8 text read as latin1, the way MySQL hands an expression default back. */
const mojibake = (text: string) => [...Buffer.from(text, 'utf8')].map((b) => String.fromCharCode(b)).join('')

describe('mysqlListTables', () => {
  const script = (data: unknown[][], schemaExists = true) =>
    scripted([
      [/FROM information_schema\.TABLES WHERE TABLE_SCHEMA = \? ORDER BY TABLE_NAME/, rows(data)],
      [/FROM information_schema\.SCHEMATA/, rows(schemaExists ? [[1]] : [])],
    ])
  const row = (extra: unknown[] = []) =>
    ['t', 'BASE TABLE', 10, 'InnoDB', '', 16384, 'utf8mb4_bin', '2030-01-01', '2030-01-02'].map((v, i) =>
      extra[i] === undefined ? v : extra[i]
    )

  it('reads each table with its engine, estimate, size, collation and times, the comment empty as none', async () => {
    const { conn, asked } = script([row()])
    expect(await mysqlListTables(conn, ns)).toEqual([
      {
        name: 't',
        kind: 'table',
        rowEstimate: 10,
        engine: 'InnoDB',
        comment: null,
        sizeBytes: 16384,
        collation: 'utf8mb4_bin',
        createdAt: '2030-01-01',
        updatedAt: '2030-01-02',
        inherits: [],
      },
    ])
    expect(asked[0]?.params).toEqual(['db'])
    expect(
      (
        await mysqlListTables(script([row(['t', 'BASE TABLE', null, null, 'about', null, null, null, null])]).conn, ns)
      )[0]
    ).toMatchObject({
      rowEstimate: null,
      engine: null,
      comment: 'about',
      sizeBytes: null,
      collation: null,
      createdAt: null,
    })
  })

  it('reads the kind from the type: a view or a system view, a sequence, any other a table', async () => {
    const kinds = ['BASE TABLE', 'VIEW', 'SYSTEM VIEW', 'SEQUENCE', 'SYSTEM VERSIONED', 'TEMPORARY']
    const tables = await mysqlListTables(script(kinds.map((k, i) => row([`t${i}`, k]))).conn, ns)
    expect(tables.map((t) => t.kind)).toEqual(['table', 'view', 'view', 'sequence', 'table', 'table'])
  })

  it('has no size for a view, and no estimate for a number that is not one', async () => {
    const [view, table, odd] = await mysqlListTables(
      script([
        row(['v', 'VIEW', 5, null, '', 999]),
        row(['a', 'BASE TABLE', '7', 'InnoDB', '', '2048']),
        row(['b', 'BASE TABLE', 'x', 'InnoDB', '', 'y']),
      ]).conn,
      ns
    )
    expect(view).toMatchObject({ sizeBytes: null, rowEstimate: 5 })
    expect(table).toMatchObject({ sizeBytes: 2048, rowEstimate: 7 })
    expect(odd).toMatchObject({ sizeBytes: null, rowEstimate: null })
  })

  it('tells a database that is gone from one with nothing in it', async () => {
    expect(await mysqlListTables(script([], true).conn, ns)).toEqual([])
    await rejectsWith(mysqlListTables(script([], false).conn, ns), 'NOT_FOUND', /Database not found: db/)
  })
})

describe('mysqlListForeignKeys', () => {
  it('joins the rows of one key into its columns, keys of the same name in different tables staying apart', async () => {
    const { conn, asked } = scripted([
      [
        /k\.TABLE_SCHEMA = \? AND k\.REFERENCED_TABLE_NAME IS NOT NULL/,
        rows([
          ['fk', 'a', 'other', 'p', 'x', 'CASCADE', 'SET NULL', 't1'],
          ['fk', 'b', 'other', 'p', 'y', 'CASCADE', 'SET NULL', 't1'],
          ['fk', 'a', 'other', 'q', 'z', 'RESTRICT', 'NO ACTION', 't2'],
        ]),
      ],
    ])
    expect(await mysqlListForeignKeys(conn, ns)).toEqual([
      {
        table: 't1',
        name: 'fk',
        columns: ['a', 'b'],
        refNamespace: { database: 'other' },
        refTable: 'p',
        refColumns: ['x', 'y'],
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      {
        table: 't2',
        name: 'fk',
        columns: ['a'],
        refNamespace: { database: 'other' },
        refTable: 'q',
        refColumns: ['z'],
        onUpdate: 'RESTRICT',
        onDelete: 'NO ACTION',
      },
    ])
    expect(asked[0]?.params).toEqual(['db'])
    expect(
      await mysqlListForeignKeys(
        scripted([[/REFERENCED_TABLE_NAME IS NOT NULL/, rows([['fk', 'a', 'o', 'p', 'x', null, null, 't']])]]).conn,
        ns
      )
    ).toMatchObject([{ onUpdate: null, onDelete: null }])
  })
})

describe('mysqlDescribeTable', () => {
  type Over = Partial<Record<'info' | 'cols' | 'checks' | 'idx' | 'fk' | 'refs', unknown[][]>>
  const script = (over: Over = {}) =>
    scripted([
      [
        /SELECT TABLE_TYPE, ENGINE, TABLE_COMMENT/,
        rows(over.info ?? [['BASE TABLE', 'InnoDB', '', 12, 'utf8mb4_bin', 5]]),
      ],
      [/FROM information_schema\.COLUMNS/, rows(over.cols ?? [])],
      [/CHECK_CONSTRAINTS/, rows(over.checks ?? [])],
      [/information_schema\.STATISTICS/, rows(over.idx ?? [])],
      [/k\.TABLE_NAME = \?/, rows(over.fk ?? [])],
      [/WHERE REFERENCED_TABLE_SCHEMA = \?/, rows(over.refs ?? [])],
    ])
  const describe1 = async (over: Over = {}, mariadb = false) => {
    const s = script(over)
    return { table: await mysqlDescribeTable(s.conn, ns, 't', mariadb), asked: s.asked }
  }
  const col = (extra: unknown[] = []) =>
    ['c', 'int', 'YES', null, '', '', null, '', null].map((v, i) => (extra[i] === undefined ? v : extra[i]))
  const first = async (data: unknown[], mariadb = false) =>
    (await describe1({ cols: [col(data)] }, mariadb)).table.columns[0]
  const U = undefined

  it('refuses a table that is not there, naming it with its database', async () => {
    await rejectsWith(mysqlDescribeTable(script({ info: [] }).conn, ns, 't'), 'NOT_FOUND', /Table not found: db\.t/)
  })

  it('reads the relation: kind, engine, comment, estimate, collation and the next AUTO_INCREMENT as text', async () => {
    const { table, asked } = await describe1({ info: [['VIEW', null, 'about', 3, 'latin1_bin', 0]] })
    expect(table).toMatchObject({
      name: 't',
      kind: 'view',
      engine: null,
      comment: 'about',
      rowEstimate: 3,
      collation: 'latin1_bin',
      autoIncrement: '0',
      partitioned: false,
      hasChildren: false,
      inherits: [],
    })
    expect(asked[0]?.params).toEqual(['db', 't'])
    expect((await describe1({ info: [['BASE TABLE', 'InnoDB', '', 'x', null, null]] })).table).toMatchObject({
      comment: null,
      rowEstimate: null,
      collation: null,
      autoIncrement: null,
    })
    expect((await describe1({ info: [['BASE TABLE', 'InnoDB', '', 1, null, 12345]] })).table.autoIncrement).toBe(
      '12345'
    )
  })

  it('reads a column: type, nullability, comment (empty as none), collation and its place in the order', async () => {
    const { table } = await describe1({
      cols: [col(['a', 'varchar(5)', 'NO', 'x', '', 'note', 'utf8mb4_bin']), col(['b', 'int', 'YES', null, '', ''])],
    })
    expect(table.columns[0]).toMatchObject({
      name: 'a',
      dataType: 'varchar(5)',
      nullable: false,
      default: 'x',
      defaultIsExpression: false,
      comment: 'note',
      collation: 'utf8mb4_bin',
      check: null,
      generated: null,
    })
    expect(table.columns[1]).toMatchObject({ name: 'b', nullable: true, comment: null, collation: null, default: null })
  })

  describe("a default in MySQL's form", () => {
    it('is a literal as it stands, and an expression when the column is flagged DEFAULT_GENERATED, unescaped', async () => {
      expect(await first([U, U, U, 'abc'])).toMatchObject({ default: 'abc', defaultIsExpression: false })
      expect(await first([U, U, U, "_utf8mb4\\'x\\'", 'DEFAULT_GENERATED'])).toMatchObject({
        default: "_utf8mb4'x'",
        defaultIsExpression: true,
      })
      expect(await first([U, U, U, 'a\\\\b', 'default_generated'])).toMatchObject({
        default: 'a\\b',
        defaultIsExpression: true,
      })
      expect(await first([U, U, U, 'a\\nb', 'DEFAULT_GENERATED'])).toMatchObject({ default: 'a\\nb' })
      expect(await first([U, U, U, 'now()', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'])).toMatchObject({
        default: 'now()',
        defaultIsExpression: true,
      })
    })

    it('puts back the UTF-8 bytes that came back as latin1, and leaves a real latin1 text and a wider text alone', async () => {
      const damaged = `concat(_utf8mb4'${mojibake('日本')}')`
      expect(await first([U, U, U, damaged, 'DEFAULT_GENERATED'])).toMatchObject({ default: "concat(_utf8mb4'日本')" })
      expect(await first([U, U, U, 'concat(café)', 'DEFAULT_GENERATED'])).toMatchObject({ default: 'concat(café)' })
      expect(await first([U, U, U, "concat('日本')", 'DEFAULT_GENERATED'])).toMatchObject({ default: "concat('日本')" })
      expect(await first([U, U, U, 'plain ascii', 'DEFAULT_GENERATED'])).toMatchObject({ default: 'plain ascii' })
    })

    it('is an expression for a binary or bit column, whatever the text, and a literal for a text column that looks the same', async () => {
      for (const type of ['binary(4)', 'varbinary(8)', 'BINARY(1)', 'bit(1)', 'BIT(8)']) {
        expect(await first([U, type, U, '0xFF']), type).toMatchObject({ default: '0xFF', defaultIsExpression: true })
      }
      for (const type of ['varchar(8)', 'int', 'binaryx', 'xbit(1)'])
        expect(await first([U, type, U, '0xFF']), type).toMatchObject({ defaultIsExpression: false })
    })
  })

  describe("a default in MariaDB's form", () => {
    it('is NULL for none, a quoted literal unquoted, and anything else an expression as printed', async () => {
      expect(await first([U, U, U, 'NULL'], true)).toMatchObject({ default: null, defaultIsExpression: false })
      expect(await first([U, U, U, "'abc'"], true)).toMatchObject({ default: 'abc', defaultIsExpression: false })
      expect(await first([U, U, U, "''"], true)).toMatchObject({ default: '', defaultIsExpression: false })
      expect(await first([U, U, U, 'current_timestamp()'], true)).toMatchObject({
        default: 'current_timestamp()',
        defaultIsExpression: true,
      })
      expect(await first([U, U, U, "'"], true)).toMatchObject({ default: "'", defaultIsExpression: true })
      expect(await first([U, U, U, "'abc"], true)).toMatchObject({ default: "'abc", defaultIsExpression: true })
      expect(await first([U, U, U, null], true)).toMatchObject({ default: null, defaultIsExpression: false })
    })

    it('undoes the five escapes inside a quoted default in one pass, so a backslash and an n stay two characters', async () => {
      expect((await first([U, U, U, "'it''s'"], true))?.default).toBe("it's")
      expect((await first([U, U, U, "'a\\nb'"], true))?.default).toBe('a\nb')
      expect((await first([U, U, U, "'a\\rb'"], true))?.default).toBe('a\rb')
      expect((await first([U, U, U, "'a\\0b'"], true))?.default).toBe('a\0b')
      expect((await first([U, U, U, "'a\\\\b'"], true))?.default).toBe('a\\b')
      expect((await first([U, U, U, "'a\\\\nb'"], true))?.default).toBe('a\\nb')
      expect((await first([U, U, U, "'a\\'"], true))?.default).toBe('a\\')
      expect((await first([U, U, U, "'a\\zb'"], true))?.default).toBe('azb')
    })

    it('carries the column-level CHECK of the column, from a second query made for MariaDB only', async () => {
      const s = script({ cols: [col(['a']), col(['b'])], checks: [['a', 'a > 0']] })
      const table = await mysqlDescribeTable(s.conn, ns, 't', true)
      expect(table.columns.map((c) => c.check)).toEqual(['a > 0', null])
      expect(s.asked.some((q) => /CHECK_CONSTRAINTS/.test(q.text))).toBe(true)
      const m = script({ cols: [col(['a'])], checks: [['a', 'a > 0']] })
      expect((await mysqlDescribeTable(m.conn, ns, 't', false)).columns[0]?.check).toBeNull()
      expect(m.asked.some((q) => /CHECK_CONSTRAINTS/.test(q.text))).toBe(false)
    })
  })

  describe('a generated column', () => {
    it('has its expression, stored or virtual, unescaped on MySQL and as printed on MariaDB', async () => {
      expect(await first([U, U, U, null, 'VIRTUAL GENERATED', U, U, U, 'a + 1'])).toMatchObject({
        generated: { expression: 'a + 1', stored: false },
      })
      expect(await first([U, U, U, null, 'STORED GENERATED', U, U, U, 'a + 1'])).toMatchObject({
        generated: { expression: 'a + 1', stored: true },
      })
      expect(await first([U, U, U, null, 'PERSISTENT GENERATED', U, U, U, 'a'], true)).toMatchObject({
        generated: { stored: true },
      })
      expect(await first([U, U, U, null, 'stored generated', U, U, U, "concat(\\'x\\')"])).toMatchObject({
        generated: { expression: "concat('x')" },
      })
      expect(await first([U, U, U, null, 'STORED GENERATED', U, U, U, "concat(\\'x\\')"], true)).toMatchObject({
        generated: { expression: "concat(\\'x\\')" },
      })
    })

    it('is none for an ordinary column, a DEFAULT_GENERATED one, or one with no expression', async () => {
      expect((await first([U, U, U, null, '', U, U, U, 'a']))?.generated).toBeNull()
      expect((await first([U, U, U, null, 'DEFAULT_GENERATED', U, U, U, 'a']))?.generated).toBeNull()
      expect((await first([U, U, U, null, 'STORED GENERATED', U, U, U, null]))?.generated).toBeNull()
      expect((await first([U, U, U, null, 'STORED GENERATED', U, U, U, '']))?.generated).toBeNull()
      expect((await first([U, U, U, null, 'auto_increment', U, U, U, 'a']))?.generated).toBeNull()
    })
  })

  describe('indexes', () => {
    const idx = (
      name: string,
      nonUnique: number,
      seq: number,
      column: string | null,
      type = 'BTREE',
      sub: number | null = null,
      expression: string | null = null
    ) => [name, nonUnique, seq, column, type, sub, expression]

    it('joins the rows of an index into its columns, the primary key first and the rest by name', async () => {
      const { table } = await describe1({
        idx: [
          idx('z_idx', 1, 1, 'c'),
          idx('PRIMARY', 0, 1, 'a'),
          idx('PRIMARY', 0, 2, 'b'),
          idx('a_idx', 0, 1, 'd', 'HASH'),
          idx('a_idx', 0, 2, 'e', 'HASH'),
        ],
      })
      expect(table.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'a_idx', 'z_idx'])
      expect(table.indexes[0]).toEqual({
        name: 'PRIMARY',
        unique: true,
        primary: true,
        columns: ['a', 'b'],
        type: 'BTREE',
        predicate: null,
        definition: null,
        lengths: {},
      })
      expect(table.indexes[1]).toMatchObject({ unique: true, primary: false, columns: ['d', 'e'], type: 'HASH' })
      expect(table.indexes[2]).toMatchObject({ unique: false, columns: ['c'] })
      expect(table.primaryKey).toEqual(['a', 'b'])
      expect((await describe1({ idx: [idx('i', 1, 1, 'c')] })).table.primaryKey).toEqual([])
    })

    it('keeps the prefix length of a column indexed by its first characters, and writes a functional part in parentheses', async () => {
      const { table } = await describe1({
        idx: [
          idx('i', 1, 1, 'name', 'BTREE', 10),
          idx('i', 1, 2, 'other'),
          idx('f', 1, 1, null, 'BTREE', null, 'lower(`n`)'),
        ],
      })
      expect(table.indexes.find((i) => i.name === 'i')).toMatchObject({
        columns: ['name', 'other'],
        lengths: { name: 10 },
      })
      expect(table.indexes.find((i) => i.name === 'f')).toMatchObject({ columns: ['(lower(`n`))'], lengths: {} })
    })

    it('asks again without the expression column when the server has none, and remembers it for the connection', async () => {
      const s = scripted([
        [/SUB_PART, EXPRESSION FROM/, fail('QUERY_FAILED', 'ER_BAD_FIELD_ERROR')],
        [/information_schema\.STATISTICS/, rows([])],
        [/SELECT TABLE_TYPE, ENGINE/, rows([['BASE TABLE', 'InnoDB', '', 1, null, null]])],
        [/FROM information_schema\.COLUMNS/, rows([])],
        [/k\.TABLE_NAME = \?/, rows([])],
        [/WHERE REFERENCED_TABLE_SCHEMA/, rows([])],
      ])
      await mysqlDescribeTable(s.conn, ns, 't')
      const first = s.asked.filter((q) => /STATISTICS/.test(q.text))
      expect(first).toHaveLength(2)
      expect(first[1]?.text).toContain('NULL AS EXPRESSION')
      await mysqlDescribeTable(s.conn, ns, 't')
      expect(s.asked.filter((q) => /STATISTICS/.test(q.text))).toHaveLength(3)
    })
  })

  describe('keys', () => {
    it('reads the foreign keys without their table, and the keys that point at the table', async () => {
      const { table } = await describe1({
        fk: [
          ['fk', 'a', 'other', 'p', 'x', 'CASCADE', 'RESTRICT', 't'],
          ['fk', 'b', 'other', 'p', 'y', 'CASCADE', 'RESTRICT', 't'],
        ],
        refs: [
          ['rk', 'src', 's', 'a', 'id'],
          ['rk', 'src', 's', 'b', 'id2'],
          ['rk', 'src2', 's', 'a', 'id'],
        ],
      })
      expect(table.foreignKeys).toEqual([
        {
          name: 'fk',
          columns: ['a', 'b'],
          refNamespace: { database: 'other' },
          refTable: 'p',
          refColumns: ['x', 'y'],
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        },
      ])
      expect(table.foreignKeys[0]).not.toHaveProperty('table')
      expect(table.referencedBy).toEqual([
        {
          name: 'rk',
          fromNamespace: { database: 'src' },
          fromTable: 's',
          fromColumns: ['a', 'b'],
          columns: ['id', 'id2'],
        },
        { name: 'rk', fromNamespace: { database: 'src2' }, fromTable: 's', fromColumns: ['a'], columns: ['id'] },
      ])
    })
  })
})

/** A cell the row leaves at its default. */
const U_ = undefined

describe('mysqlTableStats', () => {
  const stats = async (data: unknown[][]) =>
    await mysqlTableStats(scripted([[/SELECT TABLE_TYPE, DATA_LENGTH/, rows(data)]]).conn, ns, 't')
  const stat = (extra: unknown[] = []) =>
    ['BASE TABLE', 8192, 4096, 1024, 10, 819, 'Dynamic', '2030-01-01', '2030-01-02', '2030-01-03'].map((v, i) =>
      extra[i] === undefined ? v : extra[i]
    )

  it('refuses a table that is not there', async () => {
    await rejectsWith(stats([]), 'NOT_FOUND', /Table not found: db\.t/)
  })

  it('reads the sizes and the total as their sum, the row figures, format and times', async () => {
    expect(await stats([stat()])).toEqual({
      dataBytes: 8192,
      indexBytes: 4096,
      freeBytes: 1024,
      toastBytes: null,
      totalBytes: 12288,
      rowEstimate: 10,
      avgRowBytes: 819,
      rowFormat: 'Dynamic',
      createdAt: '2030-01-01',
      updatedAt: '2030-01-02',
      checkedAt: '2030-01-03',
      deadRows: null,
      lastVacuum: null,
      lastAnalyze: null,
    })
  })

  it('has no total unless both sizes are known, and nothing at all of a view', async () => {
    expect((await stats([stat([U_, null])])).totalBytes).toBeNull()
    expect((await stats([stat([U_, U_, null])])).totalBytes).toBeNull()
    expect((await stats([stat([U_, 0, 0])])).totalBytes).toBe(0)
    expect(await stats([stat(['VIEW'])])).toMatchObject({
      dataBytes: null,
      indexBytes: null,
      freeBytes: null,
      totalBytes: null,
      rowEstimate: null,
      avgRowBytes: null,
    })
    expect(await stats([stat(['SYSTEM VIEW'])])).toMatchObject({ dataBytes: null })
    expect(await stats([stat([U_, U_, U_, U_, null, null, null, null, null, null])])).toMatchObject({
      rowEstimate: null,
      avgRowBytes: null,
      rowFormat: null,
      createdAt: null,
      updatedAt: null,
      checkedAt: null,
    })
  })
})

describe('mysqlListPartitions', () => {
  const part = async (data: unknown[][]) => {
    const s = scripted([[/information_schema\.PARTITIONS/, rows(data)]])
    return { result: await mysqlListPartitions(s.conn, ns, 't'), asked: s.asked }
  }

  it('refuses a table that is not there, and has no partitions for one that is not partitioned', async () => {
    await rejectsWith(
      part([]).then((r) => r.result),
      'NOT_FOUND',
      /Table not found: db\.t/
    )
    expect((await part([[null, null, null, null, 5, 100]])).result).toEqual({
      method: null,
      expression: null,
      partitions: [],
    })
    expect((await part([[null, null, null, null, 5, 100]])).asked[0]?.params).toEqual(['db', 't'])
  })

  it('reads the base method of each way of partitioning, and the key', async () => {
    const methods: [string, string][] = [
      ['RANGE', 'range'],
      ['RANGE COLUMNS', 'range'],
      ['range', 'range'],
      ['LIST', 'list'],
      ['LIST COLUMNS', 'list'],
      ['KEY', 'key'],
      ['LINEAR KEY', 'key'],
      ['HASH', 'hash'],
      ['LINEAR HASH', 'hash'],
    ]
    for (const [method, base] of methods) {
      expect((await part([['p0', method, 'id', '10', 1, 2]])).result, method).toMatchObject({
        method: base,
        expression: 'id',
      })
    }
    expect((await part([['p0', 'HASH', null, null, 1, 2]])).result.expression).toBeNull()
  })

  it('reads each partition with its bound for the method, its estimate and its size', async () => {
    const { result } = await part([
      ['p0', 'RANGE', 'id', '10', 5, 100],
      ['p1', 'RANGE', 'id', 'MAXVALUE', null, null],
    ])
    expect(result.partitions).toEqual([
      { name: 'p0', bound: 'VALUES LESS THAN (10)', rowEstimate: 5, sizeBytes: 100 },
      { name: 'p1', bound: 'VALUES LESS THAN MAXVALUE', rowEstimate: null, sizeBytes: null },
    ])
    expect((await part([['l0', 'LIST', 'c', '1,2', 0, 0]])).result.partitions[0]).toMatchObject({
      bound: 'VALUES IN (1,2)',
      rowEstimate: 0,
      sizeBytes: 0,
    })
    expect((await part([['h0', 'HASH', 'c', null, 1, 1]])).result.partitions[0]?.bound).toBe('')
  })
})

describe('mysqlDatabaseGrants', () => {
  const grants = async (data: unknown[][]) => {
    const s = scripted([[/SCHEMA_PRIVILEGES/, rows(data)]])
    return { result: await mysqlDatabaseGrants(s.conn, 'db'), asked: s.asked }
  }

  it('groups the privileges of each account, which can pass them on when any row says so', async () => {
    const { result, asked } = await grants([
      ["'u'@'h'", 'INSERT', 'NO'],
      ["'u'@'h'", 'SELECT', 'YES'],
      ["'v'@'%'", 'SELECT', 'NO'],
    ])
    expect(result).toEqual([
      { user: 'u', host: 'h', privileges: ['INSERT', 'SELECT'], grantable: true },
      { user: 'v', host: '%', privileges: ['SELECT'], grantable: false },
    ])
    expect(asked[0]?.params).toEqual(['db'])
  })

  it('undoes the doubled quotes of a name and skips a grantee it cannot read', async () => {
    const { result } = await grants([
      ["'o''x'@'a''b'", 'SELECT', 'NO'],
      ['not a grantee', 'SELECT', 'NO'],
      ['u@h', 'SELECT', 'NO'],
      ["'u'@'h'x", 'SELECT', 'NO'],
    ])
    expect(result).toEqual([{ user: "o'x", host: "a'b", privileges: ['SELECT'], grantable: false }])
    expect((await grants([])).result).toEqual([])
  })
})

describe('the questions the MySQL readers ask, and the rows that come back short', () => {
  it('asks every query of a table about its database and name', async () => {
    const s = scripted([
      [/SELECT TABLE_TYPE, ENGINE, TABLE_COMMENT/, rows([['BASE TABLE', 'InnoDB', '', 1, null, null]])],
      [/FROM information_schema\.COLUMNS/, rows([])],
      [/CHECK_CONSTRAINTS/, rows([])],
      [/information_schema\.STATISTICS/, rows([])],
      [/k\.TABLE_NAME = \?/, rows([])],
      [/WHERE REFERENCED_TABLE_SCHEMA = \?/, rows([])],
    ])
    await mysqlDescribeTable(s.conn, ns, 't', true)
    expect(s.asked).toHaveLength(6)
    for (const q of s.asked) expect(q.params, q.text.slice(0, 40)).toEqual(['db', 't'])
  })

  it('asks whether the database exists only when it listed no tables', async () => {
    const s = scripted([
      [
        /FROM information_schema\.TABLES WHERE TABLE_SCHEMA = \? ORDER BY TABLE_NAME/,
        rows([['t', 'BASE TABLE', 1, 'InnoDB', '', 1, null, null, null]]),
      ],
    ])
    await mysqlListTables(s.conn, ns)
    expect(s.asked).toHaveLength(1)
    const empty = scripted([
      [/ORDER BY TABLE_NAME/, rows([])],
      [/SCHEMATA/, rows([[1]])],
    ])
    await mysqlListTables(empty.conn, ns)
    expect(empty.asked[1]?.params).toEqual(['db'])
  })

  it('does not take any other failure of the index query for a missing expression column', async () => {
    const s = scripted([
      [/information_schema\.STATISTICS/, fail('QUERY_FAILED', 'ER_ACCESS_DENIED')],
      [/SELECT TABLE_TYPE, ENGINE/, rows([['BASE TABLE', 'InnoDB', '', 1, null, null]])],
      [/FROM information_schema\.COLUMNS/, rows([])],
    ])
    await expect(mysqlDescribeTable(s.conn, ns, 't')).rejects.toMatchObject({ nativeCode: 'ER_ACCESS_DENIED' })
    expect(s.asked.filter((q) => /STATISTICS/.test(q.text))).toHaveLength(1)
    const plain = scripted([
      [/information_schema\.STATISTICS/, new Error('boom')],
      [/SELECT TABLE_TYPE, ENGINE/, rows([['BASE TABLE', 'InnoDB', '', 1, null, null]])],
      [/FROM information_schema\.COLUMNS/, rows([])],
    ])
    await expect(mysqlDescribeTable(plain.conn, ns, 't')).rejects.toThrow('boom')
  })

  it('reads a MariaDB default that only ends in a quote as an expression', async () => {
    const s = scripted([
      [/SELECT TABLE_TYPE, ENGINE/, rows([['BASE TABLE', 'InnoDB', '', 1, null, undefined]])],
      [/FROM information_schema\.COLUMNS/, rows([['c', 'int', 'YES', "abc'", '', '', null, '', null]])],
      [/CHECK_CONSTRAINTS/, rows([])],
      [/information_schema\.STATISTICS/, rows([])],
      [/k\.TABLE_NAME = \?/, rows([])],
      [/WHERE REFERENCED_TABLE_SCHEMA/, rows([])],
    ])
    const table = await mysqlDescribeTable(s.conn, ns, 't', true)
    expect(table.columns[0]).toMatchObject({ default: "abc'", defaultIsExpression: true })
    expect(table.autoIncrement).toBeNull()
  })

  it('takes only a grantee written from its first quote to its last', async () => {
    const s = scripted([
      [
        /SCHEMA_PRIVILEGES/,
        rows([
          ["junk'u'@'h'", 'SELECT', 'NO'],
          ["'u'@'h'", 'SELECT', 'NO'],
        ]),
      ],
    ])
    expect(await mysqlDatabaseGrants(s.conn, 'db')).toEqual([
      { user: 'u', host: 'h', privileges: ['SELECT'], grantable: false },
    ])
  })
})
