import { EXPORT_CHARSETS, type ExportCharset, type ImportFormat } from '@tsmyadmin/shared'
import type { ReactNode } from 'react'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { type ImportOptions, isRowsFormat } from './import-options.ts'

const t = locale.import

type Set = (patch: Partial<ImportOptions>) => void

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
    <label className="flex items-center gap-1">
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

const mono = 'w-24 font-mono'

/** What a format takes besides the file: the character set, where to start, and the format's own choices. */
export function ImportOptionFields({
  format,
  options,
  set,
  mysql,
  canCreate,
}: {
  format: ImportFormat
  options: ImportOptions
  set: Set
  mysql: boolean
  /** A new table can be made only where no table is fixed (the database-level tab). */
  canCreate: boolean
}) {
  const rows = isRowsFormat(format)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        {/* A spreadsheet file carries its own character set. */}
        {format === 'ods' ? null : (
          <Field id="import-charset" label={t.charset}>
            <Select
              id="import-charset"
              value={options.charset}
              onChange={(e) => set({ charset: e.target.value as ExportCharset })}
            >
              {EXPORT_CHARSETS.map((c) => (
                <option key={c} value={c}>
                  {locale.export.charsets[c]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field id="import-skip" label={t.skip} hint={t.skipHint}>
          <Input
            id="import-skip"
            type="number"
            min={0}
            value={options.skip}
            onChange={(e) => set({ skip: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
            className="w-32 tabular-nums"
          />
        </Field>
        {format === 'ods' || format === 'xml' || format === 'mediawiki' ? (
          <Field id="import-sheet" label={t.sheet} hint={t.sheetHint}>
            <Input id="import-sheet" value={options.sheet} onChange={(e) => set({ sheet: e.target.value })} />
          </Field>
        ) : null}
      </div>
      {format === 'csv' ? (
        <div className="flex flex-wrap items-end gap-4">
          <Field id="import-null" label={t.nullMarker}>
            <Input
              id="import-null"
              value={options.nullMarker}
              onChange={(e) => set({ nullMarker: e.target.value })}
              className={mono}
            />
          </Field>
          <Field id="import-delimiter" label={t.delimiter}>
            <Input
              id="import-delimiter"
              value={options.delimiter}
              maxLength={1}
              onChange={(e) => set({ delimiter: e.target.value })}
              className={mono}
            />
          </Field>
          <Field id="import-enclosure" label={t.enclosure}>
            <Input
              id="import-enclosure"
              value={options.enclosure}
              maxLength={1}
              onChange={(e) => set({ enclosure: e.target.value })}
              className={mono}
            />
          </Field>
          <Field id="import-escape" label={t.escape}>
            <Input
              id="import-escape"
              value={options.escape}
              maxLength={1}
              onChange={(e) => set({ escape: e.target.value })}
              className={mono}
            />
          </Field>
          <Check checked={options.header} onChange={(header) => set({ header })}>
            {t.header}
          </Check>
        </div>
      ) : null}
      {rows ? (
        <div className="space-y-2">
          <Field id="import-duplicate" label={t.onDuplicate}>
            <Select
              id="import-duplicate"
              value={options.onDuplicate}
              onChange={(e) => set({ onDuplicate: e.target.value as ImportOptions['onDuplicate'] })}
            >
              {(['error', 'ignore', 'replace'] as const).map((d) => (
                <option key={d} value={d}>
                  {t.onDuplicates[d]}
                </option>
              ))}
            </Select>
          </Field>
          {canCreate ? (
            <Check checked={options.createTable} onChange={(createTable) => set({ createTable })}>
              {t.createTable}
            </Check>
          ) : null}
          {canCreate && options.createTable ? <p className="text-xs text-ink-sub">{t.createTableHint}</p> : null}
        </div>
      ) : (
        <div className="space-y-1">
          <Check
            checked={options.stopOnError || options.singleTransaction}
            disabled={options.singleTransaction}
            onChange={(stopOnError) => set({ stopOnError })}
          >
            {t.stopOnError}
          </Check>
          <Check checked={options.ignoreForeignKeys} onChange={(ignoreForeignKeys) => set({ ignoreForeignKeys })}>
            {t.ignoreForeignKeys}
          </Check>
          <Check checked={options.singleTransaction} onChange={(singleTransaction) => set({ singleTransaction })}>
            {t.singleTransaction}
          </Check>
          {mysql ? (
            <Check checked={options.noAutoValueOnZero} onChange={(noAutoValueOnZero) => set({ noAutoValueOnZero })}>
              {t.noAutoValueOnZero}
            </Check>
          ) : null}
        </div>
      )}
    </div>
  )
}
