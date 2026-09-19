import type { ColumnSpec, DdlOp } from '@tsmyadmin/shared'
import { DDL_OP_NAMES } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlDdl } from '../mysql/ddl.ts'
import { pgDdl } from '../postgres/ddl.ts'
import { mysqlLiteral, pgLiteral } from '../sql/literal.ts'

const col = (name: string, dataType: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  dataType,
  nullable: true,
  default: null,
  autoIncrement: false,
  comment: null,
  collation: null,
  onUpdate: null,
  check: null,
  generated: null,
  ...extra,
})

/** One representative op per DdlOp kind. The type forces this map to stay complete. */
const SAMPLE_OPS: Record<DdlOp['op'], DdlOp> = {
  createTable: {
    op: 'createTable',
    table: 'we"ird`tbl',
    columns: [
      col('id', 'INT', { nullable: false, autoIncrement: true }),
      col('name', 'VARCHAR(100)', { default: { kind: 'literal', value: "it's \\ ok" }, comment: 'the "name"' }),
      col('created', 'TIMESTAMP', { nullable: false, default: { kind: 'expression', sql: 'CURRENT_TIMESTAMP' } }),
    ],
    primaryKey: ['id'],
  },
  addColumn: {
    op: 'addColumn',
    table: 't',
    column: col('n', 'INT', { default: { kind: 'expression', sql: '0' } }),
    after: 'id',
  },
  modifyColumn: {
    op: 'modifyColumn',
    table: 't',
    name: 'n',
    column: col('n2', 'BIGINT', {
      nullable: false,
      comment: 'renamed',
      collation: 'utf8mb4_bin',
      onUpdate: 'CURRENT_TIMESTAMP',
    }),
  },
  dropColumn: { op: 'dropColumn', table: 't', name: 'n' },
  dropColumns: { op: 'dropColumns', table: 't', names: ['a', 'b'] },
  modifyColumns: {
    op: 'modifyColumns',
    table: 't',
    changes: [
      { name: 'a', column: col('a', 'BIGINT', { nullable: false }) },
      { name: 'b', column: col('b2', 'TEXT') },
    ],
  },
  reorderColumns: { op: 'reorderColumns', table: 't', columns: [col('b', 'INT'), col('a', 'INT')] },
  partitionTable: {
    op: 'partitionTable',
    table: 'lo`g',
    method: 'range',
    expression: 'YEAR(created)',
    partitions: [
      { name: 'p2`024', bound: 'VALUES LESS THAN (2025)' },
      { name: 'pmax', bound: 'VALUES LESS THAN MAXVALUE' },
    ],
  },
  addPartition: { op: 'addPartition', table: 'lo"g', partition: { name: 'p"1', bound: 'FOR VALUES FROM (1) TO (10)' } },
  dropPartition: { op: 'dropPartition', table: 'lo"g', name: 'p"1' },
  truncatePartition: { op: 'truncatePartition', table: 'lo"g', name: 'p"1' },
  detachPartition: { op: 'detachPartition', table: 'lo"g', name: 'p"1' },
  removePartitioning: { op: 'removePartitioning', table: 'lo`g' },
  maintainPartition: { op: 'maintainPartition', table: 'lo`g', name: 'p`1', action: 'analyze' },
  setPrimaryKey: { op: 'setPrimaryKey', table: 't', columns: ['a', 'b'], current: 't_pkey' },
  setTableOptions: { op: 'setTableOptions', table: 't', comment: "it's" },
  maintainTable: { op: 'maintainTable', table: 't', action: 'analyze' },
  dropTables: { op: 'dropTables', tables: ['t', 'we"ird`tbl'] },
  truncateTables: { op: 'truncateTables', tables: ['t', 'we"ird`tbl'] },
  addIndex: { op: 'addIndex', table: 't', name: 'idx_t_a_b', columns: ['a', 'b'], unique: true },
  dropIndex: { op: 'dropIndex', table: 't', name: 'idx_t_a_b' },
  renameIndex: { op: 'renameIndex', table: 't', name: 'idx_t_a_b', newName: 'idx_t_ab' },
  alterIndex: {
    op: 'alterIndex',
    table: 't',
    name: 'idx_t_a_b',
    index: { name: 'idx_t_a', columns: ['a'], unique: false, method: 'btree' },
  },
  addForeignKey: {
    op: 'addForeignKey',
    table: 't',
    name: 'fk_t_user',
    columns: ['user_id'],
    refTable: 'us`ers',
    refColumns: ['id'],
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  },
  dropForeignKey: { op: 'dropForeignKey', table: 't', name: 'fk_t_user' },
  dropTable: { op: 'dropTable', table: 't', kind: 'table' },
  truncateTable: { op: 'truncateTable', table: 't' },
  renameTable: { op: 'renameTable', table: 't', newName: 'we"ird`new' },
  createDatabase: { op: 'createDatabase', name: 'new"db`x' },
  dropDatabase: { op: 'dropDatabase', name: 'new"db`x' },
  renameDatabase: {
    op: 'renameDatabase',
    name: 'old"db`x',
    newName: 'new"db`x',
    tables: ['we"ird`t', 'users'],
    collation: 'utf8mb4_0900_ai_ci',
  },
  copyDatabase: {
    op: 'copyDatabase',
    name: 'old"db`x',
    newName: 'new"db`x',
    withData: true,
    // A table whose every column is generated gets its structure and no INSERT.
    tables: [
      { name: 'we"ird`t', columns: ['id', 'n"m`e'] },
      { name: 'all_generated', columns: [] },
    ],
    collation: 'utf8mb4_0900_ai_ci',
  },
  createSchema: { op: 'createSchema', name: 'new"schema' },
  copyTable: {
    op: 'copyTable',
    table: 't',
    newName: 't_copy',
    withData: true,
    columns: ['id', 'na`me'],
    identityColumns: ['id'],
    serialColumns: ['na`me'],
  },
  replaceInColumn: { op: 'replaceInColumn', table: 'users', column: 'na`me"', find: "it's", replace: '%_\\' },
  moveTable: { op: 'moveTable', table: 'we"ird`tbl', to: 'arch`ive"' },
  createView: { op: 'createView', name: 'v`w"x', select: 'SELECT id, name FROM users WHERE id > 1;', orReplace: true },
  createRoutine: {
    op: 'createRoutine',
    kind: 'function',
    name: 'add`o"ne',
    params: [{ mode: 'IN', name: 'n', type: 'INT' }],
    returns: 'INT',
    body: 'RETURN n + 1;',
    language: 'sql',
    deterministic: true,
    comment: "adds 'one'",
  },
  createTrigger: {
    op: 'createTrigger',
    name: 'tr`g',
    table: 'users',
    timing: 'BEFORE',
    event: 'INSERT',
    body: 'BEGIN\n  SET NEW.name = TRIM(NEW.name);\nEND;',
  },
  createEvent: {
    op: 'createEvent',
    name: 'ev`x',
    schedule: { kind: 'every', interval: 1, unit: 'DAY', starts: '2026-01-01 00:00:00' },
    body: 'DELETE FROM logs WHERE at < NOW() - INTERVAL 30 DAY',
    enabled: true,
    comment: "prune 'old' logs",
  },
  enableEvent: { op: 'enableEvent', name: 'ev`x' },
  disableEvent: { op: 'disableEvent', name: 'ev`x' },
  dropEvent: { op: 'dropEvent', name: 'ev`x' },
}

describe('DDL builders', () => {
  it('has a sample for every DdlOp kind', () => {
    expect(Object.keys(SAMPLE_OPS).sort()).toEqual([...DDL_OP_NAMES].sort())
  })

  for (const name of DDL_OP_NAMES) {
    it(`mysql: ${name}`, () => {
      const build = () => mysqlDdl.build({ database: 'db' }, SAMPLE_OPS[name])
      if (name === 'detachPartition') expect(build).toThrow(/no DETACH/)
      else expect(build()).toMatchSnapshot()
    })
    it(`postgres: ${name}`, () => {
      const build = () => pgDdl.build({ database: 'db', schema: 'app' }, SAMPLE_OPS[name])
      if (name.endsWith('Event')) expect(build).toThrow(/no event scheduler/)
      else if (name === 'reorderColumns') expect(build).toThrow(/cannot reorder/)
      else if (name === 'partitionTable' || name === 'removePartitioning') expect(build).toThrow(/PostgreSQL cannot/)
      else expect(build()).toMatchSnapshot()
    })
  }

  it('modifyColumn without rename uses MODIFY (mysql) and skips RENAME (postgres)', () => {
    const op: DdlOp = { op: 'modifyColumn', table: 't', name: 'n', column: col('n', 'INT') }
    expect(mysqlDdl.build({ database: 'db' }, op)[0]).toContain('MODIFY COLUMN')
    expect(pgDdl.build({ database: 'db' }, op).some((s) => s.includes('RENAME'))).toBe(false)
  })

  it('parenthesises a MySQL expression default, which the bare form only accepts for CURRENT_TIMESTAMP', () => {
    const withDefault = (sql: string): DdlOp => ({
      op: 'addColumn',
      table: 't',
      column: col('n', 'CHAR(36)', { default: { kind: 'expression', sql } }),
    })
    expect(mysqlDdl.build({ database: 'db' }, withDefault('uuid()'))[0]).toContain('DEFAULT (uuid())')
    // The catalog prints a compound expression already wrapped; it must not be wrapped twice.
    expect(mysqlDdl.build({ database: 'db' }, withDefault('(1 + 1)'))[0]).toContain('DEFAULT (1 + 1)')
    expect(mysqlDdl.build({ database: 'db' }, withDefault('CURRENT_TIMESTAMP(3)'))[0]).toContain(
      'DEFAULT CURRENT_TIMESTAMP(3)'
    )
  })

  it('MODIFY COLUMN keeps the collation and ON UPDATE the column form does not show', () => {
    // MySQL replaces the whole definition: anything the builder omits is dropped from the column.
    const op: DdlOp = {
      op: 'modifyColumn',
      table: 't',
      name: 'n',
      column: col('n', 'timestamp', { collation: 'latin1_bin', onUpdate: 'CURRENT_TIMESTAMP(3)', comment: 'c' }),
    }
    expect(mysqlDdl.build({ database: 'db' }, op)[0]).toBe(
      "ALTER TABLE `db`.`t` MODIFY COLUMN `n` timestamp COLLATE latin1_bin NULL ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'c'"
    )
  })

  it('writes a generated column in each dialect, with no default of its own', () => {
    const generated = col('total', 'int', {
      generated: { expression: '`a` + `b`', stored: true },
      default: { kind: 'literal', value: '0' },
      comment: 'sum',
    })
    expect(mysqlDdl.build({ database: 'db' }, { op: 'addColumn', table: 't', column: generated })).toEqual([
      "ALTER TABLE `db`.`t` ADD COLUMN `total` int GENERATED ALWAYS AS (`a` + `b`) STORED COMMENT 'sum'",
    ])
    const virtual = col('v', 'int', { generated: { expression: 'a * 2', stored: false }, nullable: false })
    expect(pgDdl.build({ database: 'db', schema: 'app' }, { op: 'addColumn', table: 't', column: virtual })).toEqual([
      'ALTER TABLE "app"."t" ADD COLUMN "v" int GENERATED ALWAYS AS (a * 2) VIRTUAL NOT NULL',
    ])
  })

  it('changes a generated column on PostgreSQL in place, or says it cannot', () => {
    const before = col('v', 'int', { generated: { expression: 'a * 2', stored: true } })
    const change = (column: ReturnType<typeof col>) =>
      pgDdl.build(
        { database: 'db', schema: 'app' },
        { op: 'modifyColumn', table: 't', name: 'v', column, previous: before }
      )
    expect(change(col('v', 'int', { generated: { expression: 'a * 3', stored: true } }))).toEqual([
      'ALTER TABLE "app"."t" ALTER COLUMN "v" SET EXPRESSION AS (a * 3)',
    ])
    // Dropping the expression keeps the values as an ordinary column; nothing about a default is touched.
    expect(change(col('v', 'int'))).toEqual(['ALTER TABLE "app"."t" ALTER COLUMN "v" DROP EXPRESSION'])
    expect(() => change(col('v', 'int', { generated: { expression: 'a * 2', stored: false } }))).toThrow(/cannot/)
    const plain = col('p', 'int')
    expect(() =>
      pgDdl.build(
        { database: 'db', schema: 'app' },
        {
          op: 'modifyColumn',
          table: 't',
          name: 'p',
          column: { ...plain, generated: { expression: '1', stored: true } },
          previous: plain,
        }
      )
    ).toThrow(/cannot/)
  })

  it('changes a PostgreSQL collation with the type, quoted, and only when it changed', () => {
    const before = col('n', 'text', { collation: 'C' })
    const build = (column: ReturnType<typeof col>) =>
      pgDdl.build(
        { database: 'db', schema: 'app' },
        { op: 'modifyColumn', table: 't', name: 'n', column, previous: before }
      )
    expect(build(col('n', 'text', { collation: 'en_US.utf8' }))).toEqual([
      'ALTER TABLE "app"."t" ALTER COLUMN "n" TYPE text COLLATE "en_US.utf8"',
    ])
    expect(build(col('n', 'text', { collation: 'C' }))).toEqual([])
  })

  it('positions a column on MySQL and refuses to reorder on PostgreSQL', () => {
    const c = col('n', 'int')
    expect(mysqlDdl.build({ database: 'db' }, { op: 'addColumn', table: 't', column: c, first: true })[0]).toMatch(
      / FIRST$/
    )
    expect(
      mysqlDdl.build({ database: 'db' }, { op: 'modifyColumn', table: 't', name: 'n', column: c, after: 'id' })[0]
    ).toMatch(/MODIFY COLUMN `n` int NULL AFTER `id`$/)
    expect(() =>
      pgDdl.build({ database: 'db' }, { op: 'modifyColumn', table: 't', name: 'n', column: c, first: true })
    ).toThrow(/reorder/)
  })

  it('adds the key asked for with a new column', () => {
    const c = col('code', 'varchar(10)', { nullable: false })
    const add = (key: 'primary' | 'unique' | 'index') => ({ op: 'addColumn' as const, table: 't', column: c, key })
    expect(mysqlDdl.build({ database: 'db' }, add('primary'))[1]).toBe('ALTER TABLE `db`.`t` ADD PRIMARY KEY (`code`)')
    expect(mysqlDdl.build({ database: 'db' }, add('unique'))[1]).toBe(
      'CREATE UNIQUE INDEX `t_code_key` ON `db`.`t` (`code`)'
    )
    expect(pgDdl.build({ database: 'db', schema: 'app' }, add('index')).at(-1)).toBe(
      'CREATE INDEX "t_code_idx" ON "app"."t" ("code")'
    )
  })

  it('dropTable drops a view / materialized view / sequence by its kind', () => {
    const view: DdlOp = { op: 'dropTable', table: 'v', kind: 'view' }
    const mat: DdlOp = { op: 'dropTable', table: 'm', kind: 'materialized_view' }
    const seq: DdlOp = { op: 'dropTable', table: 's', kind: 'sequence' }
    expect(mysqlDdl.build({ database: 'db' }, view)).toEqual(['DROP VIEW `db`.`v`'])
    expect(mysqlDdl.build({ database: 'db' }, seq)).toEqual(['DROP SEQUENCE `db`.`s`'])
    expect(pgDdl.build({ database: 'db', schema: 'app' }, view)).toEqual(['DROP VIEW "app"."v"'])
    expect(pgDdl.build({ database: 'db', schema: 'app' }, mat)).toEqual(['DROP MATERIALIZED VIEW "app"."m"'])
    expect(pgDdl.build({ database: 'db', schema: 'app' }, seq)).toEqual(['DROP SEQUENCE "app"."s"'])
  })

  it('modifyColumn with the previous definition emits only the changed clauses on PostgreSQL', () => {
    const previous = col('n', 'INT', { nullable: true, comment: 'old' })
    const same: DdlOp = {
      op: 'modifyColumn',
      table: 't',
      name: 'n',
      column: col('n', 'INT', { nullable: true, comment: 'new' }),
      previous,
    }
    expect(pgDdl.build({ database: 'db', schema: 'app' }, same)).toEqual([`COMMENT ON COLUMN "app"."t"."n" IS 'new'`])
    const typed: DdlOp = {
      op: 'modifyColumn',
      table: 't',
      name: 'n',
      column: col('n', 'BIGINT', { nullable: false, comment: 'old' }),
      previous,
    }
    expect(pgDdl.build({ database: 'db', schema: 'app' }, typed)).toEqual([
      'ALTER TABLE "app"."t" ALTER COLUMN "n" TYPE BIGINT',
      'ALTER TABLE "app"."t" ALTER COLUMN "n" SET NOT NULL',
    ])
  })

  it('modifyColumn clears a column comment on PostgreSQL when the previous one is dropped', () => {
    const previous = col('n', 'INT', { comment: 'old' })
    const op: DdlOp = {
      op: 'modifyColumn',
      table: 't',
      name: 'n',
      column: col('n', 'INT', { comment: null }),
      previous,
    }
    expect(pgDdl.build({ database: 'db', schema: 'app' }, op)).toEqual(['COMMENT ON COLUMN "app"."t"."n" IS NULL'])
  })

  it('table options and maintenance follow each dialect', () => {
    const opts: DdlOp = {
      op: 'setTableOptions',
      table: 't',
      comment: 'c',
      engine: 'InnoDB',
      collation: 'utf8mb4_bin',
      autoIncrement: '18446744073709551614',
    }
    expect(mysqlDdl.build({ database: 'db' }, opts)).toEqual([
      "ALTER TABLE `db`.`t` COMMENT = 'c', ENGINE = InnoDB, COLLATE = utf8mb4_bin, AUTO_INCREMENT = 18446744073709551614",
    ])
    expect(() => pgDdl.build({ database: 'db' }, opts)).toThrow(/no engine/)
    expect(pgDdl.build({ database: 'db' }, { op: 'setTableOptions', table: 't', comment: null })).toEqual([
      'COMMENT ON TABLE "public"."t" IS NULL',
    ])
    expect(mysqlDdl.build({ database: 'db' }, { op: 'maintainTable', table: 't', action: 'optimize' })).toEqual([
      'OPTIMIZE TABLE `db`.`t`',
    ])
    expect(() => mysqlDdl.build({ database: 'db' }, { op: 'maintainTable', table: 't', action: 'vacuum' })).toThrow(
      /VACUUM/
    )
    expect(pgDdl.build({ database: 'db' }, { op: 'maintainTable', table: 't', action: 'vacuum' })).toEqual([
      'VACUUM (ANALYZE) "public"."t"',
    ])
    expect(() => pgDdl.build({ database: 'db' }, { op: 'maintainTable', table: 't', action: 'check' })).toThrow(
      /CHECK TABLE/
    )
    expect(mysqlDdl.build({ database: 'db' }, { op: 'maintainTable', table: 't', action: 'repair' })).toEqual([
      'REPAIR TABLE `db`.`t`',
    ])
    expect(() => pgDdl.build({ database: 'db' }, { op: 'maintainTable', table: 't', action: 'repair' })).toThrow(
      /REPAIR TABLE/
    )
  })

  it('escapes string literals per dialect', () => {
    expect(mysqlLiteral("a'b\\c")).toBe("'a''b\\\\c'")
    expect(pgLiteral("a'b\\c")).toBe("'a''b\\c'")
  })

  it('writes index kinds, methods and prefix lengths each dialect has, and refuses the rest', () => {
    const idx = (over: Partial<Extract<DdlOp, { op: 'addIndex' }>>): DdlOp => ({
      op: 'addIndex',
      table: 't',
      name: 'i',
      columns: ['a', 'b'],
      unique: false,
      ...over,
    })
    const my = (op: DdlOp) => mysqlDdl.build({ database: 'db' }, op)[0]
    const pg = (op: DdlOp) => pgDdl.build({ database: 'db', schema: 'app' }, op)[0]
    expect(my(idx({ kind: 'fulltext' }))).toBe('CREATE FULLTEXT INDEX `i` ON `db`.`t` (`a`, `b`)')
    expect(my(idx({ kind: 'spatial', columns: ['g'] }))).toBe('CREATE SPATIAL INDEX `i` ON `db`.`t` (`g`)')
    expect(my(idx({ unique: true, method: 'hash', lengths: { a: 10 } }))).toBe(
      'CREATE UNIQUE INDEX `i` ON `db`.`t` (`a`(10), `b`) USING HASH'
    )
    expect(pg(idx({ method: 'gin' }))).toBe('CREATE INDEX "i" ON "app"."t" USING gin ("a", "b")')
    expect(() => my(idx({ method: 'gin' }))).toThrow(/no gin/)
    expect(() => my(idx({ kind: 'fulltext', method: 'btree' }))).toThrow(/no method/)
    expect(() => pg(idx({ kind: 'fulltext' }))).toThrow(/GIN or GiST/)
    expect(() => pg(idx({ lengths: { a: 10 } }))).toThrow(/prefix length/)
  })

  it('replaces the MySQL primary key in one ALTER when it is the index being changed', () => {
    const op: DdlOp = {
      op: 'alterIndex',
      table: 't',
      name: 'PRIMARY',
      index: { name: 'PRIMARY', columns: ['a', 'b'], unique: true },
    }
    expect(mysqlDdl.build({ database: 'db' }, op)).toEqual([
      'ALTER TABLE `db`.`t` DROP PRIMARY KEY, ADD PRIMARY KEY (`a`, `b`)',
    ])
  })

  it('never emits an unquoted identifier from user input', () => {
    for (const name of DDL_OP_NAMES) {
      for (const dialect of [mysqlDdl, pgDdl]) {
        if (dialect === pgDdl && (name.endsWith('Event') || name === 'reorderColumns')) continue
        if (dialect === pgDdl && (name === 'partitionTable' || name === 'removePartitioning')) continue
        if (dialect === mysqlDdl && name === 'detachPartition') continue
        for (const sql of dialect.build({ database: 'db' }, SAMPLE_OPS[name])) {
          expect(sql).not.toMatch(/\bwe"ird`tbl\b/)
        }
      }
    }
  })

  it('replaces by regular expression in each dialect, every match', () => {
    const op: DdlOp = { op: 'replaceInColumn', table: 't', column: 'c', find: "a'+", replace: 'b', regex: true }
    expect(mysqlDdl.build({ database: 'db' }, op)[0]).toContain("SET `c` = REGEXP_REPLACE(`c`, 'a''+', 'b')")
    expect(pgDdl.build({ database: 'db', schema: 'app' }, op)[0]).toContain(
      `SET "c" = regexp_replace("c", 'a''+', 'b', 'g')`
    )
  })
})
