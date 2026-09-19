import { useQuery } from '@tanstack/react-query'
import { BROWSE_MAX_LIMIT, type ExportOptions, type ImportDefaults } from '@tsmyadmin/shared'
import { useState } from 'react'
import { CsvFields, FormatFields, OutputFields, SqlFields } from '@/components/export/ExportOptionFields.tsx'
import { ImportOptionFields } from '@/components/import/ImportOptionFields.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from '@/lib/import-options.ts'
import { databasesQuery } from '@/lib/queries.ts'
import type { ResolvedSettings } from '@/lib/settings.ts'

const t = locale.settings

type Patch = (patch: Partial<ResolvedSettings>) => void

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded border border-line p-4">
      <legend className="px-1 text-sm font-semibold text-ink">{title}</legend>
      {children}
    </fieldset>
  )
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  children: string
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

/** A whole number in a box; kept as typed while it is not a number, so a field can be emptied to be retyped. */
function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <Field id={id} label={label} hint={`${t.rangeHint(min, max)}${hint ? ` ${hint}` : ''}`}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Math.floor(Number(e.target.value)))}
        className="w-32 tabular-nums"
      />
    </Field>
  )
}

export function MainPanelSection({ value, set }: { value: ResolvedSettings; set: Patch }) {
  return (
    <Section title={t.sections.mainPanel}>
      <NumberField
        id="setting-browse-limit"
        label={t.browseLimit}
        hint=""
        value={value.browseLimit}
        min={1}
        max={BROWSE_MAX_LIMIT}
        onChange={(browseLimit) => set({ browseLimit })}
      />
    </Section>
  )
}

export function SqlSection({ value, set }: { value: ResolvedSettings; set: Patch }) {
  return (
    <Section title={t.sections.sql}>
      <Check checked={value.sqlSafeMode} onChange={(sqlSafeMode) => set({ sqlSafeMode })}>
        {t.sqlSafeMode}
      </Check>
      <Check checked={value.consoleDocked} onChange={(consoleDocked) => set({ consoleDocked })}>
        {t.consoleDocked}
      </Check>
      <NumberField
        id="setting-history-max"
        label={t.sqlHistoryMax}
        hint={t.sqlHistoryMaxHint}
        value={value.sqlHistoryMax}
        min={10}
        max={1000}
        onChange={(sqlHistoryMax) => set({ sqlHistoryMax })}
      />
    </Section>
  )
}

export function NavigationSection({ value, set }: { value: ResolvedSettings; set: Patch }) {
  const databases = useQuery(databasesQuery)
  // A database hidden earlier and dropped since stays in the list, so it can be shown again by name.
  const names = [...new Set([...(databases.data ?? []).map((d) => d.name), ...value.navHidden])]
  const toggle = (name: string) =>
    set({
      navHidden: value.navHidden.includes(name)
        ? value.navHidden.filter((n) => n !== name)
        : [...value.navHidden, name],
    })
  return (
    <Section title={t.sections.navigation}>
      <Field id="setting-nav-delimiter" label={t.navGroupDelimiter} hint={t.navGroupDelimiterHint}>
        <Input
          id="setting-nav-delimiter"
          value={value.navGroupDelimiter}
          maxLength={3}
          onChange={(e) => set({ navGroupDelimiter: e.target.value })}
          className="w-24 font-mono"
        />
      </Field>
      <NumberField
        id="setting-nav-page"
        label={t.navPageSize}
        hint={t.navPageSizeHint}
        value={value.navPageSize}
        min={0}
        max={1000}
        onChange={(navPageSize) => set({ navPageSize })}
      />
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-ink-sub">{t.navHidden}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {names.map((name) => (
            <label key={name} className="flex items-center gap-1">
              <input type="checkbox" checked={value.navHidden.includes(name)} onChange={() => toggle(name)} />
              {name}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-sub">{t.navHiddenHint}</p>
      </fieldset>
    </Section>
  )
}

export function ExportDefaultsSection({
  value,
  set,
  dialect,
}: {
  value: ExportOptions
  set: (next: ExportOptions) => void
  dialect: 'mysql' | 'postgres'
}) {
  const patch = (p: Partial<ExportOptions>) => set({ ...value, ...p })
  return (
    <Section title={t.sections.exportDefaults}>
      <FormatFields options={value} set={patch} />
      {value.format === 'sql' ? <SqlFields options={value} set={patch} dialect={dialect} triggersOnly={false} /> : null}
      {value.format === 'csv' || value.format === 'csvExcel' ? <CsvFields options={value} set={patch} /> : null}
      <OutputFields options={value} set={patch} />
    </Section>
  )
}

export function ImportDefaultsSection({
  value,
  set,
  mysql,
}: {
  value: ImportDefaults
  set: (next: ImportDefaults) => void
  mysql: boolean
}) {
  const [format, setFormat] = useState<'sql' | 'csv'>('sql')
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...value }
  const patch = (p: Partial<ImportOptions>) => {
    const next = { ...options, ...p }
    set({
      charset: next.charset,
      onDuplicate: next.onDuplicate,
      header: next.header,
      nullMarker: next.nullMarker,
      delimiter: next.delimiter,
      enclosure: next.enclosure,
      escape: next.escape,
      stopOnError: next.stopOnError,
      ignoreForeignKeys: next.ignoreForeignKeys,
      singleTransaction: next.singleTransaction,
    })
  }
  return (
    <Section title={t.sections.importDefaults}>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-ink-sub">{t.importFormat}</legend>
        <div className="flex gap-4 text-sm">
          {(['sql', 'csv'] as const).map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input type="radio" name="setting-import-format" checked={format === f} onChange={() => setFormat(f)} />
              {locale.import.formats[f]}
            </label>
          ))}
        </div>
      </fieldset>
      <ImportOptionFields format={format} options={options} set={patch} mysql={mysql} canCreate={false} defaultsOnly />
    </Section>
  )
}
