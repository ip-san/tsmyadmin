import { type Dialect, type ExportOptions, ExportStatementSchema } from '@tsmyadmin/shared'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { ExportCheck, type ExportPatch } from './ExportCheck.tsx'

const t = locale.export

/** SQL: what goes in the dump, and how the rows are written. */
export function SqlFields({
  options,
  set,
  dialect,
  triggersOnly,
  server = false,
}: {
  options: ExportOptions
  set: ExportPatch
  dialect: Dialect
  triggersOnly: boolean
  /** The whole-server dump always names each database itself, so that choice is not offered. */
  server?: boolean
}) {
  const mysql = dialect === 'mysql'
  const write = options.statement === 'insert'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <ExportCheck checked={options.structure} onChange={(structure) => set({ structure })}>
          {t.structure}
        </ExportCheck>
        <ExportCheck
          checked={options.dropTable}
          disabled={!options.structure}
          onChange={(dropTable) => set({ dropTable })}
        >
          {t.dropTable}
        </ExportCheck>
        <ExportCheck
          checked={options.ifNotExists}
          disabled={!options.structure}
          onChange={(ifNotExists) => set({ ifNotExists })}
        >
          {t.ifNotExists}
        </ExportCheck>
        <ExportCheck checked={options.data} onChange={(data) => set({ data })}>
          {t.data}
        </ExportCheck>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <ExportCheck
          checked={options.routines}
          disabled={!options.structure}
          onChange={(routines) => set({ routines })}
        >
          {triggersOnly ? t.triggersOnly : t.routines}
        </ExportCheck>
        {mysql ? (
          <ExportCheck
            checked={options.stripDefiner}
            disabled={!options.structure}
            onChange={(stripDefiner) => set({ stripDefiner })}
          >
            {t.stripDefiner}
          </ExportCheck>
        ) : null}
        <ExportCheck
          checked={options.viewsAsTables}
          disabled={!options.structure}
          onChange={(viewsAsTables) => set({ viewsAsTables })}
        >
          {t.viewsAsTables}
        </ExportCheck>
        {server ? null : (
          <ExportCheck checked={options.createDatabase} onChange={(createDatabase) => set({ createDatabase })}>
            {mysql ? t.createDatabaseMysql : t.createDatabasePostgres}
          </ExportCheck>
        )}
        <ExportCheck checked={options.comments} onChange={(comments) => set({ comments })}>
          {t.comments}
        </ExportCheck>
        <ExportCheck checked={options.transaction} onChange={(transaction) => set({ transaction })}>
          {t.transaction}
        </ExportCheck>
        <ExportCheck checked={options.utc} onChange={(utc) => set({ utc })}>
          {t.utc}
        </ExportCheck>
        {mysql ? (
          <ExportCheck
            checked={options.lockTables}
            disabled={!options.data}
            onChange={(lockTables) => set({ lockTables })}
          >
            {t.lockTables}
          </ExportCheck>
        ) : null}
      </div>
      <fieldset className="space-y-2" disabled={!options.data}>
        <legend className="text-xs font-medium text-ink-sub">{t.rowsAs}</legend>
        <div className="flex flex-wrap items-start gap-4">
          <Field id="export-statement" label={t.statement}>
            <Select
              id="export-statement"
              value={options.statement}
              onChange={(e) => set({ statement: e.target.value as ExportOptions['statement'] })}
            >
              {ExportStatementSchema.options.map((s) => (
                <option key={s} value={s}>
                  {t.statements[s]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="mt-5 flex min-h-[2.375rem] flex-wrap items-center gap-x-4 gap-y-1">
            <ExportCheck
              checked={options.columnNames}
              disabled={!write}
              onChange={(columnNames) => set({ columnNames })}
            >
              {t.columnNames}
            </ExportCheck>
            <ExportCheck checked={options.extended} disabled={!write} onChange={(extended) => set({ extended })}>
              {t.extended}
            </ExportCheck>
            <ExportCheck checked={options.ignore} disabled={!write} onChange={(ignore) => set({ ignore })}>
              {mysql ? t.ignoreMysql : t.ignorePostgres}
            </ExportCheck>
          </div>
          <Field id="export-max-query" label={t.maxQuery} hint={t.maxQueryHint}>
            <Input
              id="export-max-query"
              type="number"
              min={0}
              value={options.maxQuery}
              disabled={!write || !options.extended}
              onChange={(e) => set({ maxQuery: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
              className="w-32 tabular-nums"
            />
          </Field>
        </div>
        {options.statement !== 'insert' ? <p className="text-xs text-ink-sub">{t.needsKey}</p> : null}
      </fieldset>
    </div>
  )
}
