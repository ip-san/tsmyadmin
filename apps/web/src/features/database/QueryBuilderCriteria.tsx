import { type QueryBuilderOp, QueryBuilderOpSchema } from '@tsmyadmin/shared'
import { useRef } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { valueShape } from '@/lib/filter-values.ts'
import { type ColumnKey, type ConditionGroup, type ConditionRow } from './query-builder-model.ts'

export interface ColumnOption {
  key: ColumnKey
  label: string
}

const t = locale.queryBuilder

export function ColumnSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: ColumnKey
  options: readonly ColumnOption[]
  label: string
  onChange: (key: ColumnKey) => void
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-56">
      <option value="">{t.chooseColumn}</option>
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}

/** OR of groups, each an AND of conditions — the same shape the request has. */
export function QueryBuilderCriteria({
  groups,
  options,
  onChange,
  newId,
}: {
  groups: readonly ConditionGroup[]
  options: readonly ColumnOption[]
  onChange: (groups: ConditionGroup[]) => void
  newId: () => number
}) {
  const addGroupButton = useRef<HTMLButtonElement>(null)
  const blank = (): ConditionRow => ({ id: newId(), key: '', op: 'eq', value: '' })
  // A group left with no conditions is removed with its last one.
  const setGroup = (gi: number, conditions: ConditionRow[]) =>
    onChange(groups.map((g, i) => (i === gi ? { ...g, conditions } : g)).filter((g) => g.conditions.length > 0))
  const update = (gi: number, id: number, patch: Partial<ConditionRow>) =>
    setGroup(
      gi,
      (groups[gi]?.conditions ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c))
    )

  return (
    <div className="space-y-2">
      {groups.map((group, gi) => (
        <div key={group.id} className="space-y-2">
          {gi > 0 ? <p className="text-xs font-semibold text-ink-sub">{t.or}</p> : null}
          <fieldset className="space-y-2 rounded border border-line p-2">
            <legend className="px-1 text-xs text-ink-sub">{t.group(gi + 1)}</legend>
            {group.conditions.map((c, ci) => {
              const label = t.conditionLabel(gi + 1, ci + 1)
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-2">
                  <ColumnSelect
                    value={c.key}
                    options={options}
                    label={t.fieldLabel(label, t.column)}
                    onChange={(key) => update(gi, c.id, { key })}
                  />
                  <Select
                    aria-label={t.fieldLabel(label, t.operator)}
                    value={c.op}
                    onChange={(e) => update(gi, c.id, { op: e.target.value as QueryBuilderOp })}
                    className="w-36"
                  >
                    {QueryBuilderOpSchema.options.map((op) => (
                      <option key={op} value={op}>
                        {locale.search.ops[op]}
                      </option>
                    ))}
                  </Select>
                  {valueShape(c.op) === 'none' ? null : (
                    <Input
                      aria-label={t.fieldLabel(label, t.value)}
                      value={c.value}
                      onChange={(e) => update(gi, c.id, { value: e.target.value })}
                      className="w-56"
                      autoComplete="off"
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t.removeCondition(label)}
                    onClick={() => {
                      setGroup(
                        gi,
                        group.conditions.filter((x) => x.id !== c.id)
                      )
                      // This button goes (with its group, if it held the last condition): keep focus on a control that stays.
                      addGroupButton.current?.focus()
                    }}
                  >
                    {t.remove}
                  </Button>
                </div>
              )
            })}
            <Button type="button" size="sm" onClick={() => setGroup(gi, [...group.conditions, blank()])}>
              {t.addCondition}
            </Button>
          </fieldset>
        </div>
      ))}
      <Button
        ref={addGroupButton}
        type="button"
        size="sm"
        onClick={() => onChange([...groups, { id: newId(), conditions: [blank()] }])}
      >
        {groups.length === 0 ? t.addFirstCondition : t.addGroup}
      </Button>
    </div>
  )
}
