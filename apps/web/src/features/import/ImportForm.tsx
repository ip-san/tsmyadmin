import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ImportFormat, ImportResult } from '@tsmyadmin/shared'
import { IMPORT_MAX_BYTES, ImportFormatSchema } from '@tsmyadmin/shared'
import { Upload } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { api, enc, unwrap } from '@/lib/api.ts'
import { tablesQuery } from '@/lib/queries.ts'

export interface ImportFormProps {
  db: string
  schema?: string | undefined
  /** Table-level tab: CSV targets this table. */
  table?: string
}

export function detectFormat(fileName: string): ImportFormat | null {
  const ext = fileName.toLowerCase().split('.').pop()
  return ext === 'csv' ? 'csv' : ext === 'sql' ? 'sql' : null
}

export function ImportForm({ db, schema, table }: ImportFormProps) {
  const tables = useQuery({ ...tablesQuery(db, schema), enabled: table === undefined })
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [format, setFormat] = useState<ImportFormat>(table ? 'csv' : 'sql')
  const [target, setTarget] = useState(table ?? '')
  const [header, setHeader] = useState(true)
  const [nullMarker, setNullMarker] = useState('\\N')
  const [delimiter, setDelimiter] = useState(',')
  const [stopOnError, setStopOnError] = useState(true)
  const [result, setResult] = useState<ImportResult | null>(null)

  const run = useMutation({
    mutationFn: (f: File) =>
      unwrap<ImportResult>(
        api.databases[':db'].import.$post({
          param: { db: enc(db) },
          form: {
            file: f,
            format,
            ...(schema ? { schema } : {}),
            ...(format === 'csv'
              ? { table: target, header: header ? '1' : '0', nullMarker, delimiter }
              : { stopOnError: stopOnError ? '1' : '0' }),
          },
        })
      ),
    onSuccess: async (r) => {
      setResult(r)
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    },
  })

  const onFile = (f: File | null) => {
    setFile(f)
    const detected = f ? detectFormat(f.name) : null
    if (detected) setFormat(detected)
  }
  // Checked here so the user gets the limit in their own language before a 64 MB upload is attempted.
  const tooLarge = file !== null && file.size > IMPORT_MAX_BYTES
  const badDelimiter = format === 'csv' && (delimiter.length !== 1 || '"\r\n'.includes(delimiter))
  const blocked = !file || tooLarge || (format === 'csv' && !target) || badDelimiter
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!file || blocked) return
    setResult(null)
    run.mutate(file)
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-busy={run.isPending}>
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{locale.import.title}</h2>
      <Field id="import-file" label={locale.import.file} hint={locale.import.fileHint(IMPORT_MAX_BYTES / 1024 / 1024)}>
        <Input
          id="import-file"
          type="file"
          accept=".sql,.csv,text/plain,text/csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">{locale.import.format}</legend>
        <div className="flex gap-4 text-sm">
          {ImportFormatSchema.options.map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input type="radio" name="import-format" value={f} checked={format === f} onChange={() => setFormat(f)} />
              {locale.import.formats[f]}
            </label>
          ))}
        </div>
      </fieldset>
      {format === 'csv' ? (
        <div className="grid max-w-xl grid-cols-2 gap-3">
          {table ? null : (
            <Field id="import-table" label={locale.import.targetTable}>
              {tables.isPending ? (
                <Spinner />
              ) : (
                <Select id="import-table" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">—</option>
                  {(tables.data ?? [])
                    .filter((t) => t.kind === 'table')
                    .map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
          <Field id="import-null" label={locale.import.nullMarker}>
            <Input
              id="import-null"
              value={nullMarker}
              onChange={(e) => setNullMarker(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field id="import-delimiter" label={locale.import.delimiter}>
            <Input
              id="import-delimiter"
              value={delimiter}
              maxLength={1}
              onChange={(e) => setDelimiter(e.target.value)}
              className="font-mono"
            />
          </Field>
          <label className="flex items-center gap-1 self-end text-sm">
            <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
            {locale.import.header}
          </label>
        </div>
      ) : (
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} />
          {locale.import.stopOnError}
        </label>
      )}
      {format === 'csv' && !target && !table ? <Notice>{locale.import.csvNeedsTable}</Notice> : null}
      {tooLarge ? (
        <p role="alert" className="text-sm text-red-800 dark:text-red-200">
          {locale.import.fileTooLarge(IMPORT_MAX_BYTES / 1024 / 1024)}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={blocked || run.isPending}>
        <Upload className="size-4" aria-hidden />
        {run.isPending ? locale.import.running : locale.import.submit}
      </Button>
      {run.isError ? <ErrorBox error={run.error} /> : null}
      <output aria-live="polite" className={result ? 'block' : 'sr-only'}>
        {result ? <ImportSummary result={result} /> : null}
      </output>
    </form>
  )
}

/** Result banner; the live region is rendered by the parent so it exists before the message arrives. */
function ImportSummary({ result }: { result: ImportResult }) {
  if (result.format === 'csv') {
    return <Notice>{locale.import.csvResult(result.inserted, result.table, result.durationMs)}</Notice>
  }
  return (
    <div className="space-y-2">
      <Notice>{locale.import.sqlResult(result.succeeded, result.failed, result.durationMs)}</Notice>
      {result.errors.length > 0 ? (
        <section className="rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950">
          <h3 className="mb-1 font-semibold text-red-800 dark:text-red-200">{locale.import.errors}</h3>
          <ul className="space-y-1">
            {/* The enclosing <output> already announces; per-item alerts would fire twenty times at once. */}
            {result.errors.map((e, i) => (
              <li key={`${i}-${e.sql}`} className="text-red-800 dark:text-red-200">
                <span>{e.message}</span>
                <pre className="mt-0.5 overflow-x-auto font-mono text-xs text-zinc-600 dark:text-zinc-300">{e.sql}</pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
