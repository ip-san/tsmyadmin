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

/** A text folded once, to be matched against many terms. */
interface Folded {
  text: string
  folded: string
  /** For each folded character: where the original character it came from starts, and where it ends. */
  from: number[]
  to: number[]
}

/**
 * The text folded for matching, with where each folded character came from: case and width do not count (`ＩＤ`
 * finds `id`, `ｶﾅ` finds `カナ`). A character is folded with the marks after it (combining marks, half-width ﾞ ﾟ:
 * ｶﾞ is ガ), and one character may fold to several (`ﬁ` is `fi`, `…` is `...`): each of those points back to it.
 */
function fold(text: string): Folded {
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  for (const m of text.matchAll(/.[\p{M}ﾞﾟ]*/gsu)) {
    const f = m[0].normalize('NFKC').toLowerCase()
    folded += f
    for (let k = 0; k < f.length; k++) {
      from.push(m.index)
      to.push(m.index + m[0].length)
    }
  }
  return { text, folded, from, to }
}

/** The term folded as the texts are. */
export const foldTerm = (term: string): string => fold(term.trim()).folded

/**
 * Where the folded `term` is in a folded text, every place, as spans of the original characters: a match that
 * starts or ends inside a character that folded to several covers the whole of it, and matches that fall on the
 * same characters are joined into one.
 */
function spansIn(f: Folded, term: string): Span[] {
  if (term === '') return []
  const spans: [number, number][] = []
  for (let at = f.folded.indexOf(term); at !== -1; at = f.folded.indexOf(term, at + term.length)) {
    const start = f.from[at] ?? 0
    const end = f.to[at + term.length - 1] ?? f.text.length
    const last = spans.at(-1)
    if (last && start < last[1]) last[1] = Math.max(last[1], end)
    else spans.push([start, end])
  }
  return spans
}

/** Where `term` is in `text`, case and width aside (for one text; a search over many uses `indexMetadata`). */
export const findSpans = (text: string, term: string): Span[] => spansIn(fold(text), fold(term).folded)

interface Entry {
  table: string
  column: string | null
  name: Folded
  type: Folded | null
  comment: Folded | null
}

/** Every table and column, its texts folded once: typing a term then matches them without folding again. */
export type MetadataIndex = readonly Entry[]

const folded = (text: string | null) => (text === null ? null : fold(text))

/** The index of the tables described, in their order, each table before its columns. */
export function indexMetadata(schemas: readonly TableSchema[]): MetadataIndex {
  return schemas.flatMap((s) => [
    { table: s.name, column: null, name: fold(s.name), type: null, comment: folded(s.comment) },
    ...s.columns.map((c) => ({
      table: s.name,
      column: c.name,
      name: fold(c.name),
      type: fold(c.dataType),
      comment: folded(c.comment),
    })),
  ])
}

const hit = (f: Folded | null, term: string): Hit | null =>
  f === null ? null : { text: f.text, spans: spansIn(f, term) }
const matched = (h: Hit | null) => (h?.spans.length ?? 0) > 0

/**
 * Tables and columns whose name, type or comment holds the term (`foldTerm`): a table is listed when its name or
 * comment does, a column when its name, type or comment does. Blank finds nothing. At most `limit` are given, in
 * the order of the index; `total` says how many there are.
 */
export function matchMetadata(
  index: MetadataIndex,
  term: string,
  limit = Number.POSITIVE_INFINITY
): { matches: MetadataMatch[]; total: number } {
  if (term === '') return { matches: [], total: 0 }
  const matches: MetadataMatch[] = []
  let total = 0
  for (const e of index) {
    // Cheap first: most entries hold the term nowhere.
    if (!e.name.folded.includes(term) && !e.type?.folded.includes(term) && !e.comment?.folded.includes(term)) continue
    const m = {
      table: e.table,
      column: e.column,
      name: hit(e.name, term) as Hit,
      type: hit(e.type, term),
      comment: hit(e.comment, term),
    }
    if (!matched(m.name) && !matched(m.type) && !matched(m.comment)) continue
    total += 1
    if (matches.length < limit) matches.push(m)
  }
  return { matches, total }
}
