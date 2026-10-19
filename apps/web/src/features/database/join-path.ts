import type { RelationDef } from '@tsmyadmin/shared'

/** One step of a path: from one table to the next, along the keys between the two. */
export interface JoinHop {
  from: string
  to: string
  /** Every key between the two, by name: a query joins along one of them, and which is not told here. */
  keys: { relation: RelationDef; forward: boolean }[]
}

/** The most paths shown: past a few, the way between two tables is "through most of the schema". */
export const PATH_LIMIT = 3

const byName = (a: string, b: string) => a.localeCompare(b)

/**
 * The shortest ways from `from` to `to` along foreign keys, followed both ways (a table to the one it refers to, and
 * to one that refers to it), up to `limit` of them, in the order of the tables' names. A path is its tables: two
 * keys between one pair (`created_by` and `updated_by`, both to `users`) are one step that lists both. A key from a
 * table to itself leads nowhere new. `more` tells there are other paths as short. None when the two are one table or
 * no key links them.
 */
export function joinPaths(
  relations: readonly RelationDef[],
  from: string,
  to: string,
  limit = PATH_LIMIT
): { paths: JoinHop[][]; more: boolean } {
  const next = new Map<string, Set<string>>()
  const link = (a: string, b: string) => next.set(a, (next.get(a) ?? new Set()).add(b))
  for (const r of relations) {
    if (r.table === r.refTable) continue
    link(r.table, r.refTable)
    link(r.refTable, r.table)
  }
  // Steps to `to` from each table reached: walking down them from `from` never comes to a dead end.
  const left = new Map([[to, 0]])
  for (let ring = [to]; ring.length > 0; ) {
    const out: string[] = []
    for (const table of ring)
      for (const n of next.get(table) ?? [])
        if (!left.has(n)) {
          left.set(n, (left.get(table) ?? 0) + 1)
          out.push(n)
        }
    ring = out
  }
  const steps = left.get(from)
  if (from === to || steps === undefined) return { paths: [], more: false }
  const found: string[][] = []
  const walk = (path: string[]) => {
    const here = path.at(-1) ?? from
    if (here === to) {
      found.push(path)
      return
    }
    const nearer = [...(next.get(here) ?? [])].filter((n) => left.get(n) === (left.get(here) ?? 0) - 1).sort(byName)
    for (const n of nearer) {
      if (found.length > limit) return
      walk([...path, n])
    }
  }
  walk([from])
  const hop = (a: string, b: string): JoinHop => ({
    from: a,
    to: b,
    keys: relations
      .filter((r) => (r.table === a && r.refTable === b) || (r.table === b && r.refTable === a))
      .sort((x, y) => byName(x.name, y.name))
      .map((relation) => ({ relation, forward: relation.table === a })),
  })
  return {
    paths: found.slice(0, limit).map((tables) => tables.slice(1).map((b, i) => hop(tables[i] ?? from, b))),
    more: found.length > limit,
  }
}
