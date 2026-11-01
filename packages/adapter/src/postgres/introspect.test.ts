import type { Namespace } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { rejectsWith } from '../test/ddl-helpers.ts'
import { rows, scripted } from '../test/scripted-conn.ts'
import {
  pgDescribeTable,
  pgListForeignKeys,
  pgListPartitions,
  pgListSchemas,
  pgListTables,
  pgTableStats,
} from './introspect.ts'

/**
 * What the PostgreSQL readers make of the rows the catalog returns: kinds, estimates, keys, columns and sizes. The
 * conformance suite runs the queries against a real server, which answers one way; these answer every way (found by
 * mutation testing the readers with the integration tests on).
 */

const SEP = String.fromCharCode(31)
const ns: Namespace = { database: 'db', schema: 'app' }

describe('pgListSchemas', () => {
  it('lists the names the catalog gives, in its order', async () => {
    const { conn } = scripted([[/FROM pg_namespace\s+WHERE nspname NOT IN/, rows([['a'], ['b']])]])
    expect(await pgListSchemas(conn)).toEqual(['a', 'b'])
  })
})

describe('pgListTables', () => {
  const list = async (data: unknown[][], space = ns) => {
    const { conn, asked } = scripted([[/SELECT c\.relname, c\.relkind,/, rows(data)]])
    return { tables: await pgListTables(conn, space), asked }
  }
  const row = (extra: unknown[] = []) =>
    ['t', 'r', 10, null, 8192, null, null, null].map((v, i) => (extra[i] === undefined ? v : extra[i]))

  it('asks about the schema, the public one when none is named, and the separator for the parents', async () => {
    expect((await list([], ns)).asked[0]?.params).toEqual(['app', SEP])
    expect((await list([], { database: 'db' })).asked[0]?.params).toEqual(['public', SEP])
  })

  it('reads the kind of each relation: a table, partitioned table or foreign table is a table', async () => {
    const kinds = ['r', 'p', 'f', 'v', 'm', 'S', 'x']
    const { tables } = await list(kinds.map((k) => row([`t_${k}`, k])))
    expect(tables.map((t) => t.kind)).toEqual([
      'table',
      'table',
      'table',
      'view',
      'materialized_view',
      'sequence',
      'table',
    ])
    expect(tables[0]).toMatchObject({ name: 't_r', engine: null })
  })

  it('reads the row estimate rounded, none for a view, a negative or a number that is not one', async () => {
    const estimate = async (kind: string, value: unknown) =>
      (await list([row(['t', kind, value])])).tables[0]?.rowEstimate
    expect(await estimate('r', 12.4)).toBe(12)
    expect(await estimate('r', 12.5)).toBe(13)
    expect(await estimate('r', 0)).toBe(0)
    expect(await estimate('r', '7')).toBe(7)
    expect(await estimate('r', -1)).toBeNull()
    expect(await estimate('r', -0.5)).toBeNull()
    expect(await estimate('r', 'abc')).toBeNull()
    expect(await estimate('r', Number.POSITIVE_INFINITY)).toBeNull()
    expect(await estimate('v', 5)).toBeNull()
    expect(await estimate('m', 5)).toBe(5)
    expect(await estimate('S', 5)).toBe(5)
  })

  it('reads the size, none when the catalog has none, and the comment, an empty one staying empty', async () => {
    const [a, b, c] = (
      await list([row(['a', 'r', 1, 'note', 8192]), row(['b', 'r', 1, null, null]), row(['c', 'r', 1, '', 0])])
    ).tables
    expect([a?.sizeBytes, a?.comment]).toEqual([8192, 'note'])
    expect([b?.sizeBytes, b?.comment]).toEqual([null, null])
    expect([c?.sizeBytes, c?.comment]).toEqual([0, ''])
  })

  it('splits the parents of an inheritance child at the separator, and has none when there are none', async () => {
    const { tables } = await list([
      row(['a', 'r', 1, null, 1, `p${SEP}q`]),
      row(['b', 'r', 1, null, 1, null]),
      row(['c', 'r', 1, null, 1, '']),
    ])
    expect(tables.map((t) => t.inherits)).toEqual([['p', 'q'], [], []])
  })

  it('names the column a sequence belongs to, only when both the table and the column are known', async () => {
    const { tables } = await list([
      row(['a_seq', 'S', 1, null, 1, null, 'a', 'id']),
      row(['b_seq', 'S', 1, null, 1, null, 'b', null]),
      row(['c_seq', 'S', 1, null, 1, null, null, 'id']),
      row(['d', 'r']),
    ])
    expect(tables[0]?.ownedBy).toEqual({ table: 'a', column: 'id' })
    expect(tables[1]).not.toHaveProperty('ownedBy')
    expect(tables[2]).not.toHaveProperty('ownedBy')
    expect(tables[3]).not.toHaveProperty('ownedBy')
  })
})

describe('pgListForeignKeys', () => {
  const key = (extra: unknown[] = []) =>
    ['fk', 'other', 'p', 'a', 'c', `x${SEP}y`, `i${SEP}j`, 't'].map((v, i) => (extra[i] === undefined ? v : extra[i]))
  const list = async (data: unknown[][], space = ns) => {
    const { conn, asked } = scripted([[/JOIN pg_class c ON c\.oid = con\.conrelid/, rows(data)]])
    return { keys: await pgListForeignKeys(conn, space), asked }
  }

  it('reads each key with its table, columns, the table it points at and its actions', async () => {
    const { keys, asked } = await list([key()])
    expect(keys).toEqual([
      {
        table: 't',
        name: 'fk',
        columns: ['x', 'y'],
        refNamespace: { database: 'db', schema: 'other' },
        refTable: 'p',
        refColumns: ['i', 'j'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ])
    expect(asked[0]?.params).toEqual(['app', SEP])
    expect((await list([], { database: 'db' })).asked[0]?.params).toEqual(['public', SEP])
  })

  it('words each action code, an unknown one as none, and an absent table as empty', async () => {
    const codes: [string, string | null][] = [
      ['a', 'NO ACTION'],
      ['r', 'RESTRICT'],
      ['c', 'CASCADE'],
      ['n', 'SET NULL'],
      ['d', 'SET DEFAULT'],
      ['x', null],
      ['', null],
    ]
    for (const [code, word] of codes) {
      const [k] = (await list([key([undefined, undefined, undefined, code, code])])).keys
      expect([k?.onUpdate, k?.onDelete], code).toEqual([word, word])
    }
    expect(
      (await list([key([undefined, undefined, undefined, undefined, undefined, undefined, undefined, null])])).keys[0]
        ?.table
    ).toBe('')
    expect((await list([key([undefined, undefined, undefined, undefined, undefined, '', ''])])).keys[0]).toMatchObject({
      columns: [],
      refColumns: [],
    })
  })
})

describe('pgDescribeTable', () => {
  const script = (over: Partial<Record<'info' | 'cols' | 'idx' | 'fk' | 'refs', unknown[][]>> = {}) =>
    scripted([
      [/SELECT c\.relkind, obj_description/, rows(over.info ?? [['r', null, 10, false, null]])],
      [/LEFT JOIN pg_attrdef/, rows(over.cols ?? [])],
      [/FROM pg_index i/, rows(over.idx ?? [])],
      [/con\.conrelid = \$1::regclass/, rows(over.fk ?? [])],
      [/con\.confrelid = \$1::regclass/, rows(over.refs ?? [])],
    ])
  const describe1 = async (over: Parameters<typeof script>[0] = {}, space = ns) => {
    const s = script(over)
    return { table: await pgDescribeTable(s.conn, space, 't'), asked: s.asked }
  }
  const col = (extra: unknown[] = []) =>
    ['c', 'integer', 't', null, '', '', null, null, false].map((v, i) => (extra[i] === undefined ? v : extra[i]))

  it('refuses a table that is not there, naming it with its schema', async () => {
    await rejectsWith(pgDescribeTable(script({ info: [] }).conn, ns, 't'), 'NOT_FOUND', /Table not found: app\.t/)
    await rejectsWith(
      pgDescribeTable(script({ info: [] }).conn, { database: 'db' }, 't'),
      'NOT_FOUND',
      /Table not found: public\.t/
    )
  })

  it('asks about the table by its quoted name, and by schema, name and separator for the first query', async () => {
    const { asked } = await describe1()
    expect(asked[0]?.params).toEqual(['app', 't', SEP])
    expect(asked[1]?.params).toEqual(['"app"."t"'])
    expect(asked[2]?.params).toEqual(['"app"."t"', SEP])
  })

  it('reads the kind, comment, estimate, partitioning, children and parents of the relation', async () => {
    const kind = async (k: string) => (await describe1({ info: [[k, null, 0, false, null]] })).table
    expect((await kind('r')).kind).toBe('table')
    expect((await kind('v')).kind).toBe('view')
    expect((await kind('m')).kind).toBe('materialized_view')
    expect((await kind('S')).kind).toBe('sequence')
    expect(await kind('p')).toMatchObject({ kind: 'table', partitioned: true })
    expect((await kind('r')).partitioned).toBe(false)
    const { table } = await describe1({ info: [['r', 'about', 3.6, 't', `p${SEP}q`]] })
    expect(table).toMatchObject({
      name: 't',
      comment: 'about',
      rowEstimate: 4,
      hasChildren: true,
      inherits: ['p', 'q'],
      engine: null,
      collation: null,
      autoIncrement: null,
    })
    expect((await describe1({ info: [['r', null, -1, false, null]] })).table.rowEstimate).toBeNull()
    expect((await describe1({ info: [['r', null, 0, false, null]] })).table.rowEstimate).toBe(0)
    expect((await describe1({ info: [['r', null, 'x', true, null]] })).table).toMatchObject({
      rowEstimate: null,
      hasChildren: true,
    })
  })

  it('reads a column: type, nullability (t or true), default, comment and collation', async () => {
    const { table } = await describe1({
      cols: [
        col(['a', 'text', 'f', "'x'::text", '', '', 'note', 'C']),
        col(['b', 'integer', true]),
        col(['c', 'integer', false]),
      ],
    })
    expect(table.columns[0]).toEqual({
      name: 'a',
      dataType: 'text',
      nullable: true,
      default: "'x'::text",
      defaultIsExpression: true,
      check: null,
      extra: '',
      comment: 'note',
      collation: 'C',
      generated: null,
    })
    expect(table.columns[1]).toMatchObject({
      nullable: false,
      default: null,
      defaultIsExpression: false,
      comment: null,
      collation: null,
    })
    expect(table.columns[2]?.nullable).toBe(true)
  })

  it('names how a column is generated: identity first, then a computed column, then a serial one', async () => {
    const extras = async (data: unknown[]) => (await describe1({ cols: [col(data)] })).table.columns[0]
    expect((await extras([undefined, undefined, undefined, undefined, 'a']))?.extra).toBe('identity always')
    expect((await extras([undefined, undefined, undefined, undefined, 'd']))?.extra).toBe('identity by default')
    expect(await extras([undefined, undefined, undefined, 'a + 1', '', 's'])).toMatchObject({
      extra: 'generated stored',
      generated: { expression: 'a + 1', stored: true },
    })
    expect(await extras([undefined, undefined, undefined, 'a + 1', '', 'v'])).toMatchObject({
      extra: 'generated virtual',
      generated: { expression: 'a + 1', stored: false },
    })
    expect(
      (
        await extras([
          undefined,
          undefined,
          undefined,
          "nextval('t_c_seq'::regclass)",
          '',
          '',
          undefined,
          undefined,
          't',
        ])
      )?.extra
    ).toBe('serial')
    expect(
      (
        await extras([
          undefined,
          undefined,
          undefined,
          "nextval('t_c_seq'::regclass)",
          '',
          '',
          undefined,
          undefined,
          true,
        ])
      )?.extra
    ).toBe('serial')
    expect(
      (
        await extras([
          undefined,
          undefined,
          undefined,
          "nextval('t_c_seq'::regclass)",
          '',
          '',
          undefined,
          undefined,
          false,
        ])
      )?.extra
    ).toBe('')
    expect((await extras([undefined, undefined, undefined, 'now()', '', '', undefined, undefined, true]))?.extra).toBe(
      ''
    )
    expect((await extras([undefined, undefined, undefined, null, '', '', undefined, undefined, true]))?.extra).toBe('')
    expect(
      (await extras([undefined, undefined, undefined, "nextval('x')", 'a', 's', undefined, undefined, true]))?.extra
    ).toBe('identity always')
    expect((await extras([undefined, undefined, undefined, 'e', '', 's', undefined, undefined, true]))?.extra).toBe(
      'generated stored'
    )
  })

  it('reads the indexes, the primary key being the columns of the primary index', async () => {
    const { table } = await describe1({
      idx: [
        ['t_pkey', 't', 't', 'btree', `a${SEP}b`, null, 'CREATE UNIQUE INDEX t_pkey ...', 't'],
        ['t_x', 'f', 'f', 'gin', 'c', 'c > 0', 'CREATE INDEX t_x ...', 't'],
        // Left by a concurrent build that failed: named apart, never an index to read through.
        ['t_left', 't', 'f', 'btree', 'd', null, 'CREATE UNIQUE INDEX t_left ...', 'f'],
      ],
    })
    expect(table.indexes).toEqual([
      {
        name: 't_pkey',
        unique: true,
        primary: true,
        columns: ['a', 'b'],
        type: 'btree',
        predicate: null,
        lengths: {},
        definition: 'CREATE UNIQUE INDEX t_pkey ...',
      },
      {
        name: 't_x',
        unique: false,
        primary: false,
        columns: ['c'],
        type: 'gin',
        predicate: 'c > 0',
        lengths: {},
        definition: 'CREATE INDEX t_x ...',
      },
    ])
    expect(table.unusableIndexes).toEqual(['t_left'])
    expect(table.primaryKey).toEqual(['a', 'b'])
    const plain = (await describe1({ idx: [['i', 'f', 'f', 'btree', 'c', null, 'D', 't']] })).table
    expect(plain.primaryKey).toEqual([])
    expect(plain).not.toHaveProperty('unusableIndexes')
  })

  it('reads the foreign keys without their holding table, and the keys that point at the table', async () => {
    const { table } = await describe1({
      fk: [['fk', 'other', 'p', 'r', 'n', `x${SEP}y`, `i${SEP}j`, null]],
      refs: [['rk', 'src', 's', `a${SEP}b`, `c${SEP}d`]],
    })
    expect(table.foreignKeys).toEqual([
      {
        name: 'fk',
        columns: ['x', 'y'],
        refNamespace: { database: 'db', schema: 'other' },
        refTable: 'p',
        refColumns: ['i', 'j'],
        onUpdate: 'RESTRICT',
        onDelete: 'SET NULL',
      },
    ])
    expect(table.foreignKeys[0]).not.toHaveProperty('table')
    expect(table.referencedBy).toEqual([
      {
        name: 'rk',
        fromNamespace: { database: 'db', schema: 'src' },
        fromTable: 's',
        fromColumns: ['a', 'b'],
        columns: ['c', 'd'],
      },
    ])
  })
})

describe('pgTableStats', () => {
  const stats = async (data: unknown[][] | null, space = ns) => {
    const { conn, asked } = scripted([[/pg_stat_all_tables/, rows(data ?? [])]])
    return { result: await pgTableStats(conn, space, 't'), asked }
  }
  const stat = (extra: unknown[] = []) =>
    ['r', 8192, 4096, 20480, 10, 2, '2030-01-01 00:00:00', '2030-01-02 00:00:00'].map((v, i) =>
      extra[i] === undefined ? v : extra[i]
    )

  it('refuses a table that is not there', async () => {
    await rejectsWith(
      stats(null).then((r) => r.result),
      'NOT_FOUND',
      /Table not found: app\.t/
    )
    await rejectsWith(
      stats(null, { database: 'db' }).then((r) => r.result),
      'NOT_FOUND',
      /Table not found: public\.t/
    )
  })

  it('reads the sizes, the rest of the total being TOAST, and the average row from the data and the rows', async () => {
    const { result, asked } = await stats([stat()])
    expect(result).toEqual({
      dataBytes: 8192,
      indexBytes: 4096,
      freeBytes: null,
      toastBytes: 8192,
      totalBytes: 20480,
      rowEstimate: 10,
      avgRowBytes: 819,
      rowFormat: null,
      createdAt: null,
      updatedAt: null,
      checkedAt: null,
      deadRows: 2,
      lastVacuum: '2030-01-01 00:00:00',
      lastAnalyze: '2030-01-02 00:00:00',
    })
    expect(asked[0]?.params).toEqual(['app', 't'])
    expect((await stats([stat()], { database: 'db' })).asked[0]?.params).toEqual(['public', 't'])
  })

  it('has no TOAST below zero, nor an average row without rows, nor a size the catalog did not give', async () => {
    expect((await stats([stat([undefined, 8192, 4096, 1000])])).result.toastBytes).toBe(0)
    expect((await stats([stat([undefined, 8192, 4096, 12288])])).result.toastBytes).toBe(0)
    expect((await stats([stat([undefined, undefined, undefined, undefined, 0])])).result.avgRowBytes).toBeNull()
    expect((await stats([stat([undefined, undefined, undefined, undefined, 1])])).result.avgRowBytes).toBe(8192)
    const none = (await stats([stat([undefined, null, null, null, null, null])])).result
    expect(none).toMatchObject({
      dataBytes: null,
      indexBytes: null,
      totalBytes: null,
      toastBytes: null,
      rowEstimate: null,
      avgRowBytes: null,
      deadRows: null,
    })
    expect((await stats([stat([undefined, 8192, null, 20480])])).result.toastBytes).toBeNull()
    expect((await stats([stat([undefined, null, 4096, 20480])])).result.toastBytes).toBeNull()
    expect((await stats([stat([undefined, 8192, 4096, null])])).result.toastBytes).toBeNull()
    expect((await stats([stat([undefined, 'x'])])).result.dataBytes).toBeNull()
  })

  it('has the figures of a table, a partitioned table and a materialized view only; none for a view or a sequence', async () => {
    for (const kind of ['r', 'p', 'm']) expect((await stats([stat([kind])])).result.dataBytes, kind).toBe(8192)
    for (const kind of ['v', 'S', 'f']) {
      expect((await stats([stat([kind])])).result, kind).toMatchObject({
        dataBytes: null,
        indexBytes: null,
        totalBytes: null,
        rowEstimate: null,
        deadRows: null,
        lastVacuum: null,
        lastAnalyze: null,
      })
    }
    expect(
      (await stats([stat([undefined, undefined, undefined, undefined, undefined, undefined, null, null])])).result
    ).toMatchObject({ lastVacuum: null, lastAnalyze: null })
  })
})

describe('pgListPartitions', () => {
  const script = (parent: unknown[][], children: unknown[][] = []) =>
    scripted([
      [/pg_get_partkeydef/, rows(parent)],
      [/FROM pg_inherits i JOIN pg_class c ON c\.oid = i\.inhrelid/, rows(children)],
    ])

  it('refuses a table that is not there', async () => {
    await rejectsWith(pgListPartitions(script([]).conn, ns, 't'), 'NOT_FOUND', /Table not found: app\.t/)
    await rejectsWith(
      pgListPartitions(script([]).conn, { database: 'db' }, 't'),
      'NOT_FOUND',
      /Table not found: public\.t/
    )
  })

  it('has no partitions for a table that is not partitioned', async () => {
    const { conn, asked } = script([['16384', null]])
    expect(await pgListPartitions(conn, ns, 't')).toEqual({ method: null, expression: null, partitions: [] })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.params).toEqual(['app', 't'])
  })

  it('reads the method and the key of the partitioning, and each partition with its bound and size', async () => {
    const { conn, asked } = script(
      [['16384', 'RANGE (created_at)']],
      [
        ['p1', 'FOR VALUES FROM (1) TO (2)', 5, 8192],
        ['p_default', 'DEFAULT', null, null],
      ]
    )
    expect(await pgListPartitions(conn, ns, 't')).toEqual({
      method: 'range',
      expression: 'created_at',
      partitions: [
        { name: 'p1', bound: 'FOR VALUES FROM (1) TO (2)', rowEstimate: 5, sizeBytes: 8192 },
        { name: 'p_default', bound: 'DEFAULT', rowEstimate: null, sizeBytes: null },
      ],
    })
    expect(asked[1]?.params).toEqual(['16384'])
  })

  it('reads a list or hash key, a key with parentheses inside, and a key it cannot read', async () => {
    const part = async (key: string) => await pgListPartitions(script([['1', key]]).conn, ns, 't')
    expect(await part('LIST (a)')).toMatchObject({ method: 'list', expression: 'a' })
    expect(await part('HASH (a, b)')).toMatchObject({ method: 'hash', expression: 'a, b' })
    expect(await part("RANGE (date_trunc('day', ts))")).toMatchObject({
      method: 'range',
      expression: "date_trunc('day', ts)",
    })
    expect(await part('RANGE (a)\n')).toMatchObject({ method: null })
    expect(await part('FOO (a)')).toMatchObject({ method: null, expression: 'a' })
    expect(await part('weird')).toMatchObject({ method: null, expression: 'weird' })
    expect(await part('range(a)')).toMatchObject({ method: 'range', expression: 'a' })
  })
})

describe('the questions the PostgreSQL readers ask, and the rows that come back short', () => {
  const noSchema: Namespace = { database: 'db' }

  it('asks every query of a table about that table: by its quoted name, and the public schema when none is named', async () => {
    const s = scripted([
      [/SELECT c\.relkind, obj_description/, rows([['r', null, 1, false, null]])],
      [/LEFT JOIN pg_attrdef/, rows([])],
      [/FROM pg_index i/, rows([])],
      [/con\.conrelid = \$1::regclass/, rows([])],
      [/con\.confrelid = \$1::regclass/, rows([])],
    ])
    await pgDescribeTable(s.conn, noSchema, 't')
    expect(s.asked.map((q) => q.params)).toEqual([
      ['public', 't', SEP],
      ['"public"."t"'],
      ['"public"."t"', SEP],
      ['"public"."t"', SEP],
      ['"public"."t"', SEP],
    ])
    const named = scripted([
      [/SELECT c\.relkind, obj_description/, rows([['r', null, 1, false, null]])],
      [/LEFT JOIN pg_attrdef/, rows([])],
      [/FROM pg_index i/, rows([])],
      [/con\.conrelid = \$1::regclass/, rows([])],
      [/con\.confrelid = \$1::regclass/, rows([])],
    ])
    await pgDescribeTable(named.conn, ns, 't')
    expect(named.asked.map((q) => q.params?.[0])).toEqual(['app', '"app"."t"', '"app"."t"', '"app"."t"', '"app"."t"'])
  })

  it('reads a row that is shorter than the query, an absent value as none', async () => {
    const tables = await pgListTables(
      scripted([[/SELECT c\.relname, c\.relkind,/, rows([['t', 'r', 1, null, undefined, undefined]])]]).conn,
      ns
    )
    expect(tables[0]).toMatchObject({ sizeBytes: null, inherits: [] })
    const { conn } = scripted([[/pg_stat_all_tables/, rows([['r', null, 4096, 20480, 10, null, null, null]])]])
    expect(await pgTableStats(conn, ns, 't')).toMatchObject({ dataBytes: null, avgRowBytes: null, toastBytes: null })
    const rowsOnly = scripted([[/pg_stat_all_tables/, rows([['r', 8192, 4096, 20480, null, null, null, null]])]])
    expect(await pgTableStats(rowsOnly.conn, ns, 't')).toMatchObject({
      dataBytes: 8192,
      rowEstimate: null,
      avgRowBytes: null,
    })
    const part = scripted([
      [/pg_get_partkeydef/, rows([['1', 'LIST (a)']])],
      [/pg_inherits i JOIN pg_class c ON c\.oid = i\.inhrelid/, rows([['p', 'DEFAULT', undefined, undefined]])],
    ])
    expect((await pgListPartitions(part.conn, ns, 't')).partitions[0]).toMatchObject({
      rowEstimate: null,
      sizeBytes: null,
    })
  })

  it('asks about the partitions of a table in the public schema when none is named, and reads only a key written from its start', async () => {
    const s = scripted([[/pg_get_partkeydef/, rows([['1', null]])]])
    await pgListPartitions(s.conn, noSchema, 't')
    expect(s.asked[0]?.params).toEqual(['public', 't'])
    const key = async (text: string) =>
      await pgListPartitions(
        scripted([
          [/pg_get_partkeydef/, rows([['1', text]])],
          [/inhrelid/, rows([])],
        ]).conn,
        ns,
        't'
      )
    expect(await key('weird RANGE (a)')).toMatchObject({ method: null, expression: 'weird RANGE (a)' })
  })

  it('asks about the keys of the schema in the public schema when none is named', async () => {
    const s = scripted([[/JOIN pg_class c ON c\.oid = con\.conrelid/, rows([])]])
    await pgListForeignKeys(s.conn, noSchema)
    expect(s.asked[0]?.params).toEqual(['public', SEP])
  })
})
