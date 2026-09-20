import {
  BINARY_FORMATS,
  type CsvDelimiter,
  CsvDelimiterSchema,
  EXPORT_CHARSETS,
  ExportFormatSchema,
  type ExportOptions,
  UTF8_ONLY_FORMATS,
} from '@tsmyadmin/shared'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { ExportCheck, type ExportPatch } from './ExportCheck.tsx'

const t = locale.export

/** The formats to choose between. */
export function FormatFields({ options, set }: { options: ExportOptions; set: ExportPatch }) {
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

/** CSV: the separator, a byte-order mark and the spreadsheet-formula guard. */
export function CsvFields({ options, set }: { options: ExportOptions; set: ExportPatch }) {
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
        <ExportCheck checked={options.bom} onChange={(bom) => set({ bom })}>
          {t.bom}
        </ExportCheck>
      )}
      <ExportCheck checked={options.csvHeader} onChange={(csvHeader) => set({ csvHeader })}>
        {t.csvHeader}
      </ExportCheck>
      <ExportCheck checked={options.csvQuoteAll} onChange={(csvQuoteAll) => set({ csvQuoteAll })}>
        {t.csvQuoteAll}
      </ExportCheck>
      <ExportCheck checked={options.csvStripEol} onChange={(csvStripEol) => set({ csvStripEol })}>
        {t.csvStripEol}
      </ExportCheck>
      <ExportCheck checked={options.csvSafe} onChange={(csvSafe) => set({ csvSafe })}>
        {t.csvSafe}
      </ExportCheck>
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
  set: ExportPatch
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
        <ExportCheck checked={options.filePerTable} onChange={(filePerTable) => set({ filePerTable })}>
          {filePerLabel}
        </ExportCheck>
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
