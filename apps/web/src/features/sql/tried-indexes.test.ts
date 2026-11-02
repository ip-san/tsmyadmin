import { TRIED_INDEX_COMMENT } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { index } from '@/test/schema-fixtures.ts'
import { triedOnTables } from './tried-indexes.ts'

describe('triedOnTables', () => {
  it('names the indexes marked as tried on each table, but the one tried now and the ones not marked', () => {
    const tried = (name: string) => index(['a'], { name, comment: TRIED_INDEX_COMMENT })
    expect(
      triedOnTables(
        [
          {
            table: 'logs',
            indexes: [tried('idx_logs_a'), tried('idx_logs_b'), index(['c'], { name: 'mine', comment: 'designed' })],
          },
          // A partitioned parent's cannot be dropped without stopping writes (PostgreSQL).
          { table: 'users', indexes: [tried('idx_users_a')], partitioned: true },
          // Not read yet: nothing said of it.
          { table: 'posts', indexes: undefined },
        ],
        { table: 'logs', name: 'idx_logs_b' }
      )
    ).toEqual([
      { table: 'logs', name: 'idx_logs_a', online: true },
      { table: 'users', name: 'idx_users_a', online: false },
    ])
    // The same name on another table is not the one tried now.
    expect(
      triedOnTables([{ table: 'users', indexes: [tried('idx_logs_b')] }], { table: 'logs', name: 'idx_logs_b' })
    ).toEqual([{ table: 'users', name: 'idx_logs_b', online: true }])
  })
})
