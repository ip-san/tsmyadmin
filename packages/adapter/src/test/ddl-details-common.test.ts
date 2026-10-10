import type { DdlOp } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlDdl } from '../mysql/ddl.ts'
import { pgDdl } from '../postgres/ddl.ts'
import { addForeignKeySql, createIndexSql, mysqlAddIndexClause } from '../sql/ddl-common.ts'
import { col, refuses } from './ddl-helpers.ts'

/** The parts the two dialects' builders share: indexes, foreign keys, and the two normalization ops. */

const my = { database: 'd' }
const pgNs = { database: 'd', schema: 's' }
type Index = Parameters<typeof mysqlAddIndexClause>[0]
const index = (extra: Partial<Index> = {}): Index => ({
  table: 't',
  name: 'i',
  columns: ['a', 'b'],
  unique: false,
  ...extra,
})

describe('indexes', () => {
  it('writes MySQL kinds as a keyword, and the method after the columns', () => {
    expect(createIndexSql('mysql', my, index())).toBe('CREATE INDEX `i` ON `d`.`t` (`a`, `b`)')
    expect(createIndexSql('mysql', my, index({ unique: true }))).toBe('CREATE UNIQUE INDEX `i` ON `d`.`t` (`a`, `b`)')
    expect(createIndexSql('mysql', my, index({ kind: 'fulltext' }))).toBe(
      'CREATE FULLTEXT INDEX `i` ON `d`.`t` (`a`, `b`)'
    )
    expect(createIndexSql('mysql', my, index({ kind: 'spatial', columns: ['g'] }))).toBe(
      'CREATE SPATIAL INDEX `i` ON `d`.`t` (`g`)'
    )
    // `kind` wins over `unique`.
    expect(createIndexSql('mysql', my, index({ unique: true, kind: 'index' }))).toBe(
      'CREATE INDEX `i` ON `d`.`t` (`a`, `b`)'
    )
    expect(createIndexSql('mysql', my, index({ unique: false, kind: 'unique' }))).toBe(
      'CREATE UNIQUE INDEX `i` ON `d`.`t` (`a`, `b`)'
    )
    expect(createIndexSql('mysql', my, index({ method: 'hash' }))).toBe(
      'CREATE INDEX `i` ON `d`.`t` (`a`, `b`) USING HASH'
    )
    expect(createIndexSql('mysql', my, index({ method: 'btree' }))).toBe(
      'CREATE INDEX `i` ON `d`.`t` (`a`, `b`) USING BTREE'
    )
  })

  it('writes a prefix length on the columns that have one, and refuses what MySQL lacks', () => {
    expect(createIndexSql('mysql', my, index({ lengths: { a: 10 } }))).toBe(
      'CREATE INDEX `i` ON `d`.`t` (`a`(10), `b`)'
    )
    expect(createIndexSql('mysql', my, index({ lengths: { z: 10 } }))).toBe('CREATE INDEX `i` ON `d`.`t` (`a`, `b`)')
    refuses(() => createIndexSql('mysql', my, index({ method: 'gin' })), 'UNSUPPORTED', /MySQL has no gin index/)
    refuses(
      () => createIndexSql('mysql', my, index({ method: 'hash', kind: 'fulltext' })),
      'UNSUPPORTED',
      /takes no method/
    )
    refuses(
      () => createIndexSql('mysql', my, index({ method: 'btree', kind: 'spatial' })),
      'UNSUPPORTED',
      /takes no method/
    )
  })

  it('writes PostgreSQL with the method before the columns, UNIQUE only for a unique index', () => {
    expect(createIndexSql('postgres', pgNs, index())).toBe('CREATE INDEX "i" ON "s"."t" ("a", "b")')
    expect(createIndexSql('postgres', pgNs, index({ unique: true }))).toBe(
      'CREATE UNIQUE INDEX "i" ON "s"."t" ("a", "b")'
    )
    expect(createIndexSql('postgres', pgNs, index({ method: 'gin' }))).toBe(
      'CREATE INDEX "i" ON "s"."t" USING gin ("a", "b")'
    )
    expect(createIndexSql('postgres', pgNs, index({ lengths: {} }))).toBe('CREATE INDEX "i" ON "s"."t" ("a", "b")')
    refuses(
      () => createIndexSql('postgres', pgNs, index({ kind: 'fulltext' })),
      'UNSUPPORTED',
      /no FULLTEXT \/ SPATIAL index/
    )
    refuses(
      () => createIndexSql('postgres', pgNs, index({ kind: 'spatial' })),
      'UNSUPPORTED',
      /no FULLTEXT \/ SPATIAL index/
    )
    refuses(() => createIndexSql('postgres', pgNs, index({ lengths: { a: 5 } })), 'UNSUPPORTED', /no prefix length/)
  })

  it("writes MySQL's ALTER clause for the primary key and for a named index", () => {
    expect(mysqlAddIndexClause(index(), true)).toBe('ADD PRIMARY KEY (`a`, `b`)')
    expect(mysqlAddIndexClause(index({ kind: 'unique', method: 'btree' }), false)).toBe(
      'ADD UNIQUE INDEX `i` (`a`, `b`) USING BTREE'
    )
    expect(mysqlAddIndexClause(index(), false)).toBe('ADD INDEX `i` (`a`, `b`)')
  })

  it('names the key of a new column after the table and column, a unique one apart from a plain one', () => {
    const add = (key: 'primary' | 'unique' | 'index', build: (op: DdlOp) => string[]) =>
      build({ op: 'addColumn', table: 't', column: col('c', 'int'), key })
    expect(add('primary', (o) => mysqlDdl.build(my, o))[1]).toBe('ALTER TABLE `d`.`t` ADD PRIMARY KEY (`c`)')
    expect(add('unique', (o) => mysqlDdl.build(my, o))[1]).toBe('CREATE UNIQUE INDEX `t_c_key` ON `d`.`t` (`c`)')
    expect(add('index', (o) => mysqlDdl.build(my, o))[1]).toBe('CREATE INDEX `t_c_idx` ON `d`.`t` (`c`)')
    expect(add('unique', (o) => pgDdl.build(pgNs, o))[1]).toBe('CREATE UNIQUE INDEX "t_c_key" ON "s"."t" ("c")')
    expect(add('primary', (o) => pgDdl.build(pgNs, o))[1]).toBe('ALTER TABLE "s"."t" ADD PRIMARY KEY ("c")')
    expect(mysqlDdl.build(my, { op: 'addColumn', table: 't', column: col('c', 'int') })).toHaveLength(1)
  })
})

describe('foreign keys', () => {
  const fk = (extra: Record<string, unknown> = {}) =>
    ({
      op: 'addForeignKey',
      table: 't',
      name: 'k',
      columns: ['a', 'b'],
      refTable: 'p',
      refColumns: ['x', 'y'],
      ...extra,
    }) as Extract<DdlOp, { op: 'addForeignKey' }>

  it('writes the key with its actions, each only when given', () => {
    expect(addForeignKeySql('mysql', my, fk())).toBe(
      'ALTER TABLE `d`.`t` ADD CONSTRAINT `k` FOREIGN KEY (`a`, `b`) REFERENCES `d`.`p` (`x`, `y`)'
    )
    expect(addForeignKeySql('mysql', my, fk({ onUpdate: 'CASCADE', onDelete: 'SET NULL' }))).toMatch(
      / ON UPDATE CASCADE ON DELETE SET NULL$/
    )
    expect(addForeignKeySql('mysql', my, fk({ onUpdate: 'RESTRICT' }))).toMatch(/\(`x`, `y`\) ON UPDATE RESTRICT$/)
    expect(addForeignKeySql('mysql', my, fk({ onDelete: 'NO ACTION' }))).toMatch(/\(`x`, `y`\) ON DELETE NO ACTION$/)
  })

  it('points at the same database or schema unless the key names another', () => {
    expect(addForeignKeySql('mysql', my, fk({ refDatabase: 'o' }))).toContain('REFERENCES `o`.`p`')
    expect(addForeignKeySql('postgres', pgNs, fk())).toContain('REFERENCES "s"."p"')
    expect(addForeignKeySql('postgres', pgNs, fk({ refSchema: 'o' }))).toContain('REFERENCES "o"."p"')
    expect(addForeignKeySql('postgres', { database: 'd' }, fk())).toContain('REFERENCES "public"."p"')
    expect(addForeignKeySql('postgres', pgNs, fk({ refDatabase: 'd' }))).toContain('REFERENCES "s"."p"')
    refuses(() => addForeignKeySql('postgres', pgNs, fk({ refDatabase: 'other' })), 'UNSUPPORTED', /another database/)
  })
})

describe('normalization', () => {
  const split = (extra: Record<string, unknown> = {}) =>
    ({
      op: 'splitTable',
      table: 't',
      newName: 'u',
      keyColumns: ['k'],
      columns: ['a', 'b'],
      dropMoved: false,
      ...extra,
    }) as DdlOp
  const group = (extra: Record<string, unknown> = {}) =>
    ({
      op: 'moveRepeatingGroup',
      table: 't',
      newName: 'u',
      keyColumns: ['k'],
      columns: ['a', 'b'],
      valueColumn: 'v',
      dropMoved: false,
      ...extra,
    }) as DdlOp

  it('splits a table: the distinct key and moved columns into a new table, its key, the link back, and the drop', () => {
    expect(mysqlDdl.build(my, split())).toEqual([
      'CREATE TABLE `d`.`u` AS SELECT DISTINCT `k`, `a`, `b` FROM `d`.`t` WHERE `k` IS NOT NULL',
      'ALTER TABLE `d`.`u` ADD PRIMARY KEY (`k`)',
      'ALTER TABLE `d`.`t` ADD CONSTRAINT `fk_t_u` FOREIGN KEY (`k`) REFERENCES `d`.`u` (`k`)',
    ])
    expect(mysqlDdl.build(my, split({ keyColumns: ['k', 'l'], dropMoved: true }))).toEqual([
      'CREATE TABLE `d`.`u` AS SELECT DISTINCT `k`, `l`, `a`, `b` FROM `d`.`t` WHERE `k` IS NOT NULL AND `l` IS NOT NULL',
      'ALTER TABLE `d`.`u` ADD PRIMARY KEY (`k`, `l`)',
      'ALTER TABLE `d`.`t` ADD CONSTRAINT `fk_t_u` FOREIGN KEY (`k`, `l`) REFERENCES `d`.`u` (`k`, `l`)',
      'ALTER TABLE `d`.`t` DROP COLUMN `a`, DROP COLUMN `b`',
    ])
    expect(pgDdl.build(pgNs, split({ dropMoved: true }))[0]).toBe(
      'CREATE TABLE "s"."u" AS SELECT DISTINCT "k", "a", "b" FROM "s"."t" WHERE "k" IS NOT NULL'
    )
    expect(pgDdl.build(pgNs, split({ dropMoved: true })).at(-1)).toBe(
      'ALTER TABLE "s"."t" DROP COLUMN "a", DROP COLUMN "b"'
    )
  })

  it('names the link within the identifier limits of both servers', () => {
    const long = 'x'.repeat(70)
    const out = mysqlDdl.build(my, split({ table: long }))
    const name = /ADD CONSTRAINT `([^`]*)`/.exec(out[2] ?? '')?.[1] ?? ''
    expect(name).toHaveLength(60)
    expect(name.startsWith('fk_xxx')).toBe(true)
  })

  it('moves a repeating group into rows, one SELECT per column, and indexes the link only on PostgreSQL', () => {
    expect(mysqlDdl.build(my, group())).toEqual([
      'CREATE TABLE `d`.`u` AS SELECT `k`, `a` AS `v` FROM `d`.`t` WHERE `a` IS NOT NULL UNION ALL SELECT `k`, `b` AS `v` FROM `d`.`t` WHERE `b` IS NOT NULL',
      'ALTER TABLE `d`.`u` ADD CONSTRAINT `fk_u_t` FOREIGN KEY (`k`) REFERENCES `d`.`t` (`k`)',
    ])
    const pg = pgDdl.build(pgNs, group({ keyColumns: ['k', 'l'], dropMoved: true }))
    expect(pg[0]).toContain('SELECT "k", "l", "a" AS "v" FROM "s"."t" WHERE "a" IS NOT NULL UNION ALL SELECT')
    expect(pg[1]).toBe('CREATE INDEX "u_k_l_idx" ON "s"."u" ("k", "l")')
    expect(pg[2]).toBe(
      'ALTER TABLE "s"."u" ADD CONSTRAINT "fk_u_t" FOREIGN KEY ("k", "l") REFERENCES "s"."t" ("k", "l")'
    )
    expect(pg[3]).toBe('ALTER TABLE "s"."t" DROP COLUMN "a", DROP COLUMN "b"')
    expect(pgDdl.build(pgNs, group())).toHaveLength(3)
    const long = 'y'.repeat(70)
    expect(/CREATE INDEX "([^"]*)"/.exec(pgDdl.build(pgNs, group({ newName: long }))[1] ?? '')?.[1]).toHaveLength(60)
  })
})
