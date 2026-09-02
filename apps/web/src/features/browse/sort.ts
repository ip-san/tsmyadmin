import type { BrowseOptions } from '@tsmyadmin/shared'

type Sort = BrowseOptions['sort']

function encode(sort: Sort): string | undefined {
  return sort.length === 0 ? undefined : sort.map((s) => `${s.column}:${s.direction}`).join(',')
}

/**
 * Header click cycles one column asc → desc → none. A plain click replaces the whole sort; `additive`
 * (shift-click) keeps the other columns so several can be combined, in click order.
 */
export function nextSort(current: Sort, column: string, additive = false): string | undefined {
  const existing = current.find((s) => s.column === column)
  const cycled =
    existing === undefined
      ? ({ column, direction: 'asc' } as const)
      : existing.direction === 'asc'
        ? ({ column, direction: 'desc' } as const)
        : null
  if (!additive) return encode(cycled ? [cycled] : [])
  const others = current.filter((s) => s.column !== column)
  if (!cycled) return encode(others)
  const idx = current.findIndex((s) => s.column === column)
  const next = [...others]
  next.splice(idx === -1 ? next.length : idx, 0, cycled)
  return encode(next)
}
