import { ApiErrorSchema, type ImportEvent, ImportEventSchema, type ImportResult } from '@tsmyadmin/shared'
import { ApiError, api, enc } from './api.ts'

export interface ImportRequest {
  file: File
  format: 'sql' | 'csv'
  schema?: string | undefined
  table?: string
  header?: '0' | '1'
  nullMarker?: string
  delimiter?: string
  stopOnError?: '0' | '1'
  ignoreForeignKeys?: '0' | '1'
  singleTransaction?: '0' | '1'
  /** Lets the caller stop the run through `mutations.cancelSql` and still read the result. */
  queryId?: string
}

/**
 * Uploads a file through POST /databases/:db/import and follows its NDJSON events: `progress` while the run
 * goes, then the `result`. A validation problem found mid-run and a server failure arrive as `fatal` events and
 * are thrown as ApiError, like a non-2xx reply; aborting `signal` cancels the statement on the server.
 */
export async function runImport(
  db: string,
  form: ImportRequest,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<ImportResult> {
  // Optional fields are dropped when undefined (a multipart form has no "absent" value otherwise).
  const { schema, table, header, nullMarker, delimiter, stopOnError, ignoreForeignKeys, singleTransaction, queryId } =
    form
  let res: Response
  try {
    res = await api.databases[':db'].import.$post(
      {
        param: { db: enc(db) },
        form: {
          file: form.file,
          format: form.format,
          ...(schema ? { schema } : {}),
          ...(table ? { table } : {}),
          ...(header ? { header } : {}),
          ...(nullMarker !== undefined ? { nullMarker } : {}),
          ...(delimiter !== undefined ? { delimiter } : {}),
          ...(stopOnError ? { stopOnError } : {}),
          ...(ignoreForeignKeys ? { ignoreForeignKeys } : {}),
          ...(singleTransaction ? { singleTransaction } : {}),
          ...(queryId ? { queryId } : {}),
        },
      },
      { init: signal ? { signal } : {} }
    )
  } catch (err) {
    throw new ApiError(0, { code: 'INTERNAL', message: err instanceof Error ? err.message : 'network error' })
  }
  if (!res.ok || !res.body) {
    const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => null))
    throw new ApiError(res.status, parsed.success ? parsed.data : { code: 'INTERNAL', message: `HTTP ${res.status}` })
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let last: ImportEvent | null = null
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += chunk.value
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          const event = ImportEventSchema.parse(JSON.parse(line))
          if (event.type === 'progress') onProgress(event.done, event.total)
          else last = event
        }
        nl = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (last?.type === 'result') return last.result
  if (last?.type === 'fatal') throw new ApiError(400, last.error)
  throw new ApiError(0, { code: 'INTERNAL', message: 'connection closed before the import finished' })
}
