import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { CreateSection } from '@/components/ddl/CreateSection.tsx'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DefinitionToggle } from '@/components/ddl/DefinitionToggle.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { useEditDefinition } from '@/lib/open-in-console.ts'
import { routineDefinitionQuery, routinesQuery } from '@/lib/queries.ts'
import { CreateRoutineForm } from './CreateRoutineForm.tsx'
import { RoutineActions } from './RoutineActions.tsx'

export function RoutinesPage({ db, schema, dialect }: { db: string; schema?: string | undefined; dialect: Dialect }) {
  const edit = useEditDefinition(db, schema)
  const flow = useDdlFlow(db, schema)
  const routines = useQuery(routinesQuery(db, schema))
  if (routines.isPending) return <Spinner />
  if (routines.isError) return <ErrorBox error={routines.error} onRetry={() => void routines.refetch()} />
  return (
    <section className="space-y-2">
      <DdlPreviewDialog flow={flow} />
      <h2 className="text-sm font-semibold text-ink">{locale.routines.title}</h2>
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
              <Th>{locale.ddl.actions}</Th>
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
                  <DefinitionToggle
                    query={routineDefinitionQuery(db, r.name, r.kind, schema)}
                    label={r.name}
                    file={{ dialect, name: r.name }}
                    {...(r.kind === 'procedure' || r.kind === 'function'
                      ? {
                          // MariaDB packages are listed and dumped but never created here, so they get no editor.
                          onEdit: (definition: string) =>
                            edit({
                              kind: r.kind as 'procedure' | 'function',
                              name: r.name,
                              definition,
                              sqlMode: r.sqlMode,
                            }),
                        }
                      : {})}
                  />
                </Td>
                <Td>
                  <RoutineActions routine={r} dialect={dialect} db={db} schema={schema} onPreview={flow.preview} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateSection title={locale.create.routine.title}>
        <CreateRoutineForm dialect={dialect} onSubmit={flow.preview} />
      </CreateSection>
    </section>
  )
}
