import type { ColumnSpec, DdlOp, Dialect, TableSchema } from '@tsmyadmin/shared'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { locale } from '@/config/locale.ts'
import { fromColumnDef, toColumnSpec } from '@/lib/column-spec.ts'
import { ColumnForm } from './ColumnForm.tsx'

const t = locale.ddl.bulk

type IndexKind = 'unique' | 'index' | 'fulltext' | 'spatial'

/** A column's definition as it is now, for a statement that rewrites it. */
function specOf(schema: TableSchema, name: string, dialect: Dialect): ColumnSpec | null {
  const c = schema.columns.find((x) => x.name === name)
  return c ? toColumnSpec(fromColumnDef(c, dialect)) : null
}

/**
 * phpMyAdmin's "With selected" under the column list: a key on the ticked columns, changing or dropping them
 * together, and — on MySQL — putting every column in a new order.
 */
export function ColumnBulk({
  schema,
  dialect,
  selected,
  onPreview,
  onIndex,
}: {
  schema: TableSchema
  dialect: Dialect
  selected: string[]
  onPreview: (op: DdlOp) => void
  /** Opens the index form on the ticked columns with this kind. */
  onIndex: (kind: IndexKind, columns: string[]) => void
}) {
  const table = schema.name
  const [changing, setChanging] = useState<{
    step: number
    changes: Extract<DdlOp, { op: 'modifyColumns' }>['changes']
  } | null>(null)
  const [ordering, setOrdering] = useState<string[] | null>(null)
  const kinds: IndexKind[] = dialect === 'mysql' ? ['unique', 'index', 'fulltext', 'spatial'] : ['unique', 'index']
  const none = selected.length === 0
  const current = changing ? selected[changing.step] : undefined
  const currentDef = current ? schema.columns.find((c) => c.name === current) : undefined
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-xs print:hidden">
      <span className="text-ink-sub">{t.selected(selected.length)}</span>
      <Button
        size="sm"
        disabled={none}
        onClick={() =>
          onPreview({
            op: 'setPrimaryKey',
            table,
            columns: selected,
            ...(schema.primaryKey.length > 0
              ? { current: schema.indexes.find((i) => i.primary)?.name ?? 'PRIMARY' }
              : {}),
          })
        }
      >
        {t.primary}
      </Button>
      {kinds.map((k) => (
        <Button key={k} size="sm" disabled={none} aria-haspopup="dialog" onClick={() => onIndex(k, selected)}>
          {t.index[k]}
        </Button>
      ))}
      <Button size="sm" disabled={none} aria-haspopup="dialog" onClick={() => setChanging({ step: 0, changes: [] })}>
        {t.change}
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={none || selected.length === schema.columns.length}
        aria-haspopup="dialog"
        onClick={() => onPreview({ op: 'dropColumns', table, names: selected })}
      >
        {t.drop}
      </Button>
      {dialect === 'mysql' ? (
        <Button size="sm" aria-haspopup="dialog" onClick={() => setOrdering(schema.columns.map((c) => c.name))}>
          {t.reorder}
        </Button>
      ) : null}

      <Dialog
        open={changing !== null && current !== undefined}
        title={t.changeTitle(changing ? changing.step + 1 : 0, selected.length)}
        onClose={() => setChanging(null)}
      >
        {changing && current && currentDef ? (
          <ColumnForm
            key={current}
            dialect={dialect}
            mode="modify"
            initial={fromColumnDef(currentDef, dialect)}
            onCancel={() => setChanging(null)}
            onSubmit={(values) => {
              const previous = specOf(schema, current, dialect)
              const changes = [
                ...changing.changes,
                { name: current, column: toColumnSpec(values), ...(previous ? { previous } : {}) },
              ]
              if (changing.step + 1 < selected.length) return setChanging({ step: changing.step + 1, changes })
              setChanging(null)
              onPreview({ op: 'modifyColumns', table, changes })
            }}
          />
        ) : null}
      </Dialog>

      <Dialog open={ordering !== null} title={locale.ddl.titles.reorderColumns} onClose={() => setOrdering(null)}>
        {ordering ? (
          <div className="space-y-3">
            <ol className="space-y-1" aria-label={t.order}>
              {ordering.map((name, i) => (
                <li key={name} className="flex items-center gap-2 text-sm text-ink">
                  <span className="w-6 text-right tabular-nums text-ink-sub">{i + 1}</span>
                  <span className="flex-1 font-mono">{name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === 0}
                    aria-label={t.up(name)}
                    onClick={() => setOrdering((o) => (o ? move(o, i, i - 1) : o))}
                  >
                    <ArrowUp className="size-3" aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === ordering.length - 1}
                    aria-label={t.down(name)}
                    onClick={() => setOrdering((o) => (o ? move(o, i, i + 1) : o))}
                  >
                    <ArrowDown className="size-3" aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOrdering(null)}>{locale.common.cancel}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const columns = ordering.flatMap((n) => {
                    const spec = specOf(schema, n, dialect)
                    return spec ? [spec] : []
                  })
                  setOrdering(null)
                  onPreview({ op: 'reorderColumns', table, columns })
                }}
              >
                {locale.ddl.submit}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}

function move<T>(list: T[], from: number, to: number): T[] {
  const out = [...list]
  const [item] = out.splice(from, 1)
  if (item !== undefined) out.splice(to, 0, item)
  return out
}
