import { DialectSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { lexicalRules } from './lexical-rules.ts'
import { splitStatements, stripLeadingComments } from './split.ts'

/**
 * What the rules table says, and that the scanner does what the table says: each rule is one place the two servers read
 * the same text differently, so each is shown by the text that reads one way on the server that has it and the other
 * way on the server that does not.
 */
describe('lexicalRules', () => {
  it('is defined for every dialect', () => {
    for (const dialect of DialectSchema.options) expect(lexicalRules(dialect)).toBeDefined()
  })

  it('takes the backslash rule from the capability of the dialect, not from a second copy', () => {
    expect(lexicalRules('mysql').backslashEscapes).toBe(true)
    expect(lexicalRules('postgres').backslashEscapes).toBe(false)
  })

  const texts = (sql: string, dialect: 'mysql' | 'postgres') => splitStatements(sql, dialect).map((s) => s.sql.trim())

  it('reads a backslash in a string as an escape on MySQL only', () => {
    expect(texts("SELECT 'a\\'; SELECT 2", 'mysql')).toHaveLength(1)
    expect(texts("SELECT 'a\\'; SELECT 2", 'postgres')).toHaveLength(2)
  })

  it('reads a backtick as an identifier on MySQL only', () => {
    expect(texts('SELECT `a;b`; SELECT 2', 'mysql')).toHaveLength(2)
    // On PostgreSQL a backtick is an ordinary character: the semicolon inside ends the statement.
    expect(texts('SELECT `a;b`; SELECT 2', 'postgres')).toHaveLength(3)
  })

  it('reads E-strings and dollar quotes on PostgreSQL only', () => {
    expect(texts("SELECT E'a\\'; b'; SELECT 2", 'postgres')).toHaveLength(2)
    expect(texts('SELECT $$a; b$$; SELECT 2', 'postgres')).toHaveLength(2)
    expect(texts('SELECT $$a; b$$; SELECT 2', 'mysql').length).toBeGreaterThan(2)
  })

  it('nests block comments on PostgreSQL only', () => {
    expect(texts('/* a /* b */ c; */ SELECT 1; SELECT 2', 'postgres')).toHaveLength(2)
    expect(texts('/* a /* b */ c; */ SELECT 1; SELECT 2', 'mysql').length).toBeGreaterThan(2)
  })

  it('runs a MySQL version comment as code, and reads # and a spaced -- as comments there only', () => {
    expect(texts('/*!40101 SET x=1 */; SELECT 2', 'mysql')).toHaveLength(2)
    expect(texts('SELECT 1 # note; still note\n; SELECT 2', 'mysql')).toHaveLength(2)
    expect(texts('SELECT 2--2; SELECT 3', 'mysql')).toHaveLength(2)
    expect(stripLeadingComments('-- c\nSELECT 1', 'postgres')).toBe('SELECT 1')
  })

  it('takes DELIMITER as a command on MySQL only', () => {
    const script = 'DELIMITER //\nSELECT 1; SELECT 2//\n'
    expect(texts(script, 'mysql')).toEqual(['SELECT 1; SELECT 2'])
    expect(texts(script, 'postgres').length).toBeGreaterThan(1)
  })

  it('keeps the rows after COPY … FROM stdin with the statement, and drops psql meta-commands, on PostgreSQL', () => {
    expect(texts('COPY t (a) FROM stdin;\n1\n2\n\\.\nSELECT 2;', 'postgres')).toHaveLength(2)
    expect(texts('\\connect db\nSELECT 1;', 'postgres')).toContain('SELECT 1;'.slice(0, -1))
  })

  it('does not end a BEGIN ATOMIC body at its semicolons, on PostgreSQL', () => {
    const body = 'CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3'
    expect(texts(body, 'postgres')).toHaveLength(2)
  })
})
