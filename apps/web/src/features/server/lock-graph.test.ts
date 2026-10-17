import type { LockWait } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { lockGraph, lockSentences } from './lock-graph.ts'

const t = locale.server
const wait = (blocked: string, blocking: string, extra: Partial<LockWait> & { idle?: boolean } = {}): LockWait => ({
  blocked: { id: blocked, user: 'app', database: 'shop', waitSec: 3, query: null },
  blocking: {
    id: blocking,
    user: 'app',
    database: 'shop',
    state: null,
    idleInTransaction: extra.idle ?? false,
    transactionSec: 9,
    query: null,
  },
  table: 'table' in extra ? (extra.table ?? null) : 'orders',
  mode: 'mode' in extra ? (extra.mode ?? null) : 'X',
})

describe('lockGraph', () => {
  it('draws an arrow from each waiting session to the one it waits for, and marks where the chain starts', () => {
    // 3 waits for 2, which waits for 1: 1 holds both up.
    const g = lockGraph([wait('2', '1', { idle: true }), wait('3', '2')])
    expect(g.arrows.map((a) => [a.from, a.to, a.label])).toEqual([
      ['2', '1', 'orders X'],
      ['3', '2', 'orders X'],
    ])
    expect(g.roots).toEqual([{ id: '1', waiting: 2, idle: true }])
    const one = g.nodes.find((n) => n.id === '1')
    expect(one).toMatchObject({
      label: t.lockSession('1'),
      sublabel: 'app / shop',
      tone: 'focus',
      badge: t.lockBlocksBadge(2),
    })
    expect(g.nodes.find((n) => n.id === '3')?.tone).toBeUndefined()
    expect(g.cycles).toEqual([])
  })

  it('counts every session one holds up, and puts the most waited-for root first', () => {
    const g = lockGraph([wait('2', '1'), wait('3', '9'), wait('4', '9'), wait('5', '4')])
    expect(g.roots.map((r) => [r.id, r.waiting])).toEqual([
      ['9', 3],
      ['1', 1],
    ])
  })

  it('joins the locks of one pair into one arrow', () => {
    const g = lockGraph([
      wait('2', '1', { table: 'a' }),
      wait('2', '1', { table: 'b', mode: 'S' }),
      wait('2', '1', { table: 'a' }),
    ])
    expect(g.arrows).toHaveLength(1)
    expect(g.arrows[0]?.label).toBe('a X / b S')
  })

  it('shows a session waiting on two others with an arrow to each', () => {
    const g = lockGraph([wait('3', '1'), wait('3', '2')])
    expect(g.arrows.map((a) => a.to)).toEqual(['1', '2'])
    expect(g.roots.map((r) => r.id).sort()).toEqual(['1', '2'])
  })

  it('marks a deadlock: the sessions and the arrows between them, with no root', () => {
    const g = lockGraph([wait('1', '2'), wait('2', '1'), wait('3', '1')])
    expect(g.cycles).toEqual([['1', '2']])
    expect(g.roots).toEqual([])
    expect(g.nodes.filter((n) => n.tone === 'blocked').map((n) => n.id)).toEqual(['1', '2'])
    expect(g.arrows.filter((a) => a.tone === 'blocked')).toHaveLength(2)
  })

  it('leaves the label off when the server names no lock', () => {
    expect(lockGraph([wait('2', '1', { table: null, mode: null })]).arrows[0]?.label).toBeUndefined()
  })
})

describe('lockGraph, more shapes', () => {
  it('counts each session held up once, even reached along two paths (a diamond)', () => {
    const g = lockGraph([wait('2', '1'), wait('3', '1'), wait('4', '2'), wait('4', '3')])
    expect(g.roots).toEqual([{ id: '1', waiting: 3, idle: false }])
  })

  it('remembers a blocker is idle whichever of its rows says so', () => {
    expect(lockGraph([wait('2', '1', { idle: true }), wait('3', '1')]).roots[0]?.idle).toBe(true)
    expect(lockGraph([wait('2', '1'), wait('3', '1', { idle: true })]).roots[0]?.idle).toBe(true)
  })

  it('keeps the user and database a blocker was named with when a later row leaves them out', () => {
    const later = wait('3', '1')
    const unnamed = { ...later, blocking: { ...later.blocking, user: null, database: null } }
    expect(lockGraph([wait('2', '1'), unnamed]).nodes.find((n) => n.id === '1')?.sublabel).toBe('app / shop')
  })

  it('marks every session of cycles that share sessions, with a separate chain beside them', () => {
    // 1→2→1 and 1→3→2→1 share sessions; 9 holds 8 up on its own.
    const g = lockGraph([wait('1', '2'), wait('2', '1'), wait('1', '3'), wait('3', '2'), wait('8', '9')])
    expect(g.cycles).toEqual([['1', '2', '3']])
    expect(g.nodes.filter((n) => n.tone === 'blocked').map((n) => n.id)).toEqual(['1', '2', '3'])
    expect(g.roots.map((r) => r.id)).toEqual(['9'])
  })
})

describe('lockSentences', () => {
  it('says the roots first, idle ones as such, then any deadlock, then every wait with its locks', () => {
    expect(lockSentences(lockGraph([wait('2', '1', { idle: true })]))).toEqual([
      `${t.lockRoot('1', 1)}${t.lockRootIdle}`,
      t.lockWait('2', '1', 'orders X'),
    ])
    expect(lockSentences(lockGraph([wait('1', '2'), wait('2', '1', { table: null, mode: null })]))).toEqual([
      t.lockCycle(['1', '2']),
      t.lockWait('1', '2', 'orders X'),
      t.lockWait('2', '1', ''),
    ])
  })
})
