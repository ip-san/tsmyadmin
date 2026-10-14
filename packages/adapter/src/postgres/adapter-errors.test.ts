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

  // Every member of each set the adapter classifies by (the sets are private to it; a code left out here is a
  // code the adapter stopped knowing).
  it.each([
    // invalid_password, invalid_authorization_specification
    ['28P01', 'AUTH_FAILED'],
    ['28000', 'AUTH_FAILED'],
    // socket-level codes of the driver
    ['ECONNREFUSED', 'CONNECTION_FAILED'],
    ['ECONNRESET', 'CONNECTION_FAILED'],
    ['ETIMEDOUT', 'CONNECTION_FAILED'],
    ['ENOTFOUND', 'CONNECTION_FAILED'],
    ['EHOSTUNREACH', 'CONNECTION_FAILED'],
    // admin_shutdown, cannot_connect_now, too_many_connections
    ['57P01', 'CONNECTION_FAILED'],
    ['57P03', 'CONNECTION_FAILED'],
    ['53300', 'CONNECTION_FAILED'],
    // insufficient_privilege
    ['42501', 'PERMISSION_DENIED'],
    // invalid_catalog_name, invalid_schema_name, undefined_table, undefined_column
    ['3D000', 'NOT_FOUND'],
    ['3F000', 'NOT_FOUND'],
    ['42P01', 'NOT_FOUND'],
    ['42703', 'NOT_FOUND'],
    // anything else: unique_violation, syntax_error, query_canceled
    ['23505', 'QUERY_FAILED'],
    ['42601', 'QUERY_FAILED'],
    ['57014', 'QUERY_FAILED'],
  ])('classifies the code %s as %s', (code, kind) => {
    expect(err(driver({ code }))).toMatchObject({ code: kind, nativeCode: code })
  })

  it.each([
    'Connection terminated unexpectedly',
    'terminating connection due to administrator command',
    'Connection closed',
    'read ECONNRESET',
    // pg's own wording for a client whose socket already failed.
    'Client has encountered a connection error and is not queryable',
  ])('takes a lost connection without a code for one by its message: %s', (message) => {
    expect(err(driver({ message })).code).toBe('CONNECTION_FAILED')
  })

  it('reads the message for a lost connection only when there is no code', () => {
    expect(err(driver({ code: '23505', message: 'terminated by constraint' })).code).toBe('QUERY_FAILED')
    expect(err(driver({ code: '42601', message: 'connection closed' })).code).toBe('QUERY_FAILED')
    expect(err(driver({ message: 'duplicate key' })).code).toBe('QUERY_FAILED')
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
