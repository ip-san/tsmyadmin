import type { DdlOp } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlDdl } from '../mysql/ddl.ts'
import { pgDdl } from '../postgres/ddl.ts'

describe('DDL builders: indexes', () => {
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

  it('builds and drops an index without stopping writes in each dialect, and refuses where MySQL cannot', () => {
    const op: DdlOp = { op: 'addIndex', table: 't', name: 'i', columns: ['a'], unique: true, online: true }
    const drop: DdlOp = { op: 'dropIndex', table: 't', name: 'i', online: true }
    const myNs = { database: 'db' }
    const pgNs = { database: 'db', schema: 'app' }
    expect(mysqlDdl.build(myNs, op)).toEqual(['CREATE UNIQUE INDEX `i` ON `db`.`t` (`a`) ALGORITHM=INPLACE LOCK=NONE'])
    expect(mysqlDdl.build(myNs, { ...op, method: 'btree' })).toEqual([
      'CREATE UNIQUE INDEX `i` ON `db`.`t` (`a`) USING BTREE ALGORITHM=INPLACE LOCK=NONE',
    ])
    expect(pgDdl.build(pgNs, op)).toEqual(['CREATE UNIQUE INDEX CONCURRENTLY "i" ON "app"."t" ("a")'])
    expect(mysqlDdl.build(myNs, drop)).toEqual(['ALTER TABLE `db`.`t` DROP INDEX `i`, ALGORITHM=INPLACE, LOCK=NONE'])
    expect(pgDdl.build(pgNs, drop)).toEqual(['DROP INDEX CONCURRENTLY "app"."i"'])
    expect(() => mysqlDdl.build(myNs, { ...op, kind: 'fulltext' })).toThrow(/without stopping writes/)
    expect(() => mysqlDdl.build(myNs, { ...op, kind: 'spatial' })).toThrow(/without stopping writes/)
  })

  it('drops first an unusable index of the name, where the server found one (PostgreSQL)', () => {
    const op: DdlOp = {
      op: 'addIndex',
      table: 't',
      name: 'i',
      columns: ['a'],
      unique: false,
      online: true,
      comment: 'c',
      replacesUnusable: true,
    }
    const pgNs = { database: 'db', schema: 'app' }
    expect(pgDdl.build(pgNs, op)).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "app"."i"',
      'CREATE INDEX CONCURRENTLY "i" ON "app"."t" ("a")',
      `COMMENT ON INDEX "app"."i" IS 'c'`,
    ])
    expect(pgDdl.build(pgNs, { ...op, online: false })).toEqual([
      'BEGIN',
      'DROP INDEX IF EXISTS "app"."i"',
      'CREATE INDEX "i" ON "app"."t" ("a")',
      `COMMENT ON INDEX "app"."i" IS 'c'`,
      'COMMIT',
    ])
    // Without a comment too: the leftover is not dropped where the build then fails.
    expect(pgDdl.build(pgNs, { ...op, online: false, comment: undefined } as DdlOp)).toEqual([
      'BEGIN',
      'DROP INDEX IF EXISTS "app"."i"',
      'CREATE INDEX "i" ON "app"."t" ("a")',
      'COMMIT',
    ])
    // MySQL leaves no index from a build cut short: nothing to drop.
    expect(mysqlDdl.build({ database: 'db' }, op)).toEqual([
      "CREATE INDEX `i` ON `db`.`t` (`a`) COMMENT 'c' ALGORITHM=INPLACE LOCK=NONE",
    ])
  })

  it("keeps an index's comment in each dialect: in the index on MySQL, a statement after it on PostgreSQL", () => {
    const op: DdlOp = {
      op: 'addIndex',
      table: 't',
      name: 'i',
      columns: ['a'],
      unique: false,
      online: true,
      comment: "it's",
    }
    const myNs = { database: 'db' }
    const pgNs = { database: 'db', schema: 'app' }
    expect(mysqlDdl.build(myNs, op)).toEqual([
      "CREATE INDEX `i` ON `db`.`t` (`a`) COMMENT 'it''s' ALGORITHM=INPLACE LOCK=NONE",
    ])
    expect(pgDdl.build(pgNs, op)).toEqual([
      'CREATE INDEX CONCURRENTLY "i" ON "app"."t" ("a")',
      `COMMENT ON INDEX "app"."i" IS 'it''s'`,
    ])
    // Not built concurrently: made and marked together, or neither.
    expect(pgDdl.build(pgNs, { ...op, online: false })).toEqual([
      'BEGIN',
      'CREATE INDEX "i" ON "app"."t" ("a")',
      `COMMENT ON INDEX "app"."i" IS 'it''s'`,
      'COMMIT',
    ])
    // Changed, the index keeps it.
    const alter: DdlOp = {
      op: 'alterIndex',
      table: 't',
      name: 'i',
      index: { name: 'i', columns: ['a', 'b'], unique: false, comment: 'kept' },
    }
    expect(mysqlDdl.build(myNs, alter)).toEqual([
      "ALTER TABLE `db`.`t` DROP INDEX `i`, ADD INDEX `i` (`a`, `b`) COMMENT 'kept'",
    ])
    expect(pgDdl.build(pgNs, alter)).toEqual([
      'BEGIN',
      'DROP INDEX "app"."i"',
      'CREATE INDEX "i" ON "app"."t" ("a", "b")',
      `COMMENT ON INDEX "app"."i" IS 'kept'`,
      'COMMIT',
    ])
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
})
