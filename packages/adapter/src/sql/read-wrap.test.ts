import { describe, expect, it } from 'vitest'
import { stripLiterals, WRAP_PREFIX, wrapReadOnly } from './read-wrap.ts'

const wrapped = (body: string, limit: number) => `${WRAP_PREFIX}${body}\n) AS _tsmyadmin LIMIT ${limit}`

describe('wrapReadOnly', () => {
  it('wraps a plain read as a subquery with the row cap, the body on its own line', () => {
    expect(WRAP_PREFIX).toBe('SELECT * FROM (\n')
    expect(wrapReadOnly('SELECT 1', 10)).toBe(wrapped('SELECT 1', 10))
    expect(wrapReadOnly('  select 1;; ', 5)).toBe(wrapped('select 1', 5))
    // Only the semicolons at the very end go: one inside a literal, or before a comment, stays.
    expect(wrapReadOnly("SELECT ';' FROM t", 3)).toBe(wrapped("SELECT ';' FROM t", 3))
    expect(wrapReadOnly('SELECT 1;-- c', 3)).toBe(wrapped('SELECT 1;-- c', 3))
    expect(wrapReadOnly('SELECT 1 -- note', 3)).toBe(wrapped('SELECT 1 -- note', 3))
  })

  it('keeps a limit of at least 1, in whole rows', () => {
    expect(wrapReadOnly('SELECT 1', 0)).toBe(wrapped('SELECT 1', 1))
    expect(wrapReadOnly('SELECT 1', -5)).toBe(wrapped('SELECT 1', 1))
    expect(wrapReadOnly('SELECT 1', 2.9)).toBe(wrapped('SELECT 1', 2))
    expect(wrapReadOnly('SELECT 1', 1)).toBe(wrapped('SELECT 1', 1))
  })

  it('wraps only what starts as a read: SELECT, WITH, VALUES, TABLE or a parenthesis', () => {
    for (const read of [
      'SELECT 1',
      'with a as (select 1) select * from a',
      'VALUES (1)',
      'TABLE t',
      '(SELECT 1)',
      '  \n select 1',
    ])
      expect(wrapReadOnly(read, 9), read).not.toBeNull()
    for (const other of [
      'INSERT INTO t VALUES (1)',
      'EXPLAIN SELECT 1',
      'SHOW TABLES',
      'SELECTED 1',
      'SELECT1',
      'CREATE TABLE t (a int)',
      '',
    ])
      expect(wrapReadOnly(other, 9), other).toBeNull()
  })

  it('does not count leading comments when deciding, and keeps them in the text', () => {
    expect(wrapReadOnly('-- a read\nSELECT 1', 9)).toBe(wrapped('-- a read\nSELECT 1', 9))
    expect(wrapReadOnly('/* c */ SELECT 1', 9)).toBe(wrapped('/* c */ SELECT 1', 9))
    expect(wrapReadOnly('-- not a read\nDELETE FROM t', 9)).toBeNull()
  })

  it('never wraps a statement that writes, locks or reads into a variable, also inside a WITH', () => {
    for (const writing of [
      'SELECT * INTO t2 FROM t',
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t FOR   SHARE',
      'SELECT * FROM t FOR NO KEY UPDATE',
      'SELECT * FROM t FOR KEY SHARE',
      'SELECT * FROM t LOCK IN SHARE MODE',
      'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
      'WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u',
      'WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i',
      'WITH m AS (MERGE INTO t USING s ON true WHEN MATCHED THEN DO NOTHING RETURNING *) SELECT * FROM m',
    ])
      expect(wrapReadOnly(writing, 9), writing).toBeNull()
  })

  it('does not take a word that merely contains a keyword, or sits in a literal, for the keyword', () => {
    expect(wrapReadOnly('SELECT updated_at, insertion, deleted FROM t', 9)).not.toBeNull()
    expect(wrapReadOnly("SELECT 'delete', 'for update'", 9)).not.toBeNull()
    expect(wrapReadOnly('SELECT "insert" FROM t', 9)).not.toBeNull()
    expect(wrapReadOnly('SELECT $$ delete $$', 9)).not.toBeNull()
    expect(wrapReadOnly('SELECT $tag$ update $tag$', 9)).not.toBeNull()
    expect(wrapReadOnly('SELECT 1 /* delete */', 9)).not.toBeNull()
    expect(wrapReadOnly('SELECT 1 -- delete', 9)).not.toBeNull()
  })

  it('reads a MySQL backtick name, # comment and backslash escape as MySQL does, and PostgreSQL as it does', () => {
    expect(wrapReadOnly('SELECT `delete` FROM t', 9, 'mysql')).not.toBeNull()
    expect(wrapReadOnly('SELECT `delete` FROM t', 9, 'postgres')).toBeNull()
    expect(wrapReadOnly('SELECT 1 # delete', 9, 'mysql')).not.toBeNull()
    expect(wrapReadOnly('SELECT 1 # delete', 9, 'postgres')).toBeNull()
    // `\'` stays inside the string for MySQL; for PostgreSQL the string ended at it and INSERT is outside.
    expect(wrapReadOnly("SELECT 'it\\'s INSERT'", 9, 'mysql')).not.toBeNull()
    expect(wrapReadOnly("SELECT 'it\\'s INSERT'", 9, 'postgres')).toBeNull()
    expect(wrapReadOnly("SELECT E'it\\'s INSERT'", 9, 'postgres')).not.toBeNull()
    expect(wrapReadOnly("SELECT 'it''s INSERT'", 9, 'postgres')).not.toBeNull()
    // PostgreSQL is the default dialect.
    expect(wrapReadOnly('SELECT 1 # delete', 9)).toBeNull()
  })
})

describe('stripLiterals', () => {
  it('replaces each literal, quoted name and comment with a space, leaving the code around them', () => {
    expect(stripLiterals("a 'x' b", 'postgres')).toBe('a   b')
    expect(stripLiterals('a "x" b -- c', 'postgres')).toBe('a   b  ')
    expect(stripLiterals('a /* c\n d */ b', 'postgres')).toBe('a   b')
    expect(stripLiterals('a $q$ x $q$ b', 'postgres')).toBe('a   b')
    expect(stripLiterals('a `x` b', 'mysql')).toBe('a   b')
    expect(stripLiterals('a `x` b', 'postgres')).toBe('a `x` b')
    expect(stripLiterals("a E'x' b", 'postgres')).toBe('a   b')
  })

  it('stops a $tag$ string only at the same tag', () => {
    expect(stripLiterals('a $q$ x $r$ y $q$ b', 'postgres')).toBe('a   b')
  })
})
