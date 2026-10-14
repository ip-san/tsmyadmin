import { AdapterError } from '@tsmyadmin/adapter'
import { describe, expect, it } from 'vitest'
import { type LoginTarget, loginHint } from './login-hints.ts'

const mysql: LoginTarget = { host: '127.0.0.1', port: 13306, user: 'root' }
const pg: LoginTarget = { host: 'db', port: 5432, user: 'app', database: 'shop' }
const err = (code: 'AUTH_FAILED' | 'CONNECTION_FAILED', native: string, message: string) =>
  new AdapterError(code, `${native}: ${message}`, message, { nativeCode: native })

describe('loginHint', () => {
  it('reads the account and the address MySQL refused', () => {
    expect(
      loginHint(
        err(
          'AUTH_FAILED',
          'ER_ACCESS_DENIED_ERROR',
          "Access denied for user 'root'@'172.18.0.1' (using password: YES)"
        ),
        mysql
      )
    ).toEqual({ reason: 'LOGIN_MYSQL_ACCESS_DENIED', params: { user: 'root', from: '172.18.0.1' } })
    expect(
      loginHint(
        err(
          'CONNECTION_FAILED',
          'ER_HOST_NOT_PRIVILEGED',
          "Host '172.18.0.1' is not allowed to connect to this MySQL server"
        ),
        mysql
      )
    ).toEqual({ reason: 'LOGIN_MYSQL_HOST_NOT_ALLOWED', params: { from: '172.18.0.1' } })
    expect(
      loginHint(
        err('CONNECTION_FAILED', 'ER_HOST_IS_BLOCKED', "Host '10.0.0.5' is blocked because of many connection errors"),
        mysql
      )
    ).toEqual({ reason: 'LOGIN_MYSQL_HOST_BLOCKED', params: { from: '10.0.0.5' } })
  })

  it('reads the pg_hba.conf line PostgreSQL is missing, and a wrong password', () => {
    expect(
      loginHint(
        err(
          'AUTH_FAILED',
          '28000',
          'no pg_hba.conf entry for host "172.18.0.1", user "app", database "shop", no encryption'
        ),
        pg
      )
    ).toEqual({ reason: 'LOGIN_PG_NO_HBA_ENTRY', params: { from: '172.18.0.1', user: 'app', database: 'shop' } })
    expect(loginHint(err('AUTH_FAILED', '28P01', 'password authentication failed for user "app"'), pg)).toEqual({
      reason: 'LOGIN_PG_PASSWORD',
      params: { user: 'app' },
    })
    // 28000 without the pg_hba wording (a role without LOGIN, say) is not that hint.
    expect(loginHint(err('AUTH_FAILED', '28000', 'role "app" is not permitted to log in'), pg)).toBeNull()
  })

  it('says which address had nothing listening, and whether it was a loopback one', () => {
    expect(loginHint(err('CONNECTION_FAILED', 'ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:13306'), mysql)).toEqual({
      reason: 'LOGIN_REFUSED',
      params: { host: '127.0.0.1', port: 13306, loopback: 1 },
    })
    expect(loginHint(err('CONNECTION_FAILED', 'ECONNREFUSED', 'connect ECONNREFUSED'), pg)).toMatchObject({
      params: { loopback: 0 },
    })
    expect(loginHint(err('CONNECTION_FAILED', 'ETIMEDOUT', 'connect ETIMEDOUT'), pg)).toEqual({
      reason: 'LOGIN_UNREACHABLE',
      params: { host: 'db', port: 5432 },
    })
    expect(loginHint(err('CONNECTION_FAILED', 'ENOTFOUND', 'getaddrinfo ENOTFOUND db'), pg)).toEqual({
      reason: 'LOGIN_HOST_UNKNOWN',
      params: { host: 'db' },
    })
  })

  it('is null for an error that says nothing more than its code', () => {
    expect(loginHint(err('CONNECTION_FAILED', 'ER_CON_COUNT_ERROR', 'Too many connections'), mysql)).toBeNull()
    expect(loginHint(new AdapterError('CONNECTION_FAILED', 'x'), mysql)).toBeNull()
  })
})
