import { useQuery } from '@tanstack/react-query'
import { type DdlOp, sqlScript } from '@tsmyadmin/shared'
import { type PreviewFlow, usePreviewFlow } from './preview-flow.ts'
import { mutations, sessionQuery } from './queries.ts'

export type DdlFlow = PreviewFlow<DdlOp>

/** Statement timeout for DDL runs: index builds and column rewrites on large tables take minutes, not seconds. */
const DDL_TIMEOUT_MS = 300_000

/** DDL preview via /ddl/preview, execution through /sql (stopOnError) after user confirmation. */
export function useDdlFlow(
  db: string,
  schema: string | undefined,
  onSuccess?: (op: DdlOp) => void | Promise<void>
): DdlFlow {
  const dialect = useQuery(sessionQuery).data?.dialect ?? 'mysql'
  return usePreviewFlow<DdlOp>({
    preview: (op) => mutations.previewDdl(db, schema, op),
    // DDL runs through the SQL route, which is not transactional: a failure leaves what already ran in place.
    execute: async (_op, sql) => ({
      results: await mutations.executeSql(db, {
        // One script the SQL route splits back into these statements, bodies with `;` of their own included.
        sql: sqlScript(dialect, sql),
        ...(schema ? { schema } : {}),
        stopOnError: true,
        timeoutMs: DDL_TIMEOUT_MS,
      }),
    }),
    ...(onSuccess ? { onSuccess } : {}),
  })
}
