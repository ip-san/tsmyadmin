import { describe, expect, it } from 'vitest'
import { classifyStatement } from './tracking.ts'

describe('classifyStatement', () => {
  it('names the kind and the table of the statements tracking records', () => {
    expect(classifyStatement('ALTER TABLE `shop`.`or``ders` ADD COLUMN x INT')).toEqual({
      kind: 'alter',
      table: 'or`ders',
      qualifier: 'shop',
    })
    expect(classifyStatement('ALTER TABLE "public"."t" RENAME TO t2')).toEqual({
      kind: 'rename',
      table: 't',
      qualifier: 'public',
    })
    expect(classifyStatement('-- note\n/* x */ INSERT IGNORE INTO t (a) VALUES (1)')).toEqual({
      kind: 'insert',
      table: 't',
    })
    expect(classifyStatement('update ONLY t set a = 1')).toEqual({ kind: 'update', table: 't' })
    expect(classifyStatement('DELETE FROM t WHERE a = 1')).toEqual({ kind: 'delete', table: 't' })
    expect(classifyStatement('CREATE UNIQUE INDEX i ON t (a)')).toEqual({ kind: 'index', table: 't' })
    expect(classifyStatement('DROP INDEX i ON `t`')).toEqual({ kind: 'index', table: 't' })
    expect(classifyStatement('TRUNCATE TABLE t')).toEqual({ kind: 'truncate', table: 't' })
    expect(classifyStatement('DROP TABLE IF EXISTS t')).toEqual({ kind: 'drop', table: 't' })
    expect(classifyStatement('RENAME TABLE t TO u')).toEqual({ kind: 'rename', table: 't' })
    expect(classifyStatement('CREATE TABLE IF NOT EXISTS t (a INT)')).toEqual({ kind: 'create', table: 't' })
    expect(classifyStatement('SELECT * FROM t')).toBeNull()
    expect(classifyStatement('CREATE VIEW v AS SELECT 1')).toBeNull()
  })
})
