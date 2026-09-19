import { gunzipSync } from 'node:zlib'
import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { ApiError, ExportCharset, ImportEvent, ImportForm, ImportResult, Namespace } from '@tsmyadmin/shared'
import type { Context } from 'hono'
import iconv from 'iconv-lite'
import { apiError, toApiError } from './errors.ts'
import { csvSource, decodeUpload, ImportValidationError, importRows, importSql, type RowsSource } from './import.ts'
import { pickSheet, RowsParseError, readOds, readWikiTables, readXmlTables } from './import-rows.ts'
import { MAX_UNPACKED, readZip, UnpackLimitError } from './zip.ts'

/**
 * From the bytes a browser sent to a run: compressed files opened, text decoded in the character set chosen,
 * a spreadsheet / XML / wiki file turned into rows, and the run streamed back as NDJSON.
 */

const HEARTBEAT_MS = 15_000
/** NDJSON responses: progress lines must reach the browser as they are written, not when a proxy buffer fills. */
const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

export const validationError = (err: ImportValidationError): ApiError => ({
  ...apiError('VALIDATION', err.message),
  reason: err.reason,
  params: err.params,
})

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b
/** A ZIP starts with a file header (`PK\\x03\\x04`), or, when it holds no file, with its end record (`PK\\x05\\x06`). */
const isZip = (b: Uint8Array) =>
  b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06))

/**
 * The bytes of the file itself: a gzip file inflated, and a ZIP opened (its only file, or several SQL files run
 * one after the other). A spreadsheet is a ZIP already and is left as it is.
 */
export function unpack(bytes: Uint8Array, format: ImportForm['format']): Uint8Array {
  const mb = Math.floor(MAX_UNPACKED / 1024 / 1024)
  let out = bytes
  if (isGzip(out)) {
    try {
      out = new Uint8Array(gunzipSync(out, { maxOutputLength: MAX_UNPACKED }))
    } catch (err) {
      const tooBig = err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
      throw tooBig
        ? new ImportValidationError('ARCHIVE_TOO_LARGE', `The file unpacks to more than ${mb} MB`, { mb })
        : new ImportValidationError('ARCHIVE_INVALID', 'The gzip file could not be opened', {
            message: err instanceof Error ? err.message : String(err),
          })
    }
  }
  if (format === 'ods' || !isZip(out)) return out
  let files: ReturnType<typeof readZip>
  try {
    files = readZip(out).filter((f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('.DS_Store'))
  } catch (err) {
    throw new ImportValidationError('ARCHIVE_INVALID', 'The zip file could not be opened', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
  // One budget for the whole zip: the entries together may not unpack to more than the limit either.
  let budget = MAX_UNPACKED
  const open = (f: (typeof files)[number]) => {
    try {
      if (budget <= 0) throw new UnpackLimitError('The zip unpacks past the limit')
      const out = f.bytes(budget)
      budget -= out.length + 1
      return out
    } catch (err) {
      throw err instanceof UnpackLimitError
        ? new ImportValidationError('ARCHIVE_TOO_LARGE', `The file unpacks to more than ${mb} MB`, { mb })
        : new ImportValidationError('ARCHIVE_INVALID', 'A file in the zip is damaged', {
            message: err instanceof Error ? err.message : String(err),
          })
    }
  }
  if (files.length === 1 && files[0]) return open(files[0])
  if (files.length > 1 && format === 'sql' && files.every((f) => f.name.toLowerCase().endsWith('.sql'))) {
    // Run in the order of their names: a dump split into parts numbers them.
    const parts = [...files].sort((a, b) => a.name.localeCompare(b.name)).map(open)
    return new Uint8Array(Buffer.concat(parts.flatMap((p) => [Buffer.from(p), Buffer.from('\n')])))
  }
  throw new ImportValidationError(
    'ARCHIVE_MULTIPLE',
    files.length === 0
      ? 'The zip file is empty'
      : 'The zip file holds several files: only SQL files can be run together'
  )
}

/** Text in the chosen character set. Anything the set cannot make sense of is refused, not replaced. */
export function decodeText(bytes: Uint8Array, charset: ExportCharset): string {
  if (charset === 'utf-8') return decodeUpload(bytes)
  const text = iconv.decode(Buffer.from(bytes), charset)
  const at = text.indexOf('�')
  if (at >= 0)
    throw new ImportValidationError(
      'INVALID_ENCODING',
      `The file is not valid ${charset} (near line ${text.slice(0, at).split('\n').length})`,
      {
        line: text.slice(0, at).split('\n').length,
      }
    )
  return text.startsWith('﻿') ? text.slice(1) : text
}

/** The rows of a spreadsheet, XML or wiki file. */
function rowsSource(format: 'ods' | 'xml' | 'mediawiki', bytes: Uint8Array, form: ImportForm): RowsSource {
  try {
    if (format === 'ods') {
      const sheet = pickSheet(readOds(bytes), form.sheet)
      return { header: null, format, records: () => sheet.rows }
    }
    const text = decodeText(bytes, form.charset)
    if (format === 'xml') {
      const t = pickSheet(readXmlTables(text), form.sheet)
      return { header: t.header, format, records: () => t.rows }
    }
    const t = pickSheet(readWikiTables(text), form.sheet)
    return { header: t.header, format, records: () => t.rows }
  } catch (err) {
    if (err instanceof UnpackLimitError) {
      const mb = Math.floor(MAX_UNPACKED / 1024 / 1024)
      throw new ImportValidationError('ARCHIVE_TOO_LARGE', `The file unpacks to more than ${mb} MB`, { mb })
    }
    if (err instanceof RowsParseError) {
      throw new ImportValidationError(err.kind === 'NO_SHEET' ? 'ROWS_NO_SHEET' : 'ROWS_PARSE', err.message, err.params)
    }
    throw err
  }
}

export interface PreparedImport {
  run: (
    adapter: DatabaseAdapter,
    ns: Namespace,
    queryId: string,
    onProgress: (done: number, total: number) => void
  ) => Promise<ImportResult>
}

/** The upload made ready to run (decompressed and decoded), or the user-fixable reason it cannot be. */
export function prepareImport(bytes: Uint8Array, form: ImportForm): PreparedImport {
  const data = unpack(bytes, form.format)
  if (form.format === 'sql') {
    const text = decodeText(data, form.charset)
    return {
      run: (adapter, ns, queryId, onProgress) =>
        importSql(adapter, ns, text, {
          stopOnError: form.stopOnError === '1',
          ignoreForeignKeys: form.ignoreForeignKeys === '1',
          singleTransaction: form.singleTransaction === '1',
          noAutoValueOnZero: form.noAutoValueOnZero === '1',
          skip: form.skip,
          queryId,
          onProgress,
        }),
    }
  }
  const source =
    form.format === 'csv' ? csvSource(decodeText(data, form.charset), form) : rowsSource(form.format, data, form)
  return { run: (adapter, ns) => importRows(adapter, ns, form, source) }
}

/** Runs the import and answers as NDJSON: progress while it goes, then the result or the reason it failed. */
export function importResponse(
  c: Context,
  adapter: DatabaseAdapter,
  namespace: Namespace,
  form: ImportForm,
  prepared: PreparedImport
): Response {
  // A client that goes away cancels the statement instead of leaving it to run on an abandoned connection.
  const queryId = form.queryId ?? crypto.randomUUID()
  const encoder = new TextEncoder()
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ImportEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode('\n'))
      }, HEARTBEAT_MS)
      try {
        const result = await prepared.run(adapter, namespace, queryId, (done, total) =>
          send({ type: 'progress', done, total })
        )
        send({ type: 'result', result })
      } catch (err) {
        send({
          type: 'fatal',
          error: err instanceof ImportValidationError ? validationError(err) : toApiError(err).body,
        })
      } finally {
        clearInterval(heartbeat)
        if (!closed) {
          closed = true
          controller.close()
        }
      }
    },
    async cancel() {
      closed = true
      await adapter.cancelQuery(queryId)
    },
  })
  return c.body(stream, 200, NDJSON_HEADERS)
}
