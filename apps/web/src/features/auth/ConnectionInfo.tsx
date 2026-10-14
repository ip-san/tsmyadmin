import type { ServerPreset } from '@tsmyadmin/shared'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { copyText } from '@/lib/clipboard.ts'
import { type ConnectionSnippets, connectionEndpoints, connectionSnippets, type Viewpoint } from './connection-info.ts'

const t = locale.login.connectionInfo

const HINT: Record<Viewpoint, string> = {
  host: t.hostHint,
  sameNetwork: t.sameNetworkHint,
  otherNetwork: t.otherNetworkHint,
}
const ITEMS: readonly { key: keyof ConnectionSnippets; label: string }[] = [
  { key: 'address', label: t.address },
  { key: 'databaseUrl', label: t.databaseUrl },
  { key: 'env', label: t.env },
  { key: 'laravelEnv', label: t.laravelEnv },
]

function viewpointLabel(viewpoint: Viewpoint, project: string | undefined): string {
  if (viewpoint === 'host') return t.host
  if (viewpoint === 'otherNetwork') return t.otherNetwork
  return project ? t.sameNetwork(project) : t.sameNetworkNoProject
}

/**
 * For a container Docker discovery found: what the application under development puts in its configuration to reach
 * the same database — the address from where it runs, a `DATABASE_URL` and `.env` lines — each with a copy button.
 * Folded away: the login is what the screen is for. Nothing for a preset that is not a Docker container.
 */
export function ConnectionInfo({ preset }: { preset: ServerPreset | undefined }) {
  const id = useId()
  const [viewpoint, setViewpoint] = useState<Viewpoint>('host')
  const [copied, setCopied] = useState<{ label: string; ok: boolean } | null>(null)
  const endpoints = preset ? connectionEndpoints(preset) : []
  // A container without a Compose service has no same-network address: fall back to the host's.
  const endpoint = endpoints.find((e) => e.viewpoint === viewpoint) ?? endpoints[0]
  if (!preset || !endpoint) return null
  const snippets = connectionSnippets(preset, endpoint)
  const copy = (label: string, text: string) => {
    copyText(text).then(
      () => setCopied({ label, ok: true }),
      () => setCopied({ label, ok: false })
    )
  }
  return (
    <details className="rounded border border-line bg-surface-sub p-3 text-sm text-ink-sub">
      <summary className="cursor-pointer font-semibold text-ink">{t.title}</summary>
      <div className="mt-2 space-y-3">
        <p className="text-xs">{t.intro}</p>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs font-medium text-ink">{t.viewpoint}</legend>
          {endpoints.map((e) => (
            <label key={e.viewpoint} className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`${id}-viewpoint`}
                checked={endpoint.viewpoint === e.viewpoint}
                onChange={() => setViewpoint(e.viewpoint)}
              />
              {viewpointLabel(e.viewpoint, preset.docker?.project)}
            </label>
          ))}
        </fieldset>
        <p className="text-xs">{HINT[endpoint.viewpoint]}</p>
        <dl className="space-y-2">
          {ITEMS.map(({ key, label }) => (
            <div key={key}>
              <dt className="flex items-center justify-between gap-2 text-xs font-medium text-ink">
                <span>{label}</span>
                <Button size="sm" aria-label={t.copy(label)} onClick={() => copy(label, snippets[key])}>
                  {t.copyLabel}
                </Button>
              </dt>
              <dd className="mt-1">
                {/* Wrapped rather than scrolled: a long URL stays readable without a region to scroll by keyboard. */}
                <pre className="whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 font-mono text-xs text-ink">
                  {snippets[key]}
                </pre>
              </dd>
            </div>
          ))}
        </dl>
        <output aria-live="polite" className="block text-xs text-ink-sub">
          {copied === null ? '' : copied.ok ? `${copied.label}: ${t.copied}` : t.copyFailed}
        </output>
      </div>
    </details>
  )
}
