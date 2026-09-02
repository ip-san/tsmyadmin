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
    column: col('n2', 'BIGINT', { nullable: false, comment: 'renamed' }),
  },
  dropColumn: { op: 'dropColumn', table: 't', name: 'n' },
  setTableOptions: { op: 'setTableOptions', table: 't', comment: "it's" },
  maintainTable: { op: 'maintainTable', table: 't', action: 'analyze' },
  dropTables: { op: 'dropTables', tables: ['t', 'we"ird`tbl'] },
  truncateTables: { op: 'truncateTables', tables: ['t', 'we"ird`tbl'] },
  addIndex: { op: 'addIndex', table: 't', name: 'idx_t_a_b', columns: ['a', 'b'], unique: true },
  dropIndex: { op: 'dropIndex', table: 't', name: 'idx_t_a_b' },
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
      expect(mysqlDdl.build({ database: 'db' }, SAMPLE_OPS[name])).toMatchSnapshot()
    })
    it(`postgres: ${name}`, () => {
      const build = () => pgDdl.build({ database: 'db', schema: 'app' }, SAMPLE_OPS[name])
      if (name.endsWith('Event')) expect(build).toThrow(/no event scheduler/)
      else expect(build()).toMatchSnapshot()
    })
  }

  it('modifyColumn without rename uses MODIFY (mysql) and skips RENAME (postgres)', () => {
    const op: DdlOp = { op: 'modifyColumn', table: 't', name: 'n', column: col('n', 'INT') }
    expect(mysqlDdl.build({ database: 'db' }, op)[0]).toContain('MODIFY COLUMN')
    expect(pgDdl.build({ database: 'db' }, op).some((s) => s.includes('RENAME'))).toBe(false)
  })

  it('dropTable drops a view / materialized view by its kind', () => {
    const view: DdlOp = { op: 'dropTable', table: 'v', kind: 'view' }
    const mat: DdlOp = { op: 'dropTable', table: 'm', kind: 'materialized_view' }
    expect(mysqlDdl.build({ database: 'db' }, view)).toEqual(['DROP VIEW `db`.`v`'])
    expect(pgDdl.build({ database: 'db', schema: 'app' }, view)).toEqual(['DROP VIEW "app"."v"'])
    expect(pgDdl.build({ database: 'db', schema: 'app' }, mat)).toEqual(['DROP MATERIALIZED VIEW "app"."m"'])
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

  it('table options and maintenance follow each dialect', () => {
    const opts: DdlOp = {
      op: 'setTableOptions',
      table: 't',
      comment: 'c',
      engine: 'InnoDB',
      collation: 'utf8mb4_bin',
      autoIncrement: 100,
    }
    expect(mysqlDdl.build({ database: 'db' }, opts)).toEqual([
      "ALTER TABLE `db`.`t` COMMENT = 'c', ENGINE = InnoDB, COLLATE = utf8mb4_bin, AUTO_INCREMENT = 100",
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
  })

  it('escapes string literals per dialect', () => {
    expect(mysqlLiteral("a'b\\c")).toBe("'a''b\\\\c'")
    expect(pgLiteral("a'b\\c")).toBe("'a''b\\c'")
  })

  it('never emits an unquoted identifier from user input', () => {
    for (const name of DDL_OP_NAMES) {
      for (const dialect of [mysqlDdl, pgDdl]) {
        if (dialect === pgDdl && name.endsWith('Event')) continue
        for (const sql of dialect.build({ database: 'db' }, SAMPLE_OPS[name])) {
          expect(sql).not.toMatch(/\bwe"ird`tbl\b/)
        }
      }
    }
  })
})
