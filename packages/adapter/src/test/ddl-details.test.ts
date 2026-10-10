import type { ColumnSpec, DdlOp } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { mysqlDdl, mysqlPartitionBound } from '../mysql/ddl.ts'
import { col, refuses } from './ddl-helpers.ts'

/**
 * The details the snapshot of every op kind in ddl.test.ts does not pin: each option of an op, each refusal, and the
 * edges of the small helpers. Mutation testing found these as changes nothing noticed (see `bun run mutation`).
 */

const ns = { database: 'd' }
const mysql = (op: DdlOp, space = ns) => mysqlDdl.build(space, op)
/** The one statement of an addColumn, which carries the column's whole definition. */
const columnSql = (c: ColumnSpec) => {
  const [sql] = mysql({ op: 'addColumn', table: 't', column: c })
  return (sql ?? '').replace('ALTER TABLE `d`.`t` ADD COLUMN ', '')
}
describe('MySQL: databases', () => {
  it('creates a database with its collation when one is given, and without when not', () => {
    expect(mysql({ op: 'createDatabase', name: 'x' })).toEqual(['CREATE DATABASE `x`'])
    expect(mysql({ op: 'createDatabase', name: 'x', collation: 'utf8mb4_bin' })).toEqual([
      'CREATE DATABASE `x` COLLATE utf8mb4_bin',
    ])
    expect(mysql({ op: 'createSchema', name: 'x' })).toEqual(['CREATE DATABASE `x`'])
  })

  it('sets the character set from the collation name, or "binary" for the binary collation', () => {
    expect(
      mysql({ op: 'setDatabaseCollation', name: 'x', collation: 'latin1_swedish_ci', applyToTables: false })
    ).toEqual(['ALTER DATABASE `x` CHARACTER SET latin1 COLLATE latin1_swedish_ci'])
    expect(mysql({ op: 'setDatabaseCollation', name: 'x', collation: 'binary', applyToTables: false })).toEqual([
      'ALTER DATABASE `x` CHARACTER SET binary COLLATE binary',
    ])
  })

  it('converts the listed tables only when asked to, and lists none when the server named none', () => {
    const tables = ['a', 'b']
    expect(
      mysql({ op: 'setDatabaseCollation', name: 'x', collation: 'utf8mb4_bin', applyToTables: true, tables })
    ).toEqual([
      'ALTER DATABASE `x` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      'ALTER TABLE `x`.`a` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      'ALTER TABLE `x`.`b` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    ])
    expect(
      mysql({ op: 'setDatabaseCollation', name: 'x', collation: 'utf8mb4_bin', applyToTables: false, tables })
    ).toHaveLength(1)
    expect(
      mysql({ op: 'setDatabaseCollation', name: 'x', collation: 'utf8mb4_bin', applyToTables: true })
    ).toHaveLength(1)
  })

  it('renames a database by creating the new one and moving every table in one RENAME TABLE, leaving the old one', () => {
    expect(
      mysql({ op: 'renameDatabase', name: 'old', newName: 'new', tables: ['a', 'b'], collation: 'utf8mb4_bin' })
    ).toEqual([
      'CREATE DATABASE `new` COLLATE utf8mb4_bin',
      'RENAME TABLE `old`.`a` TO `new`.`a`, `old`.`b` TO `new`.`b`',
    ])
    expect(mysql({ op: 'renameDatabase', name: 'old', newName: 'new', tables: [] })).toEqual(['CREATE DATABASE `new`'])
    refuses(() => mysql({ op: 'renameDatabase', name: 'old', newName: 'new' }), 'VALIDATION', /list of tables to move/)
  })

  it('drops several databases one statement each, in the order given', () => {
    expect(mysql({ op: 'dropDatabases', names: ['b', 'a'] })).toEqual(['DROP DATABASE `b`', 'DROP DATABASE `a`'])
  })

  it('moves a table to another database', () => {
    expect(mysql({ op: 'moveTable', table: 't', to: 'e' })).toEqual(['RENAME TABLE `d`.`t` TO `e`.`t`'])
  })
})

describe('MySQL: copying a database', () => {
  const tables = [
    { name: 'a', columns: ['id', 'n'], autoIncrement: '7' },
    {
      name: 'b',
      columns: [],
      foreignKeys: [{ name: 'fk', columns: ['x'], refTable: 'a', refColumns: ['id'], onDelete: 'CASCADE' as const }],
    },
  ]
  const copy = (extra: Record<string, unknown>) =>
    mysql({ op: 'copyDatabase', name: 'src', newName: 'dst', withData: true, tables, ...extra } as DdlOp)

  it('creates the database and each table like its source, then fills the tables that have columns', () => {
    expect(copy({})).toEqual([
      'CREATE DATABASE `dst`',
      'CREATE TABLE `dst`.`a` LIKE `src`.`a`',
      'INSERT INTO `dst`.`a` (`id`, `n`) SELECT `id`, `n` FROM `src`.`a`',
      'CREATE TABLE `dst`.`b` LIKE `src`.`b`',
    ])
  })

  it('copies the structure only when told not to copy the rows, and keeps the source collation', () => {
    expect(copy({ withData: false, collation: 'utf8mb4_bin' })).toEqual([
      'CREATE DATABASE `dst` COLLATE utf8mb4_bin',
      'CREATE TABLE `dst`.`a` LIKE `src`.`a`',
      'CREATE TABLE `dst`.`b` LIKE `src`.`b`',
    ])
  })

  it('copies rows only, into tables that exist, when the structure is switched off', () => {
    expect(copy({ structure: false })).toEqual(['INSERT INTO `dst`.`a` (`id`, `n`) SELECT `id`, `n` FROM `src`.`a`'])
    refuses(() => copy({ structure: false, withData: false }), 'VALIDATION', /neither the structure nor the rows/i)
  })

  it('refuses to copy without the list of tables the preview fills in', () => {
    refuses(
      () => mysql({ op: 'copyDatabase', name: 'src', newName: 'dst', withData: true }),
      'VALIDATION',
      /list of tables to copy/
    )
  })

  it("sets each table's next AUTO_INCREMENT after the rows, only for tables that have one", () => {
    expect(copy({ autoIncrement: true }).slice(-1)).toEqual(['ALTER TABLE `dst`.`a` AUTO_INCREMENT = 7'])
    expect(copy({ autoIncrement: false })).not.toContain('ALTER TABLE `dst`.`a` AUTO_INCREMENT = 7')
  })

  it("adds the foreign keys to the copy, pointing a key into the source at the copy's own table", () => {
    const out = copy({ foreignKeys: true })
    expect(out.at(-1)).toBe(
      'ALTER TABLE `dst`.`b` ADD CONSTRAINT `fk` FOREIGN KEY (`x`) REFERENCES `dst`.`a` (`id`) ON DELETE CASCADE'
    )
    expect(copy({ foreignKeys: false })).toHaveLength(4)
    // A key into a third database stays where it points; one into the source database moves to the copy.
    const keyInto = (refDatabase: string) =>
      copy({
        foreignKeys: true,
        tables: [
          {
            name: 'b',
            columns: [],
            foreignKeys: [{ name: 'k', columns: ['x'], refTable: 'a', refDatabase, refColumns: ['id'] }],
          },
        ],
      })
    expect(keyInto('third').at(-1)).toContain('REFERENCES `third`.`a`')
    expect(keyInto('src').at(-1)).toContain('REFERENCES `dst`.`a`')
  })

  it('grants the privileges the source has to the copy: plain ones only, never GRANT OPTION', () => {
    const grants = [
      { user: 'u', host: 'h', privileges: ['SELECT', 'INSERT', 'GRANT OPTION'], grantable: true },
      { user: 'v', host: '%', privileges: ['GRANT OPTION'], grantable: false },
      { user: 'w', host: '%', privileges: ['select', 'ALL PRIVILEGES'], grantable: false },
      // Only plain upper-case words are carried over: nothing else may reach the statement.
      { user: 'x', host: '%', privileges: ['a SELECT', 'SELECT;', 'SELECT, DROP'], grantable: false },
    ]
    const out = copy({ privileges: true, grants })
    expect(out.slice(-2)).toEqual([
      "GRANT SELECT, INSERT ON `dst`.* TO 'u'@'h' WITH GRANT OPTION",
      "GRANT ALL PRIVILEGES ON `dst`.* TO 'w'@'%'",
    ])
    expect(copy({ privileges: false, grants })).toHaveLength(4)
    expect(copy({ privileges: true })).toHaveLength(4)
    // Rows alone copy into a database that already has its own grants and keys.
    expect(copy({ privileges: true, grants, structure: false })).toHaveLength(1)
    expect(copy({ foreignKeys: true, structure: false })).toHaveLength(1)
  })
})

describe('MySQL: routines', () => {
  const proc = (extra: Record<string, unknown> = {}): DdlOp =>
    ({
      op: 'createRoutine',
      kind: 'procedure',
      name: 'p',
      params: [
        { mode: 'IN', name: 'a', type: 'INT' },
        { mode: 'OUT', name: 'b', type: 'TEXT' },
      ],
      body: 'SELECT 1;',
      language: 'plpgsql',
      deterministic: false,
      ...extra,
    }) as DdlOp

  it('spells a procedure parameter with its mode and a function parameter without', () => {
    expect(mysql(proc())).toEqual(['CREATE PROCEDURE `d`.`p`(IN `a` INT, OUT `b` TEXT) NOT DETERMINISTIC SELECT 1'])
    const fn = mysql({
      op: 'createRoutine',
      kind: 'function',
      name: 'f',
      params: [{ mode: 'IN', name: 'a', type: 'INT' }],
      returns: 'INT',
      body: 'RETURN a',
      language: 'plpgsql',
      deterministic: true,
    })
    expect(fn).toEqual(['CREATE FUNCTION `d`.`f`(`a` INT) RETURNS INT DETERMINISTIC RETURN a'])
  })

  it('writes the definer, comment, data access and security in that order, and quotes them as literals', () => {
    expect(
      mysql(
        proc({
          params: [],
          definer: { user: "o'x", host: '%' },
          comment: "it's",
          dataAccess: 'READS SQL DATA',
          sqlSecurity: 'INVOKER',
        })
      )
    ).toEqual([
      "CREATE DEFINER = 'o''x'@'%' PROCEDURE `d`.`p`() COMMENT 'it''s' NOT DETERMINISTIC READS SQL DATA SQL SECURITY INVOKER SELECT 1",
    ])
  })

  it('drops the trailing semicolons and blanks of a body, and keeps those inside a BEGIN … END block', () => {
    expect(mysql(proc({ params: [], body: '  BEGIN SELECT 1; END;  \n ;' }))).toEqual([
      'CREATE PROCEDURE `d`.`p`() NOT DETERMINISTIC BEGIN SELECT 1; END',
    ])
  })

  it('refuses a function with an OUT parameter or without a return type', () => {
    const fn = (extra: Record<string, unknown>): DdlOp =>
      ({
        op: 'createRoutine',
        kind: 'function',
        name: 'f',
        params: [],
        returns: 'INT',
        body: 'RETURN 1',
        language: 'plpgsql',
        deterministic: false,
        ...extra,
      }) as DdlOp
    refuses(() => mysql(fn({ params: [{ mode: 'OUT', name: 'a', type: 'INT' }] })), 'UNSUPPORTED', /IN parameters only/)
    refuses(
      () => mysql(fn({ params: [{ mode: 'INOUT', name: 'a', type: 'INT' }] })),
      'UNSUPPORTED',
      /IN parameters only/
    )
    refuses(() => mysql(fn({ returns: undefined })), 'UNSUPPORTED', /needs a return type/)
    // A procedure with OUT parameters is fine, and needs no return type.
    expect(mysql(proc())).toHaveLength(1)
  })

  it('alters only the characteristics given, and refuses an alteration of none', () => {
    expect(
      mysql({
        op: 'alterRoutine',
        kind: 'function',
        name: 'f',
        comment: 'c',
        dataAccess: 'NO SQL',
        sqlSecurity: 'DEFINER',
      })
    ).toEqual(["ALTER FUNCTION `d`.`f` COMMENT 'c' NO SQL SQL SECURITY DEFINER"])
    expect(mysql({ op: 'alterRoutine', kind: 'procedure', name: 'p', comment: '' })).toEqual([
      "ALTER PROCEDURE `d`.`p` COMMENT ''",
    ])
    refuses(
      () => mysql({ op: 'alterRoutine', kind: 'procedure', name: 'p' }),
      'VALIDATION',
      /No routine characteristic/
    )
  })

  it('drops a routine of the kind named, and replaces one by dropping it first', () => {
    expect(mysql({ op: 'dropRoutine', kind: 'function', name: 'f' })).toEqual(['DROP FUNCTION `d`.`f`'])
    expect(mysql({ op: 'dropRoutine', kind: 'procedure', name: 'p' })).toEqual(['DROP PROCEDURE `d`.`p`'])
    const replace = mysql({
      ...(proc({ params: [] }) as object),
      op: 'replaceRoutine',
      replaces: { kind: 'procedure', name: 'old' },
    } as DdlOp)
    expect(replace).toEqual(['DROP PROCEDURE `d`.`old`', 'CREATE PROCEDURE `d`.`p`() NOT DETERMINISTIC SELECT 1'])
  })
})

describe('MySQL: a column definition', () => {
  it('writes the parts in order: collation, nullability, default, ON UPDATE, AUTO_INCREMENT, comment, check', () => {
    expect(
      columnSql(
        col('c', 'VARCHAR(9)', {
          collation: 'utf8mb4_bin',
          nullable: false,
          default: { kind: 'literal', value: 'x' },
          onUpdate: 'CURRENT_TIMESTAMP',
          autoIncrement: true,
          comment: 'k',
          check: 'c > 0',
        })
      )
    ).toBe(
      "`c` VARCHAR(9) COLLATE utf8mb4_bin NOT NULL DEFAULT 'x' ON UPDATE CURRENT_TIMESTAMP AUTO_INCREMENT COMMENT 'k' CHECK (c > 0)"
    )
    expect(columnSql(col('c', 'INT'))).toBe('`c` INT NULL')
    expect(columnSql(col('c', 'INT', { comment: '' }))).toBe("`c` INT NULL COMMENT ''")
  })

  it('writes a generated column without default, AUTO_INCREMENT or ON UPDATE, and says NOT NULL only when it is', () => {
    const generated = { expression: 'a + 1', stored: true }
    expect(
      columnSql(
        col('g', 'INT', {
          generated,
          default: { kind: 'literal', value: '1' },
          autoIncrement: true,
          onUpdate: 'CURRENT_TIMESTAMP',
        })
      )
    ).toBe('`g` INT GENERATED ALWAYS AS (a + 1) STORED')
    expect(
      columnSql(
        col('g', 'INT', {
          generated: { expression: 'a', stored: false },
          nullable: false,
          comment: 'c',
          check: 'g > 0',
          collation: 'utf8mb4_bin',
        })
      )
    ).toBe("`g` INT COLLATE utf8mb4_bin GENERATED ALWAYS AS (a) VIRTUAL NOT NULL COMMENT 'c' CHECK (g > 0)")
    expect(columnSql(col('g', 'INT', { generated, comment: '' }))).toBe(
      "`g` INT GENERATED ALWAYS AS (a + 1) STORED COMMENT ''"
    )
  })

  it('wraps an expression default in parentheses, except the ones the server takes bare or already wrapped', () => {
    const d = (sql: string) => columnSql(col('c', 'INT', { default: { kind: 'expression', sql } }))
    expect(d('uuid()')).toBe('`c` INT NULL DEFAULT (uuid())')
    expect(d('  a + b ')).toBe('`c` INT NULL DEFAULT (a + b)')
    expect(d('CURRENT_TIMESTAMP')).toBe('`c` INT NULL DEFAULT CURRENT_TIMESTAMP')
    expect(d('current_timestamp(6)')).toBe('`c` INT NULL DEFAULT current_timestamp(6)')
    expect(d('CURRENT_TIMESTAMP()')).toBe('`c` INT NULL DEFAULT CURRENT_TIMESTAMP()')
    expect(d('CURRENT_TIMESTAMP(12)')).toBe('`c` INT NULL DEFAULT (CURRENT_TIMESTAMP(12))')
    expect(d('CURRENT_TIMESTAMP + 1')).toBe('`c` INT NULL DEFAULT (CURRENT_TIMESTAMP + 1)')
    expect(d('(a + b)')).toBe('`c` INT NULL DEFAULT (a + b)')
    expect(d('0xFF')).toBe('`c` INT NULL DEFAULT 0xFF')
    expect(d('0x')).toBe('`c` INT NULL DEFAULT 0x')
    expect(d("x'0f'")).toBe("`c` INT NULL DEFAULT x'0f'")
    expect(d("X'0F'")).toBe("`c` INT NULL DEFAULT X'0F'")
    expect(d("b'101'")).toBe("`c` INT NULL DEFAULT b'101'")
    expect(d("B''")).toBe("`c` INT NULL DEFAULT B''")
    expect(d('0xZZ')).toBe('`c` INT NULL DEFAULT (0xZZ)')
    expect(d("b'102'")).toBe("`c` INT NULL DEFAULT (b'102')")
    expect(d('x0F')).toBe('`c` INT NULL DEFAULT (x0F)')
    // The patterns are anchored at both ends: a longer expression that merely contains or ends in one is wrapped.
    expect(d('xCURRENT_TIMESTAMP')).toBe('`c` INT NULL DEFAULT (xCURRENT_TIMESTAMP)')
    expect(d('1+0xFF')).toBe('`c` INT NULL DEFAULT (1+0xFF)')
    expect(d('CURRENT_TIMESTAMP(6) + 1')).toBe('`c` INT NULL DEFAULT (CURRENT_TIMESTAMP(6) + 1)')
  })
})

describe('mysqlPartitionBound', () => {
  it('reads a RANGE bound as LESS THAN, a LIST bound as IN, and anything else as no bound', () => {
    expect(mysqlPartitionBound('RANGE', '100')).toBe('VALUES LESS THAN (100)')
    expect(mysqlPartitionBound('RANGE COLUMNS', "'a','b'")).toBe("VALUES LESS THAN ('a','b')")
    expect(mysqlPartitionBound('RANGE', 'MAXVALUE')).toBe('VALUES LESS THAN MAXVALUE')
    expect(mysqlPartitionBound('LIST', '1,2')).toBe('VALUES IN (1,2)')
    expect(mysqlPartitionBound('LIST COLUMNS', "'a'")).toBe("VALUES IN ('a')")
    expect(mysqlPartitionBound('HASH', '3')).toBe('')
    expect(mysqlPartitionBound('KEY', '3')).toBe('')
    expect(mysqlPartitionBound('RANGE', null)).toBe('')
    expect(mysqlPartitionBound('LIST', null)).toBe('')
  })
})

describe('MySQL: server variables, views and find-and-replace', () => {
  it('sets a variable to a number or keyword as itself, to DEFAULT when no value is given, else to a string', () => {
    const set = (value?: string) =>
      mysql({ op: 'setServerVariable', name: 'v', ...(value === undefined ? {} : { value }) })[0]
    expect(set()).toBe('SET GLOBAL v = DEFAULT')
    expect(set('10')).toBe('SET GLOBAL v = 10')
    expect(set(' -1.5 ')).toBe('SET GLOBAL v = -1.5')
    expect(set('on')).toBe('SET GLOBAL v = on')
    expect(set('OFF')).toBe('SET GLOBAL v = OFF')
    expect(set('True')).toBe('SET GLOBAL v = True')
    expect(set('default')).toBe('SET GLOBAL v = default')
    expect(set('1.25')).toBe('SET GLOBAL v = 1.25')
    expect(set('1.')).toBe("SET GLOBAL v = '1.'")
    expect(set('1e3')).toBe("SET GLOBAL v = '1e3'")
    expect(set('ONE')).toBe("SET GLOBAL v = 'ONE'")
    expect(set('x ON')).toBe("SET GLOBAL v = 'x ON'")
    expect(set("it's")).toBe("SET GLOBAL v = 'it''s'")
    expect(set('')).toBe("SET GLOBAL v = ''")
  })

  it('builds a view with each option in its place', () => {
    expect(
      mysql({
        op: 'createView',
        name: 'v',
        select: ' SELECT 1; ',
        orReplace: true,
        columns: ['a', 'b'],
        checkOption: 'LOCAL',
        algorithm: 'MERGE',
        definer: { user: 'u', host: 'h' },
        sqlSecurity: 'INVOKER',
      })
    ).toEqual([
      "CREATE OR REPLACE ALGORITHM = MERGE DEFINER = 'u'@'h' SQL SECURITY INVOKER VIEW `d`.`v` (`a`, `b`) AS SELECT 1\nWITH LOCAL CHECK OPTION",
    ])
    expect(mysql({ op: 'createView', name: 'v', select: 'SELECT 1', orReplace: false, columns: [] })).toEqual([
      'CREATE VIEW `d`.`v` AS SELECT 1',
    ])
  })

  it('replaces by the literal text or by a regular expression, comparing bytes so a case-only change counts', () => {
    const base = { op: 'replaceInColumn', table: 't', column: 'c', find: "a'b", replace: 'x' } as const
    expect(mysql(base)).toEqual([
      "UPDATE `d`.`t` SET `c` = REPLACE(`c`, 'a''b', 'x') WHERE CAST(REPLACE(`c`, 'a''b', 'x') AS BINARY) <> CAST(`c` AS BINARY)",
    ])
    expect(mysql({ ...base, regex: true })[0]).toContain("SET `c` = REGEXP_REPLACE(`c`, 'a''b', 'x')")
    expect(mysql({ ...base, regex: false })[0]).toContain('SET `c` = REPLACE(')
  })
})
