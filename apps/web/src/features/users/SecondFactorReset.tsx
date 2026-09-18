import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { accountSecondFactorsQuery, mutations, sessionQuery } from '@/lib/queries.ts'

const t = locale.users.secondFactor

/**
 * The login names whose second factor this account may reset. Asked only where a second factor can exist at
 * all; a failure leaves the list empty rather than taking the users page down with it.
 */
export function useResettableAccounts(): ReadonlySet<string> {
  const supported = useQuery(sessionQuery).data?.secondFactor !== 'unsupported'
  const accounts = useQuery({ ...accountSecondFactorsQuery, enabled: supported })
  return new Set(accounts.data?.accounts ?? [])
}

/** Confirms resetting another account's second factor, for someone who lost the device and the recovery codes. */
export function SecondFactorResetDialog({ user, onClose }: { user: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const reset = useMutation({
    mutationFn: mutations.resetSecondFactor,
    onSuccess: (next) => {
      queryClient.setQueryData(accountSecondFactorsQuery.queryKey, next)
      onClose()
    },
  })
  const close = () => {
    reset.reset()
    onClose()
  }
  return (
    <Dialog
      open={user !== null}
      title={user ? `${t.resetTitle}: ${user}` : ''}
      onClose={close}
      busy={reset.isPending}
      footer={
        <>
          <Button onClick={close} disabled={reset.isPending}>
            {locale.common.cancel}
          </Button>
          <Button variant="danger" onClick={() => user && reset.mutate(user)} disabled={reset.isPending}>
            {t.resetExecute}
          </Button>
        </>
      }
    >
      <p>{user ? t.resetConfirm(user) : ''}</p>
      {reset.isError ? <ErrorBox error={reset.error} className="mt-2" /> : null}
    </Dialog>
  )
}
