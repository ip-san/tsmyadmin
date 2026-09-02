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
  addIndex: { op: 'addIndex', table: 't', name: 'idx_t_a_b', columns: ['a', 'b'], unique: true },
  dropIndex: { op: 'dropIndex', table: 't', name: 'idx_t_a_b' },
  dropTable: { op: 'dropTable', table: 't' },
  truncateTable: { op: 'truncateTable', table: 't' },
  renameTable: { op: 'renameTable', table: 't', newName: 'we"ird`new' },
  createDatabase: { op: 'createDatabase', name: 'new"db`x' },
  dropDatabase: { op: 'dropDatabase', name: 'new"db`x' },
  createSchema: { op: 'createSchema', name: 'new"schema' },
  copyTable: { op: 'copyTable', table: 't', newName: 't_copy', withData: true },
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
      expect(pgDdl.build({ database: 'db', schema: 'app' }, SAMPLE_OPS[name])).toMatchSnapshot()
    })
  }

  it('modifyColumn without rename uses MODIFY (mysql) and skips RENAME (postgres)', () => {
    const op: DdlOp = { op: 'modifyColumn', table: 't', name: 'n', column: col('n', 'INT') }
    expect(mysqlDdl.build({ database: 'db' }, op)[0]).toContain('MODIFY COLUMN')
    expect(pgDdl.build({ database: 'db' }, op).some((s) => s.includes('RENAME'))).toBe(false)
  })

  it('escapes string literals per dialect', () => {
    expect(mysqlLiteral("a'b\\c")).toBe("'a''b\\\\c'")
    expect(pgLiteral("a'b\\c")).toBe("'a''b\\c'")
  })

  it('never emits an unquoted identifier from user input', () => {
    for (const name of DDL_OP_NAMES) {
      for (const dialect of [mysqlDdl, pgDdl]) {
        for (const sql of dialect.build({ database: 'db' }, SAMPLE_OPS[name])) {
          expect(sql).not.toMatch(/\bwe"ird`tbl\b/)
        }
      }
    }
  })
})
