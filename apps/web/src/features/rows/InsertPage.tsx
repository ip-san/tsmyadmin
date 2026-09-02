import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { isViewKind } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { RowForm } from '@/components/rows/RowForm.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, rowsKey, structureQuery, type TableRef } from '@/lib/queries.ts'

export function InsertPage({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  const queryClient = useQueryClient()
  const [inserted, setInserted] = useState(0)
  const formRef = useRef<HTMLDivElement>(null)
  const insert = useMutation({
    mutationFn: ({ values }: { values: Parameters<typeof mutations.insertRow>[1] }) =>
      mutations.insertRow(tableRef, values),
    onSuccess: async (r) => {
      // The page stays: the notice confirms the insert and links to the browse view; the form is remounted
      // blank (via `key`) so entering several rows needs no navigation.
      setInserted((n) => n + r.affectedRows)
      await queryClient.invalidateQueries({ queryKey: rowsKey(tableRef) })
    },
  })
  // After a remount the focused submit button is gone; keyboard users continue from the first field.
  useEffect(() => {
    if (inserted > 0)
      formRef.current
        ?.querySelector<HTMLElement>('input:not([type="checkbox"]):not([disabled]), textarea:not([disabled])')
        ?.focus()
  }, [inserted])
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  if (isViewKind(structure.data.kind)) return <Notice>{locale.browse.readOnly}</Notice>
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.rows.insertTitle}</h2>
      <output aria-live="polite" className={inserted > 0 ? 'block' : 'sr-only'}>
        {inserted > 0 ? (
          <Notice>
            {locale.rows.inserted(inserted)}{' '}
            <Link
              to="/db/$db/table/$table"
              params={{ db: tableRef.db, table: tableRef.table }}
              search={tableRef.schema ? { schema: tableRef.schema } : {}}
              className="underline"
            >
              {locale.rows.backToBrowse}
            </Link>
          </Notice>
        ) : null}
      </output>
      <div ref={formRef}>
        <RowForm
          key={inserted}
          columns={structure.data.columns}
          mode="insert"
          pending={insert.isPending}
          error={insert.error}
          onSubmit={(values) => insert.mutate({ values })}
        />
      </div>
    </div>
  )
}
