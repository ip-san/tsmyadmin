import type { LockWait } from '@tsmyadmin/shared'
import type { GraphArrow, GraphNode } from '@/components/node-graph/NodeGraph.tsx'
import { cyclicGroups } from '@/components/schema-diagram/layout.ts'
import { locale } from '@/config/locale-screens.ts'

const t = locale.server

/** The lock waits as a graph, and what it says in words. */
export interface LockGraphModel {
  nodes: GraphNode[]
  arrows: GraphArrow[]
  /** Sessions that hold others up and wait for nobody: what to look at (or end) first, most waited for first. */
  roots: { id: string; waiting: number; idle: boolean }[]
  /** Groups of sessions that wait for each other (deadlocks), each group's IDs sorted. */
  cycles: string[][]
}

/**
 * Sessions as boxes, an arrow from each waiting session to the session it waits for (one arrow per pair, its locks
 * joined in the label). A root is marked as the start; a cycle, as blocked.
 */
export function lockGraph(waits: readonly LockWait[]): LockGraphModel {
  const sessions = new Map<string, { user: string | null; database: string | null; idle: boolean }>()
  const pairs = new Map<string, { from: string; to: string; locks: string[] }>()
  for (const w of waits) {
    if (!sessions.has(w.blocked.id))
      sessions.set(w.blocked.id, { user: w.blocked.user, database: w.blocked.database, idle: false })
    const blocker = sessions.get(w.blocking.id)
    sessions.set(w.blocking.id, {
      user: w.blocking.user ?? blocker?.user ?? null,
      database: w.blocking.database ?? blocker?.database ?? null,
      idle: w.blocking.idleInTransaction || (blocker?.idle ?? false),
    })
    const key = JSON.stringify([w.blocked.id, w.blocking.id])
    const pair = pairs.get(key) ?? { from: w.blocked.id, to: w.blocking.id, locks: [] }
    const lock = [w.table, w.mode].filter(Boolean).join(' ')
    if (lock && !pair.locks.includes(lock)) pair.locks.push(lock)
    pairs.set(key, pair)
  }
  const ids = [...sessions.keys()]
  const edges = [...pairs.values()]
  const cycles = cyclicGroups(ids, edges)
  const inCycle = new Set(cycles.flat())
  const waitsFor = new Set(edges.map((e) => e.from))
  const waitedBy = (id: string) => countWaiting(id, edges)
  const roots = ids
    .filter((id) => !waitsFor.has(id))
    .map((id) => ({ id, waiting: waitedBy(id), idle: sessions.get(id)?.idle ?? false }))
    .sort((a, b) => b.waiting - a.waiting)
  const rootIds = new Set(roots.map((r) => r.id))
  const nodes: GraphNode[] = ids.map((id) => {
    const s = sessions.get(id)
    return {
      id,
      label: t.lockSession(id),
      sublabel: [s?.user, s?.database].filter(Boolean).join(' / ') || undefined,
      tone: inCycle.has(id) ? 'blocked' : rootIds.has(id) ? 'focus' : undefined,
      badge: rootIds.has(id) ? t.lockBlocksBadge(waitedBy(id)) : undefined,
    }
  })
  const arrows: GraphArrow[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.locks.join(' / ') || undefined,
    tone: inCycle.has(e.from) && inCycle.has(e.to) ? 'blocked' : undefined,
  }))
  return { nodes, arrows, roots, cycles }
}

/** How many sessions wait for `id`, directly or through others that wait for it. */
function countWaiting(id: string, edges: readonly { from: string; to: string }[]): number {
  const seen = new Set<string>()
  const queue = [id]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const e of edges) {
      if (e.to === next && !seen.has(e.from) && e.from !== id) {
        seen.add(e.from)
        queue.push(e.from)
      }
    }
  }
  return seen.size
}

/**
 * The graph in words, for the list beside the picture (what a screen reader follows): the roots first, then any
 * deadlock, then every arrow — who waits for whom, on which lock.
 */
export function lockSentences(model: LockGraphModel): string[] {
  return [
    ...model.roots.map((r) => `${t.lockRoot(r.id, r.waiting)}${r.idle ? t.lockRootIdle : ''}`),
    ...model.cycles.map((c) => t.lockCycle(c)),
    ...model.arrows.map((a) => t.lockWait(a.from, a.to, a.label ?? '')),
  ]
}
