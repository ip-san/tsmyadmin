import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Badge, ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { eventsQuery } from '@/lib/queries.ts'

export function EventsPage({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const events = useQuery({ ...eventsQuery(db, schema), enabled: dialect === 'mysql' })
  const flow = useDdlFlow(db, schema)
  if (dialect !== 'mysql') return <Notice>{locale.events.unsupported}</Notice>
  if (events.isPending) return <Spinner />
  if (events.isError) return <ErrorBox error={events.error} onRetry={() => void events.refetch()} />
  return (
    <section className="space-y-2">
      <DdlPreviewDialog flow={flow} />
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.events.title}</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{locale.events.schedulerHint}</p>
      {events.data.length === 0 ? (
        <Notice>{locale.events.none}</Notice>
      ) : (
        <Table aria-label={locale.events.title}>
          <thead>
            <tr>
              <Th>{locale.events.name}</Th>
              <Th>{locale.events.status}</Th>
              <Th>{locale.events.schedule}</Th>
              <Th>{locale.events.starts}</Th>
              <Th>{locale.events.ends}</Th>
              <Th>{locale.events.lastExecuted}</Th>
              <Th>{locale.events.comment}</Th>
              <Th>{locale.events.definition}</Th>
              <Th>{locale.ddl.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {events.data.map((e) => {
              const enabled = e.status === 'ENABLED'
              return (
                <Tr key={e.name}>
                  <Td className="font-medium">{e.name}</Td>
                  <Td>
                    <Badge tone={enabled ? 'info' : 'neutral'}>{e.status}</Badge>
                  </Td>
                  <Td className="font-mono text-xs">{e.schedule}</Td>
                  <Td className="font-mono text-xs">{e.starts ?? ''}</Td>
                  <Td className="font-mono text-xs">{e.ends ?? ''}</Td>
                  <Td className="font-mono text-xs">{e.lastExecuted ?? ''}</Td>
                  <Td className="text-xs">{e.comment ?? ''}</Td>
                  <Td>
                    <DefinitionToggle definition={e.definition} label={e.name} />
                  </Td>
                  <Td className="space-x-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      onClick={() => flow.preview({ op: enabled ? 'disableEvent' : 'enableEvent', name: e.name })}
                      aria-label={`${e.name}: ${enabled ? locale.events.disable : locale.events.enable}`}
                    >
                      {enabled ? locale.events.disable : locale.events.enable}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => flow.preview({ op: 'dropEvent', name: e.name })}
                      aria-label={`${e.name}: ${locale.events.drop}`}
                    >
                      {locale.events.drop}
                    </Button>
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </section>
  )
}
