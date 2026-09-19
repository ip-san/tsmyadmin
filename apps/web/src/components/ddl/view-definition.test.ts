import { describe, expect, it } from 'vitest'
import { parseViewDefinition } from './view-definition.ts'

describe('parseViewDefinition', () => {
  it('reads MySQL’s options and the SELECT after AS', () => {
    const mysql =
      'CREATE ALGORITHM=MERGE DEFINER=`app`@`%` SQL SECURITY INVOKER VIEW `db`.`v` AS select `t`.`a` AS `a` from `t` where (`t`.`a` > 1) WITH CASCADED CHECK OPTION;'
    expect(parseViewDefinition(mysql)).toEqual({
      select: 'select `t`.`a` AS `a` from `t` where (`t`.`a` > 1)',
      algorithm: 'MERGE',
      definer: { user: 'app', host: '%' },
      sqlSecurity: 'INVOKER',
      checkOption: 'CASCADED',
    })
  })

  it('reads a PostgreSQL view with its check option, and leaves the trailing COMMENT alone', () => {
    const pg =
      'CREATE VIEW "public"."v" AS\n SELECT id\n   FROM users\nWITH LOCAL CHECK OPTION;\n\nCOMMENT ON VIEW "public"."v" IS \'x\';'
    expect(parseViewDefinition(pg)).toEqual({ select: 'SELECT id\n   FROM users', checkOption: 'LOCAL' })
  })

  it('unquotes a definer’s parts and refuses what is not a view', () => {
    expect(parseViewDefinition("CREATE DEFINER='o''b'@'h' VIEW v AS select 1")?.definer).toEqual({
      user: "o'b",
      host: 'h',
    })
    expect(parseViewDefinition('CREATE TABLE t (a int)')).toBeNull()
  })

  it('does not offer to edit a PostgreSQL view that carries reloptions', () => {
    expect(parseViewDefinition('CREATE VIEW v WITH (security_invoker=true) AS\n SELECT 1;')).toBeNull()
  })
})
