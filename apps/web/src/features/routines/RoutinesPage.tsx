import { useQuery } from '@tanstack/react-query'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { routineDefinitionQuery, routinesQuery } from '@/lib/queries.ts'

export function RoutinesPage({ db, schema }: { db: string; schema?: string | undefined }) {
  const routines = useQuery(routinesQuery(db, schema))
  if (routines.isPending) return <Spinner />
  if (routines.isError) return <ErrorBox error={routines.error} onRetry={() => void routines.refetch()} />
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.routines.title}</h2>
      {routines.data.length === 0 ? (
        <Notice>{locale.routines.none}</Notice>
      ) : (
        <Table aria-label={locale.routines.title}>
          <thead>
            <tr>
              <Th>{locale.routines.name}</Th>
              <Th>{locale.routines.kind}</Th>
              <Th>{locale.routines.parameters}</Th>
              <Th>{locale.routines.returns}</Th>
              <Th>{locale.routines.language}</Th>
              <Th>{locale.routines.comment}</Th>
              <Th>{locale.routines.definition}</Th>
            </tr>
          </thead>
          <tbody>
            {routines.data.map((r) => (
              <Tr key={`${r.kind}:${r.name}:${r.parameters}`}>
                <Td className="font-medium">{r.name}</Td>
                <Td>{locale.routines.kinds[r.kind]}</Td>
                <Td className="font-mono text-xs">{r.parameters}</Td>
                <Td className="font-mono text-xs">{r.returns ?? ''}</Td>
                <Td className="text-xs">{r.language ?? ''}</Td>
                <Td className="text-xs">{r.comment ?? ''}</Td>
                <Td>
                  <DefinitionToggle query={routineDefinitionQuery(db, r.name, r.kind, schema)} label={r.name} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
