import { type ExportOptions, STRUCTURE_FORMATS } from '@tsmyadmin/shared'
import { Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { ExportCheck, type ExportPatch } from './ExportCheck.tsx'

const t = locale.export

/** Whether the file of this format holds a table's structure and its data as separate parts. */
export const holdsStructure = (format: ExportOptions['format']) => STRUCTURE_FORMATS.includes(format)

/** The structure and the data, each on its own: for the document formats and XML. */
function StructureDataFields({ options, set }: { options: ExportOptions; set: ExportPatch }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <ExportCheck checked={options.structure} onChange={(structure) => set({ structure })}>
          {t.documentStructure}
        </ExportCheck>
        <ExportCheck checked={options.data} onChange={(data) => set({ data })}>
          {t.documentData}
        </ExportCheck>
      </div>
      <p className="text-xs text-ink-sub">{t.documentPartsHint}</p>
    </div>
  )
}

/**
 * The choices only one format has: the parts of a document or XML file (and the definitions XML can add), LaTeX's
 * caption and label, JSON's layout and how a spreadsheet writes NULL. CSV's own are in CsvFields.
 */
export function FormatOptionFields({ options, set }: { options: ExportOptions; set: ExportPatch }) {
  const { format } = options
  return (
    <div className="space-y-2">
      {holdsStructure(format) ? <StructureDataFields options={options} set={set} /> : null}
      {format === 'xml' ? (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-ink-sub">{t.xmlObjects}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <ExportCheck checked={options.xmlViews} onChange={(xmlViews) => set({ xmlViews })}>
              {t.xmlViews}
            </ExportCheck>
            <ExportCheck checked={options.xmlRoutines} onChange={(xmlRoutines) => set({ xmlRoutines })}>
              {t.xmlRoutines}
            </ExportCheck>
            <ExportCheck checked={options.xmlTriggers} onChange={(xmlTriggers) => set({ xmlTriggers })}>
              {t.xmlTriggers}
            </ExportCheck>
          </div>
        </fieldset>
      ) : null}
      {format === 'latex' ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <ExportCheck checked={options.latexCaption} onChange={(latexCaption) => set({ latexCaption })}>
            {t.latexCaption}
          </ExportCheck>
          <ExportCheck
            checked={options.latexLabel && options.latexCaption}
            disabled={!options.latexCaption}
            onChange={(latexLabel) => set({ latexLabel })}
          >
            {t.latexLabel}
          </ExportCheck>
        </div>
      ) : null}
      {format === 'json' ? (
        <ExportCheck checked={options.jsonCompact} onChange={(jsonCompact) => set({ jsonCompact })}>
          {t.jsonCompact}
        </ExportCheck>
      ) : null}
      {format === 'ods' ? (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="export-ods-null">{t.odsNull}</label>
          <Input
            id="export-ods-null"
            value={options.odsNull}
            maxLength={100}
            onChange={(e) => set({ odsNull: e.target.value })}
            className="w-40"
            autoComplete="off"
          />
        </div>
      ) : null}
    </div>
  )
}
