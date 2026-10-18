import type { RelationDef } from '@tsmyadmin/shared'

/** The most steps a focus reaches out: further, on a joined-up schema, it is most of the diagram again. */
export const MAX_HOPS = 3

/**
 * The tables within `hops` keys of `start`, following keys both ways (what it refers to, and what refers to it),
 * `start` included. Only `tables` are reached: a key to a table not drawn leads nowhere. A start not among them
 * gives nothing.
 */
export function neighbourhood(
  tables: readonly string[],
  relations: readonly Pick<RelationDef, 'table' | 'refTable'>[],
  start: string,
  hops: number
): Set<string> {
  const drawn = new Set(tables)
  if (!drawn.has(start)) return new Set()
  const next = new Map<string, string[]>()
  const link = (a: string, b: string) => next.set(a, [...(next.get(a) ?? []), b])
  for (const r of relations) {
    if (!drawn.has(r.table) || !drawn.has(r.refTable)) continue
    link(r.table, r.refTable)
    link(r.refTable, r.table)
  }
  const reached = new Set([start])
  let ring = [start]
  for (let step = 0; step < hops && ring.length > 0; step++) {
    const out: string[] = []
    for (const table of ring)
      for (const n of next.get(table) ?? [])
        if (!reached.has(n)) {
          reached.add(n)
          out.push(n)
        }
    ring = out
  }
  return reached
}
