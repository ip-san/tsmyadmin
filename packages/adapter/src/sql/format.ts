import type { ObjectDependency } from '@tsmyadmin/shared'
/** Catalog-row value normalisers shared by introspection and server queries. */
/** Builds ObjectDependency entries from (kind, name, refKind, refName) rows, dropping self-references. */
export function groupDependencies(
  rows: { kind: 'view' | 'routine'; name: string; refKind: 'table' | 'view' | 'routine'; refName: string }[]
): ObjectDependency[] {
  const byKey = new Map<string, ObjectDependency>()
  for (const r of rows) {
    if (r.kind === r.refKind && r.name === r.refName) continue
    const key = `${r.kind}:${r.name}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = { kind: r.kind, name: r.name, dependsOn: [] }
      byKey.set(key, entry)
    }
    entry.dependsOn.push({ kind: r.refKind, name: r.refName })
  }
  return [...byKey.values()]
}

export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
/** Joins optional parts with " / ", or null when all are empty (e.g. COMMAND / STATE). */
export const joinParts = (...parts: unknown[]): string | null =>
  parts
    .map(strOrNull)
    .filter((x): x is string => !!x)
    .join(' / ') || null
