import type { EventInfo, TableSchema, TriggerInfo } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlExporter } from '../mysql/export.ts'
import { pgAdvanceSequence, pgExporter } from '../postgres/export.ts'
import { commentText, createNamespaceStatements, createTableFromColumns } from '../sql/export.ts'
import type { DropTarget } from '../types.ts'
import { refuses } from './ddl-helpers.ts'

/**
 * The details of the dump text that the snapshot in export.test.ts does not pin: every option of an INSERT, the
 * DROPs before a restore, the programs of each server, and the sequence advance. A dump is what a restore runs, so a
 * wrong word here is a wrong restore (found as surviving mutants; see `bun run mutation`).
 */

const ns = { database: 'db', schema: 'app' }
const insert = (exporter: typeof mysqlExporter, columns: string[], rows: unknown[][], options = {}) =>
  exporter.insert(ns, 't', columns, rows as never, options)

describe('commentText and the statements a dump makes its own', () => {
  it('turns every run of line breaks in a comment into one space, so a name cannot start a statement', () => {
    expect(commentText('a\nDROP TABLE x')).toBe('a DROP TABLE x')
    expect(commentText('a\r\n\r\nb\rc')).toBe('a b c')
    expect(commentText('plain')).toBe('plain')
  })

  it('creates the schema in the public schema when none is named, and quotes what it creates', () => {
    expect(createNamespaceStatements('postgres', { database: 'd' })).toEqual(['CREATE SCHEMA IF NOT EXISTS "public";'])
    expect(createNamespaceStatements('postgres', { database: 'd', schema: 's"x' })).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "s""x";',
    ])
    expect(createNamespaceStatements('mysql', { database: 'a`b' })).toEqual([
      'CREATE DATABASE IF NOT EXISTS `a``b`;',
      'USE `a``b`;',
    ])
  })

  it('writes the columns of a view as a table, NOT NULL only where the column is', () => {
    expect(
      createTableFromColumns('mysql', 'v', [
        { name: 'a', dataType: 'int', nullable: false },
        { name: 'b', dataType: 'text', nullable: true },
      ])
    ).toBe('CREATE TABLE `v` (\n  `a` int NOT NULL,\n  `b` text\n)')
  })

  it('names the dumped database in the first line of a MySQL dump, on one line, then sets the modes', () => {
    const lines = mysqlExporter.preamble({ database: 'a\nb' })
    expect(lines[0]).toBe('-- Database: a b (statements are unqualified: import into the database of your choice)')
    expect(lines.slice(1)).toEqual([
      "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
      'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;',
    ])
    expect(mysqlExporter.postamble()).toEqual([
      'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;',
      'SET SQL_MODE = @OLD_SQL_MODE;',
    ])
    expect(pgExporter.preamble(ns)).toEqual([
      'SET search_path TO "app";',
      'SET check_function_bodies = false;',
      'SET standard_conforming_strings = on;',
    ])
    expect(pgExporter.preamble({ database: 'd' })[0]).toBe('SET search_path TO "public";')
    expect(pgExporter.postamble()).toEqual([])
  })
})

describe('INSERT: every option', () => {
  it('writes the rows as one statement, a missing cell as NULL, and nothing for no rows', () => {
    expect(insert(mysqlExporter, ['id', 'n'], [[1, 'x'], [2]])).toBe(
      "INSERT INTO `t` (`id`, `n`) VALUES\n(1, 'x'),\n(2, NULL);"
    )
    expect(insert(pgExporter, ['id', 'n'], [[1, 'x']])).toBe('INSERT INTO "app"."t" ("id", "n") VALUES\n(1, \'x\');')
    expect(insert(mysqlExporter, ['id'], [])).toBe('')
    expect(insert(pgExporter, ['id'], [])).toBe('')
  })

  it('leaves out the column list when asked, and writes one statement per row when not extended', () => {
    expect(insert(mysqlExporter, ['id', 'n'], [[1, 'x']], { columnNames: false })).toBe(
      "INSERT INTO `t` VALUES\n(1, 'x');"
    )
    expect(insert(mysqlExporter, ['id', 'n'], [[1, 'x']], { columnNames: true })).toContain('(`id`, `n`)')
    expect(insert(mysqlExporter, ['id'], [[1], [2]], { extended: false })).toBe(
      'INSERT INTO `t` (`id`) VALUES\n(1);\nINSERT INTO `t` (`id`) VALUES\n(2);'
    )
    expect(insert(mysqlExporter, ['id'], [[1], [2]], { extended: true })).toBe(
      'INSERT INTO `t` (`id`) VALUES\n(1),\n(2);'
    )
  })

  it('starts a new statement before the byte limit would be passed, and sends a row longer than it alone', () => {
    const head = 'INSERT INTO `t` (`id`) VALUES\n'
    const rows = [[1], [2], [3]]
    expect(insert(mysqlExporter, ['id'], rows, { maxQuery: head.length + 10 })).toBe(`${head}(1),\n(2);\n${head}(3);`)
    expect(insert(mysqlExporter, ['id'], rows, { maxQuery: head.length + 9 })).toBe(
      `${head}(1);\n${head}(2);\n${head}(3);`
    )
    expect(insert(mysqlExporter, ['id'], rows, { maxQuery: 1 })).toBe(`${head}(1);\n${head}(2);\n${head}(3);`)
    expect(insert(mysqlExporter, ['id'], rows, { maxQuery: head.length + 15 })).toBe(`${head}(1),\n(2),\n(3);`)
    // No limit, or one that is not positive, means one statement.
    expect(insert(mysqlExporter, ['id'], rows, { maxQuery: 0 })).toBe(`${head}(1),\n(2),\n(3);`)
    expect(insert(mysqlExporter, ['id'], rows, { maxQuery: -5 })).toBe(`${head}(1),\n(2),\n(3);`)
  })

  it('writes REPLACE and INSERT IGNORE on MySQL, and ON CONFLICT on PostgreSQL', () => {
    expect(insert(mysqlExporter, ['id', 'n'], [[1, 'x']], { kind: 'replace' })).toBe(
      "REPLACE INTO `t` (`id`, `n`) VALUES\n(1, 'x');"
    )
    expect(insert(mysqlExporter, ['id'], [[1]], { ignore: true })).toBe('INSERT IGNORE INTO `t` (`id`) VALUES\n(1);')
    expect(insert(mysqlExporter, ['id'], [[1]], { kind: 'replace', ignore: true })).toMatch(/^REPLACE INTO/)
    const keyed = { kind: 'replace', keyColumns: ['id'] } as const
    expect(insert(pgExporter, ['id', 'a', 'b'], [[1, 2, 3]], keyed)).toBe(
      'INSERT INTO "app"."t" ("id", "a", "b") VALUES\n(1, 2, 3) ON CONFLICT ("id") DO UPDATE SET "a" = EXCLUDED."a", "b" = EXCLUDED."b";'
    )
    expect(insert(pgExporter, ['id'], [[1]], keyed)).toBe(
      'INSERT INTO "app"."t" ("id") VALUES\n(1) ON CONFLICT DO NOTHING;'
    )
    expect(insert(pgExporter, ['id'], [[1]], { ignore: true })).toBe(
      'INSERT INTO "app"."t" ("id") VALUES\n(1) ON CONFLICT DO NOTHING;'
    )
    expect(insert(pgExporter, ['id'], [[1]], { ignore: false })).toBe('INSERT INTO "app"."t" ("id") VALUES\n(1);')
  })

  it('keeps identity values on PostgreSQL by overriding the system value, between the columns and VALUES', () => {
    expect(insert(pgExporter, ['id'], [[1]], { overriding: true })).toBe(
      'INSERT INTO "app"."t" ("id") OVERRIDING SYSTEM VALUE VALUES\n(1);'
    )
    expect(insert(pgExporter, ['id'], [[1]], { overriding: false })).toBe('INSERT INTO "app"."t" ("id") VALUES\n(1);')
    expect(insert(mysqlExporter, ['id'], [[1]], { overriding: true })).toBe('INSERT INTO `t` (`id`) VALUES\n(1);')
  })

  it('updates rows by their key: every other column set, the key in WHERE, a key-only table skipped', () => {
    const upd = { kind: 'update', keyColumns: ['id', 'k'] } as const
    expect(
      insert(
        mysqlExporter,
        ['id', 'k', 'a'],
        [
          [1, 'x', 5],
          [2, 'y', null],
        ],
        upd
      )
    ).toBe(
      "UPDATE `t` SET `a` = 5 WHERE `id` = 1 AND `k` = 'x';\nUPDATE `t` SET `a` = NULL WHERE `id` = 2 AND `k` = 'y';"
    )
    expect(insert(pgExporter, ['a', 'id'], [[5, 1]], { kind: 'update', keyColumns: ['id'] })).toBe(
      'UPDATE "app"."t" SET "a" = 5 WHERE "id" = 1;'
    )
    expect(insert(mysqlExporter, ['id', 'k'], [[1, 'x']], upd)).toBe('')
  })

  it('refuses an update, or on PostgreSQL a replace, without a key', () => {
    refuses(
      () => insert(mysqlExporter, ['id'], [[1]], { kind: 'update' }),
      'VALIDATION',
      /UPDATE needs a primary key on t/
    )
    refuses(
      () => insert(pgExporter, ['id'], [[1]], { kind: 'update' }),
      'VALIDATION',
      /UPDATE needs a primary key on t/
    )
    refuses(
      () => insert(pgExporter, ['id'], [[1]], { kind: 'replace' }),
      'VALIDATION',
      /REPLACE needs a primary key on t/
    )
    expect(insert(mysqlExporter, ['id'], [[1]], { kind: 'replace', keyColumns: [] })).toMatch(/^REPLACE/)
  })
})

describe('the DROPs before a restore', () => {
  const objects: DropTarget[] = [
    { kind: 'view', name: 'v' },
    { kind: 'table', name: 'a' },
    {
      kind: 'routine',
      name: 'f',
      statements: [
        "CREATE OR REPLACE FUNCTION public.f(a integer, b text DEFAULT 'x') RETURNS void LANGUAGE sql AS $$ select 1 $$",
        'create procedure p(IN x int) language sql as $$ select 1 $$',
        'not a create statement',
      ],
    },
    { kind: 'materialized_view', name: 'm' },
    { kind: 'table', name: 'b' },
    { kind: 'sequence', name: 's' },
  ]

  it('drops views and routines as met, then every table in one statement, then the sequences', () => {
    expect(pgExporter.dropAll(ns, objects)).toEqual([
      'DROP VIEW IF EXISTS "app"."v"',
      'DROP FUNCTION IF EXISTS public.f(a integer, b text)',
      'DROP PROCEDURE IF EXISTS p(IN x int)',
      'DROP MATERIALIZED VIEW IF EXISTS "app"."m"',
      'DROP TABLE IF EXISTS "app"."a", "app"."b"',
      'DROP SEQUENCE IF EXISTS "app"."s"',
    ])
    expect(pgExporter.dropAll(ns, [])).toEqual([])
    expect(pgExporter.dropAll(ns, [{ kind: 'sequence', name: 's' }])).toEqual(['DROP SEQUENCE IF EXISTS "app"."s"'])
  })

  it('names MySQL objects without the database, and drops no routine, whose signature it cannot read', () => {
    expect(mysqlExporter.dropAll(ns, objects)).toEqual([
      'DROP VIEW IF EXISTS `v`',
      'DROP MATERIALIZED VIEW IF EXISTS `m`',
      'DROP TABLE IF EXISTS `a`, `b`',
      'DROP SEQUENCE IF EXISTS `s`',
    ])
  })

  it('drops one object by its kind', () => {
    const drop = (kind: TableSchema['kind']) => pgExporter.dropIfExists(ns, { name: 'x', kind })
    expect(drop('table')).toBe('DROP TABLE IF EXISTS "app"."x"')
    expect(drop('view')).toBe('DROP VIEW IF EXISTS "app"."x"')
    expect(drop('materialized_view')).toBe('DROP MATERIALIZED VIEW IF EXISTS "app"."x"')
    expect(drop('sequence')).toBe('DROP SEQUENCE IF EXISTS "app"."x"')
    expect(mysqlExporter.dropIfExists(ns, { name: 'x', kind: 'view' })).toBe('DROP VIEW IF EXISTS `x`')
  })

  describe('reading a routine signature from its CREATE statement', () => {
    const sig = (statement: string) =>
      pgExporter.dropAll(ns, [{ kind: 'routine', name: 'f', statements: [statement] }])[0]

    it('keeps the name as written, the arguments without their defaults', () => {
      expect(sig('CREATE FUNCTION f() RETURNS int AS $$ x $$')).toBe('DROP FUNCTION IF EXISTS f()')
      expect(sig("CREATE FUNCTION f(a int, b text default 'a, b', c int DEFAULT (1 + 2)) RETURNS int")).toBe(
        'DROP FUNCTION IF EXISTS f(a int, b text, c int)'
      )
      expect(sig('CREATE FUNCTION s.f(a numeric(10,2), b int[]) RETURNS int')).toBe(
        'DROP FUNCTION IF EXISTS s.f(a numeric(10,2), b int[])'
      )
      expect(sig('CREATE FUNCTION "my f(x)"(a int) RETURNS int')).toBe('DROP FUNCTION IF EXISTS "my f(x)"(a int)')
      expect(sig('CREATE FUNCTION "q""n"."f g"(a int) RETURNS int')).toBe('DROP FUNCTION IF EXISTS "q""n"."f g"(a int)')
      expect(sig("CREATE FUNCTION f(a text DEFAULT 'x)y') RETURNS int")).toBe('DROP FUNCTION IF EXISTS f(a text)')
      expect(sig('CREATE FUNCTION f(  a   int  ) RETURNS int')).toBe('DROP FUNCTION IF EXISTS f(a   int)')
      expect(sig('CREATE FUNCTION f(a "my type") RETURNS int')).toBe('DROP FUNCTION IF EXISTS f(a "my type")')
    })

    it('skips what it cannot read: no closing parenthesis, no routine, not a CREATE', () => {
      expect(sig('CREATE FUNCTION f(a int')).toBeUndefined()
      expect(sig('CREATE TABLE f(a int)')).toBeUndefined()
      expect(sig('SELECT f(a int)')).toBeUndefined()
      expect(sig('')).toBeUndefined()
    })
  })
})

describe('MySQL programs', () => {
  it('strips the DEFINER of a header, in each way it is quoted, and leaves the same text in a body', () => {
    const strip = (sql: string) => mysqlExporter.withoutDefiner(sql)
    expect(strip('CREATE DEFINER=`root`@`localhost` VIEW v AS SELECT 1')).toBe('CREATE VIEW v AS SELECT 1')
    expect(strip("CREATE DEFINER = 'r'@'h' PROCEDURE p() SELECT 1")).toBe('CREATE PROCEDURE p() SELECT 1')
    expect(strip('CREATE DEFINER="r"@"h" TRIGGER t BEFORE INSERT ON x FOR EACH ROW SELECT 1')).toBe(
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SELECT 1'
    )
    expect(strip('create algorithm = merge definer=`r`@`h` sql security definer view v as select 1')).toBe(
      'create algorithm = merge sql security definer view v as select 1'
    )
    expect(strip("CREATE DEFINER=`a``b`@`c''d` VIEW v AS SELECT 1")).toBe('CREATE VIEW v AS SELECT 1')
    expect(strip("CREATE VIEW v AS SELECT 'DEFINER=`r`@`h` '")).toBe("CREATE VIEW v AS SELECT 'DEFINER=`r`@`h` '")
    expect(strip('CREATE DEFINER=root@localhost VIEW v AS SELECT 1')).toBe(
      'CREATE DEFINER=root@localhost VIEW v AS SELECT 1'
    )
    expect(strip('SELECT 1')).toBe('SELECT 1')
  })

  it('drops a routine first and writes its definition, with or without its DEFINER', () => {
    const def = 'CREATE DEFINER=`r`@`h` PROCEDURE p() SELECT 1'
    expect(mysqlExporter.routine(ns, 'procedure', 'p', def, true)).toEqual({
      sql: 'DROP PROCEDURE IF EXISTS `p`;;\nCREATE PROCEDURE p() SELECT 1',
    })
    expect(mysqlExporter.routine(ns, 'function', 'f`x', def, false)).toEqual({
      sql: `DROP FUNCTION IF EXISTS \`f\`\`x\`;;\n${def}`,
    })
  })

  const trigger = (extra: Partial<TriggerInfo> = {}): TriggerInfo => ({
    name: 'tg',
    table: 'tbl',
    timing: 'BEFORE',
    events: 'INSERT',
    orientation: 'ROW',
    definition: 'BEGIN SET NEW.a = 1; END',
    sqlMode: 'ANSI',
    definer: 'u@h',
    fireMode: 'origin',
    ...extra,
  })

  it('rebuilds the header of a trigger known only by its body, from its metadata', () => {
    expect(mysqlExporter.trigger(ns, trigger(), false)).toEqual({
      sql: 'DROP TRIGGER IF EXISTS `tg`;;\nCREATE DEFINER=`u`@`h` TRIGGER `tg` BEFORE INSERT ON `tbl` FOR EACH ROW\nBEGIN SET NEW.a = 1; END',
      sqlMode: 'ANSI',
    })
    expect(mysqlExporter.trigger(ns, trigger(), true).sql).toContain('CREATE TRIGGER `tg` BEFORE')
    expect(mysqlExporter.trigger(ns, trigger({ definer: null }), false).sql).toContain('CREATE TRIGGER `tg` BEFORE')
    expect(mysqlExporter.trigger(ns, trigger({ definer: 'only' }), false).sql).toContain('DEFINER=`only`@`%` TRIGGER')
    expect(mysqlExporter.trigger(ns, trigger({ definer: 'a@b@c' }), false).sql).toContain('DEFINER=`a@b`@`c` TRIGGER')
    expect(mysqlExporter.trigger(ns, trigger({ definition: null }), false).sql).toMatch(/FOR EACH ROW\n$/)
    expect(mysqlExporter.trigger(ns, trigger({ orientation: 'STATEMENT' }), false).sql).toContain('FOR EACH STATEMENT')
  })

  it("restores a trigger's own CREATE as written, minus the dumped database in its header and the DEFINER when asked", () => {
    const own =
      'CREATE DEFINER=`root`@`localhost` TRIGGER `db`.`tg` BEFORE INSERT ON `db`.`tbl` FOR EACH ROW SELECT `db`.`x` FROM `db`.`y`'
    expect(mysqlExporter.trigger(ns, trigger({ definition: own }), false).sql).toBe(
      'DROP TRIGGER IF EXISTS `tg`;;\nCREATE DEFINER=`root`@`localhost` TRIGGER `tg` BEFORE INSERT ON `tbl` FOR EACH ROW SELECT `db`.`x` FROM `db`.`y`'
    )
    expect(mysqlExporter.trigger(ns, trigger({ definition: own }), true).sql).toContain('\nCREATE TRIGGER `tg` BEFORE')
    // Unquoted qualifiers, other databases and look-alikes stay.
    const plain = 'CREATE TRIGGER db.tg BEFORE INSERT ON other.tbl FOR EACH ROW SELECT 1'
    expect(mysqlExporter.trigger(ns, trigger({ definition: plain }), false).sql).toContain(
      'TRIGGER tg BEFORE INSERT ON other.tbl FOR'
    )
    const near = 'CREATE TRIGGER mydb.tg BEFORE INSERT ON `xdb`.tbl FOR EACH ROW SELECT 1'
    expect(mysqlExporter.trigger(ns, trigger({ definition: near }), false).sql).toContain(
      'TRIGGER mydb.tg BEFORE INSERT ON `xdb`.tbl FOR'
    )
    const dots = 'CREATE TRIGGER a_b.tg BEFORE INSERT ON a_b.tbl FOR EACH ROW SELECT 1'
    expect(mysqlExporter.trigger({ database: 'a.b' }, trigger({ definition: dots }), false).sql).toContain(
      'TRIGGER a_b.tg'
    )
    const noFor = 'CREATE TRIGGER `db`.`tg` weird'
    expect(mysqlExporter.trigger(ns, trigger({ definition: noFor }), false).sql).toContain('TRIGGER `db`.`tg` weird')
  })

  const event = (extra: Partial<EventInfo> = {}): EventInfo => ({
    name: 'ev',
    status: 'ENABLED',
    type: 'RECURRING',
    schedule: 'EVERY 1 DAY',
    starts: null,
    ends: null,
    lastExecuted: null,
    onCompletion: null,
    comment: null,
    definition: 'SELECT 1',
    sqlMode: 'ANSI',
    timeZone: 'UTC',
    definer: 'u@h',
    ...extra,
  })

  it('rebuilds an event known only by its body: schedule, start and end, completion, state, comment, DO', () => {
    expect(
      mysqlExporter.event(
        ns,
        event({
          starts: '2030-01-01 00:00:00',
          ends: '2031-01-01 00:00:00',
          onCompletion: 'PRESERVE',
          comment: "it's",
        }),
        false
      )
    ).toEqual({
      sql: "DROP EVENT IF EXISTS `ev`;;\nCREATE DEFINER=`u`@`h` EVENT `ev` ON SCHEDULE EVERY 1 DAY STARTS '2030-01-01 00:00:00' ENDS '2031-01-01 00:00:00' ON COMPLETION PRESERVE ENABLE COMMENT 'it''s'\nDO SELECT 1",
      sqlMode: 'ANSI',
      timeZone: 'UTC',
    })
    expect(mysqlExporter.event(ns, event(), true).sql).toBe(
      'DROP EVENT IF EXISTS `ev`;;\nCREATE EVENT `ev` ON SCHEDULE EVERY 1 DAY ENABLE\nDO SELECT 1'
    )
    expect(mysqlExporter.event(ns, event({ definer: null }), false).sql).toContain('\nCREATE EVENT `ev`')
    expect(mysqlExporter.event(ns, event({ schedule: 'AT 2030-01-01 00:00:00' }), true).sql).toContain(
      "ON SCHEDULE AT '2030-01-01 00:00:00' ENABLE"
    )
    expect(mysqlExporter.event(ns, event({ status: 'DISABLED' }), true).sql).toContain(' DISABLE\n')
    expect(mysqlExporter.event(ns, event({ status: 'SLAVESIDE_DISABLED' }), true).sql).toContain(' DISABLE\n')
    expect(mysqlExporter.event(ns, event({ definition: null }), true).sql).toMatch(/\nDO $/)
  })

  it("restores an event's own CREATE as written, minus the database before its name and the DEFINER when asked", () => {
    const own = 'CREATE DEFINER=`root`@`localhost` EVENT `db`.`ev` ON SCHEDULE EVERY 1 DAY DO SELECT `db`.`t`'
    expect(mysqlExporter.event(ns, event({ definition: own }), false)).toEqual({
      sql: 'DROP EVENT IF EXISTS `ev`;;\nCREATE DEFINER=`root`@`localhost` EVENT `ev` ON SCHEDULE EVERY 1 DAY DO SELECT `db`.`t`',
      sqlMode: 'ANSI',
      timeZone: 'UTC',
    })
    expect(mysqlExporter.event(ns, event({ definition: own }), true).sql).toContain('\nCREATE EVENT `ev` ON')
    const ifNot = 'CREATE EVENT IF NOT EXISTS db.ev ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    expect(mysqlExporter.event(ns, event({ definition: ifNot }), true).sql).toContain('EVENT IF NOT EXISTS ev ON')
    const other = 'CREATE EVENT `other`.`ev` ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    expect(mysqlExporter.event(ns, event({ definition: other }), true).sql).toContain('EVENT `other`.`ev` ON')
  })

  it("wraps programs in the modes they were created under and restores the dump's own after", () => {
    expect(mysqlExporter.programBlock([])).toBe('')
    const block = mysqlExporter.programBlock([
      { sql: 'S1', sqlMode: 'ANSI', timeZone: 'UTC' },
      { sql: 'S2' },
      { sql: 'S3', sqlMode: '' },
      { sql: 'S4', sqlMode: null, timeZone: '' },
    ])
    expect(block).toBe(
      [
        'SET @tsmyadmin_sql_mode = @@sql_mode;',
        'SET @tsmyadmin_time_zone = @@time_zone;',
        'DELIMITER ;;',
        "SET sql_mode = 'ANSI';;",
        "SET time_zone = 'UTC';;",
        'S1;;',
        '',
        'S2;;',
        '',
        "SET sql_mode = '';;",
        'S3;;',
        '',
        'S4;;',
        '',
        'DELIMITER ;',
        'SET sql_mode = @tsmyadmin_sql_mode;',
        'SET time_zone = @tsmyadmin_time_zone;',
        '',
        '',
      ].join('\n')
    )
    expect(mysqlExporter.afterData(ns, {} as TableSchema)).toEqual([])
  })
})

describe('PostgreSQL programs', () => {
  const trigger = (
    fireMode: TriggerInfo['fireMode'],
    definition: string | null = 'CREATE TRIGGER tg ...'
  ): TriggerInfo => ({
    name: 'tg"x',
    table: 'tbl',
    timing: 'BEFORE',
    events: 'INSERT',
    orientation: 'ROW',
    definition,
    sqlMode: null,
    definer: null,
    fireMode,
  })

  it('drops a trigger and creates it as the server prints it, restoring a mode other than the default', () => {
    const head = 'DROP TRIGGER IF EXISTS "tg""x" ON "app"."tbl";\nCREATE TRIGGER tg ...'
    expect(pgExporter.trigger(ns, trigger('origin'), false)).toEqual({ sql: head })
    expect(pgExporter.trigger(ns, trigger('always'), false).sql).toBe(
      `${head};\nALTER TABLE "app"."tbl" ENABLE ALWAYS TRIGGER "tg""x"`
    )
    expect(pgExporter.trigger(ns, trigger('replica'), false).sql).toBe(
      `${head};\nALTER TABLE "app"."tbl" ENABLE REPLICA TRIGGER "tg""x"`
    )
    expect(pgExporter.trigger(ns, trigger('disabled'), false).sql).toBe(
      `${head};\nALTER TABLE "app"."tbl" DISABLE TRIGGER "tg""x"`
    )
    expect(pgExporter.trigger(ns, trigger('origin', null), false).sql).toBe(
      'DROP TRIGGER IF EXISTS "tg""x" ON "app"."tbl";\n'
    )
  })

  it('takes a routine definition as it is, ends each program with a semicolon, and has no events or definers', () => {
    expect(pgExporter.routine(ns, 'function', 'f', 'CREATE OR REPLACE FUNCTION f() ...', true)).toEqual({
      sql: 'CREATE OR REPLACE FUNCTION f() ...',
    })
    expect(pgExporter.programBlock([{ sql: 'A' }, { sql: 'B' }])).toBe('A;\n\nB;\n\n')
    expect(pgExporter.programBlock([])).toBe('')
    expect(pgExporter.withoutDefiner('CREATE DEFINER=`r`@`h` VIEW v')).toBe('CREATE DEFINER=`r`@`h` VIEW v')
    refuses(() => pgExporter.event(ns, {} as EventInfo, false), 'UNSUPPORTED', /PostgreSQL has no events/)
  })
})

describe('advancing the sequences after the data', () => {
  const column = (name: string, extra: string, def: string | null, dataType = 'integer') => ({
    name,
    extra,
    default: def,
    dataType,
  })
  const schema = (columns: ReturnType<typeof column>[]) => ({ name: 't', columns }) as unknown as TableSchema

  it('advances the sequence of an identity column and the one a nextval() default names, and no other column', () => {
    const out = pgExporter.afterData(
      ns,
      schema([
        column('id', 'identity by default', null),
        column('n', '', "nextval('app.t_n_seq'::regclass)", 'bigint'),
        column('o', '', "nextval('it''s'::regclass)"),
        column('p', '', '5'),
        column('q', '', null),
        column('r', '', "nextval('x'::regclass) + 1"),
      ])
    )
    expect(out).toEqual([
      `${pgAdvanceSequence('"app"."t"', 'id', undefined, 'integer')};`,
      `${pgAdvanceSequence('"app"."t"', 'n', 'app.t_n_seq', 'bigint')};`,
      `${pgAdvanceSequence('"app"."t"', 'o', "it's", 'integer')};`,
    ])
    expect(pgExporter.afterData(ns, schema([column('a', 'auto_increment', null)]))).toEqual([])
  })

  it("names the column's own sequence by default, or the one given, and bounds the probe by the sequence", () => {
    const own = pgAdvanceSequence('"app"."t"', 'id')
    expect(own).toContain(`pg_get_serial_sequence('"app"."t"', 'id')::regclass`)
    expect(own).toContain('WHERE s.seqrelid = pg_get_serial_sequence')
    const named = pgAdvanceSequence('"app"."t"', 'id', "s.q'z")
    expect(named).toContain(`s.seqrelid = 's.q''z'::regclass`)
    expect(named).not.toContain('pg_get_serial_sequence')
    expect(own).toContain(
      '(SELECT MAX("id")::bigint FROM "app"."t" WHERE "id" BETWEEN s.seqmin AND s.seqmax) AS max_id'
    )
    expect(own).toContain(
      '(SELECT MIN("id")::bigint FROM "app"."t" WHERE "id" BETWEEN s.seqmin AND s.seqmax) AS min_id'
    )
    expect(own).toContain(
      'WHEN s.seqincrement > 0 THEN GREATEST(m.max_id, s.seqmin, COALESCE(pg_sequence_last_value(s.seqrelid), s.seqmin))'
    )
    expect(own).toContain('ELSE LEAST(m.min_id, s.seqmax, COALESCE(pg_sequence_last_value(s.seqrelid), s.seqmax))')
    expect(own.endsWith('AND m.max_id IS NOT NULL')).toBe(true)
  })

  it('compares a numeric column directly and any other type through a cast to bigint', () => {
    const probe = (type: string) => pgAdvanceSequence('t', 'c', undefined, type).includes('"c" BETWEEN')
    for (const numeric of [
      'smallint',
      'integer',
      'bigint',
      'int',
      'int2',
      'int4',
      'int8',
      'INT8',
      'numeric(10,2)',
      'decimal',
      'real',
      'double precision',
      'serial',
      'bigserial',
      'smallserial',
      'integer[]',
    ])
      expect(probe(numeric), numeric).toBe(true)
    for (const other of ['oid', 'text', 'uuid', 'integers', 'int16', 'xinteger', 'interval', 'int4range', ''])
      expect(probe(other), other).toBe(false)
    expect(pgAdvanceSequence('t', 'c', undefined, 'oid')).toContain('"c"::bigint BETWEEN')
  })
})

describe('dump boundaries: blanks, anchors and lists', () => {
  const trig = (definition: string | null): TriggerInfo => ({
    name: 'tg',
    table: 'tbl',
    timing: 'BEFORE',
    events: 'INSERT',
    orientation: 'ROW',
    definition,
    sqlMode: null,
    definer: 'u@h',
    fireMode: 'origin',
  })
  const evt = (definition: string | null): EventInfo => ({
    name: 'ev',
    status: 'ENABLED',
    type: 'RECURRING',
    schedule: 'EVERY 1 DAY',
    starts: null,
    ends: null,
    lastExecuted: null,
    onCompletion: null,
    comment: null,
    definition,
    sqlMode: null,
    timeZone: null,
    definer: 'u@h',
  })
  const sig = (statement: string) =>
    pgExporter.dropAll(ns, [{ kind: 'routine', name: 'f', statements: [statement] }])[0]

  it('sets several columns of an update with commas, and has nothing to refuse when there are no rows', () => {
    expect(insert(mysqlExporter, ['id', 'a', 'b'], [[1, 2, 3]], { kind: 'update', keyColumns: ['id'] })).toBe(
      'UPDATE `t` SET `a` = 2, `b` = 3 WHERE `id` = 1;'
    )
    expect(insert(pgExporter, ['id'], [], { kind: 'update' })).toBe('')
    expect(insert(mysqlExporter, ['id'], [], { kind: 'update' })).toBe('')
  })

  it('names every key column in ON CONFLICT', () => {
    expect(insert(pgExporter, ['id', 'k', 'a'], [[1, 2, 3]], { kind: 'replace', keyColumns: ['id', 'k'] })).toContain(
      'ON CONFLICT ("id", "k") DO UPDATE SET "a" = EXCLUDED."a";'
    )
  })

  it('reads a CREATE with any run of blanks between its words, only at its start', () => {
    expect(sig('CREATE  OR  REPLACE  FUNCTION  f(a int) RETURNS int')).toBe('DROP FUNCTION IF EXISTS f(a int)')
    expect(sig('create or replace procedure p(a int)')).toBe('DROP PROCEDURE IF EXISTS p(a int)')
    expect(sig('CREATE\nFUNCTION f(a int)')).toBe('DROP FUNCTION IF EXISTS f(a int)')
    expect(sig('CREATE FUNCTION f("a,b" int, c int)')).toBe('DROP FUNCTION IF EXISTS f("a,b" int, c int)')
    expect(sig('CREATE FUNCTION f(a int  DEFAULT  1, b int\nDEFAULT\n2)')).toBe(
      'DROP FUNCTION IF EXISTS f(a int, b int)'
    )
    expect(sig('CREATE FUNCTION f(a int,   )')).toBe('DROP FUNCTION IF EXISTS f(a int)')
    expect(sig('SELECT 1; CREATE FUNCTION g(a int)')).toBeUndefined()
    expect(sig('CREATE FUNCTIONf(a int)')).toBeUndefined()
    expect(sig('CREATE ORREPLACE FUNCTION f(a int)')).toBeUndefined()
  })

  it('names a procedure only when the statement itself creates one, not when its text says so', () => {
    expect(sig('CREATE FUNCTION f() RETURNS int AS $$ CREATE PROCEDURE x() $$')).toBe('DROP FUNCTION IF EXISTS f()')
    expect(sig('CREATE  OR  REPLACE  PROCEDURE p()')).toBe('DROP PROCEDURE IF EXISTS p()')
    expect(sig('CREATE OR REPLACE PROCEDURE p()')).toBe('DROP PROCEDURE IF EXISTS p()')
  })

  it('does not take a body that merely contains CREATE for a complete statement', () => {
    const body = 'BEGIN CREATE TEMPORARY TABLE x (a int); END'
    const sql = mysqlExporter.trigger(ns, trig(body), false).sql
    expect(sql).toContain('FOR EACH ROW\nBEGIN CREATE TEMPORARY')
    expect(sql.startsWith('DROP TRIGGER IF EXISTS `tg`;;\nCREATE DEFINER=`u`@`h` TRIGGER')).toBe(true)
    const event = mysqlExporter.event(ns, evt('SELECT 1; CREATE TABLE x (a int)'), true).sql
    expect(event).toContain('\nDO SELECT 1; CREATE TABLE x (a int)')
    expect(event).toContain('CREATE EVENT `ev` ON SCHEDULE')
  })

  it('finds FOR EACH ROW and EVENT IF NOT EXISTS across any blanks', () => {
    const spaced = 'CREATE TRIGGER `db`.`tg` BEFORE INSERT ON `db`.`tbl` FOR\n  EACH   STATEMENT SELECT `db`.`x`'
    expect(mysqlExporter.trigger(ns, trig(spaced), false).sql).toContain(
      'TRIGGER `tg` BEFORE INSERT ON `tbl` FOR\n  EACH   STATEMENT SELECT `db`.`x`'
    )
    const withIf = 'CREATE EVENT  IF  NOT  EXISTS  `db`.`ev` ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    expect(mysqlExporter.event(ns, evt(withIf), true).sql).toContain('EVENT  IF  NOT  EXISTS  `ev` ON')
    const plain = 'CREATE EVENT  `db`.`ev` ON SCHEDULE EVERY 1 DAY DO SELECT 1'
    expect(mysqlExporter.event(ns, evt(plain), true).sql).toContain('EVENT  `ev` ON')
  })

  it('takes the sequence of an identity column even when a nextval() default is also printed', () => {
    const columns = [
      { name: 'i', extra: 'identity always', default: "nextval('other'::regclass)", dataType: 'integer' },
    ]
    expect(pgExporter.afterData(ns, { name: 't', columns } as unknown as TableSchema)).toEqual([
      `${pgAdvanceSequence('"app"."t"', 'i', undefined, 'integer')};`,
    ])
  })
})
