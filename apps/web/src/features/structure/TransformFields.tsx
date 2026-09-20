import type { TransformKind } from '@tsmyadmin/shared'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import type { TransformParams } from './transform-params.ts'

const t = locale.transform

/** The options of the kind chosen: none for most, a few boxes for a link, a part, a date, a pattern. */
export function TransformFields({
  id,
  kind,
  params,
  onChange,
}: {
  id: string
  kind: TransformKind
  params: TransformParams
  onChange: (patch: Partial<TransformParams>) => void
}) {
  const box = (key: keyof TransformParams, label: string, extra: { hint?: string; className?: string } = {}) => (
    <Field id={`${id}-${key}`} label={label} {...(extra.hint ? { hint: extra.hint } : {})}>
      <Input
        id={`${id}-${key}`}
        value={params[key]}
        onChange={(e) => onChange({ [key]: e.target.value })}
        className={extra.className ?? ''}
      />
    </Field>
  )
  switch (kind) {
    case 'link':
    case 'imagelink':
      return (
        <Field id={`${id}-template`} label={t.template}>
          <Input
            id={`${id}-template`}
            type="url"
            pattern="https?://.+"
            placeholder="https://example.com/items/{value}"
            value={params.template}
            onChange={(e) => onChange({ template: e.target.value })}
            className="w-96 max-w-full font-mono"
          />
        </Field>
      )
    case 'substring':
      return (
        <>
          <Field id={`${id}-start`} label={t.start}>
            <Input
              id={`${id}-start`}
              type="number"
              min={0}
              value={params.start}
              onChange={(e) => onChange({ start: e.target.value })}
              className="w-28"
            />
          </Field>
          <Field id={`${id}-length`} label={t.length}>
            <Input
              id={`${id}-length`}
              type="number"
              min={1}
              value={params.length}
              onChange={(e) => onChange({ length: e.target.value })}
              className="w-28"
            />
          </Field>
        </>
      )
    case 'boolean':
      return (
        <>
          {box('trueText', t.trueText, { className: 'w-32' })}
          {box('falseText', t.falseText, { className: 'w-32' })}
          <p className="w-full text-xs text-ink-sub">{t.boolHint}</p>
        </>
      )
    case 'date':
      return box('format', t.format, { hint: t.formatHint, className: 'w-64 font-mono' })
    case 'affix':
      return (
        <>
          {box('prefix', t.prefix, { className: 'w-40' })}
          {box('suffix', t.suffix, { className: 'w-40' })}
        </>
      )
    case 'pattern':
      return (
        <>
          {box('pattern', t.pattern, { hint: t.patternHint, className: 'w-72 font-mono' })}
          {box('message', t.message, { className: 'w-72' })}
        </>
      )
    default:
      return null
  }
}
