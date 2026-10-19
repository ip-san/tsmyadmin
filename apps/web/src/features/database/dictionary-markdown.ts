import type { TableSchema } from '@tsmyadmin/shared'
import { locale } from '@/config/locale-screens.ts'

const t = locale.dictionary

/** What a column references, as `table.column` (the first key a column takes part in). */
export function referencesOf(schema: Pick<TableSchema, 'foreignKeys'>): Map<string, string> {
  const out = new Map<string, string>()
  for (const fk of schema.foreignKeys)
    fk.columns.forEach((c, i) => {
      if (!out.has(c)) out.set(c, `${fk.refTable}.${fk.refColumns[i] ?? ''}`)
    })
  return out
}

const WORD = /[\p{L}\p{N}]/u

/**
 * Text as Markdown shows it within a line, not as Markdown reads it: a name or a comment may hold `*`, `|`, `<script>`
 * or `[x](y)`, and is written to be read, not to format. A tag is written with `&lt;` (a renderer that lets HTML
 * through shows it as text), and so is an `&` that would begin an entity; a line break as a space (`breaks` says what
 * goes there instead, in a table cell). An `_` inside a word (`user_id`) is left as it is: Markdown does not read it
 * there, and the file stays readable. A bare URL is left to be linked, as the address it is.
 */
export function markdownText(text: string, breaks = ' '): string {
  return text
    .replace(/&(?=#?\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/[\\`*[\]|~]/g, '\\$&')
    .replace(/_/g, (_, i: number, s: string) =>
      WORD.test(s.charAt(i - 1)) && WORD.test(s.charAt(i + 1)) ? '_' : '\\_'
    )
    .replace(/\r\n|\r|\n/g, breaks)
}

/**
 * `markdownText` for text that stands on a line of its own (a paragraph, an item of a list): what would begin a
 * heading, a quote, a list, a rule or (indented) a block of code at its start is written as text.
 */
export function markdownLine(text: string): string {
  return markdownText(text.trim())
    .replace(/^([#>+=-])/, '\\$1')
    .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')
}

/** A heading's text: as a line, and a `#` at its end not taken for the heading's closing marks. */
const heading = (text: string) => markdownLine(text).replace(/(\s)(#+)$/, '$1\\$2')
const cell = (text: string) => markdownText(text.trim(), '<br>')
const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`

function entry(schema: TableSchema): string[] {
  const refs = referencesOf(schema)
  const title = `## ${heading(schema.name)}${schema.kind === 'view' ? t.viewMark : ''}`
  const header = [locale.table.name, t.type, t.nullable, t.default, t.references, locale.database.comment]
  const columns = schema.columns.map((c) =>
    row([
      `${cell(c.name)}${schema.primaryKey.includes(c.name) ? t.primaryMark : ''}`,
      cell(c.dataType),
      c.nullable ? locale.common.yes : locale.common.no,
      cell(c.default ?? ''),
      cell(refs.get(c.name) ?? ''),
      cell(c.comment ?? ''),
    ])
  )
  const indexes = schema.indexes.map(
    (i) => `- ${markdownLine(`${i.name} (${i.columns.join(', ')})`)}${i.unique ? ` ${t.unique}` : ''}`
  )
  return [
    title,
    ...(schema.comment ? ['', markdownLine(schema.comment)] : []),
    '',
    row(header),
    row(header.map(() => '---')),
    ...columns,
    ...(indexes.length > 0 ? ['', `${t.indexes}:`, '', ...indexes] : []),
  ]
}

/**
 * The data dictionary as a Markdown file, to keep with the code or paste into a wiki: one section per table and
 * view, in the order given, with the same columns as the page. Tables whose definitions could not be read are named
 * at the top, so a file that lacks them says so.
 */
export function dictionaryMarkdown(title: string, schemas: readonly TableSchema[], failed: readonly string[]): string {
  const lines = [`# ${heading(t.title(title))}`]
  if (failed.length > 0) lines.push('', `> ${markdownLine(t.failed(failed))}`)
  for (const s of schemas) lines.push('', ...entry(s))
  return `${lines.join('\n')}\n`
}
