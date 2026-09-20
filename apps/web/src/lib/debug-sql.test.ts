import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDebugSql, DEBUG_SQL_MAX, maskSql, recordSql, useDebugSql } from './debug-sql.ts'

describe('maskSql', () => {
  it('masks the password of an account statement', () => {
    expect(maskSql("CREATE USER 'a'@'%' IDENTIFIED BY 'hunter2'")).not.toContain('hunter2')
    expect(maskSql("ALTER USER a IDENTIFIED WITH mysql_native_password BY 'x''y'")).not.toMatch(/x''y|'x'/)
    expect(maskSql("SET PASSWORD FOR a = 'secret'")).not.toContain('secret')
    expect(maskSql("ALTER ROLE a PASSWORD 'secret'")).not.toContain('secret')
    expect(maskSql('CREATE SUBSCRIPTION s CONNECTION host=h password=secret dbname=d PUBLICATION p')).not.toContain(
      'secret'
    )
  })
  it('leaves an ordinary statement as it is', () => {
    expect(maskSql("SELECT * FROM t WHERE a = 'x'")).toBe("SELECT * FROM t WHERE a = 'x'")
    expect(maskSql('SELECT password FROM users')).toBe('SELECT password FROM users')
  })
})

describe('the ring buffer', () => {
  beforeEach(clearDebugSql)
  it('keeps the newest DEBUG_SQL_MAX statements', () => {
    for (let i = 0; i < DEBUG_SQL_MAX + 5; i++) recordSql(`SELECT ${i}`, 1, true)
    const { result } = renderHook(() => useDebugSql())
    expect(result.current).toHaveLength(DEBUG_SQL_MAX)
    expect(result.current[0]?.sql).toBe('SELECT 5')
    expect(result.current.at(-1)?.sql).toBe(`SELECT ${DEBUG_SQL_MAX + 4}`)
  })
  it('masks what it stores, for the re-run too', () => {
    recordSql("CREATE USER u IDENTIFIED BY 'pw'", 3, true)
    const { result } = renderHook(() => useDebugSql())
    expect(result.current[0]?.sql).not.toContain('pw')
    expect(result.current[0]?.rerun).not.toContain('pw')
  })
})
