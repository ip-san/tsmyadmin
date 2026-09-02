import type { DdlOp } from '@tsmyadmin/shared'
import { type PreviewFlow, usePreviewFlow } from './preview-flow.ts'
import { mutations } from './queries.ts'

export type DdlFlow = PreviewFlow<DdlOp>

/** Statement timeout for DDL runs: index builds and column rewrites on large tables take minutes, not seconds. */
const DDL_TIMEOUT_MS = 300_000

/** DDL preview via /ddl/preview, execution through /sql (stopOnError) after user confirmation. */
export function useDdlFlow(
  db: string,
  schema: string | undefined,
  onSuccess?: (op: DdlOp) => void | Promise<void>
): DdlFlow {
  return usePreviewFlow<DdlOp>({
    preview: (op) => mutations.previewDdl(db, schema, op),
    execute: (_op, sql) =>
      mutations.executeSql(db, {
        sql: sql.join(';\n'),
        ...(schema ? { schema } : {}),
        stopOnError: true,
        timeoutMs: DDL_TIMEOUT_MS,
      }),
    ...(onSuccess ? { onSuccess } : {}),
  })
}
