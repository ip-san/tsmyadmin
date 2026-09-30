/** The connection: the session, the servers offered at login, and the second factors (routes/session.ts, routes/second-factor.ts). */
import { queryOptions } from '@tanstack/react-query'
import type {
  AccountSecondFactors,
  DiscoveryDiagnosis,
  PasskeyChallenge,
  PasskeyRegistration,
  PasskeyResponse,
  SecondFactorProof,
  SecondFactorSetup,
  SecondFactorStatus,
  ServerPreset,
  SessionState,
} from '@tsmyadmin/shared'
import { api, enc, isApiError, unwrap } from '../api.ts'

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<SessionState | null> => {
    try {
      return await unwrap<SessionState>(api.session.$get())
    } catch (err) {
      if (isApiError(err, 'UNAUTHENTICATED')) return null
      throw err
    }
  },
  staleTime: 60_000,
})

export const serversQuery = queryOptions({
  queryKey: ['servers'],
  queryFn: () => unwrap<ServerPreset[]>(api.servers.$get()),
  // Containers started while the page is open (Docker discovery) show up when the login screen is opened again.
  staleTime: 10_000,
})

/** Why a database container is missing from the login list or cannot be reached (Docker discovery, development). */
export const discoveryDiagnosisQuery = queryOptions({
  queryKey: ['servers', 'diagnosis'],
  queryFn: () => unwrap<DiscoveryDiagnosis>(api.servers.diagnosis.$get()),
  // Someone stuck fixes a compose file and comes back: re-read while the screen is open.
  // Only where discovery is on: with it off there is nothing that could change.
  refetchInterval: (query) => (query.state.data?.enabled ? 5000 : false),
  staleTime: 0,
})

export const secondFactorQuery = queryOptions({
  queryKey: ['second-factor'],
  queryFn: () => unwrap<SecondFactorStatus>(api['second-factor'].$get()),
})

/** Other accounts' second factors this one may reset (empty for an account without that authority). */
export const accountSecondFactorsQuery = queryOptions({
  queryKey: ['second-factor', 'accounts'],
  queryFn: () => unwrap<AccountSecondFactors>(api['second-factor'].accounts.$get()),
})

export const sessionMutations = {
  login: (body: Parameters<typeof api.session.$post>[0]['json']) =>
    unwrap<SessionState>(api.session.$post({ json: body })),
  logout: () => unwrap<{ ok: boolean }>(api.session.$delete()),
  beginSecondFactor: (proof?: SecondFactorProof) =>
    unwrap<SecondFactorSetup>(api['second-factor'].begin.$post({ json: proof ?? {} })),
  confirmSecondFactor: (code: string) =>
    unwrap<SecondFactorStatus>(api['second-factor'].confirm.$post({ json: { code } })),
  disableSecondFactor: (proof: SecondFactorProof) =>
    unwrap<SecondFactorStatus>(api['second-factor'].$delete({ json: proof })),
  removeTotp: (proof: SecondFactorProof) =>
    unwrap<SecondFactorStatus>(api['second-factor'].totp.$delete({ json: proof })),
  passkeyChallenge: () => unwrap<PasskeyChallenge>(api['second-factor'].passkeys.challenge.$post()),
  beginPasskey: (proof?: SecondFactorProof) =>
    unwrap<PasskeyRegistration>(api['second-factor'].passkeys.begin.$post({ json: proof ?? {} })),
  confirmPasskey: (response: PasskeyResponse) =>
    unwrap<SecondFactorStatus>(api['second-factor'].passkeys.confirm.$post({ json: { response } })),
  removePasskey: (id: string, proof: SecondFactorProof) =>
    unwrap<SecondFactorStatus>(api['second-factor'].passkeys[':id'].$delete({ param: { id: enc(id) }, json: proof })),
  resetSecondFactor: (user: string) =>
    unwrap<AccountSecondFactors>(api['second-factor'].accounts.reset.$post({ json: { user } })),
}
