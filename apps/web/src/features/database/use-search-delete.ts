import { usePreviewFlow } from '@/lib/preview-flow.ts'
import { mutations } from '@/lib/queries.ts'

/** The matched rows of one table, as the DELETE the search built: shown first, run on confirmation, then counted again. */
export function useSearchDelete(db: string, schema: string | undefined, onDeleted: (table: string) => Promise<void>) {
  return usePreviewFlow<{ table: string; sql: string }>({
    preview: async (op) => ({ sql: [op.sql] }),
    execute: async (_op, sql) => ({
      results: await mutations.executeSql(db, {
        sql: sql.join(';\n'),
        ...(schema ? { schema } : {}),
        stopOnError: true,
        timeoutMs: 300_000,
      }),
    }),
    onSuccess: ({ table }) => onDeleted(table),
  })
}
