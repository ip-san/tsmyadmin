/** Catalog-row value normalisers shared by introspection and server queries. */
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
/** Joins optional parts with " / ", or null when all are empty (e.g. COMMAND / STATE). */
export const joinParts = (...parts: unknown[]): string | null =>
  parts
    .map(strOrNull)
    .filter((x): x is string => !!x)
    .join(' / ') || null
