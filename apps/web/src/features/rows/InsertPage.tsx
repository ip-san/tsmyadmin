import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { RowForm } from '@/components/rows/RowForm.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { mutations, structureQuery, type TableRef } from '@/lib/queries.ts'

export function InsertPage({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [inserted, setInserted] = useState(0)
  const insert = useMutation({
    mutationFn: (values: Parameters<typeof mutations.insertRow>[1]) => mutations.insertRow(tableRef, values),
    onSuccess: async (r) => {
      setInserted((n) => n + r.affectedRows)
      await queryClient.invalidateQueries({ queryKey: ['rows', tableRef.db] })
      await navigate({
        to: '/db/$db/table/$table',
        params: { db: tableRef.db, table: tableRef.table },
        search: tableRef.schema ? { schema: tableRef.schema } : {},
      })
    },
  })
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} />
  if (structure.data.kind === 'view') return <Notice>{locale.browse.readOnly}</Notice>
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.rows.insertTitle}</h2>
      {inserted > 0 ? <Notice>{locale.rows.inserted(inserted)}</Notice> : null}
      <RowForm
        key={inserted}
        columns={structure.data.columns}
        mode="insert"
        pending={insert.isPending}
        error={insert.error}
        onSubmit={(values) => insert.mutate(values)}
      />
    </div>
  )
}
