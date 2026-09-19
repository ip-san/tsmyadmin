import {
  BINARY_FORMATS,
  type CsvDelimiter,
  CsvDelimiterSchema,
  type Dialect,
  EXPORT_CHARSETS,
  ExportFormatSchema,
  type ExportOptions,
  ExportStatementSchema,
  UTF8_ONLY_FORMATS,
} from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.export

type Patch = (patch: Partial<ExportOptions>) => void

function Check({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled ?? false}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  )
}

/** The formats to choose between. */
export function FormatFields({ options, set }: { options: ExportOptions; set: Patch }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-ink-sub">{t.format}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {ExportFormatSchema.options.map((f) => (
          <label key={f} className="flex items-center gap-1">
            <input
              type="radio"
              name="export-format"
              value={f}
              checked={options.format === f}
              onChange={() => set({ format: f })}
            />
            {t.formats[f]}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** SQL: what goes in the dump, and how the rows are written. */
export function SqlFields({
  options,
  set,
  dialect,
  triggersOnly,
  server = false,
}: {
  options: ExportOptions
  set: Patch
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
        <Check checked={options.structure} onChange={(structure) => set({ structure })}>
          {t.structure}
        </Check>
        <Check checked={options.dropTable} disabled={!options.structure} onChange={(dropTable) => set({ dropTable })}>
          {t.dropTable}
        </Check>
        <Check
          checked={options.ifNotExists}
          disabled={!options.structure}
          onChange={(ifNotExists) => set({ ifNotExists })}
        >
          {t.ifNotExists}
        </Check>
        <Check checked={options.data} onChange={(data) => set({ data })}>
          {t.data}
        </Check>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Check checked={options.routines} disabled={!options.structure} onChange={(routines) => set({ routines })}>
          {triggersOnly ? t.triggersOnly : t.routines}
        </Check>
        {mysql ? (
          <Check
            checked={options.stripDefiner}
            disabled={!options.structure}
            onChange={(stripDefiner) => set({ stripDefiner })}
          >
            {t.stripDefiner}
          </Check>
        ) : null}
        <Check
          checked={options.viewsAsTables}
          disabled={!options.structure}
          onChange={(viewsAsTables) => set({ viewsAsTables })}
        >
          {t.viewsAsTables}
        </Check>
        {server ? null : (
          <Check checked={options.createDatabase} onChange={(createDatabase) => set({ createDatabase })}>
            {mysql ? t.createDatabaseMysql : t.createDatabasePostgres}
          </Check>
        )}
        <Check checked={options.comments} onChange={(comments) => set({ comments })}>
          {t.comments}
        </Check>
        <Check checked={options.transaction} onChange={(transaction) => set({ transaction })}>
          {t.transaction}
        </Check>
        <Check checked={options.utc} onChange={(utc) => set({ utc })}>
          {t.utc}
        </Check>
        {mysql ? (
          <Check checked={options.lockTables} disabled={!options.data} onChange={(lockTables) => set({ lockTables })}>
            {t.lockTables}
          </Check>
        ) : null}
      </div>
      <fieldset className="space-y-2" disabled={!options.data}>
        <legend className="text-xs font-medium text-ink-sub">{t.rowsAs}</legend>
        <div className="flex flex-wrap items-end gap-4">
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
          <Check checked={options.columnNames} disabled={!write} onChange={(columnNames) => set({ columnNames })}>
            {t.columnNames}
          </Check>
          <Check checked={options.extended} disabled={!write} onChange={(extended) => set({ extended })}>
            {t.extended}
          </Check>
          <Check checked={options.ignore} disabled={!write} onChange={(ignore) => set({ ignore })}>
            {mysql ? t.ignoreMysql : t.ignorePostgres}
          </Check>
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

/** CSV: the separator, a byte-order mark and the spreadsheet-formula guard. */
export function CsvFields({ options, set }: { options: ExportOptions; set: Patch }) {
  const excel = options.format === 'csvExcel'
  return (
    <div className="space-y-1">
      {excel ? (
        <p className="text-xs text-ink-sub">{t.csvExcelHint}</p>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="export-csv-delimiter">{t.csvDelimiter}</label>
          <Select
            id="export-csv-delimiter"
            value={options.csvDelimiter}
            onChange={(e) => set({ csvDelimiter: e.target.value as CsvDelimiter })}
          >
            {CsvDelimiterSchema.options.map((d) => (
              <option key={d} value={d}>
                {t.csvDelimiters[d]}
              </option>
            ))}
          </Select>
        </div>
      )}
      {excel ? null : (
        <Check checked={options.bom} onChange={(bom) => set({ bom })}>
          {t.bom}
        </Check>
      )}
      <Check checked={options.csvSafe} onChange={(csvSafe) => set({ csvSafe })}>
        {t.csvSafe}
      </Check>
      <p className="text-xs text-ink-sub">{t.csvSafeHint}</p>
    </div>
  )
}

/** Every format: which rows, and what the file is called, compressed and encoded as. */
export function OutputFields({
  options,
  set,
  filePerLabel = t.filePerTable,
}: {
  options: ExportOptions
  set: Patch
  filePerLabel?: string
}) {
  // A spreadsheet or document file, and JSON / XML / YAML / HTML (always UTF-8), have no character set to choose.
  const binary = BINARY_FORMATS.includes(options.format) || UTF8_ONLY_FORMATS.includes(options.format)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <Field id="export-row-offset" label={t.rowOffset}>
          <Input
            id="export-row-offset"
            type="number"
            min={0}
            value={options.rowOffset}
            onChange={(e) => set({ rowOffset: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
            className="w-32 tabular-nums"
          />
        </Field>
        <Field id="export-row-limit" label={t.rowLimit} hint={t.rowLimitHint}>
          <Input
            id="export-row-limit"
            type="number"
            min={0}
            value={options.rowLimit}
            onChange={(e) => set({ rowLimit: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
            className="w-32 tabular-nums"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field id="export-compress" label={t.compress}>
          <Select
            id="export-compress"
            value={options.compress}
            disabled={options.filePerTable}
            onChange={(e) => set({ compress: e.target.value as ExportOptions['compress'] })}
          >
            <option value="none">{t.compressions.none}</option>
            <option value="gzip">{t.compressions.gzip}</option>
            <option value="zip">{t.compressions.zip}</option>
          </Select>
        </Field>
        <Check checked={options.filePerTable} onChange={(filePerTable) => set({ filePerTable })}>
          {filePerLabel}
        </Check>
        <Field id="export-charset" label={t.charset}>
          <Select
            id="export-charset"
            value={options.charset}
            disabled={binary}
            onChange={(e) => set({ charset: e.target.value as ExportOptions['charset'] })}
          >
            {EXPORT_CHARSETS.map((c) => (
              <option key={c} value={c}>
                {t.charsets[c]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field id="export-filename" label={t.filename} hint={t.filenameHint}>
        <Input
          id="export-filename"
          value={options.filename}
          onChange={(e) => set({ filename: e.target.value })}
          placeholder="@DATABASE@_%Y%m%d"
          className="max-w-md font-mono"
          autoComplete="off"
        />
      </Field>
    </div>
  )
}
