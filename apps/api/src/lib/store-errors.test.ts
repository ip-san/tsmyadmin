import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { toApiError } from './errors.ts'
import { isStoreUnavailable } from './store-errors.ts'

/** The error node:sqlite really throws (the same under Bun and Node), not a lookalike. */
function sqliteError(open: () => unknown): Error {
  try {
    open()
  } catch (err) {
    if (err instanceof Error) return err
  }
  throw new Error('the probe did not fail')
}

describe('isStoreUnavailable', () => {
  it('recognises the error ioredis gives when Redis does not answer', () => {
    // Observed with a Redis stopped under a live connection: class and name are both this.
    const err = Object.assign(new Error('Reached the max retries per request limit (which is 3).'), {
      name: 'MaxRetriesPerRequestError',
    })
    expect(isStoreUnavailable(err)).toBe(true)
  })

  it('recognises a command sent after the Redis connection ended', () => {
    expect(isStoreUnavailable(new Error('Connection is closed.'))).toBe(true)
  })

  it('recognises a SQLite file that cannot be opened', () => {
    expect(isStoreUnavailable(sqliteError(() => new DatabaseSync('/nonexistent-dir/sessions.db')))).toBe(true)
  })

  it('recognises a SQLite file that is locked, and one that is read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-errors-'))
    const file = join(dir, 'sessions.db')
    const holder = new DatabaseSync(file)
    holder.exec('create table t(a)')
    const writer = new DatabaseSync(file, { timeout: 20 })
    const reader = new DatabaseSync(file, { readOnly: true })
    holder.exec('BEGIN EXCLUSIVE')
    try {
      // Two connections to one file: the second cannot write while the first holds the lock.
      expect(isStoreUnavailable(sqliteError(() => writer.exec('insert into t values (1)')))).toBe(true)
      holder.exec('ROLLBACK')
      expect(isStoreUnavailable(sqliteError(() => reader.exec('insert into t values (1)')))).toBe(true)
    } finally {
      holder.close()
      writer.close()
      reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not take a constraint violation or a missing table (bugs) for an outage', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('create table u(x unique); insert into u values (1)')
    expect(isStoreUnavailable(sqliteError(() => db.exec('insert into u values (1)')))).toBe(false)
    expect(isStoreUnavailable(sqliteError(() => db.exec('select * from missing_table')))).toBe(false)
    db.close()
  })

  it('does not take anything else for an outage', () => {
    expect(isStoreUnavailable(new Error('boom'))).toBe(false)
    expect(isStoreUnavailable('Connection is closed.')).toBe(false)
    expect(isStoreUnavailable(null)).toBe(false)
  })

  it('maps to 503 STORE_UNAVAILABLE with no detail for the client', () => {
    const { body, status } = toApiError(Object.assign(new Error('x'), { name: 'MaxRetriesPerRequestError' }))
    expect(status).toBe(503)
    expect(body).toEqual({ code: 'STORE_UNAVAILABLE', message: 'The session store is unavailable' })
  })
})
