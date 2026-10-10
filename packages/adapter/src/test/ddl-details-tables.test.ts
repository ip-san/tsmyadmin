import type { DdlOp } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlDdl } from '../mysql/ddl.ts'
import { col, refuses } from './ddl-helpers.ts'

/** The options, refusals and edges of the MySQL table, partition, event and maintenance ops (see ddl-details.test.ts). */

const mysql = (op: DdlOp) => mysqlDdl.build({ database: 'd' }, op)

describe('MySQL: creating a table', () => {
  const base: Extract<DdlOp, { op: 'createTable' }> = {
    op: 'createTable',
    table: 't',
    columns: [col('id', 'INT')],
    primaryKey: [],
  }

  it('lists the columns and the primary key, with the table options after, only those given', () => {
    expect(mysql(base)).toEqual(['CREATE TABLE `d`.`t` (\n  `id` INT NULL\n)'])
    expect(mysql({ ...base, primaryKey: ['id'], engine: 'InnoDB', collation: 'utf8mb4_bin', comment: "it's" })).toEqual(
      [
        "CREATE TABLE `d`.`t` (\n  `id` INT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE = InnoDB COLLATE = utf8mb4_bin COMMENT = 'it''s'",
      ]
    )
    expect(mysql({ ...base, columns: [col('id', 'INT'), col('x', 'INT')], primaryKey: ['id', 'x'] })[0]).toContain(
      'PRIMARY KEY (`id`, `x`)'
    )
    expect(mysql({ ...base, engine: 'MyISAM' })).toEqual(['CREATE TABLE `d`.`t` (\n  `id` INT NULL\n) ENGINE = MyISAM'])
    expect(mysql({ ...base, collation: 'latin1_bin' })).toEqual([
      'CREATE TABLE `d`.`t` (\n  `id` INT NULL\n) COLLATE = latin1_bin',
    ])
    expect(mysql({ ...base, comment: 'c' })).toEqual(["CREATE TABLE `d`.`t` (\n  `id` INT NULL\n) COMMENT = 'c'"])
  })

  it('refuses a table created already partitioned, which MySQL declares with the partitioning', () => {
    refuses(
      () => mysql({ ...base, partitionBy: { method: 'range', expression: 'id' } }),
      'UNSUPPORTED',
      /create the table, then partition it/
    )
  })
})

describe('MySQL: changing columns', () => {
  it('modifies a column in place, or changes it when it is renamed, placing it first or after another', () => {
    const c = col('a', 'INT')
    expect(mysql({ op: 'modifyColumn', table: 't', name: 'a', column: c })).toEqual([
      'ALTER TABLE `d`.`t` MODIFY COLUMN `a` INT NULL',
    ])
    expect(mysql({ op: 'modifyColumn', table: 't', name: 'a', column: col('b', 'INT'), after: 'x' })).toEqual([
      'ALTER TABLE `d`.`t` CHANGE COLUMN `a` `b` INT NULL AFTER `x`',
    ])
    expect(mysql({ op: 'modifyColumn', table: 't', name: 'a', column: c, first: true, after: 'x' })).toEqual([
      'ALTER TABLE `d`.`t` MODIFY COLUMN `a` INT NULL FIRST',
    ])
  })

  it('changes several columns in one statement, each by the kind of change it is', () => {
    expect(
      mysql({
        op: 'modifyColumns',
        table: 't',
        changes: [
          { name: 'a', column: col('a', 'BIGINT') },
          { name: 'b', column: col('c', 'TEXT') },
        ],
      })
    ).toEqual(['ALTER TABLE `d`.`t` MODIFY COLUMN `a` BIGINT NULL, CHANGE COLUMN `b` `c` TEXT NULL'])
  })

  it('puts each column in its new place by its full definition: the first FIRST, the others after the one before', () => {
    expect(
      mysql({ op: 'reorderColumns', table: 't', columns: [col('b', 'INT'), col('a', 'TEXT'), col('c', 'INT')] })
    ).toEqual([
      'ALTER TABLE `d`.`t` MODIFY COLUMN `b` INT NULL FIRST, MODIFY COLUMN `a` TEXT NULL AFTER `b`, MODIFY COLUMN `c` INT NULL AFTER `a`',
    ])
  })

  it('adds a column first or after another, with a key on it when asked', () => {
    expect(mysql({ op: 'addColumn', table: 't', column: col('n', 'INT'), first: true })).toEqual([
      'ALTER TABLE `d`.`t` ADD COLUMN `n` INT NULL FIRST',
    ])
    expect(mysql({ op: 'addColumn', table: 't', column: col('n', 'INT'), after: 'id', first: false })).toEqual([
      'ALTER TABLE `d`.`t` ADD COLUMN `n` INT NULL AFTER `id`',
    ])
    expect(mysql({ op: 'addColumn', table: 't', column: col('n', 'INT'), key: 'unique' })[1]).toContain('UNIQUE')
  })

  it('drops the primary key first only when one is there to replace', () => {
    expect(mysql({ op: 'setPrimaryKey', table: 't', columns: ['a', 'b'] })).toEqual([
      'ALTER TABLE `d`.`t` ADD PRIMARY KEY (`a`, `b`)',
    ])
    expect(mysql({ op: 'setPrimaryKey', table: 't', columns: ['a'], current: 'PRIMARY' })).toEqual([
      'ALTER TABLE `d`.`t` DROP PRIMARY KEY, ADD PRIMARY KEY (`a`)',
    ])
  })

  it('replaces an index in one statement, as the primary key or as a named index', () => {
    const index = { name: 'n', columns: ['a'], unique: true }
    const alter = (name: string) => mysql({ op: 'alterIndex', table: 't', name, index } as DdlOp)[0]
    expect(alter('PRIMARY')).toMatch(/^ALTER TABLE `d`\.`t` DROP PRIMARY KEY, ADD /)
    expect(alter('old')).toMatch(/^ALTER TABLE `d`\.`t` DROP INDEX `old`, ADD /)
  })

  it('drops and renames the objects it is told to', () => {
    expect(mysql({ op: 'dropTable', table: 't', kind: 'table' })).toEqual(['DROP TABLE `d`.`t`'])
    expect(mysql({ op: 'dropTable', table: 't', kind: 'view' })).toEqual(['DROP VIEW `d`.`t`'])
    expect(mysql({ op: 'dropTable', table: 't', kind: 'sequence' })).toEqual(['DROP SEQUENCE `d`.`t`'])
    expect(mysql({ op: 'renameTable', table: 't', newName: 'u' })).toEqual(['RENAME TABLE `d`.`t` TO `d`.`u`'])
    expect(
      mysql({
        op: 'renameTables',
        renames: [
          { from: 'a', to: 'b' },
          { from: 'c', to: 'd' },
        ],
      })
    ).toEqual(['RENAME TABLE `d`.`a` TO `d`.`b`, `d`.`c` TO `d`.`d`'])
    expect(mysql({ op: 'dropTables', tables: ['a', 'b'] })).toEqual(['DROP TABLE `d`.`a`, `d`.`b`'])
    expect(mysql({ op: 'truncateTables', tables: ['a', 'b'] })).toEqual([
      'TRUNCATE TABLE `d`.`a`',
      'TRUNCATE TABLE `d`.`b`',
    ])
  })

  it('drops mixed objects tables-and-views-first-safe, each with IF EXISTS', () => {
    const out = mysql({
      op: 'dropObjects',
      objects: [
        { kind: 'table', name: 't' },
        { kind: 'view', name: 'v' },
        { kind: 'sequence', name: 's' },
      ],
    })
    expect(out).toHaveLength(3)
    expect(out).toContain('DROP TABLE IF EXISTS `d`.`t`')
    expect(out).toContain('DROP VIEW IF EXISTS `d`.`v`')
    expect(out).toContain('DROP SEQUENCE IF EXISTS `d`.`s`')
    // A view goes before the table it reads from.
    expect(out.indexOf('DROP VIEW IF EXISTS `d`.`v`')).toBeLessThan(out.indexOf('DROP TABLE IF EXISTS `d`.`t`'))
  })
})

describe('MySQL: table options', () => {
  const opts = (extra: Record<string, unknown>) => mysql({ op: 'setTableOptions', table: 't', ...extra } as DdlOp)

  it('lists the options given, in a fixed order, and refuses when none is given', () => {
    expect(
      opts({
        comment: "it's",
        engine: 'InnoDB',
        collation: 'utf8mb4_bin',
        autoIncrement: '9',
        rowFormat: 'DYNAMIC',
        checksum: true,
        packKeys: '1',
        delayKeyWrite: false,
        transactional: true,
        pageChecksum: false,
        statsPersistent: 'DEFAULT',
        statsAutoRecalc: '0',
      })
    ).toEqual([
      "ALTER TABLE `d`.`t` COMMENT = 'it''s', ENGINE = InnoDB, COLLATE = utf8mb4_bin, AUTO_INCREMENT = 9, ROW_FORMAT = DYNAMIC, CHECKSUM = 1, PACK_KEYS = 1, DELAY_KEY_WRITE = 0, TRANSACTIONAL = 1, PAGE_CHECKSUM = 0, STATS_PERSISTENT = DEFAULT, STATS_AUTO_RECALC = 0",
    ])
    refuses(() => opts({}), 'VALIDATION', /No table option to change/)
  })

  it('writes each option alone, a boolean as 1 or 0, and a cleared comment as an empty string', () => {
    expect(opts({ comment: null })).toEqual(["ALTER TABLE `d`.`t` COMMENT = ''"])
    expect(opts({ comment: '' })).toEqual(["ALTER TABLE `d`.`t` COMMENT = ''"])
    expect(opts({ engine: 'MyISAM' })).toEqual(['ALTER TABLE `d`.`t` ENGINE = MyISAM'])
    expect(opts({ collation: 'latin1_bin' })).toEqual(['ALTER TABLE `d`.`t` COLLATE = latin1_bin'])
    expect(opts({ autoIncrement: '5' })).toEqual(['ALTER TABLE `d`.`t` AUTO_INCREMENT = 5'])
    expect(opts({ rowFormat: 'COMPACT' })).toEqual(['ALTER TABLE `d`.`t` ROW_FORMAT = COMPACT'])
    expect(opts({ checksum: false })).toEqual(['ALTER TABLE `d`.`t` CHECKSUM = 0'])
    expect(opts({ checksum: true })).toEqual(['ALTER TABLE `d`.`t` CHECKSUM = 1'])
    expect(opts({ packKeys: 'DEFAULT' })).toEqual(['ALTER TABLE `d`.`t` PACK_KEYS = DEFAULT'])
    expect(opts({ delayKeyWrite: true })).toEqual(['ALTER TABLE `d`.`t` DELAY_KEY_WRITE = 1'])
    expect(opts({ transactional: false })).toEqual(['ALTER TABLE `d`.`t` TRANSACTIONAL = 0'])
    expect(opts({ pageChecksum: true })).toEqual(['ALTER TABLE `d`.`t` PAGE_CHECKSUM = 1'])
    expect(opts({ statsPersistent: '1' })).toEqual(['ALTER TABLE `d`.`t` STATS_PERSISTENT = 1'])
    expect(opts({ statsAutoRecalc: 'DEFAULT' })).toEqual(['ALTER TABLE `d`.`t` STATS_AUTO_RECALC = DEFAULT'])
  })

  it('converts a table to the character set its collation name begins with, or to binary', () => {
    expect(mysql({ op: 'convertCollation', table: 't', collation: 'utf8mb4_0900_ai_ci' })).toEqual([
      'ALTER TABLE `d`.`t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    ])
    expect(mysql({ op: 'convertCollation', table: 't', collation: 'binary' })).toEqual([
      'ALTER TABLE `d`.`t` CONVERT TO CHARACTER SET binary COLLATE binary',
    ])
  })

  it('orders a table by a column, descending when asked, and refuses without a column', () => {
    expect(mysql({ op: 'orderTable', table: 't', column: 'a' })).toEqual(['ALTER TABLE `d`.`t` ORDER BY `a`'])
    expect(mysql({ op: 'orderTable', table: 't', column: 'a', desc: true })).toEqual([
      'ALTER TABLE `d`.`t` ORDER BY `a` DESC',
    ])
    expect(mysql({ op: 'orderTable', table: 't', column: 'a', desc: false })).toEqual([
      'ALTER TABLE `d`.`t` ORDER BY `a`',
    ])
    refuses(() => mysql({ op: 'orderTable', table: 't', index: 'i' }), 'VALIDATION', /orders a table by a column/)
  })
})

describe('MySQL: maintenance', () => {
  it('maintains one table, with the statement each action names', () => {
    const run = (action: string) => mysql({ op: 'maintainTable', table: 't', action } as DdlOp)
    expect(run('analyze')).toEqual(['ANALYZE TABLE `d`.`t`'])
    expect(run('optimize')).toEqual(['OPTIMIZE TABLE `d`.`t`'])
    expect(run('check')).toEqual(['CHECK TABLE `d`.`t`'])
    expect(run('repair')).toEqual(['REPAIR TABLE `d`.`t`'])
    expect(run('checksum')).toEqual(['CHECKSUM TABLE `d`.`t`'])
    expect(run('flush')).toEqual(['FLUSH TABLES `d`.`t`'])
    refuses(() => run('vacuum'), 'UNSUPPORTED', /no VACUUM/)
  })

  it('maintains several tables in one statement, and has no VACUUM', () => {
    const run = (action: string) => mysql({ op: 'maintainTables', tables: ['a', 'b'], action } as DdlOp)
    expect(run('analyze')).toEqual(['ANALYZE TABLE `d`.`a`, `d`.`b`'])
    expect(run('checksum')).toEqual(['CHECKSUM TABLE `d`.`a`, `d`.`b`'])
    refuses(() => run('vacuum'), 'UNSUPPORTED', /no VACUUM/)
  })

  it('truncates and empties a table', () => {
    expect(mysql({ op: 'truncateTable', table: 't' })).toEqual(['TRUNCATE TABLE `d`.`t`'])
  })
})

describe('MySQL: copying a table', () => {
  const copy = (extra: Record<string, unknown> = {}) =>
    mysql({ op: 'copyTable', table: 't', newName: 'u', withData: true, ...extra } as DdlOp)

  it('creates the copy like the source and fills it, with the listed columns or all of them', () => {
    expect(copy()).toEqual(['CREATE TABLE `d`.`u` LIKE `d`.`t`', 'INSERT INTO `d`.`u` SELECT * FROM `d`.`t`'])
    expect(copy({ columns: ['a', 'b'] })).toEqual([
      'CREATE TABLE `d`.`u` LIKE `d`.`t`',
      'INSERT INTO `d`.`u` (`a`, `b`) SELECT `a`, `b` FROM `d`.`t`',
    ])
    expect(copy({ columns: [] })[1]).toBe('INSERT INTO `d`.`u` SELECT * FROM `d`.`t`')
    expect(copy({ withData: false })).toEqual(['CREATE TABLE `d`.`u` LIKE `d`.`t`'])
  })

  it('copies into another database, drops a table of that name first when asked, and can copy rows only', () => {
    expect(copy({ toDatabase: 'e', withData: false, dropExisting: true })).toEqual([
      'DROP TABLE IF EXISTS `e`.`u`',
      'CREATE TABLE `e`.`u` LIKE `d`.`t`',
    ])
    expect(copy({ structure: false })).toEqual(['INSERT INTO `d`.`u` SELECT * FROM `d`.`t`'])
    expect(copy({ structure: true, withData: false })).toHaveLength(1)
    refuses(() => copy({ structure: false, dropExisting: true }), 'VALIDATION', /cannot drop the table it copies into/)
  })

  it('adds foreign keys to the copy, still pointing at the source database unless the key names another', () => {
    const fk = { name: 'k', columns: ['x'], refTable: 'p', refColumns: ['id'] }
    expect(copy({ withData: false, toDatabase: 'e', foreignKeys: [fk] }).at(-1)).toBe(
      'ALTER TABLE `e`.`u` ADD CONSTRAINT `k` FOREIGN KEY (`x`) REFERENCES `d`.`p` (`id`)'
    )
    expect(copy({ withData: false, toDatabase: 'e', foreignKeys: [{ ...fk, refDatabase: 'z' }] }).at(-1)).toContain(
      'REFERENCES `z`.`p`'
    )
  })

  it('copies several tables under their own names, into another database, with the details the preview filled', () => {
    expect(
      mysql({
        op: 'copyTables',
        tables: ['a', 'b'],
        toDatabase: 'e',
        withData: true,
        details: { a: { columns: ['x'] } },
      })
    ).toEqual([
      'CREATE TABLE `e`.`a` LIKE `d`.`a`',
      'INSERT INTO `e`.`a` (`x`) SELECT `x` FROM `d`.`a`',
      'CREATE TABLE `e`.`b` LIKE `d`.`b`',
      'INSERT INTO `e`.`b` SELECT * FROM `d`.`b`',
    ])
    expect(mysql({ op: 'copyTables', tables: ['a'], withData: false })).toEqual(['CREATE TABLE `d`.`a` LIKE `d`.`a`'])
  })
})

describe('MySQL: partitions', () => {
  it('partitions by hash or key into a count of partitions, or the server default count', () => {
    expect(
      mysql({ op: 'partitionTable', table: 't', method: 'hash', expression: 'id', partitions: [], count: 4 })
    ).toEqual(['ALTER TABLE `d`.`t` PARTITION BY HASH (id) PARTITIONS 4'])
    expect(mysql({ op: 'partitionTable', table: 't', method: 'key', expression: 'id', partitions: [] })).toEqual([
      'ALTER TABLE `d`.`t` PARTITION BY KEY (id)',
    ])
  })

  it('partitions by range or list with each partition and its bound, and refuses with none', () => {
    expect(
      mysql({
        op: 'partitionTable',
        table: 't',
        method: 'range',
        expression: 'id',
        partitions: [
          { name: 'p0', bound: 'VALUES LESS THAN (10)' },
          { name: 'p1', bound: '' },
        ],
      })
    ).toEqual([
      'ALTER TABLE `d`.`t` PARTITION BY RANGE (id) (\n  PARTITION `p0` VALUES LESS THAN (10),\n  PARTITION `p1`\n)',
    ])
    refuses(
      () => mysql({ op: 'partitionTable', table: 't', method: 'list', expression: 'id', partitions: [] }),
      'VALIDATION',
      /needs its partitions/
    )
  })

  it('adds, drops, truncates and maintains a partition, removes partitioning, and cannot detach one', () => {
    expect(mysql({ op: 'addPartition', table: 't', partition: { name: 'p', bound: 'VALUES IN (1)' } })).toEqual([
      'ALTER TABLE `d`.`t` ADD PARTITION (PARTITION `p` VALUES IN (1))',
    ])
    expect(mysql({ op: 'addPartition', table: 't', partition: { name: 'p', bound: '' } })).toEqual([
      'ALTER TABLE `d`.`t` ADD PARTITION (PARTITION `p`)',
    ])
    expect(mysql({ op: 'dropPartition', table: 't', name: 'p' })).toEqual(['ALTER TABLE `d`.`t` DROP PARTITION `p`'])
    expect(mysql({ op: 'truncatePartition', table: 't', name: 'p' })).toEqual([
      'ALTER TABLE `d`.`t` TRUNCATE PARTITION `p`',
    ])
    expect(mysql({ op: 'removePartitioning', table: 't' })).toEqual(['ALTER TABLE `d`.`t` REMOVE PARTITIONING'])
    expect(mysql({ op: 'maintainPartition', table: 't', name: 'p', action: 'rebuild' })).toEqual([
      'ALTER TABLE `d`.`t` REBUILD PARTITION `p`',
    ])
    refuses(() => mysql({ op: 'detachPartition', table: 't', name: 'p' }), 'UNSUPPORTED', /no DETACH PARTITION/)
  })
})

describe('MySQL: triggers and events', () => {
  it('creates a trigger with its timing, event and body, and its definer when given', () => {
    expect(
      mysql({
        op: 'createTrigger',
        name: 'g',
        table: 't',
        timing: 'BEFORE',
        event: 'INSERT',
        body: ' SET NEW.a = 1; ',
        definer: { user: 'u', host: 'h' },
      })
    ).toEqual(["CREATE DEFINER = 'u'@'h' TRIGGER `d`.`g` BEFORE INSERT ON `d`.`t` FOR EACH ROW SET NEW.a = 1"])
    expect(mysql({ op: 'dropTrigger', name: 'g', table: 't' })).toEqual(['DROP TRIGGER `d`.`g`'])
    expect(
      mysql({
        op: 'replaceTrigger',
        name: 'g',
        table: 't',
        timing: 'AFTER',
        event: 'DELETE',
        body: 'SELECT 1',
        replaces: { name: 'old', table: 't' },
      })
    ).toEqual(['DROP TRIGGER `d`.`old`', 'CREATE TRIGGER `d`.`g` AFTER DELETE ON `d`.`t` FOR EACH ROW SELECT 1'])
  })

  it('creates an event at a moment, or every so often with its start and end, and its options', () => {
    expect(
      mysql({
        op: 'createEvent',
        name: 'e',
        schedule: { kind: 'at', at: '2030-01-01 00:00:00' },
        body: 'SELECT 1;',
        enabled: false,
        preserve: true,
        comment: 'c',
        definer: { user: 'u', host: 'h' },
      })
    ).toEqual([
      "CREATE DEFINER = 'u'@'h' EVENT `d`.`e` ON SCHEDULE AT '2030-01-01 00:00:00' ON COMPLETION PRESERVE DISABLE COMMENT 'c' DO SELECT 1",
    ])
    expect(
      mysql({
        op: 'createEvent',
        name: 'e',
        schedule: {
          kind: 'every',
          interval: 5,
          unit: 'MINUTE',
          starts: '2030-01-01 00:00:00',
          ends: '2031-01-01 00:00:00',
        },
        body: 'SELECT 1',
        enabled: true,
      })
    ).toEqual([
      "CREATE EVENT `d`.`e` ON SCHEDULE EVERY 5 MINUTE STARTS '2030-01-01 00:00:00' ENDS '2031-01-01 00:00:00' ON COMPLETION NOT PRESERVE ENABLE DO SELECT 1",
    ])
    expect(
      mysql({
        op: 'createEvent',
        name: 'e',
        schedule: { kind: 'every', interval: 1, unit: 'DAY' },
        body: 'SELECT 1',
        enabled: true,
      })
    ).toEqual(['CREATE EVENT `d`.`e` ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE ENABLE DO SELECT 1'])
  })

  it('enables, disables, drops and replaces an event', () => {
    expect(mysql({ op: 'enableEvent', name: 'e' })).toEqual(['ALTER EVENT `d`.`e` ENABLE'])
    expect(mysql({ op: 'disableEvent', name: 'e' })).toEqual(['ALTER EVENT `d`.`e` DISABLE'])
    expect(mysql({ op: 'dropEvent', name: 'e' })).toEqual(['DROP EVENT `d`.`e`'])
    expect(
      mysql({
        op: 'replaceEvent',
        name: 'e',
        replaces: 'old',
        schedule: { kind: 'at', at: '2030-01-01 00:00:00' },
        body: 'SELECT 1',
        enabled: true,
      })
    ).toEqual([
      'DROP EVENT `d`.`old`',
      "CREATE EVENT `d`.`e` ON SCHEDULE AT '2030-01-01 00:00:00' ON COMPLETION NOT PRESERVE ENABLE DO SELECT 1",
    ])
  })
})
