import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TableSchema } from '@tsmyadmin/shared'
import { type ReactNode, useDeferredValue, useId, useState } from 'react'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'
import { eachLimited } from '@/lib/each-limited.ts'
import { structureQuery, tablesQuery } from '@/lib/queries.ts'
import { type Hit, type MetadataMatch, matchMetadata } from './metadata-search.ts'

const t = locale.metadataSearch

/** Every table and view described, a few at a time; the names of those that could not be read. */
function useSchemas(db: string, schema: string | undefined, on: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['metadata-search', db, schema ?? ''],
    queryFn: async ({ signal }) => {
      const tables = await queryClient.fetchQuery(tablesQuery(db, schema))
      // A sequence has no columns to find.
      const names = tables.filter((x) => x.kind !== 'sequence').map((x) => x.name)
      const done = await eachLimited(names, (table) => queryClient.fetchQuery(structureQuery({ db, schema, table })), {
        signal,
      })
      return {
        schemas: done.flatMap(({ settled }) => (settled.ok ? [settled.value] : [])) as TableSchema[],
        failed: done.flatMap(({ item, settled }) => (settled.ok ? [] : [item])),
      }
    },
    enabled: on,
  })
}

/**
 * Finds tables and columns by name, type and comment across the database ("where is user_id?", "which columns are
 * json?"): the catalog, not the rows (the search below reads the rows). The tables are described once, when the
 * first term is typed, and the term is matched as it is typed.
 */
export function MetadataSearch({ db, schema }: { db: string; schema?: string | undefined }) {
  const [term, setTerm] = useState('')
  const shown = useDeferredValue(term)
  const titleId = useId()
  const described = useSchemas(db, schema, term.trim() !== '')
  const matches = described.data ? matchMetadata(described.data.schemas, shown) : []
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded border border-line p-3">
      <h2 id={titleId} className="text-sm font-semibold text-ink">
        {t.title}
      </h2>
      <Field id="metadata-search-term" label={t.term} hint={t.termHint}>
        <Input
          id="metadata-search-term"
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="w-72"
        />
      </Field>
      {term.trim() === '' ? null : described.isPending ? (
        <Spinner label={t.reading} />
      ) : described.isError ? (
        <ErrorBox error={described.error} onRetry={() => void described.refetch()} />
      ) : (
        <>
          <p role="status" className="text-xs text-ink-sub">
            {t.found(matches.length, described.data.schemas.length)}
          </p>
          {described.data.failed.length > 0 ? <Notice>{t.failed(described.data.failed)}</Notice> : null}
          {matches.length > 0 ? <Results db={db} schema={schema} matches={matches} /> : null}
        </>
      )}
    </section>
  )
}

function Results({ db, schema, matches }: { db: string; schema: string | undefined; matches: MetadataMatch[] }) {
  return (
    <Table aria-label={t.results}>
      <thead>
        <tr>
          <Th>{t.table}</Th>
          <Th>{t.column}</Th>
          <Th>{t.type}</Th>
          <Th>{t.comment}</Th>
        </tr>
      </thead>
      <tbody>
        {matches.map((m) => (
          <Tr key={JSON.stringify([m.table, m.column])}>
            <Td>
              <Link
                to="/db/$db/table/$table/structure"
                params={{ db, table: m.table }}
                search={{ schema }}
                className="text-brand underline"
              >
                {m.column === null ? <Marked hit={m.name} /> : m.table}
              </Link>
            </Td>
            <Td className="font-medium">{m.column === null ? '—' : <Marked hit={m.name} />}</Td>
            <Td className="font-mono text-xs">{m.type ? <Marked hit={m.type} /> : null}</Td>
            <Td className="text-ink-sub">{m.comment ? <Marked hit={m.comment} /> : null}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

/** The text with the places the term was found marked. */
function Marked({ hit }: { hit: Hit }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of hit.spans) {
    if (start > at) parts.push(hit.text.slice(at, start))
    parts.push(
      <mark key={start} className="rounded-sm bg-amber-100 text-ink dark:bg-amber-900 dark:text-amber-50">
        {hit.text.slice(start, end)}
      </mark>
    )
    at = end
  }
  if (at < hit.text.length) parts.push(hit.text.slice(at))
  return <>{parts}</>
}
