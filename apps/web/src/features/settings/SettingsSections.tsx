import { useQuery } from '@tanstack/react-query'
import { BROWSE_MAX_LIMIT, type ExportOptions, type ImportDefaults } from '@tsmyadmin/shared'
import { useState } from 'react'
import { CsvFields, FormatFields, OutputFields } from '@/components/export/ExportOptionFields.tsx'
import { FormatOptionFields } from '@/components/export/FormatOptionFields.tsx'
import { SqlFields } from '@/components/export/SqlExportFields.tsx'
import { ImportOptionFields } from '@/components/import/ImportOptionFields.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from '@/lib/import-options.ts'
import { databasesQuery } from '@/lib/queries.ts'
import type { ResolvedSettings } from '@/lib/settings.ts'
import { Check, ChoiceField, NumberField, Section } from './SettingsFields.tsx'

const t = locale.settings

type Patch = (patch: Partial<ResolvedSettings>) => void

export function MainPanelSection({ value, set }: { value: ResolvedSettings; set: Patch }) {
  return (
    <Section id="main-panel" title={t.sections.mainPanel}>
      <NumberField
        id="setting-browse-limit"
        label={t.browseLimit}
        hint=""
        value={value.browseLimit}
        min={1}
        max={BROWSE_MAX_LIMIT}
        onChange={(browseLimit) => set({ browseLimit })}
      />
      <Check checked={value.browseUnlimited} onChange={(browseUnlimited) => set({ browseUnlimited })}>
        {t.browseUnlimited}
      </Check>
      <NumberField
        id="setting-header-every"
        label={t.headerEvery}
        hint={t.headerEveryHint}
        value={value.headerEvery}
        min={0}
        max={1000}
        onChange={(headerEvery) => set({ headerEvery })}
      />
      <NumberField
        id="setting-insert-rows"
        label={t.insertRowCount}
        hint=""
        value={value.insertRowCount}
        min={1}
        max={10}
        onChange={(insertRowCount) => set({ insertRowCount })}
      />
      <ChoiceField
        id="setting-grid-edit"
        label={t.gridEdit}
        value={value.gridEdit}
        options={t.gridEdits}
        onChange={(gridEdit) => set({ gridEdit })}
      />
      <Check checked={value.saveOnBlur} onChange={(saveOnBlur) => set({ saveOnBlur })}>
        {t.saveOnBlur}
      </Check>
      <Check checked={value.confirmDrop} onChange={(confirmDrop) => set({ confirmDrop })}>
        {t.confirmDrop}
      </Check>
      <ChoiceField
        id="setting-tab-server"
        label={t.defaultServerTab}
        value={value.defaultServerTab}
        options={t.serverTabs}
        onChange={(defaultServerTab) => set({ defaultServerTab })}
      />
      <ChoiceField
        id="setting-tab-db"
        label={t.defaultDbTab}
        value={value.defaultDbTab}
        options={t.dbTabs}
        onChange={(defaultDbTab) => set({ defaultDbTab })}
      />
      <ChoiceField
        id="setting-tab-table"
        label={t.defaultTableTab}
        value={value.defaultTableTab}
        options={t.tableTabs}
        onChange={(defaultTableTab) => set({ defaultTableTab })}
      />
    </Section>
  )
}

export function SqlSection({ value, set }: { value: ResolvedSettings; set: Patch }) {
  return (
    <Section id="sql" title={t.sections.sql}>
      <Check checked={value.sqlSafeMode} onChange={(sqlSafeMode) => set({ sqlSafeMode })}>
        {t.sqlSafeMode}
      </Check>
      <Check checked={value.consoleDocked} onChange={(consoleDocked) => set({ consoleDocked })}>
        {t.consoleDocked}
      </Check>
      <Check checked={value.sqlEnterRuns} onChange={(sqlEnterRuns) => set({ sqlEnterRuns })}>
        {t.sqlEnterRuns}
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
    <Section id="navigation" title={t.sections.navigation}>
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
        id="setting-nav-width"
        label={t.navWidth}
        hint=""
        value={value.navWidth}
        min={200}
        max={480}
        onChange={(navWidth) => set({ navWidth })}
      />
      <Check checked={value.navShowRoutines} onChange={(navShowRoutines) => set({ navShowRoutines })}>
        {t.navShowRoutines}
      </Check>
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
    <Section id="export" title={t.sections.exportDefaults}>
      <FormatFields options={value} set={patch} />
      {value.format === 'sql' ? <SqlFields options={value} set={patch} dialect={dialect} triggersOnly={false} /> : null}
      {value.format === 'csv' || value.format === 'csvExcel' ? <CsvFields options={value} set={patch} /> : null}
      <FormatOptionFields options={value} set={patch} />
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
      lineEnd: next.lineEnd,
      skipBlank: next.skipBlank,
      odsPercent: next.odsPercent,
      odsCurrency: next.odsCurrency,
      odsDate: next.odsDate,
    })
  }
  return (
    <Section id="import" title={t.sections.importDefaults}>
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
