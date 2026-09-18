import { describe, expect, it } from 'vitest'
import type { PreferenceStore } from './preferences.ts'
import { pushRecent, RECENT_LIMIT, shortcutStore, type TableShortcut, toggleIn } from './table-shortcuts.ts'

const memory = (): PreferenceStore => {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const t = (table: string, schema?: string) => ({ db: 'shop', ...(schema ? { schema } : {}), table })

describe('table shortcuts', () => {
  it('keeps the most recent first, once each, up to the limit', () => {
    let list: TableShortcut[] = [t('a'), t('b')]
    list = pushRecent(list, t('b'))
    expect(list.map((x) => x.table)).toEqual(['b', 'a'])
    for (let i = 0; i < RECENT_LIMIT + 5; i++) list = pushRecent(list, t(`t${i}`))
    expect(list).toHaveLength(RECENT_LIMIT)
    expect(list[0]?.table).toBe(`t${RECENT_LIMIT + 4}`)
  })

  it('tells a table from the one of the same name in another schema', () => {
    const list = pushRecent([t('users', 'app')], t('users', 'audit'))
    expect(list).toHaveLength(2)
    expect(toggleIn(list, t('users', 'app'))).toEqual([t('users', 'audit')])
  })

  it('adds a favorite, and takes it out again', () => {
    expect(toggleIn([], t('a'))).toEqual([t('a')])
    expect(toggleIn([t('a'), t('b')], t('a'))).toEqual([t('b')])
  })

  it('keeps each connection’s lists apart', () => {
    const store = memory()
    const one = shortcutStore('mysql|db|3306|root', store)
    const other = shortcutStore('mysql|db|3306|alice', store)
    one.visit(t('orders'))
    one.toggleFavorite(t('users'))
    expect(one.read('recent')).toEqual([t('orders')])
    expect(one.read('favorites')).toEqual([t('users')])
    expect(other.read('recent')).toEqual([])
    expect(other.read('favorites')).toEqual([])
  })
})
