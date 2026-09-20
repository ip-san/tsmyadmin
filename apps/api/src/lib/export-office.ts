import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, Namespace } from '@tsmyadmin/shared'
import { cellText, DATA_ONLY, type DocOptions, tableSections } from './export-documents.ts'
import { type ZipEntry, zipStream } from './zip.ts'

/**
 * Spreadsheet and document files: OpenDocument (ODS, ODT) and Word (DOCX) are ZIP files of XML, written as the rows
 * arrive. They are for reading and sharing, not restoring: a NULL is an empty cell, and a character XML cannot carry
 * (most control characters) becomes U+FFFD.
 */

export type OfficeKind = 'ods' | 'odt' | 'docx'

export const OFFICE_TYPES: Record<OfficeKind, string> = {
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const xml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
/** Whether XML 1.0 cannot carry this character at all (most control characters). */
const unrepresentable = (code: number) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff
/** Text as XML 1.0 can hold it: the control characters it cannot are replaced. */
const clean = (s: string) => xml(Array.from(s, (ch) => (unrepresentable(ch.charCodeAt(0)) ? '\ufffd' : ch)).join(''))

/** A sheet name: at most 31 characters, none of `[]:*?/\`, and not the same as an earlier one. */
export function sheetNames(tables: readonly string[]): string[] {
  const used = new Set<string>()
  return tables.map((table) => {
    const base = (table.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet').replace(/^'|'$/g, '_')
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)}_${n}`
    used.add(name.toLowerCase())
    return name
  })
}

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'

/** A cell's paragraphs, one per line (`text:p` cannot hold a line feed). */
const odfParagraphs = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map((l) => `<text:p>${clean(l)}</text:p>`)
    .join('')

function odfCell(cell: Cell, nullText = ''): string {
  const text = cellText(cell)
  if (text === null) {
    return nullText === ''
      ? '<table:table-cell/>'
      : `<table:table-cell office:value-type="string">${odfParagraphs(nullText)}</table:table-cell>`
  }
  if (typeof cell === 'number' && Number.isFinite(cell))
    return `<table:table-cell office:value-type="float" office:value="${cell}"><text:p>${cell}</text:p></table:table-cell>`
  return `<table:table-cell office:value-type="string">${odfParagraphs(text)}</table:table-cell>`
}

async function* odfContent(
  kind: 'ods' | 'odt',
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions,
  nullText: string
): AsyncIterable<string> {
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_NS} office:version="1.2">\n<office:body>\n<office:${kind === 'ods' ? 'spreadsheet' : 'text'}>\n`
  const sections = tables.flatMap((table) => tableSections(adapter, ns, table, o))
  const names = sheetNames(sections.map((sec) => sec.title))
  for (const [t, sec] of sections.entries()) {
    if (kind === 'odt') yield `<text:h text:outline-level="2">${clean(sec.title)}</text:h>\n`
    let opened = false
    for await (const { columns, rows } of sec.batches()) {
      if (!opened) {
        yield `<table:table table:name="${clean(kind === 'ods' ? (names[t] ?? sec.title) : `Table${t + 1}`)}">\n<table:table-column table:number-columns-repeated="${Math.max(columns.length, 1)}"/>\n`
        yield `<table:table-row>${columns.map((c) => `<table:table-cell office:value-type="string"><text:p>${clean(c)}</text:p></table:table-cell>`).join('')}</table:table-row>\n`
        opened = true
      }
      yield rows
        .map((row) => `<table:table-row>${row.map((c) => odfCell(c, nullText)).join('')}</table:table-row>\n`)
        .join('')
    }
    yield '</table:table>\n'
  }
  yield `</office:${kind === 'ods' ? 'spreadsheet' : 'text'}>\n</office:body>\n</office:document-content>\n`
}

const odfManifest = (mime: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>\n<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>\n</manifest:manifest>\n`

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** A cell's paragraphs, one per line, in Word's runs. */
const docxParagraphs = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${clean(l)}</w:t></w:r></w:p>`)
    .join('')

async function* docxContent(
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions
): AsyncIterable<string> {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}>\n<w:body>\n`
  const borders =
    '<w:tblPr><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>'
  for (const sec of tables.flatMap((table) => tableSections(adapter, ns, table, o))) {
    yield `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${clean(sec.title)}</w:t></w:r></w:p>\n`
    let opened = false
    for await (const { columns, rows } of sec.batches()) {
      if (!opened) {
        yield `<w:tbl>${borders}\n<w:tr>${columns.map((c) => `<w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${clean(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>\n`
        opened = true
      }
      yield rows
        .map((row) => `<w:tr>${row.map((c) => `<w:tc>${docxParagraphs(cellText(c) ?? '')}</w:tc>`).join('')}</w:tr>\n`)
        .join('')
    }
    // A table must be followed by a paragraph.
    yield '</w:tbl>\n<w:p/>\n'
  }
  yield '</w:body>\n</w:document>\n'
}

const DOCX_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>
`
const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>
`

/** The tables as an ODS / ODT / DOCX file (a ZIP of XML), streamed. */
export function officeBody(
  kind: OfficeKind,
  adapter: DatabaseAdapter,
  ns: Namespace,
  tables: string[],
  o: DocOptions = DATA_ONLY,
  /** ODS: what a NULL is written as (empty: an empty cell). */
  nullText = ''
): AsyncIterable<Uint8Array> {
  const entries: ZipEntry[] =
    kind === 'docx'
      ? [
          { name: '[Content_Types].xml', data: DOCX_TYPES },
          { name: '_rels/.rels', data: DOCX_RELS },
          { name: 'word/document.xml', data: docxContent(adapter, ns, tables, o) },
        ]
      : [
          // The media type comes first and is not compressed, so a program can tell the file's kind from its head.
          { name: 'mimetype', data: OFFICE_TYPES[kind], store: true },
          { name: 'META-INF/manifest.xml', data: odfManifest(OFFICE_TYPES[kind]) },
          { name: 'content.xml', data: odfContent(kind, adapter, ns, tables, o, nullText) },
        ]
  return zipStream(entries)
}
