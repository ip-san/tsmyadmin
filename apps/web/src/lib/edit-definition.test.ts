import { describe, expect, it } from 'vitest'
import { editDefinitionSql } from '@/lib/edit-definition.ts'

describe('editDefinitionSql', () => {
  it('replaces a PostgreSQL routine in place and drops a trigger first', () => {
    // pg_get_functiondef already yields CREATE OR REPLACE; nothing has to be dropped.
    const fn = editDefinitionSql({
      dialect: 'postgres',
      kind: 'function',
      name: 'f',
      definition: 'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
    })
    expect(fn).not.toContain('DROP')
    expect(fn.trimEnd().endsWith(';')).toBe(true)

    const trg = editDefinitionSql({
      dialect: 'postgres',
      kind: 'trigger',
      name: 'trg',
      table: 'users',
      schema: 'app',
      definition: 'CREATE TRIGGER trg BEFORE INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION f()',
    })
    expect(trg).toContain('DROP TRIGGER IF EXISTS "trg" ON "app"."users";')
    expect(trg).toContain('CREATE TRIGGER trg')
  })

  it('drops first and wraps the body in DELIMITER on MySQL, restoring sql_mode', () => {
    const sql = editDefinitionSql({
      dialect: 'mysql',
      kind: 'procedure',
      name: 'p',
      sqlMode: 'STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY',
      definition: 'CREATE PROCEDURE `p`() BEGIN SELECT 1; END',
    })
    // The body carries its own `;`, so it can only run between DELIMITER lines.
    expect(sql).toContain('DELIMITER ;;')
    expect(sql).toContain('DELIMITER ;')
    expect(sql).toContain('DROP PROCEDURE IF EXISTS `p`;')
    // The routine may not parse under a different sql_mode, and the session must be left as it was found.
    expect(sql).toContain("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY';")
    expect(sql.indexOf('SET SESSION sql_mode = @tsmyadmin_sql_mode')).toBeGreaterThan(sql.indexOf('DELIMITER ;\n'))
  })

  it('uses CREATE OR REPLACE for a view on both dialects', () => {
    for (const dialect of ['mysql', 'postgres'] as const) {
      const sql = editDefinitionSql({ dialect, kind: 'view', name: 'v', definition: 'CREATE VIEW v AS SELECT 1' })
      expect(sql).toContain('CREATE OR REPLACE VIEW')
      expect(sql).not.toContain('DROP')
    }
  })

  it('quotes the identifiers it builds', () => {
    const sql = editDefinitionSql({
      dialect: 'mysql',
      kind: 'function',
      name: 'we`ird',
      definition: 'CREATE FUNCTION `we``ird`() RETURNS INT RETURN 1',
    })
    expect(sql).toContain('DROP FUNCTION IF EXISTS `we``ird`;')
  })
})
