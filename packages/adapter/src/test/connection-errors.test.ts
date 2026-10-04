import { describe, expect, it } from 'vitest'
import { MysqlAdapter } from '../mysql/adapter.ts'
import { PostgresAdapter } from '../postgres/adapter.ts'

/**
 * A connection that cannot be had or kept is reported as CONNECTION_FAILED (the API answers 502), never as a query the
 * caller got wrong (400): a server that has no connection left to give (seen against the real servers: 40 sessions of
 * 4 connections each against PostgreSQL's default 100), and a server that restarts while a statement runs.
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

  // PostgreSQL's words for being restarted or stopped (seen: `docker restart` while a long query ran).
  it.each([
    ['57P01', 'terminating connection due to administrator command'],
    ['57P03', 'the database system is starting up'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['ETIMEDOUT', 'connect ETIMEDOUT'],
  ])('is a CONNECTION_FAILED on PostgreSQL when the server goes away (%s)', (code, message) => {
    expect(postgres.toAdapterError({ code, message })).toMatchObject({ code: 'CONNECTION_FAILED', nativeCode: code })
  })

  it('leaves an ordinary query error alone', () => {
    expect(mysql.toAdapterError({ code: 'ER_PARSE_ERROR', sqlMessage: 'syntax' })).toMatchObject({
      code: 'QUERY_FAILED',
    })
    expect(postgres.toAdapterError({ code: '42601', message: 'syntax error' })).toMatchObject({ code: 'QUERY_FAILED' })
  })
})
