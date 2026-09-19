import { useQuery } from '@tanstack/react-query'
import type { Dialect } from '@tsmyadmin/shared'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import type { ColumnFormValues } from '@/lib/column-spec.ts'
import { serverCatalogQuery } from '@/lib/queries.ts'

const t = locale.ddl.extras

/** MySQL's column attributes, which are written as part of the type (`INT UNSIGNED`). */
const ATTRIBUTES = ['UNSIGNED', 'UNSIGNED ZEROFILL', 'BINARY'] as const
const ATTRIBUTE = /\s+(?:UNSIGNED\s+ZEROFILL|UNSIGNED|ZEROFILL|BINARY)\b/gi

/** The attribute the type carries, if any, and the type with a different one (or none). */
export function attributeOf(dataType: string): string {
  const m = /\b(UNSIGNED\s+ZEROFILL|UNSIGNED|BINARY)\b/i.exec(dataType)
  return m?.[1] ? m[1].toUpperCase().replace(/\s+/g, ' ') : ''
}
export function withAttribute(dataType: string, attribute: string): string {
  const base = dataType.replace(ATTRIBUTE, '').trim()
  return attribute ? `${base} ${attribute}` : base
}

const TIMESTAMP_TYPE = /^\s*(?:TIMESTAMP|DATETIME)\s*(?:\((\d)\))?/i

/**
 * The column settings phpMyAdmin shows beside the basics: collation, MySQL's attributes and ON UPDATE, and a
 * generated column (an expression the server computes, stored or computed on read).
 */
export function ColumnExtras({
  dialect,
  v,
  set,
}: {
  dialect: Dialect
  v: ColumnFormValues
  set: (patch: Partial<ColumnFormValues>) => void
}) {
  const collations = useQuery(serverCatalogQuery('collations'))
  // The name is the second column on MySQL (after the character set), the first on PostgreSQL.
  const at = dialect === 'mysql' ? 1 : 0
  const names = (collations.data?.rows ?? []).map((r) => String(r[at] ?? '')).filter((n) => n !== '')
  const stamp = TIMESTAMP_TYPE.exec(v.dataType)
  return (
    <div className="space-y-3 rounded border border-line p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field id="col-collation" label={t.collation}>
          <Input
            id="col-collation"
            list="col-collation-list"
            value={v.collation ?? ''}
            placeholder={t.collationDefault}
            onChange={(e) => set({ collation: e.target.value.trim() === '' ? null : e.target.value.trim() })}
            className="font-mono"
          />
          <datalist id="col-collation-list">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>
        {dialect === 'mysql' ? (
          <Field id="col-attribute" label={t.attribute}>
            <Select
              id="col-attribute"
              value={attributeOf(v.dataType)}
              onChange={(e) => set({ dataType: withAttribute(v.dataType, e.target.value) })}
            >
              <option value="">{t.none}</option>
              {ATTRIBUTES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      {dialect === 'mysql' && stamp && !v.generated ? (
        <label className="flex items-center gap-1 text-sm text-ink">
          <input
            type="checkbox"
            checked={v.onUpdate !== null}
            onChange={(e) =>
              set({ onUpdate: e.target.checked ? `CURRENT_TIMESTAMP${stamp[1] ? `(${stamp[1]})` : ''}` : null })
            }
          />
          {t.onUpdate}
        </label>
      ) : null}
      <label className="flex items-center gap-1 text-sm text-ink">
        <input
          type="checkbox"
          checked={v.generated !== null}
          onChange={(e) =>
            set({
              generated: e.target.checked ? { expression: '', stored: dialect === 'postgres' } : null,
              ...(e.target.checked ? { defaultKind: 'none' as const, autoIncrement: false, onUpdate: null } : {}),
            })
          }
        />
        {t.generated}
      </label>
      {v.generated ? (
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field id="col-expression" label={t.expression}>
            <Input
              id="col-expression"
              value={v.generated.expression}
              onChange={(e) => set({ generated: { ...(v.generated ?? { stored: true }), expression: e.target.value } })}
              className="font-mono"
              required
            />
          </Field>
          <Field id="col-stored" label={t.storage}>
            <Select
              id="col-stored"
              value={v.generated.stored ? 'stored' : 'virtual'}
              onChange={(e) =>
                set({ generated: { ...(v.generated ?? { expression: '' }), stored: e.target.value === 'stored' } })
              }
            >
              <option value="stored">{t.stored}</option>
              <option value="virtual">{t.virtual}</option>
            </Select>
          </Field>
        </div>
      ) : null}
    </div>
  )
}
