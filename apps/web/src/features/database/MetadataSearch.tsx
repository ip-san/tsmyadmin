import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useDeferredValue, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'
import { tablesQuery } from '@/lib/queries.ts'
import { useAllStructures } from '@/lib/use-all-structures.ts'
import { useDebounced } from '@/lib/use-debounced.ts'
import { foldTerm, type Hit, indexMetadata, type MetadataMatch, matchMetadata } from './metadata-search.ts'

const t = locale.metadataSearch
/** Rows drawn at most: a one-letter term in a large database matches thousands, and a longer term narrows them. */
const SHOWN_MAX = 200
/** How long the count waits for typing to pause before it is read out. */
const ANNOUNCE_MS = 500
/** Tables named when some could not be read; the rest are counted. */
const FAILED_NAMED = 5
/**
 * Every table and view described (a few at a time, kept as long as the other screens that read them all keep
 * them: `useAllStructures`), and indexed for matching once, not on each key typed; the names of those that could
 * not be read.
 */
function useSchemas(db: string, schema: string | undefined, on: boolean) {
  // The list of tables as fresh as the other screens have it (a table made elsewhere is found); the definitions
  // are what is kept longer.
  const tables = useQuery({ ...tablesQuery(db, schema), enabled: on })
  // A sequence has no columns to find.
  const names = useMemo(
    () => (tables.data ?? []).filter((x) => x.kind !== 'sequence').map((x) => x.name),
    [tables.data]
  )
  const all = useAllStructures(db, schema, names, { enabled: on && tables.data !== undefined })
  const listed = tables.data !== undefined
  const data = useMemo(() => {
    if (!listed) return undefined
    if (names.length === 0) return { index: indexMetadata([]), tables: 0, failed: [] as readonly string[] }
    if (!all.data) return undefined
    return {
      index: indexMetadata([...all.data.byName.values()]),
      tables: all.data.byName.size,
      failed: all.data.failed,
    }
  }, [listed, names, all.data])
  return {
    data,
    isPending: data === undefined && !tables.isError && !all.isError,
    isError: tables.isError || all.isError,
    error: tables.error ?? all.error,
    isFetching: tables.isFetching || all.isFetching,
    // One reading again: the list when it failed (the definitions follow from it), the definitions otherwise.
    refetch: () => (tables.isError ? tables.refetch() : all.refetch()),
  }
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
  const index = described.data?.index
  const folded = foldTerm(shown)
  const { matches, total } = useMemo(
    () => (index ? matchMetadata(index, folded, SHOWN_MAX) : { matches: [], total: 0 }),
    [index, folded]
  )
  const data = described.data
  // What the status line says, as sentences: the count, and what was not searched or is being read again.
  const summary =
    term.trim() !== '' && data && !described.isError
      ? t.sentences(
          [
            t.found(total, data.tables),
            total > matches.length ? t.shownFirst(matches.length) : '',
            data.failed.length > 0
              ? t.failed(data.failed.slice(0, FAILED_NAMED), data.failed.length - FAILED_NAMED)
              : '',
            described.isFetching ? t.refreshing : '',
          ].filter(Boolean)
        )
      : ''
  // Said once typing pauses, not on every key. The line is there from the start (empty), so it is heard, and it
  // stays, so it can be read again.
  const said = useDebounced(summary, ANNOUNCE_MS)
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
      <p role="status" className="text-xs text-ink-sub">
        {said}
      </p>
      {term.trim() === '' ? null : described.isPending ? (
        <Spinner label={t.reading} />
      ) : (
        <>
          {/* A reading again that failed: the error, with the results of the reading before kept under it. */}
          {described.isError ? <ErrorBox error={described.error} onRetry={() => void described.refetch()} /> : null}
          {data && data.failed.length > 0 && !described.isError ? (
            <Button size="sm" disabled={described.isFetching} onClick={() => void described.refetch()}>
              {t.readAgain}
            </Button>
          ) : null}
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
              {/* A table opens on what it is (its overview); a column on where it is defined (the structure). */}
              <Link
                to={m.column === null ? '/db/$db/table/$table/overview' : '/db/$db/table/$table/structure'}
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
