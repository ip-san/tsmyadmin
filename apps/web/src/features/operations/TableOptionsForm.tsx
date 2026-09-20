import { useQueryClient } from '@tanstack/react-query'
import type { Dialect, TableSchema } from '@tsmyadmin/shared'
import { type FormEvent, useRef, useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Field, Input, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { structureQuery, type TableRef } from '@/lib/queries.ts'

const IDENT = /^[A-Za-z0-9_]+$/
const ROW_FORMATS = ['DEFAULT', 'DYNAMIC', 'COMPACT', 'COMPRESSED', 'REDUNDANT', 'FIXED'] as const
type RowFormat = (typeof ROW_FORMATS)[number]

/** Options that are on, off or the server's default (`''` = leave as it is). */
type Triple = '' | 'DEFAULT' | '0' | '1'
/** Options that are on or off. */
type Toggle = '' | 'on' | 'off'
const TRIPLES = ['packKeys', 'statsPersistent', 'statsAutoRecalc'] as const
const TOGGLES = ['delayKeyWrite', 'transactional', 'pageChecksum'] as const

/** Table comment (both dialects) and MySQL's engine / collation / AUTO_INCREMENT, through the preview flow. */
export function TableOptionsForm({
  tableRef,
  dialect,
  schema,
}: {
  tableRef: TableRef
  dialect: Dialect
  schema: TableSchema
}) {
  const mysql = dialect === 'mysql'
  const [comment, setComment] = useState(schema.comment ?? '')
  const [engine, setEngine] = useState(schema.engine ?? '')
  const [collation, setCollation] = useState(schema.collation ?? '')
  const [autoIncrement, setAutoIncrement] = useState(schema.autoIncrement ?? '')
  // Not part of TableSchema: empty means "leave as it is".
  const [rowFormat, setRowFormat] = useState<RowFormat | ''>('')
  const [checksum, setChecksum] = useState<'' | 'on' | 'off'>('')
  const [triples, setTriples] = useState<Record<(typeof TRIPLES)[number], Triple>>({
    packKeys: '',
    statsPersistent: '',
    statsAutoRecalc: '',
  })
  const [toggles, setToggles] = useState<Record<(typeof TOGGLES)[number], Toggle>>({
    delayKeyWrite: '',
    transactional: '',
    pageChecksum: '',
  })
  const reseed = (from: TableSchema) => {
    setRowFormat('')
    setChecksum('')
    setTriples({ packKeys: '', statsPersistent: '', statsAutoRecalc: '' })
    setToggles({ delayKeyWrite: '', transactional: '', pageChecksum: '' })
    setComment(from.comment ?? '')
    setEngine(from.engine ?? '')
    setCollation(from.collation ?? '')
    setAutoIncrement(from.autoIncrement ?? '')
  }
  // Re-seed from the refetched schema in place (state-from-props reset): remounting would discard the success
  // notice and its focus.
  const seed = [schema.comment, schema.engine, schema.collation, schema.autoIncrement].join('\0')
  const [prevSeed, setPrevSeed] = useState(seed)
  if (prevSeed !== seed) {
    setPrevSeed(seed)
    reseed(schema)
  }
  // After a run the fields go back to what the server reports, so a value it ignored (AUTO_INCREMENT below the
  // current one) does not linger as a pending change: the structure is refetched first and read from the cache
  // (the flow invalidates everything else afterwards; `prevSeed` re-seeds on any later change too).
  const queryClient = useQueryClient()
  // The dialog closes before the refetch lands: a field changed in that gap is the person's next edit, not a leftover.
  const editedSinceRun = useRef(false)
  const flow = useDdlFlow(tableRef.db, tableRef.schema, async () => {
    const query = structureQuery(tableRef)
    await queryClient.invalidateQueries({ queryKey: query.queryKey })
    if (!editedSinceRun.current) reseed(queryClient.getQueryData(query.queryKey) ?? schema)
  })
  const commentChanged = comment !== (schema.comment ?? '')
  const engineChanged = mysql && engine.trim() !== '' && engine.trim() !== (schema.engine ?? '')
  const collationChanged = mysql && collation.trim() !== '' && collation.trim() !== (schema.collation ?? '')
  const autoIncrementChanged =
    mysql && autoIncrement.trim() !== '' && autoIncrement.trim() !== (schema.autoIncrement ?? '')
  const invalid =
    (engineChanged && !IDENT.test(engine.trim())) ||
    (collationChanged && !IDENT.test(collation.trim())) ||
    (autoIncrementChanged && !/^\d{1,20}$/.test(autoIncrement.trim()))
  const changed =
    commentChanged ||
    engineChanged ||
    collationChanged ||
    autoIncrementChanged ||
    rowFormat !== '' ||
    checksum !== '' ||
    (mysql && (TRIPLES.some((k) => triples[k] !== '') || TOGGLES.some((k) => toggles[k] !== '')))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!changed || invalid) return
    editedSinceRun.current = false
    flow.preview({
      op: 'setTableOptions',
      table: tableRef.table,
      ...(commentChanged ? { comment: comment === '' ? null : comment } : {}),
      ...(engineChanged ? { engine: engine.trim() } : {}),
      ...(collationChanged ? { collation: collation.trim() } : {}),
      ...(autoIncrementChanged ? { autoIncrement: autoIncrement.trim() } : {}),
      ...(mysql && rowFormat ? { rowFormat } : {}),
      ...(mysql && checksum ? { checksum: checksum === 'on' } : {}),
      ...(mysql
        ? Object.fromEntries([
            ...TRIPLES.flatMap((k) => (triples[k] ? [[k, triples[k]]] : [])),
            ...TOGGLES.flatMap((k) => (toggles[k] ? [[k, toggles[k] === 'on']] : [])),
          ])
        : {}),
    })
  }
  return (
    <section className="rounded border border-line p-3">
      <form
        onSubmit={submit}
        onChange={() => {
          editedSinceRun.current = true
        }}
        className="space-y-2"
        aria-label={locale.ddl.titles.setTableOptions}
      >
        <h2 className="text-sm font-semibold text-ink">{locale.ddl.titles.setTableOptions}</h2>
        <div className="grid max-w-2xl gap-2 sm:grid-cols-2">
          <Field id="table-comment" label={locale.database.comment}>
            <Input id="table-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          {mysql ? (
            <>
              <Field id="table-engine" label={locale.database.engine} hint={locale.ddl.engineHint}>
                <Input id="table-engine" value={engine} onChange={(e) => setEngine(e.target.value)} />
              </Field>
              <Field id="table-collation" label={locale.table.collation} hint={locale.ddl.collationHint}>
                <Input
                  id="table-collation"
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  placeholder={locale.ddl.unchanged}
                />
              </Field>
              <Field id="table-auto-increment" label={locale.ddl.autoIncrementNext} hint={locale.ddl.autoIncrementHint}>
                <Input
                  id="table-auto-increment"
                  inputMode="numeric"
                  value={autoIncrement}
                  onChange={(e) => setAutoIncrement(e.target.value)}
                  placeholder={locale.ddl.unchanged}
                />
              </Field>
              <Field id="table-row-format" label={locale.table.stats.rowFormat}>
                <Select
                  id="table-row-format"
                  value={rowFormat}
                  onChange={(e) => setRowFormat(e.target.value as RowFormat | '')}
                >
                  <option value="">{locale.ddl.unchanged}</option>
                  {ROW_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="table-checksum" label={locale.ddl.checksumOption} hint={locale.ddl.checksumOptionHint}>
                <Select
                  id="table-checksum"
                  value={checksum}
                  onChange={(e) => setChecksum(e.target.value as '' | 'on' | 'off')}
                >
                  <option value="">{locale.ddl.unchanged}</option>
                  <option value="on">{locale.common.yes}</option>
                  <option value="off">{locale.common.no}</option>
                </Select>
              </Field>
              {TRIPLES.map((k) => (
                <Field key={k} id={`table-${k}`} label={locale.ddl.tableOptions[k]}>
                  <Select
                    id={`table-${k}`}
                    value={triples[k]}
                    onChange={(e) => setTriples((prev) => ({ ...prev, [k]: e.target.value as Triple }))}
                  >
                    <option value="">{locale.ddl.unchanged}</option>
                    <option value="DEFAULT">{locale.ddl.tableOptions.defaultValue}</option>
                    <option value="1">{locale.common.yes}</option>
                    <option value="0">{locale.common.no}</option>
                  </Select>
                </Field>
              ))}
              {TOGGLES.map((k) => (
                <Field
                  key={k}
                  id={`table-${k}`}
                  label={locale.ddl.tableOptions[k]}
                  {...(k === 'transactional' || k === 'pageChecksum' ? { hint: locale.ddl.tableOptions.ariaHint } : {})}
                >
                  <Select
                    id={`table-${k}`}
                    value={toggles[k]}
                    onChange={(e) => setToggles((prev) => ({ ...prev, [k]: e.target.value as Toggle }))}
                  >
                    <option value="">{locale.ddl.unchanged}</option>
                    <option value="on">{locale.common.yes}</option>
                    <option value="off">{locale.common.no}</option>
                  </Select>
                </Field>
              ))}
            </>
          ) : null}
        </div>
        <Button type="submit" variant="primary" disabled={!changed || invalid}>
          {locale.ddl.submit}
        </Button>
      </form>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
