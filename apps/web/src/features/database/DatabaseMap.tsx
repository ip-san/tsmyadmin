import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { TABLE_ROLES } from '@/lib/table-role.ts'
import type { DatabaseMap as MapData } from './database-map.ts'
import { useDatabaseMap } from './use-database-map.ts'

const t = locale.databaseMap
const LINK = 'text-brand underline'

/**
 * What a database is made of, from its definitions (`databaseMap`): the tables by the role their keys suggest, the
 * ones most referred to, and what to look at (no primary key, a foreign key without an index). No rows are read.
 */
export function DatabaseMap({ db, schema }: { db: string; schema: string | undefined }) {
  const { map, failed, error, status, readAgain, fetching } = useDatabaseMap(db, schema)
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title(schema ?? db)}</h2>
        <p className="text-sm text-ink-sub">{t.hint}</p>
      </div>
      {/* One line, there from the start (empty): what is being read, then what was; heard, and left to read again. */}
      <p role="status" className="text-sm text-ink empty:mb-0">
        {status}
      </p>
      {error ? <ErrorBox error={error.error} onRetry={error.retry} /> : null}
      {failed.length > 0 && !error ? (
        // Left focusable while reading: a keyboard user who pressed it keeps their place.
        <Button size="sm" aria-disabled={fetching} onClick={readAgain}>
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
  /**
   * Some tables could not be read: what is not in the lists may be in them, so "none" is not said (not even of the
   * tables referred to, which the tables read could tell: one rule for every list).
   */
  partial: boolean
}) {
  const none = (text: string): ReactNode => (partial ? null : <p className="text-sm text-ink-sub">{text}</p>)
  const overview = (table: string): ReactNode => (
    <Link to="/db/$db/table/$table/overview" params={{ db, table }} search={{ schema }} className={LINK}>
      {table}
    </Link>
  )
  return (
    <>
      <Card title={t.rolesTitle}>
        <ul className="space-y-2 text-sm text-ink">
          {TABLE_ROLES.filter((r) => map.roles[r].length > 0).map((r) => (
            <li key={r}>
              <p className="font-medium">{t.roleCount(t.roles[r], map.roles[r].length)}</p>
              <ul aria-label={t.roles[r]} className="flex flex-wrap gap-x-3 gap-y-1">
                {map.roles[r].map((name) => (
                  <li key={name}>{overview(name)}</li>
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
                {overview(h.table)} <span className="text-ink-sub">{t.hub(h.referredBy)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title={t.checksTitle}>
        <div className="space-y-3 text-sm">
          <Check title={t.noPrimaryKey} hint={t.noPrimaryKeyHint} none={none(t.noPrimaryKeyNone)} inline>
            {map.noPrimaryKey.map((name) => (
              <li key={name}>{overview(name)}</li>
            ))}
          </Check>
          <Check title={t.unindexed} hint={t.unindexedHint} none={none(t.unindexedNone)}>
            {map.unindexedKeys.map((k) => (
              // A key is fixed on the table's structure, where its index is made.
              <li key={`${k.table}.${k.key}`}>
                <Link
                  to="/db/$db/table/$table/structure"
                  params={{ db, table: k.table }}
                  search={{ schema }}
                  className={LINK}
                >
                  {t.unindexedKey(k.table, k.columns.join(', '), k.refTable)}
                </Link>
              </li>
            ))}
          </Check>
          <Check title={t.keyTypes} hint={t.keyTypesHint} none={none(t.keyTypesNone)}>
            {map.keyTypes.map((k) => (
              // Its type is changed on the table's structure.
              <li key={`${k.table}.${k.key}.${k.column}`}>
                <Link
                  to="/db/$db/table/$table/structure"
                  params={{ db, table: k.table }}
                  search={{ schema }}
                  className={LINK}
                >
                  {t.keyType(
                    t.keySide(k.table, k.column, k.type, k.collations?.from ?? null),
                    t.keySide(k.refTable, k.refColumn, k.refType, k.collations?.to ?? null)
                  )}
                </Link>
              </li>
            ))}
          </Check>
          <Check title={t.nameTypes} hint={t.nameTypesHint} none={none(t.nameTypesNone)}>
            {map.nameTypes.map((n) => (
              <li key={n.column}>
                <span className="font-mono">{n.column}</span>
                <ul aria-label={t.nameTypesOf(n.column)} className="pl-4">
                  {n.types.map((x) => (
                    <li key={x.type}>{t.nameType(x.type, x.tables)}</li>
                  ))}
                </ul>
              </li>
            ))}
          </Check>
        </div>
      </Card>
    </>
  )
}

/** One thing to look at: its name, why it matters, and the items found (or that there are none). */
function Check({
  title,
  hint,
  none,
  inline = false,
  children,
}: {
  title: string
  hint: string
  none: ReactNode
  /** Names side by side, not one sentence a line. */
  inline?: boolean
  children: ReactNode[]
}) {
  return (
    <section aria-label={title}>
      <h3 className="font-medium text-ink">{title}</h3>
      <p className="text-xs text-ink-sub">{hint}</p>
      {children.length === 0 ? (
        none
      ) : (
        <ul className={inline ? 'flex flex-wrap gap-x-3 gap-y-1 text-ink' : 'list-disc pl-5 text-ink'}>{children}</ul>
      )}
    </section>
  )
}
