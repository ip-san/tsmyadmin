import { useQuery } from '@tanstack/react-query'
import { type Dialect, sqlScript } from '@tsmyadmin/shared'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import type { createStatementQuery, routineDefinitionQuery } from '@/lib/queries.ts'

type DefinitionQuery = ReturnType<typeof routineDefinitionQuery> | ReturnType<typeof createStatementQuery>
type Source = { definition: string | null } | { query: DefinitionQuery }

/** Where the definition is saved as an .sql file, and the dialect that decides how its statements are delimited. */
export interface DefinitionFile {
  dialect: Dialect
  name: string
}

function Definition({
  definition,
  onEdit,
  file,
}: {
  definition: string | null
  onEdit?: (d: string) => void
  file?: DefinitionFile
}) {
  if (definition === null) return <span className="text-xs text-ink-sub">{locale.routines.noDefinition}</span>
  return (
    <>
      {onEdit || file ? (
        <div className="mt-2 space-x-1">
          {onEdit ? (
            <Button size="sm" onClick={() => onEdit(definition)} title={locale.routines.editHint}>
              {locale.routines.edit}
            </Button>
          ) : null}
          {file ? (
            <Button
              size="sm"
              onClick={() =>
                downloadText(
                  safeFilename(file.name, 'sql'),
                  `${sqlScript(file.dialect, [definition.replace(/;\s*$/, '')])};\n`,
                  'application/sql;charset=utf-8'
                )
              }
            >
              {locale.routines.download}
            </Button>
          ) : null}
        </div>
      ) : null}
      <pre
        tabIndex={0}
        // Wrapped: inside a table cell a non-wrapping <pre> widens the column to its longest line.
        className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-sub p-2 font-mono text-xs"
      >
        {definition}
      </pre>
    </>
  )
}

function LazyDefinition({
  query,
  onEdit,
  file,
}: {
  query: DefinitionQuery
  onEdit?: (d: string) => void
  file?: DefinitionFile
}) {
  const q = useQuery(query)
  if (q.isPending) return <Spinner />
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
  return <Definition definition={q.data.definition} {...(onEdit ? { onEdit } : {})} {...(file ? { file } : {})} />
}

/**
 * Collapsible SQL definition. Pass `definition` when the list already carries it (triggers, events) or `query`
 * to fetch it on first expand (routines: one SHOW CREATE per routine on MySQL). null = the account may not read it.
 */
export function DefinitionToggle({
  label,
  onEdit,
  file,
  ...source
}: { label: string; onEdit?: (definition: string) => void; file?: DefinitionFile } & Source) {
  const [open, setOpen] = useState(false)
  if ('definition' in source && source.definition === null) return <Definition definition={null} />
  return (
    <div>
      <Button
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}: ${open ? locale.routines.hide : locale.routines.show}`}
      >
        {open ? locale.routines.hide : locale.routines.show}
      </Button>
      {open ? (
        'definition' in source ? (
          <Definition definition={source.definition} {...(onEdit ? { onEdit } : {})} {...(file ? { file } : {})} />
        ) : (
          <LazyDefinition query={source.query} {...(onEdit ? { onEdit } : {})} {...(file ? { file } : {})} />
        )
      ) : null}
    </div>
  )
}
