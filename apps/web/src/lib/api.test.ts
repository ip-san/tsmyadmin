import { describe, expect, it } from 'vitest'
import { ApiError, sessionExpired } from './api.ts'

const error = (status: number, code: string) => new ApiError(status, { code: code as never, message: 'x' })

describe('sessionExpired', () => {
  it('is true for the 401s that really end a session', () => {
    expect(sessionExpired(error(401, 'UNAUTHENTICATED'))).toBe(true)
    expect(sessionExpired(error(401, 'AUTH_FAILED'))).toBe(true)
  })

  it('is false for a one-time code that was refused or asked for', () => {
    // Both come back as 401 from the same routes. Treating them as an expired session would clear the session
    // client-side and throw the user out to /login after one mistyped code, while the session is still alive.
    expect(sessionExpired(error(401, 'SECOND_FACTOR_INVALID'))).toBe(false)
    expect(sessionExpired(error(401, 'SECOND_FACTOR_REQUIRED'))).toBe(false)
  })

  it('is false for anything that is not a 401 ApiError', () => {
    expect(sessionExpired(error(403, 'HOST_NOT_ALLOWED'))).toBe(false)
    expect(sessionExpired(error(429, 'RATE_LIMITED'))).toBe(false)
    expect(sessionExpired(new Error('network'))).toBe(false)
    expect(sessionExpired(null)).toBe(false)
  })
})
