import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useMemo, useRef } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { homeNamespace } from '@/lib/home-namespace.ts'
import { tablesQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { useAllStructures } from '@/lib/use-all-structures.ts'
import { databaseMap, type DatabaseMap as MapData, ROLE_ORDER } from './database-map.ts'

const t = locale.databaseMap
/** Tables named when some could not be read; the rest are counted. */
const FAILED_NAMED = 5

/**
 * What a database is made of, from its definitions (`databaseMap`): the tables by the role their keys suggest, the
 * ones most referred to, and what to look at (no primary key, a foreign key without an index). Every table's
 * definition is read (a few at a time, shared with the other screens that read them all); no rows are.
 */
export function DatabaseMap({ db, schema }: { db: string; schema: string | undefined }) {
  const tables = useQuery(tablesQuery(db, schema))
  const dialect = useDialect()
  // A sequence has no columns or keys.
  const names = useMemo(
    () => (tables.data ?? []).filter((x) => x.kind !== 'sequence').map((x) => x.name),
    [tables.data]
  )
  const all = useAllStructures(db, schema, names, { enabled: tables.data !== undefined })
  const map = useMemo(() => {
    if (!all.data) return undefined
    const ns = schema ? { database: db, schema } : { database: db }
    return databaseMap([...all.data.byName.values()], homeNamespace(dialect, ns))
  }, [all.data, dialect, db, schema])
  const failed = all.data?.failed ?? []
  const empty = tables.data !== undefined && names.length === 0
  const error = tables.isError ? tables : all.isError ? all : null
  // One line, there from the start (empty), says what is being read and then what was: heard, and left to be read
  // again.
  const status = empty
    ? t.empty
    : map
      ? t.sentences(
          [
            t.summary(map.tables, map.views),
            failed.length > 0 ? t.failed(failed.slice(0, FAILED_NAMED), failed.length - FAILED_NAMED) : '',
          ].filter(Boolean)
        )
      : error
        ? ''
        : t.reading
  // Reading again is pressed once: the fetching flag is a render late, so a second press in the same frame would pass.
  const reading = useRef(false)
  const readAgain = () => {
    if (reading.current || all.isFetching) return
    reading.current = true
    void all.refetch().finally(() => {
      reading.current = false
    })
  }
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title(schema ?? db)}</h2>
        <p className="text-sm text-ink-sub">{t.hint}</p>
      </div>
      <p role="status" className="text-sm text-ink empty:mb-0">
        {status}
      </p>
      {error ? <ErrorBox error={error.error} onRetry={() => void error.refetch()} /> : null}
      {failed.length > 0 && !error ? (
        // Left focusable while reading: a keyboard user who pressed it keeps their place.
        <Button size="sm" aria-disabled={all.isFetching} onClick={readAgain}>
          {t.readAgain}
        </Button>
      ) : null}
      {map && map.tables > 0 ? <MapCards db={db} schema={schema} map={map} partial={failed.length > 0} /> : null}
    </div>
  )
}

function MapCards({
  db,
  schema,
  map,
  partial,
}: {
  db: string
  schema: string | undefined
  map: MapData
  /** Some tables could not be read: what is not in the lists may be in them, so "none" is not said. */
  partial: boolean
}) {
  const none = (text: string): ReactNode => (partial ? null : <p className="text-sm text-ink-sub">{text}</p>)
  const link = (table: string): ReactNode => (
    <Link
      to="/db/$db/table/$table/overview"
      params={{ db, table }}
      search={{ schema }}
      className="text-brand underline"
    >
      {table}
    </Link>
  )
  return (
    <>
      <Card title={t.rolesTitle}>
        <ul className="space-y-2 text-sm text-ink">
          {ROLE_ORDER.filter((r) => map.roles[r].length > 0).map((r) => (
            <li key={r}>
              <p className="font-medium">{t.roleCount(t.roles[r], map.roles[r].length)}</p>
              <ul aria-label={t.roles[r]} className="flex flex-wrap gap-x-3 gap-y-1">
                {map.roles[r].map((name) => (
                  <li key={name}>{link(name)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t.hubsTitle}>
        <p className="text-xs text-ink-sub">{t.hubsHint}</p>
        {map.hubs.length === 0 ? (
          none(t.hubsNone)
        ) : (
          <ol aria-label={t.hubsTitle} className="list-decimal pl-5 text-sm text-ink">
            {map.hubs.map((h) => (
              <li key={h.table}>
                {link(h.table)} <span className="text-ink-sub">{t.hub(h.referredBy)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title={t.checksTitle}>
        <div className="space-y-3 text-sm">
          <section aria-label={t.noPrimaryKey}>
            <h3 className="font-medium text-ink">{t.noPrimaryKey}</h3>
            <p className="text-xs text-ink-sub">{t.noPrimaryKeyHint}</p>
            {map.noPrimaryKey.length === 0 ? (
              none(t.noPrimaryKeyNone)
            ) : (
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-ink">
                {map.noPrimaryKey.map((name) => (
                  <li key={name}>{link(name)}</li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label={t.unindexed}>
            <h3 className="font-medium text-ink">{t.unindexed}</h3>
            <p className="text-xs text-ink-sub">{t.unindexedHint}</p>
            {map.unindexedKeys.length === 0 ? (
              none(t.unindexedNone)
            ) : (
              <ul className="list-disc pl-5 text-ink">
                {map.unindexedKeys.map((k) => (
                  <li key={`${k.table}.${k.key}`}>
                    <Link
                      to="/db/$db/table/$table/structure"
                      params={{ db, table: k.table }}
                      search={{ schema }}
                      className="text-brand underline"
                    >
                      {t.unindexedKey(k.table, k.columns.join(', '), k.refTable)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Card>
    </>
  )
}
