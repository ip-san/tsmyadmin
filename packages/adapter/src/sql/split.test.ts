import { describe, expect, it } from 'vitest'
import { splitStatements } from './split.ts'

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(splitStatements('SELECT 1; SELECT 2 ;\n\nSELECT 3', 'mysql')).toEqual([
      { sql: 'SELECT 1', line: 1 },
      { sql: 'SELECT 2', line: 1 },
      { sql: 'SELECT 3', line: 3 },
    ])
  })

  it('returns [] for empty or whitespace input', () => {
    expect(splitStatements('', 'mysql')).toEqual([])
    expect(splitStatements('  \n ; ; ', 'postgres')).toEqual([])
  })

  it('ignores semicolons inside single and double quoted strings', () => {
    const sql = `SELECT 'a;b', "c;d"; SELECT 2`
    expect(splitStatements(sql, 'mysql').map((s) => s.sql)).toEqual([`SELECT 'a;b', "c;d"`, 'SELECT 2'])
  })

  it('handles doubled quotes and MySQL backslash escapes', () => {
    expect(splitStatements(`SELECT 'it''s; here'; SELECT 1`, 'postgres').map((s) => s.sql)).toEqual([
      `SELECT 'it''s; here'`,
      'SELECT 1',
    ])
    expect(splitStatements(`SELECT 'a\\'; b'; SELECT 1`, 'mysql').map((s) => s.sql)).toEqual([
      `SELECT 'a\\'; b'`,
      'SELECT 1',
    ])
  })

  it('treats backslash literally in postgres strings', () => {
    expect(splitStatements(`SELECT 'a\\'; SELECT 1`, 'postgres').map((s) => s.sql)).toEqual([
      `SELECT 'a\\'`,
      'SELECT 1',
    ])
  })

  it('ignores semicolons inside MySQL backtick identifiers', () => {
    expect(splitStatements('SELECT `a;b` FROM t; SELECT 1', 'mysql').map((s) => s.sql)).toEqual([
      'SELECT `a;b` FROM t',
      'SELECT 1',
    ])
  })

  it('ignores semicolons in -- / # / block comments but keeps comment text', () => {
    const sql = `-- c1; still comment\nSELECT 1; # c2; x\n/* multi;\nline */ SELECT 2`
    expect(splitStatements(sql, 'mysql')).toEqual([
      { sql: '-- c1; still comment\nSELECT 1', line: 1 },
      { sql: '# c2; x\n/* multi;\nline */ SELECT 2', line: 2 },
    ])
  })

  it('nests block comments on PostgreSQL only', () => {
    expect(splitStatements('/* a /* b */ ; */ SELECT 7', 'postgres').map((s) => s.sql)).toEqual([
      '/* a /* b */ ; */ SELECT 7',
    ])
    expect(splitStatements('/* a /* b */ SELECT 8', 'mysql').map((s) => s.sql)).toEqual(['/* a /* b */ SELECT 8'])
  })

  it('treats backslashes as escapes inside PostgreSQL E-strings only', () => {
    expect(splitStatements("SELECT E'a\\';' AS x; SELECT 2", 'postgres').map((s) => s.sql)).toEqual([
      "SELECT E'a\\';' AS x",
      'SELECT 2',
    ])
    // A plain literal keeps standard_conforming_strings semantics: the backslash is not an escape.
    expect(splitStatements("SELECT 'a\\'; SELECT 2", 'postgres').map((s) => s.sql)).toEqual([
      "SELECT 'a\\'",
      'SELECT 2',
    ])
  })

  it('keeps MySQL /*! version comments */ as statements but drops them on PostgreSQL', () => {
    const dump = '/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */;\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\nSELECT 1;'
    expect(splitStatements(dump, 'mysql').map((s) => s.sql)).toEqual([
      '/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */',
      '/*!40014 SET FOREIGN_KEY_CHECKS=0 */',
      'SELECT 1',
    ])
    expect(splitStatements(dump, 'postgres').map((s) => s.sql)).toEqual(['SELECT 1'])
  })

  it('drops chunks that are only comments or whitespace', () => {
    expect(splitStatements(`SELECT 1; -- done\n/* nothing */ ;   `, 'postgres')).toEqual([{ sql: 'SELECT 1', line: 1 }])
    expect(splitStatements(`-- only a comment`, 'mysql')).toEqual([])
  })

  it('requires whitespace after -- on MySQL (2--2 is arithmetic) but not on PostgreSQL', () => {
    expect(splitStatements('SELECT 2--2; SELECT 3', 'mysql').map((s) => s.sql)).toEqual(['SELECT 2--2', 'SELECT 3'])
    expect(splitStatements('SELECT 2--2; SELECT 3', 'postgres').map((s) => s.sql)).toEqual(['SELECT 2--2; SELECT 3'])
    expect(splitStatements('SELECT 1 -- ok; x\n; SELECT 2', 'mysql').map((s) => s.sql)).toEqual([
      'SELECT 1 -- ok; x',
      'SELECT 2',
    ])
  })

  it('recognises DELIMITER after leading comments and blank lines, but not inside code', () => {
    expect(
      splitStatements('-- header\n/* c */\nDELIMITER $$\nSELECT 1$$\nDELIMITER ;\nSELECT 2;', 'mysql').map((s) => s.sql)
    ).toEqual(['SELECT 1', 'SELECT 2'])
    expect(
      splitStatements('SELECT delimiter FROM t; SELECT 1\nDELIMITER $$\nSELECT 2$$', 'mysql').map((s) => s.sql)
    ).toEqual(['SELECT delimiter FROM t', 'SELECT 1\nDELIMITER $$\nSELECT 2$$'])
  })

  it('keeps a PostgreSQL BEGIN ATOMIC function body (with an inner CASE ... END) in one statement', () => {
    const fn = `CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC
  SELECT CASE WHEN a > 0 THEN a ELSE 0 END;
  SELECT a + 1;
END`
    expect(splitStatements(`${fn}; SELECT 1`, 'postgres').map((s) => s.sql)).toEqual([fn, 'SELECT 1'])
    // A plain BEGIN (transaction) is still split as usual.
    expect(splitStatements('BEGIN; SELECT 1; END', 'postgres').map((s) => s.sql)).toEqual(['BEGIN', 'SELECT 1', 'END'])
  })

  it('does not treat # as a comment in postgres', () => {
    expect(splitStatements(`SELECT '#'; SELECT 1 # not comment`, 'postgres').map((s) => s.sql)).toEqual([
      `SELECT '#'`,
      'SELECT 1 # not comment',
    ])
  })

  it('handles postgres dollar quoting with and without tags', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT $tag$a;b$tag$; SELECT 3`
    expect(splitStatements(sql, 'postgres').map((s) => s.sql)).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql',
      'SELECT $tag$a;b$tag$',
      'SELECT 3',
    ])
  })

  it('does not apply dollar quoting for mysql', () => {
    expect(splitStatements('SELECT $$; SELECT 1', 'mysql').map((s) => s.sql)).toEqual(['SELECT $$', 'SELECT 1'])
  })

  it('tolerates unterminated strings and comments', () => {
    expect(splitStatements(`SELECT 'abc`, 'mysql').map((s) => s.sql)).toEqual([`SELECT 'abc`])
    expect(splitStatements(`SELECT 1 /* never closed`, 'mysql').map((s) => s.sql)).toEqual(['SELECT 1 /* never closed'])
  })

  it('reports correct line numbers across multi-line statements', () => {
    const sql = `SELECT\n1;\n\n\nUPDATE t\nSET a = 'x;\ny';\nDELETE FROM t`
    expect(splitStatements(sql, 'postgres')).toEqual([
      { sql: 'SELECT\n1', line: 1 },
      { sql: "UPDATE t\nSET a = 'x;\ny'", line: 5 },
      { sql: 'DELETE FROM t', line: 8 },
    ])
  })
})

describe('splitStatements: MySQL DELIMITER', () => {
  it('switches the terminator so routine bodies with ; stay intact, and restores it', () => {
    const sql = [
      'DELIMITER $$',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END$$',
      'DELIMITER ;',
      'CALL p();',
    ].join('\n')
    expect(splitStatements(sql, 'mysql')).toEqual([
      { sql: 'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND', line: 2 },
      { sql: 'CALL p()', line: 8 },
    ])
  })

  it('supports multi-character delimiters and ignores DELIMITER for postgres', () => {
    expect(
      splitStatements('DELIMITER //\nSELECT 1;//\nSELECT 2//\nDELIMITER ;\nSELECT 3;', 'mysql').map((s) => s.sql)
    ).toEqual(['SELECT 1;', 'SELECT 2', 'SELECT 3'])
    expect(splitStatements('DELIMITER $$\nSELECT 1$$', 'postgres').map((s) => s.sql)).toEqual([
      'DELIMITER $$\nSELECT 1$$',
    ])
  })

  it('treats DELIMITER inside a statement or a string as ordinary text', () => {
    expect(splitStatements("SELECT 'DELIMITER //'; SELECT 2", 'mysql').map((s) => s.sql)).toEqual([
      "SELECT 'DELIMITER //'",
      'SELECT 2',
    ])
  })
})
