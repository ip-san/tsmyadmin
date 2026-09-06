import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ImportFormat, ImportResult } from '@tsmyadmin/shared'
import { IMPORT_MAX_BYTES, ImportFormatSchema } from '@tsmyadmin/shared'
import { Upload } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { runImport } from '@/lib/import-stream.ts'
import { mutations, tablesQuery } from '@/lib/queries.ts'

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
  const [ignoreForeignKeys, setIgnoreForeignKeys] = useState(false)
  const [singleTransaction, setSingleTransaction] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Leaving the page aborts the upload, which makes the server stop the running statement. The 中止 button
  // instead cancels by id and keeps reading, so the summary still says what ran before the stop.
  const abort = useRef<AbortController | null>(null)
  const queryId = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // The submit / cancel buttons disable or unmount while focused: focus lands on the summary once the run ends.
  const summary = useRef<HTMLOutputElement>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const cancel = useMutation({ mutationFn: (id: string) => mutations.cancelSql(db, id) })

  const run = useMutation({
    mutationFn: (f: File) => {
      const controller = new AbortController()
      abort.current = controller
      queryId.current = crypto.randomUUID()
      setProgress(null)
      return runImport(
        db,
        {
          file: f,
          format,
          schema,
          queryId: queryId.current,
          ...(format === 'csv'
            ? { table: target, header: header ? ('1' as const) : ('0' as const), nullMarker, delimiter }
            : {
                stopOnError: stopOnError ? ('1' as const) : ('0' as const),
                ignoreForeignKeys: ignoreForeignKeys ? ('1' as const) : ('0' as const),
                singleTransaction: singleTransaction ? ('1' as const) : ('0' as const),
              }),
        },
        (done, total) => setProgress({ done, total }),
        controller.signal
      )
    },
    onMutate: () => cancel.reset(),
    onSuccess: async (r) => {
      setResult(r)
      // The file is consumed: a second click must not import it again (the summary stays on screen).
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })
    },
    onSettled: () => {
      abort.current = null
      setProgress(null)
      summary.current?.focus()
    },
  })

  // A cancel that found nothing running (the file was still being decoded) leaves the button usable.
  const cancelSent = cancel.isPending || (cancel.isSuccess && cancel.data.cancelled)
  const cancelled = cancel.isSuccess && cancel.data.cancelled && !run.isPending

  const onFile = (f: File | null) => {
    setFile(f)
    // A fresh file must not sit under the previous run's summary.
    setResult(null)
    run.reset()
    cancel.reset()
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
      {/* Everything is frozen while a run is in flight: changing the file would detach the running upload. */}
      <fieldset disabled={run.isPending} className="space-y-4">
        <Field
          id="import-file"
          label={locale.import.file}
          hint={locale.import.fileHint(IMPORT_MAX_BYTES / 1024 / 1024)}
        >
          <Input
            id="import-file"
            ref={fileInput}
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
                <input
                  type="radio"
                  name="import-format"
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                />
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
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={stopOnError || singleTransaction}
                disabled={singleTransaction}
                onChange={(e) => setStopOnError(e.target.checked)}
              />
              {locale.import.stopOnError}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={ignoreForeignKeys}
                onChange={(e) => setIgnoreForeignKeys(e.target.checked)}
              />
              {locale.import.ignoreForeignKeys}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={singleTransaction}
                onChange={(e) => setSingleTransaction(e.target.checked)}
              />
              {locale.import.singleTransaction}
            </label>
          </div>
        )}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{locale.import.notes[format]}</p>
      </fieldset>
      {format === 'csv' && !target && !table ? <Notice>{locale.import.csvNeedsTable}</Notice> : null}
      {tooLarge ? (
        <p role="alert" className="text-sm text-red-800 dark:text-red-200">
          {locale.import.fileTooLarge(IMPORT_MAX_BYTES / 1024 / 1024)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={blocked || run.isPending}>
          <Upload className="size-4" aria-hidden />
          {run.isPending ? locale.import.running : locale.import.submit}
        </Button>
        {/* CSV runs as one INSERT transaction the server cannot interrupt by id: no cancel for it. */}
        {run.isPending && format === 'sql' ? (
          <Button onClick={() => queryId.current && cancel.mutate(queryId.current)} disabled={cancelSent}>
            {cancelSent ? locale.import.cancelling : locale.import.cancel}
          </Button>
        ) : null}
        {run.isPending && progress ? (
          <progress
            className="h-2 w-48"
            value={progress.done}
            max={Math.max(progress.total, 1)}
            aria-label={locale.import.progress(progress.done, progress.total)}
          />
        ) : null}
        {run.isPending && progress ? (
          <span className="text-xs text-zinc-600 dark:text-zinc-300">
            {locale.import.progress(progress.done, progress.total)}
          </span>
        ) : null}
      </div>
      {cancel.isError ? <ErrorBox error={cancel.error} /> : null}
      <output
        ref={summary}
        tabIndex={-1}
        aria-live="polite"
        className={cn('outline-none', result || cancelled || run.isError ? 'block' : 'sr-only')}
      >
        {run.isError ? <ErrorBox error={run.error} /> : null}
        {cancelled ? <Notice>{locale.import.cancelled}</Notice> : null}
        {result ? <ImportSummary result={result} db={db} schema={schema} /> : null}
      </output>
    </form>
  )
}

/** Result banner; the live region is rendered by the parent so it exists before the message arrives. */
function ImportSummary({ result, db, schema }: { result: ImportResult; db: string; schema?: string | undefined }) {
  if (result.format === 'csv') {
    return (
      <Notice>
        {locale.import.csvResult(result.inserted, result.table, result.durationMs)}{' '}
        <Link
          to="/db/$db/table/$table"
          params={{ db, table: result.table }}
          search={schema ? { schema } : {}}
          className="text-blue-700 underline dark:text-blue-300"
        >
          {locale.import.viewRows}
        </Link>
        {result.skippedColumns.length > 0 ? (
          <span className="block text-xs">{locale.import.skippedColumns(result.skippedColumns.join(', '))}</span>
        ) : null}
      </Notice>
    )
  }
  const skipped = result.total - result.statements
  return (
    <div className="space-y-2">
      <Notice>
        {locale.import.sqlResult(result.succeeded, result.failed, result.durationMs)}
        {skipped > 0 ? <span className="block text-xs">{locale.import.skipped(skipped)}</span> : null}
        {result.warnings.map((w) => (
          <span key={w} className="block text-xs text-amber-900 dark:text-amber-200">
            {locale.import.warnings[w]}
          </span>
        ))}
      </Notice>
      {result.errors.length > 0 ? (
        <section className="rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-700 dark:bg-red-950">
          <h3 className="mb-1 font-semibold text-red-800 dark:text-red-200">{locale.import.errors}</h3>
          <ul className="space-y-1">
            {/* The enclosing <output> already announces; per-item alerts would fire twenty times at once. */}
            {result.errors.map((e, i) => (
              <li key={`${i}-${e.sql}`} className="text-red-800 dark:text-red-200">
                <span>
                  {e.line !== undefined && e.index !== undefined ? `${locale.import.errorAt(e.line, e.index)}: ` : ''}
                  {e.message}
                </span>
                <pre tabIndex={0} className="mt-0.5 overflow-x-auto font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  {e.sql}
                </pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
