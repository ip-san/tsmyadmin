import { describe, expect, it } from 'vitest'
import { mysqlExporter } from '../mysql/export.ts'
import { pgExporter } from '../postgres/export.ts'
import { isGeneratedColumn } from '../sql/export.ts'

const ns = { database: 'db', schema: 'app' }
const rows = [
  [1, "it's", null, { $bin: 'AQI=' }, true],
  [2, 'plain', 3.5, null, false],
]

describe('SqlExporter.insert', () => {
  it('renders one multi-row INSERT per batch with quoted identifiers and escaped literals', () => {
    expect(mysqlExporter.insert(ns, 'we`ird', ['id', 's', 'n', 'b', 'f'], rows)).toMatchSnapshot()
    expect(pgExporter.insert(ns, 'we"ird', ['id', 's', 'n', 'b', 'f'], rows)).toMatchSnapshot()
  })

  it('returns an empty string for no rows', () => {
    expect(mysqlExporter.insert(ns, 't', ['a'], [])).toBe('')
    expect(pgExporter.insert(ns, 't', ['a'], [])).toBe('')
  })

  it('never lets a value close the statement', () => {
    const evil = "'); DROP TABLE users; --"
    for (const e of [mysqlExporter, pgExporter]) {
      const sql = e.insert(ns, 't', ['a'], [[evil]])
      expect(sql.split('DROP TABLE')).toHaveLength(2)
      expect(sql).toMatch(/\('''\); DROP TABLE users; --'\);$/)
    }
  })
})

describe('program objects', () => {
  it('strips only the header DEFINER, wraps MySQL programs in their sql_mode and keeps bodies verbatim', () => {
    const body = "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN SELECT 'DEFINER=root@localhost' AS s; END"
    expect(mysqlExporter.withoutDefiner(body)).toBe(
      "CREATE PROCEDURE `p`()\nBEGIN SELECT 'DEFINER=root@localhost' AS s; END"
    )
    expect(
      mysqlExporter.withoutDefiner('CREATE ALGORITHM=UNDEFINED DEFINER=`a`@`%` SQL SECURITY DEFINER VIEW v AS SELECT 1')
    ).toBe('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW v AS SELECT 1')
    const block = mysqlExporter.programBlock([
      { ...mysqlExporter.routine(ns, 'procedure', 'p', body, true), sqlMode: 'STRICT_TRANS_TABLES' },
      mysqlExporter.event(
        ns,
        {
          name: 'ev',
          definer: 'app@localhost',
          status: 'ENABLED',
          type: 'ONE TIME',
          schedule: 'AT 2030-01-01 00:00:00',
          starts: null,
          ends: null,
          lastExecuted: null,
          onCompletion: 'PRESERVE',
          comment: "it's",
          definition: 'DELETE FROM t',
          sqlMode: '',
          timeZone: '+09:00',
        },
        false
      ),
    ])
    expect(block).toMatchSnapshot()
    expect(block).toContain('CREATE DEFINER=`app`@`localhost` EVENT `ev`')
    expect(block).toContain("SET sql_mode = 'STRICT_TRANS_TABLES';;")
    expect(block).toContain("SET time_zone = '+09:00';;")
    expect(block).toContain('DROP PROCEDURE IF EXISTS `p`;;')
    // ANSI_QUOTES routines print a double-quoted definer.
    expect(mysqlExporter.withoutDefiner('CREATE DEFINER="a"@"%" FUNCTION "f"() RETURNS int RETURN 1')).toBe(
      'CREATE FUNCTION "f"() RETURNS int RETURN 1'
    )
    // A trigger keeps its definer unless clauses are stripped.
    const trigger = {
      name: 'tr',
      table: 't',
      timing: 'BEFORE',
      events: 'INSERT',
      orientation: 'ROW',
      definition: 'SET NEW.n = 1',
      sqlMode: '',
      definer: 'app@localhost',
      enabled: true,
      fireMode: 'origin' as const,
    }
    expect(mysqlExporter.trigger(ns, trigger, false).sql).toContain('CREATE DEFINER=`app`@`localhost` TRIGGER `tr`')
    expect(mysqlExporter.trigger(ns, trigger, true).sql).toContain('CREATE TRIGGER `tr`')
    expect(block).toContain("SELECT 'DEFINER=root@localhost' AS s")
    // PostgreSQL: overloads are already complete statements; nothing is wrapped.
    expect(
      pgExporter.programBlock([pgExporter.routine(ns, 'function', 'f', 'CREATE OR REPLACE FUNCTION f() ...', true)])
    ).toBe('CREATE OR REPLACE FUNCTION f() ...;\n\n')
    expect(pgExporter.withoutDefiner('CREATE DEFINER=x@y VIEW v AS SELECT 1')).toBe(
      'CREATE DEFINER=x@y VIEW v AS SELECT 1'
    )
  })
})

describe('isGeneratedColumn', () => {
  it('matches only server-computed columns, not expression defaults', () => {
    for (const extra of ['VIRTUAL GENERATED', 'STORED GENERATED', 'STORED GENERATED INVISIBLE', 'generated stored'])
      expect(isGeneratedColumn(extra)).toBe(true)
    for (const extra of [
      '',
      'auto_increment',
      'DEFAULT_GENERATED',
      'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
      'identity always',
      'serial',
    ])
      expect(isGeneratedColumn(extra)).toBe(false)
  })
})
