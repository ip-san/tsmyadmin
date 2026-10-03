import { describe, expect, it } from 'vitest'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'

/**
 * A server that has no connection left to give is a capacity problem on its side, not a mistake in the request: it
 * is reported as CONNECTION_FAILED (the API answers 502), where it used to be QUERY_FAILED (400, "your request is
 * wrong"). Seen against the real servers: 40 sessions of 4 connections each against PostgreSQL's default 100.
 */
describe('a server that has run out of connections', () => {
  const mysql = new MysqlAdapter({ dialect: 'mysql', host: 'h', port: 1, user: 'u', password: 'p' })
  const postgres = new PostgresAdapter({ dialect: 'postgres', host: 'h', port: 1, user: 'u', password: 'p' })

  it.each([
    ['max_connections', { code: 'ER_CON_COUNT_ERROR', errno: 1040, sqlMessage: 'Too many connections' }],
    ['the account limit', { code: 'ER_TOO_MANY_USER_CONNECTIONS', errno: 1203, sqlMessage: 'already has more' }],
    [
      'the account limit on a resource',
      { code: 'ER_USER_LIMIT_REACHED', errno: 1226, sqlMessage: 'max_user_connections' },
    ],
  ])('is a CONNECTION_FAILED on MySQL (%s)', (_name, err) => {
    expect(mysql.toAdapterError(err)).toMatchObject({ code: 'CONNECTION_FAILED', nativeCode: err.code })
  })

  it("is a CONNECTION_FAILED on PostgreSQL, with the server's own wording kept", () => {
    const e = postgres.toAdapterError({ code: '53300', message: 'sorry, too many clients already' })
    expect(e).toMatchObject({ code: 'CONNECTION_FAILED', nativeCode: '53300' })
    expect(e.message).toContain('too many clients')
  })

  it('leaves an ordinary query error alone', () => {
    expect(mysql.toAdapterError({ code: 'ER_PARSE_ERROR', sqlMessage: 'syntax' })).toMatchObject({
      code: 'QUERY_FAILED',
    })
    expect(postgres.toAdapterError({ code: '42601', message: 'syntax error' })).toMatchObject({ code: 'QUERY_FAILED' })
  })
})
