import { describe, expect, it } from 'vitest'
import { AdapterError } from '../types.ts'
import { PostgresAdapter } from './adapter.ts'

/** How the PostgreSQL adapter turns what the driver throws into its own error, case by case. */

const adapter = new PostgresAdapter({ dialect: 'postgres', host: 'h', port: 1, user: 'u', password: 'p' })
const err = (e: unknown) => adapter.toAdapterError(e)
const driver = (props: Record<string, unknown>) => Object.assign(new Error(String(props.message ?? 'm')), props)

describe('PostgresAdapter.toAdapterError', () => {
  it("says the connections were all busy for the pool's timeout wording, but only when the error has no code", () => {
    const busy = err({ message: 'timeout exceeded when trying to connect' })
    expect(busy).toMatchObject({ code: 'CONNECTION_FAILED', message: 'No connection became free in time' })
    const withCode = err(driver({ message: 'timeout exceeded when trying to connect', code: '57014' }))
    expect(withCode.message).toBe('57014: timeout exceeded when trying to connect')
    expect(err({ message: 'timeout exceeded' }).message).toBe('UNKNOWN: timeout exceeded')
  })

  it('keeps an adapter error as it is', () => {
    const own = new AdapterError('VALIDATION', 'x')
    expect(err(own)).toBe(own)
  })

  it('uses UNKNOWN when the driver gave no code (and no native code), and the string form of what is not an error', () => {
    const none = err({ message: 'something' })
    expect(none.message).toBe('UNKNOWN: something')
    expect(none.nativeCode).toBeUndefined()
    expect(err({ code: 42, message: 'numeric code' }).message).toBe('UNKNOWN: numeric code')
    expect(err('plain text').message).toBe('UNKNOWN: plain text')
    expect(err(driver({ code: '23505', message: 'dup' })).nativeCode).toBe('23505')
  })

  it('classifies by the code: sign-in, lost connection, permission, missing object, anything else', () => {
    expect(err(driver({ code: '28P01' })).code).toBe('AUTH_FAILED')
    expect(err(driver({ code: '57P01' })).code).toBe('CONNECTION_FAILED')
    expect(err(driver({ code: '42501' })).code).toBe('PERMISSION_DENIED')
    expect(err(driver({ code: '42P01' })).code).toBe('NOT_FOUND')
    expect(err(driver({ code: '23505' })).code).toBe('QUERY_FAILED')
  })

  it('takes a lost connection without a code for one by its message, and only then', () => {
    expect(err(driver({ message: 'Connection terminated unexpectedly' })).code).toBe('CONNECTION_FAILED')
    expect(err(driver({ message: 'read ECONNRESET' })).code).toBe('CONNECTION_FAILED')
    expect(err(driver({ message: 'Client has encountered a connection error and is not queryable' })).code).toBe(
      'QUERY_FAILED'
    )
    expect(err(driver({ code: '23505', message: 'terminated by constraint' })).code).toBe('QUERY_FAILED')
  })

  it('adds the detail and the hint to the detail text, not to the message', () => {
    const e = err(driver({ code: '23505', message: 'dup', detail: 'Key (id)=(1) exists.', hint: 'Use another id.' }))
    expect(e.message).toBe('23505: dup')
    expect(e.detail).toBe('dup (Key (id)=(1) exists.; Use another id.)')
    expect(err(driver({ code: '23505', message: 'dup', detail: '', hint: 7 })).detail).toBe('dup')
    expect(err(driver({ code: '23505', message: 'dup', hint: 'h' })).detail).toBe('dup (h)')
  })

  it('reports where in the statement the error is only for a whole position above 0', () => {
    expect(err(driver({ code: '42601', position: '17' })).position).toBe(17)
    expect(err(driver({ code: '42601', position: 1 })).position).toBe(1)
    for (const position of [0, -3, 2.5, 'x', undefined, null]) {
      expect(err(driver({ code: '42601', position })).position, String(position)).toBeUndefined()
    }
  })
})
