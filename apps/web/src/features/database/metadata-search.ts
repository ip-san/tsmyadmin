import type { TableSchema } from '@tsmyadmin/shared'

/** Where in a text the term was found: `[start, end)` in the text as it is shown. */
export type Span = readonly [number, number]

/** A text with the places the term was found in it (none: it did not match). */
export interface Hit {
  text: string
  spans: Span[]
}

/** One line of the results: a table (column null) or one of its columns, with what matched in each part. */
export interface MetadataMatch {
  table: string
  column: string | null
  /** The parts shown, each with its matches: name, type, comment. */
  name: Hit
  type: Hit | null
  comment: Hit | null
}

/**
 * The text folded for matching, character by character, with where each folded character came from: case and
 * width do not count (`ＩＤ` finds `id`, `ｶﾅ` finds `カナ`), and a match is shown on the characters it came from.
 */
function fold(text: string): { folded: string; from: number[] } {
  let folded = ''
  const from: number[] = []
  // A character with the marks after it (combining marks, half-width ﾞ ﾟ), folded together: ｶﾞ is ガ.
  for (const m of text.matchAll(/.[\p{M}\uFF9E\uFF9F]*/gsu)) {
    const f = m[0].normalize('NFKC').toLowerCase()
    folded += f
    for (let k = 0; k < f.length; k++) from.push(m.index)
  }
  from.push(text.length)
  return { folded, from }
}

/** Where `term` (already folded) is in `text`, every place, without overlaps. */
export function findSpans(text: string, term: string): Span[] {
  if (term === '') return []
  const { folded, from } = fold(text)
  const spans: Span[] = []
  for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
    const start = from[at] ?? 0
    const endAt = at + term.length
    // The end is the start of the next original character (a folded character may stand for several).
    const end = endAt < from.length - 1 ? (from[endAt] ?? text.length) : text.length
    spans.push([start, Math.max(end, start + 1)])
  }
  return spans
}

const hit = (text: string | null, term: string): Hit | null =>
  text === null ? null : { text, spans: findSpans(text, term) }
const matched = (h: Hit | null) => (h?.spans.length ?? 0) > 0

/**
 * Tables and columns whose name, type or comment holds the term, across every table described: a table is listed
 * when its name or comment does, a column when its name, type or comment does. Blank finds nothing. In the order
 * of the tables, then of their columns.
 */
export function matchMetadata(schemas: readonly TableSchema[], term: string): MetadataMatch[] {
  const q = fold(term.trim()).folded
  if (q === '') return []
  return schemas.flatMap((s) => {
    const own = { table: s.name, column: null, name: hit(s.name, q) as Hit, type: null, comment: hit(s.comment, q) }
    const columns = s.columns.map((c) => ({
      table: s.name,
      column: c.name,
      name: hit(c.name, q) as Hit,
      type: hit(c.dataType, q),
      comment: hit(c.comment, q),
    }))
    return [own, ...columns].filter((m) => matched(m.name) || matched(m.type) || matched(m.comment))
  })
}
