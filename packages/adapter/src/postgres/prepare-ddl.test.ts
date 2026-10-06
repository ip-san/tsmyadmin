import { describe, expect, it } from 'vitest'
import { FakeAdapter } from '../testing/fake-adapter.ts'
import { AdapterError } from '../types.ts'
import { pgPrepareDdl } from './prepare-ddl.ts'

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof AdapterError) return { code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

describe('pgPrepareDdl: a rename or copy of a whole database', () => {
  it('refuses, on PostgreSQL, the database the session is connected through', async () => {
    const pg = new FakeAdapter({
      dialect: 'postgres',
      serverNamespace: { database: 'app' },
      databases: { app: { tables: {} }, other: { tables: {} } },
    })
    expect(
      await refusal(pgPrepareDdl(pg, { database: 'app' }, { op: 'renameDatabase', name: 'app', newName: 'x' }))
    ).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('connected through'),
    })
    // Any other database is renamed in place, with nothing to fill in.
    expect(await pgPrepareDdl(pg, { database: 'app' }, { op: 'renameDatabase', name: 'other', newName: 'x' })).toEqual({
      op: 'renameDatabase',
      name: 'other',
      newName: 'x',
    })
  })
})
