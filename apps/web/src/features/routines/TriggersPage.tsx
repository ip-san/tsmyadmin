import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { CreateSection } from '@/components/ddl/CreateSection.tsx'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { EditDetail } from '@/components/ddl/EditDetail.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { useEditDefinition } from '@/lib/open-in-console.ts'
import { tablesQuery, triggerDetailQuery, triggersQuery } from '@/lib/queries.ts'
import { CreateTriggerForm } from './CreateTriggerForm.tsx'

export function TriggersPage({
  db,
  schema,
  table,
  dialect,
}: {
  db: string
  schema?: string | undefined
  table?: string
  dialect: Dialect
}) {
  const edit = useEditDefinition(db, schema)
  const flow = useDdlFlow(db, schema)
  const queryClient = useQueryClient()
  // Only needed to choose a table; on a table's own tab the table is given.
  const tables = useQuery({ ...tablesQuery(db, schema), enabled: !table })
  const triggers = useQuery(triggersQuery(db, schema, table))
  if (triggers.isPending) return <Spinner />
  if (triggers.isError) return <ErrorBox error={triggers.error} onRetry={() => void triggers.refetch()} />
  return (
    <section className="space-y-2">
      <DdlPreviewDialog flow={flow} />
      <h2 className="text-sm font-semibold text-ink">{locale.triggers.title}</h2>
      {triggers.data.length === 0 ? (
        <Notice>{locale.triggers.none}</Notice>
      ) : (
        <Table aria-label={locale.triggers.title}>
          <thead>
            <tr>
              <Th>{locale.triggers.name}</Th>
              {table ? null : <Th>{locale.triggers.table}</Th>}
              <Th>{locale.triggers.timing}</Th>
              <Th>{locale.triggers.events}</Th>
              <Th>{locale.triggers.orientation}</Th>
              <Th>{locale.triggers.definition}</Th>
              <Th>{locale.ddl.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {triggers.data.map((t) => (
              <Tr key={`${t.table}:${t.name}`}>
                <Td className="font-medium">{t.name}</Td>
                {table ? null : <Td>{t.table}</Td>}
                <Td className="text-xs">{t.timing}</Td>
                <Td className="text-xs">{t.events}</Td>
                <Td className="text-xs">{t.orientation}</Td>
                <Td>
                  <DefinitionToggle
                    definition={t.definition}
                    label={t.name}
                    file={{ dialect, name: t.name }}
                    onEdit={(definition) => edit({ kind: 'trigger', name: t.name, definition, table: t.table })}
                  />
                </Td>
                <Td className="space-x-1 whitespace-nowrap">
                  <EditDetail
                    label={`${t.name}: ${locale.create.edit.button}`}
                    title={locale.create.edit.title(t.name)}
                    load={() => queryClient.fetchQuery(triggerDetailQuery(db, t.table, t.name, schema))}
                  >
                    {(detail, close) => (
                      <div className="space-y-3">
                        {dialect === 'mysql' ? <p className="text-xs text-ink-sub">{locale.create.edit.hint}</p> : null}
                        <CreateTriggerForm
                          dialect={dialect}
                          table={t.table}
                          tables={[t.table]}
                          initial={detail}
                          replaces={{ name: t.name, table: t.table }}
                          onCancel={close}
                          onSubmit={(op) => {
                            close()
                            flow.preview(op)
                          }}
                        />
                      </div>
                    )}
                  </EditDetail>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-haspopup="dialog"
                    aria-label={`${t.name}: ${locale.triggers.drop}`}
                    onClick={() => flow.preview({ op: 'dropTrigger', name: t.name, table: t.table })}
                  >
                    {locale.triggers.drop}
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateSection title={locale.create.trigger.title}>
        <CreateTriggerForm
          dialect={dialect}
          table={table}
          tables={(tables.data ?? []).filter((x) => x.kind === 'table').map((x) => x.name)}
          onSubmit={flow.preview}
        />
      </CreateSection>
    </section>
  )
}
