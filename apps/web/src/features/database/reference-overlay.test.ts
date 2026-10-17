import type { ReferenceCheck } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import { locale } from '@/config/locale-screens.ts'
import { checkAll, orphansText, referenceOverlay, type TableCheck } from './reference-overlay.ts'

const t = locale.designer.refCheck
const check = (name: string, orphans: number): ReferenceCheck => ({
  name,
  columns: ['user_id'],
  refNamespace: { database: 'shop' },
  refTable: 'users',
  refColumns: ['id'],
  orphans,
  sql: 'SELECT …',
})
const checks = new Map<string, TableCheck>([
  ['posts', [check('fk_posts_user', 3), check('fk_posts_cat', 0)]],
  ['logs', 'failed'],
])

describe('referenceOverlay', () => {
  const overlay = referenceOverlay(checks)

  it('lights and badges only the keys with rows whose parent is missing', () => {
    const key = relationKey({ table: 'posts', name: 'fk_posts_user' })
    expect([...overlay.relations]).toEqual([[key, 'delete']])
    expect([...(overlay.relationBadges ?? [])]).toEqual([[key, t.orphans(3)]])
  })

  it('adds to the picture without fading the rest, and lights no table', () => {
    expect(overlay.fade).toBe(false)
    expect(overlay.tables.size).toBe(0)
  })
})

describe('orphansText', () => {
  it('gives the count, that the table could not be checked, or nothing before the check', () => {
    expect(orphansText(checks, 'posts', 'fk_posts_user')).toBe('3')
    expect(orphansText(checks, 'posts', 'fk_posts_cat')).toBe('0')
    expect(orphansText(checks, 'logs', 'fk_logs_x')).toBe(t.failed)
    expect(orphansText(checks, 'orders', 'fk')).toBeNull()
    // Checked, but not a key the check knows (made since): not checked, rather than the "…" of waiting.
    expect(orphansText(checks, 'posts', 'gone')).toBe(t.notChecked)
  })

  it('writes large counts with the locale separators', () => {
    expect(orphansText(new Map([['p', [check('fk', 12345)]]]), 'p', 'fk')).toBe(t.count(12345))
    expect(t.count(12345)).toMatch(/12.345/)
  })
})

describe('checkAll', () => {
  it('checks every table, never more than the limit at once, keeping the order given', async () => {
    let running = 0
    let most = 0
    const tables = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const result = await checkAll(
      tables,
      async (table) => {
        running += 1
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, table === 'a' ? 5 : 1))
        running -= 1
        return [check(`fk_${table}`, 0)]
      },
      { limit: 3 }
    )
    expect(most).toBe(3)
    expect([...result.keys()]).toEqual(tables)
  })

  it('marks a table whose check fails, and keeps the others', async () => {
    const result = await checkAll(['a', 'b'], async (table) => {
      if (table === 'a') throw new Error('timeout')
      return [check('fk_b', 2)]
    })
    expect(result.get('a')).toBe('failed')
    expect(result.get('b')).toEqual([check('fk_b', 2)])
  })

  it('starts no more tables once told to stop', async () => {
    const stop = new AbortController()
    const started: string[] = []
    const result = await checkAll(
      ['a', 'b', 'c'],
      async (table) => {
        started.push(table)
        stop.abort()
        return []
      },
      { limit: 1, signal: stop.signal }
    )
    expect(started).toEqual(['a'])
    expect([...result.keys()]).toEqual(['a'])
  })

  it('has nothing to check for no tables', async () => {
    expect(await checkAll([], async () => [])).toEqual(new Map())
  })
})
