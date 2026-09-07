import { ApiErrorSchema } from '@tsmyadmin/shared'
import type { ZodType } from 'zod'
import { ApiError } from './api.ts'

/** A non-2xx reply of a streaming route: its JSON error body, or the bare status. */
export async function streamError(res: Response): Promise<ApiError> {
  const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => null))
  return new ApiError(res.status, parsed.success ? parsed.data : { code: 'INTERNAL', message: `HTTP ${res.status}` })
}

/**
 * The events of an NDJSON response, one per non-blank line (blank lines are the server's heartbeats), parsed
 * with `schema`. Only the unparsed tail of the current chunk is kept in memory. A bad line closes the body
 * (the connection would otherwise stay open until the server finishes) before the error propagates.
 */
export async function* ndjsonEvents<T>(body: ReadableStream, schema: ZodType<T>): AsyncGenerator<T> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += chunk.value
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) yield schema.parse(JSON.parse(line))
        nl = buffer.indexOf('\n')
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    throw err
  } finally {
    reader.releaseLock()
  }
}
