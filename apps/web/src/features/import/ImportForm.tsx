import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { newQueryId } from '@/lib/uuid.ts'
import { ImportSummary } from './ImportSummary.tsx'

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
  const summary = useRef<HTMLElement>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const cancel = useMutation({ mutationFn: (id: string) => mutations.cancelSql(db, id) })

  const run = useMutation({
    onMutate: () => {
      abort.current = new AbortController()
      queryId.current = newQueryId()
      setProgress(null)
      cancel.reset()
    },
    mutationFn: (f: File) => {
      return runImport(
        db,
        {
          file: f,
          format,
          schema,
          ...(queryId.current ? { queryId: queryId.current } : {}),
          ...(format === 'csv'
            ? { table: target, header: header ? ('1' as const) : ('0' as const), nullMarker, delimiter }
            : {
                stopOnError: stopOnError ? ('1' as const) : ('0' as const),
                ignoreForeignKeys: ignoreForeignKeys ? ('1' as const) : ('0' as const),
                singleTransaction: singleTransaction ? ('1' as const) : ('0' as const),
              }),
        },
        (done, total) => setProgress({ done, total }),
        abort.current?.signal
      )
    },
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
    },
  })

  // A cancel that found nothing running (the file was still being decoded) leaves the button usable.
  const cancelSent = cancel.isPending || (cancel.isSuccess && cancel.data.cancelled)
  const cancelled = cancel.isSuccess && cancel.data.cancelled && !run.isPending
  // Focus lands on the result once it is on screen (the submit / cancel buttons may have gone or changed).
  const outcome = result !== null || run.isError || cancelled
  useEffect(() => {
    if (outcome) summary.current?.focus()
  }, [outcome])

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
    if (run.isPending) return
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
        {/* Kept focusable while busy: a control that disables itself under the keyboard drops focus to the page. */}
        <Button type="submit" variant="primary" disabled={blocked} aria-disabled={blocked || run.isPending}>
          <Upload className="size-4" aria-hidden />
          {run.isPending ? locale.import.running : locale.import.submit}
        </Button>
        {/* CSV runs as one INSERT transaction the server cannot interrupt by id: no cancel for it. */}
        {run.isPending && format === 'sql' ? (
          <Button
            onClick={() => !cancelSent && queryId.current && cancel.mutate(queryId.current)}
            aria-disabled={cancelSent}
          >
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
      {run.isPending && cancel.isError ? <ErrorBox error={cancel.error} /> : null}
      {/* One channel only: the region takes focus once its content is rendered (a live region on top would read
          the same text again). The server's own CANCELLED warning speaks for a cancelled run that returned a
          result; the client-side notice covers a cancel whose run ended without one. */}
      <section
        ref={summary}
        tabIndex={-1}
        aria-label={locale.import.resultRegion}
        className={cn('outline-none', result || cancelled || run.isError ? 'block' : 'hidden')}
      >
        {run.isError ? <ErrorBox error={run.error} live={false} /> : null}
        {cancelled && !result ? <Notice>{locale.import.cancelled}</Notice> : null}
        {result ? <ImportSummary result={result} db={db} schema={schema} /> : null}
      </section>
    </form>
  )
}
