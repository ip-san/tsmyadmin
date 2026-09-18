import { describe, expect, it } from 'vitest'
import { readPayload } from './saved-queries.ts'

describe('readPayload', () => {
  it('reads a stored item, and a row written before export templates existed as a bookmark', () => {
    expect(readPayload(JSON.stringify({ kind: 'export', name: 'nightly', body: '{}' }), 'i', 5)).toEqual({
      id: 'i',
      kind: 'export',
      name: 'nightly',
      body: '{}',
      at: 5,
    })
    // 0.2.x rows hold { name, sql } and no kind: they are bookmarks, not something to throw away.
    expect(readPayload(JSON.stringify({ name: 'daily', sql: 'SELECT 1' }), 'i', 5)).toEqual({
      id: 'i',
      kind: 'sql',
      name: 'daily',
      body: 'SELECT 1',
      at: 5,
    })
    // An unknown kind is read as a bookmark rather than becoming a fourth state nothing handles.
    expect(readPayload(JSON.stringify({ kind: 'chart', name: 'x', body: 'y' }), 'i', 5).kind).toBe('sql')
  })
})
