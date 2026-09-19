/**
 * Lays statements out over lines: a clause to a line, and the select list, the conditions and the rows of a VALUES
 * list one to a line under it. Only whitespace between tokens changes. Words keep their case and the text of a
 * string, an identifier or a comment stays exactly as written, so formatting never alters what a statement means.
 * A subquery in parentheses stays on its line.
 */

export interface SqlToken {
  kind: 'word' | 'quoted' | 'comment' | 'punct'
  text: string
  /** Whitespace came before it in the source. */
  gap: boolean
  /** A blank line came before it in the source. */
  blank: boolean
  /** Where in the source it starts. */
  start: number
}

const PATTERNS: [RegExp, SqlToken['kind']][] = [
  [/^(?:--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/, 'comment'],
  [/^\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/, 'quoted'],
  [/^[\p{L}_][\w$\p{L}]*/u, 'word'],
  [/^\d[\d.]*(?:[eE][+-]?\d+)?/, 'word'],
]

/** The end of a quoted run that starts at `start`: a doubled quote (and, in strings, a backslash) is inside it. */
function quotedEnd(sql: string, start: number): number {
  const quote = sql.charAt(start)
  let i = start + 1
  while (i < sql.length) {
    if (sql.charAt(i) === '\\' && quote !== '`') i += 2
    else if (sql.charAt(i) === quote && sql.charAt(i + 1) === quote) i += 2
    else if (sql.charAt(i) === quote) return i + 1
    else i++
  }
  return sql.length
}

/** The statement as tokens (strings, identifiers, comments, words, punctuation), each with where it starts. */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = []
  let i = 0
  let gap = false
  let blank = false
  while (i < sql.length) {
    const rest = sql.slice(i)
    const space = /^\s+/.exec(rest)
    if (space) {
      gap = true
      if ((space[0].match(/\n/g) ?? []).length >= 2) blank = true
      i += space[0].length
      continue
    }
    const ch = sql.charAt(i)
    let text: string
    let kind: SqlToken['kind']
    if (ch === "'" || ch === '"' || ch === '`') {
      text = sql.slice(i, quotedEnd(sql, i))
      kind = 'quoted'
    } else {
      const hit = PATTERNS.map(([re, k]) => ({ m: re.exec(rest), k })).find((x) => x.m)
      text = hit?.m?.[0] ?? ch
      kind = hit?.k ?? 'punct'
    }
    out.push({ kind, text, gap, blank, start: i })
    gap = false
    blank = false
    i += text.length
  }
  return out
}

/** Clauses that start a line at the top level. */
const CLAUSE = new Set([
  'from',
  'where',
  'having',
  'limit',
  'offset',
  'values',
  'set',
  'returning',
  'union',
  'intersect',
  'except',
])
const JOIN_LEAD = new Set(['inner', 'left', 'right', 'full', 'cross', 'natural', 'straight_join'])
/** Statement keywords that only start a line when they start a statement (`FOR UPDATE`, `ON DELETE` do not). */
const STATEMENT = new Set(['insert', 'update', 'delete', 'replace', 'with'])
/** Clauses whose comma-separated items go one to a line. */
const LISTED = new Set(['select', 'set', 'group', 'order', 'values'])

export function formatSql(sql: string): string {
  const tokens = tokenizeSql(sql)
  let out = ''
  let atLineStart = true
  let depth = 0
  let clause = ''
  let between = false
  const breakLine = (indent: number) => {
    if (atLineStart) return
    out = `${out.trimEnd()}\n${'  '.repeat(indent)}`
    atLineStart = true
  }
  const emit = (text: string, gap: boolean) => {
    out += atLineStart || !gap ? text : ` ${text}`
    atLineStart = false
  }
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    const word = t.kind === 'word' ? t.text.toLowerCase() : ''
    const prevWord = prev?.kind === 'word' ? prev.text.toLowerCase() : ''
    const startsStatement = prev === undefined || prev.text === ';'
    if (t.blank && !atLineStart) breakLine(0)
    if (t.kind === 'comment') {
      emit(t.text, t.gap)
      if (t.text.startsWith('--') || t.text.startsWith('#')) breakLine(depth === 0 && LISTED.has(clause) ? 1 : 0)
      return
    }
    if (t.kind === 'punct') {
      if (t.text === '(') depth++
      if (t.text === ')') depth = Math.max(0, depth - 1)
      emit(t.text, t.gap)
      if (t.text === ';' && depth === 0) {
        breakLine(0)
        out += '\n'
        clause = ''
      } else if (t.text === ',' && depth === 0 && LISTED.has(clause)) breakLine(1)
      return
    }
    if (depth === 0 && word !== '') {
      const call = next?.text === '('
      if (word === 'select') {
        breakLine(0)
        clause = 'select'
      } else if (STATEMENT.has(word) && startsStatement) {
        breakLine(0)
        clause = word
      } else if ((word === 'group' || word === 'order') && next?.text.toLowerCase() === 'by') {
        breakLine(0)
        clause = word
      } else if (JOIN_LEAD.has(word) && !call) {
        breakLine(0)
        clause = 'join'
      } else if (word === 'join' && !JOIN_LEAD.has(prevWord) && prevWord !== 'outer') {
        breakLine(0)
        clause = 'join'
      } else if (
        CLAUSE.has(word) &&
        !(word === 'from' && clause === 'delete') &&
        // `VALUES (…)` is the row list of an INSERT, but `values(col)` elsewhere is a function.
        (!call || (word === 'values' && (clause === 'insert' || clause === 'replace')))
      ) {
        breakLine(0)
        clause = word
      } else if (word === 'between') between = true
      else if ((word === 'and' || word === 'or') && (clause === 'where' || clause === 'join' || clause === 'having')) {
        if (word === 'and' && between) between = false
        else breakLine(1)
      }
    }
    emit(t.text, t.gap)
  })
  return out.trim()
}
