import { describe, expect, it } from 'vitest'
import { AdapterError } from '../types.ts'
import { mapMysqlError } from './errors.ts'

describe('mapMysqlError: what kind of failure it is', () => {
  it.each([
    ['AUTH_FAILED', ['ER_ACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR']],
    [
      'CONNECTION_FAILED',
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EHOSTUNREACH',
        'PROTOCOL_CONNECTION_LOST',
        'ER_HOST_NOT_PRIVILEGED',
        'ER_HOST_IS_BLOCKED',
        // The server has no connection to give: its capacity, not a mistake in the request.
        'ER_CON_COUNT_ERROR',
        'ER_TOO_MANY_USER_CONNECTIONS',
        'ER_USER_LIMIT_REACHED',
        'ER_CONNECTION_KILLED',
        'ER_SERVER_SHUTDOWN',
      ],
    ],
    [
      'PERMISSION_DENIED',
      [
        'ER_TABLEACCESS_DENIED_ERROR',
        'ER_COLUMNACCESS_DENIED_ERROR',
        'ER_SPECIFIC_ACCESS_DENIED_ERROR',
        'ER_PROCACCESS_DENIED_ERROR',
        'ER_DBACCESS_DENIED_ERROR',
        'ER_KILL_DENIED_ERROR',
      ],
    ],
    [
      'NOT_FOUND',
      [
        'ER_NO_SUCH_TABLE',
        'ER_UNKNOWN_SEQUENCES',
        'ER_TRG_DOES_NOT_EXIST',
        'ER_EVENT_DOES_NOT_EXIST',
        'ER_BAD_DB_ERROR',
        'ER_BAD_FIELD_ERROR',
        'ER_NO_SUCH_THREAD',
        'ER_SP_DOES_NOT_EXIST',
      ],
    ],
  ])('is a %s', (kind, codes) => {
    for (const code of codes) {
      expect(mapMysqlError({ code, sqlMessage: 'm' }, false), code).toMatchObject({ code: kind, nativeCode: code })
    }
  })

  it('keeps an interrupted statement a query failure: the connection is still usable', () => {
    expect(mapMysqlError({ code: 'ER_QUERY_INTERRUPTED', errno: 1317, sqlMessage: 'i' }, false)).toMatchObject({
      code: 'QUERY_FAILED',
    })
    expect(mapMysqlError({ code: 'ER_PARSE_ERROR', errno: 1064, sqlMessage: 'syntax' }, false)).toMatchObject({
      code: 'QUERY_FAILED',
    })
  })

  it('takes a fatal driver error for a lost connection, and a non-fatal one for an ordinary failure', () => {
    expect(mapMysqlError({ code: 'WHATEVER', fatal: true, message: 'x' }, false).code).toBe('CONNECTION_FAILED')
    expect(mapMysqlError({ code: 'WHATEVER', fatal: false, message: 'x' }, false).code).toBe('QUERY_FAILED')
  })

  it("says the server's own words, with the native code in front and kept apart", () => {
    const e = mapMysqlError({ code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: "Duplicate entry '1'" }, false)
    expect(e.message).toBe("ER_DUP_ENTRY: Duplicate entry '1'")
    expect(e.nativeCode).toBe('ER_DUP_ENTRY')
  })

  it('has no native code for something that is not a server error at all', () => {
    const e = mapMysqlError({ message: 'just a message' }, false)
    expect(e.message).toBe('UNKNOWN: just a message')
    expect(e.nativeCode).toBeUndefined()
    expect(mapMysqlError('a string', false).message).toBe('UNKNOWN: a string')
  })

  it('hands an AdapterError back as it is', () => {
    const own = new AdapterError('NOT_FOUND', 'x')
    expect(mapMysqlError(own, true)).toBe(own)
  })
})

describe('mapMysqlError: error numbers that only MariaDB has', () => {
  it('names them, whether or not the server was recognised as MariaDB, when there is no code', () => {
    for (const mariadb of [false, true]) {
      expect(mapMysqlError({ errno: 1969, sqlMessage: 'Query execution was interrupted' }, mariadb)).toMatchObject({
        code: 'QUERY_FAILED',
        nativeCode: 'ER_STATEMENT_TIMEOUT',
      })
      expect(mapMysqlError({ errno: 4084, sqlMessage: 'seq' }, mariadb)).toMatchObject({
        nativeCode: 'ER_SEQUENCE_RUN_OUT',
      })
      expect(mapMysqlError({ errno: 4091, sqlMessage: 'x' }, mariadb)).toMatchObject({
        code: 'NOT_FOUND',
        nativeCode: 'ER_UNKNOWN_SEQUENCES',
      })
    }
  })

  it('calls an unnamed number ER_<number>', () => {
    expect(mapMysqlError({ errno: 4242, message: 'x' }, true).nativeCode).toBe('ER_4242')
    expect(mapMysqlError({ errno: 1234, sqlMessage: 'only a number' }, false).nativeCode).toBe('ER_1234')
  })

  it("lets a MariaDB number win over the driver's code only on a MariaDB server", () => {
    // mysql2 names numbers after MySQL 8: on MariaDB a number from 4000 up means something else.
    const e = { code: 'ER_SOMETHING', errno: 4100, sqlMessage: 'm' }
    expect(mapMysqlError(e, true).nativeCode).toBe('ER_4100')
    expect(mapMysqlError(e, false).nativeCode).toBe('ER_SOMETHING')
  })
})
