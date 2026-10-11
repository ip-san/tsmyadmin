import { describe, expect, it } from 'vitest'
import { editDefinitionSql } from './edit-definition.ts'

/**
 * The script a definition is edited as: what runs first, how a body is cut, and what each server needs around it.
 * The user sees the whole script before it runs, but a wrong word in it is still a wrong word (found by mutation
 * testing).
 */

describe('editDefinitionSql: PostgreSQL', () => {
  const pg = (o: Partial<Parameters<typeof editDefinitionSql>[0]> & { definition: string }) =>
    editDefinitionSql({ dialect: 'postgres', kind: 'function', name: 'f', ...o })

  it('replaces a function, a procedure and an event in place, with the body as the server printed it', () => {
    for (const kind of ['function', 'procedure', 'event'] as const)
      expect(pg({ kind, definition: 'CREATE OR REPLACE FUNCTION f() ...' })).toBe(
        'CREATE OR REPLACE FUNCTION f() ...;\n'
      )
  })

  it('drops a trigger first, naming the table and its schema when it has them', () => {
    const def = 'CREATE TRIGGER tg BEFORE INSERT ON s.t FOR EACH ROW EXECUTE FUNCTION f()'
    expect(pg({ kind: 'trigger', name: 'tg', table: 't', schema: 's', definition: def })).toBe(
      `DROP TRIGGER IF EXISTS "tg" ON "s"."t";\n${def};\n`
    )
    expect(pg({ kind: 'trigger', name: 'tg', table: 't', definition: def })).toBe(
      `DROP TRIGGER IF EXISTS "tg" ON "t";\n${def};\n`
    )
    expect(pg({ kind: 'trigger', name: 'tg', definition: def })).toBe(`DROP TRIGGER IF EXISTS "tg";\n${def};\n`)
    expect(pg({ kind: 'trigger', name: 'we"ird', table: 'a"b', schema: 'c"d', definition: 'X' })).toBe(
      'DROP TRIGGER IF EXISTS "we""ird" ON "c""d"."a""b";\nX;\n'
    )
  })

  it('makes a view replaceable unless it already is, whatever the case and the blanks', () => {
    const view = (definition: string) => pg({ kind: 'view', name: 'v', definition })
    expect(view('CREATE VIEW v AS SELECT 1')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1;\n')
    expect(view('  \n create   view v AS SELECT 1')).toBe('CREATE OR REPLACE view v AS SELECT 1;\n')
    expect(view('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1;\n')
    expect(view('  create  or  replace  view v AS SELECT 1')).toBe('create  or  replace  view v AS SELECT 1;\n')
    expect(view('CREATE\nOR\nREPLACE VIEW v AS SELECT 1')).toBe('CREATE\nOR\nREPLACE VIEW v AS SELECT 1;\n')
    expect(view('CREATE ORREPLACE VIEW v')).toBe('CREATE OR REPLACE ORREPLACE VIEW v;\n')
    // Only a view is made replaceable.
    expect(pg({ kind: 'function', definition: 'CREATE FUNCTION f() ...' })).toBe('CREATE FUNCTION f() ...;\n')
  })

  it('cuts the body of its blanks and one closing semicolon, and keeps the semicolons inside it', () => {
    expect(pg({ definition: '  SELECT 1; SELECT 2;  \n' })).toBe('SELECT 1; SELECT 2;\n')
    expect(pg({ definition: 'X;' })).toBe('X;\n')
    expect(pg({ definition: 'X;;' })).toBe('X;;\n')
    expect(pg({ definition: 'X; ; ' })).toBe('X; ;\n')
    expect(pg({ definition: 'X' })).toBe('X;\n')
    expect(pg({ definition: 'a;b' })).toBe('a;b;\n')
  })
})

describe('editDefinitionSql: MySQL and MariaDB', () => {
  const my = (o: Partial<Parameters<typeof editDefinitionSql>[0]> & { definition: string }) =>
    editDefinitionSql({ dialect: 'mysql', kind: 'procedure', name: 'p', ...o })

  it('drops a routine, trigger or event by name and creates it between DELIMITER lines', () => {
    const body = 'CREATE PROCEDURE p() BEGIN SELECT 1; END'
    expect(my({ definition: body })).toBe(`DROP PROCEDURE IF EXISTS \`p\`;\nDELIMITER ;;\n${body} ;;\nDELIMITER ;\n`)
    expect(my({ kind: 'function', name: 'f', definition: 'X' })).toBe(
      'DROP FUNCTION IF EXISTS `f`;\nDELIMITER ;;\nX ;;\nDELIMITER ;\n'
    )
    expect(my({ kind: 'event', name: 'e', definition: 'X' })).toBe(
      'DROP EVENT IF EXISTS `e`;\nDELIMITER ;;\nX ;;\nDELIMITER ;\n'
    )
    // MySQL drops a trigger by its name alone, whatever table is known.
    expect(my({ kind: 'trigger', name: 'tg', table: 't', schema: 's', definition: 'X' })).toBe(
      'DROP TRIGGER IF EXISTS `tg`;\nDELIMITER ;;\nX ;;\nDELIMITER ;\n'
    )
    expect(my({ name: 'we`ird', definition: 'X' })).toContain('DROP PROCEDURE IF EXISTS `we``ird`;')
  })

  it('cuts the body of its blanks and one closing semicolon, the DELIMITER marking its end', () => {
    expect(my({ definition: '  BEGIN SELECT 1; END;  \n' })).toBe(
      'DROP PROCEDURE IF EXISTS `p`;\nDELIMITER ;;\nBEGIN SELECT 1; END ;;\nDELIMITER ;\n'
    )
    expect(my({ definition: 'X;;' })).toContain('\nX; ;;\n')
  })

  it("runs the body under the sql_mode it was written for, and restores the session's own afterwards", () => {
    expect(my({ definition: 'X', sqlMode: "ANSI,IT'S" })).toBe(
      [
        'SET @tsmyadmin_sql_mode = @@session.sql_mode;',
        "SET SESSION sql_mode = 'ANSI,IT''S';",
        'DROP PROCEDURE IF EXISTS `p`;',
        'DELIMITER ;;',
        'X ;;',
        'DELIMITER ;',
        'SET SESSION sql_mode = @tsmyadmin_sql_mode;',
        '',
      ].join('\n')
    )
    for (const none of [null, '', undefined]) {
      const out = my(none === undefined ? { definition: 'X' } : { definition: 'X', sqlMode: none })
      expect(out).not.toContain('sql_mode')
      expect(out.startsWith('DROP PROCEDURE')).toBe(true)
    }
  })

  it('makes a view replaceable by putting OR REPLACE after CREATE, with no drop and no DELIMITER', () => {
    const view = (definition: string) => my({ kind: 'view', name: 'v', definition })
    expect(view('CREATE ALGORITHM=UNDEFINED VIEW v AS SELECT 1;')).toBe(
      'CREATE OR REPLACE ALGORITHM=UNDEFINED VIEW v AS SELECT 1;\n'
    )
    expect(view('  \n create   view v AS SELECT 1')).toBe('CREATE OR REPLACE view v AS SELECT 1;\n')
    expect(view('CREATE VIEW v AS SELECT 1')).not.toContain('DELIMITER')
    expect(view('CREATE VIEW v AS SELECT 1')).not.toContain('DROP')
    expect(my({ kind: 'view', definition: 'CREATE VIEW v AS SELECT 1', sqlMode: 'ANSI' })).not.toContain('sql_mode')
  })
})
