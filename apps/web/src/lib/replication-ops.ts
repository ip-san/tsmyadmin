import type { DdlPreviewResponse, ReplicationOp, UserOpResponse } from '@tsmyadmin/shared'
import { api, unwrap } from './api.ts'
import { type PreviewFlow, usePreviewFlow } from './preview-flow.ts'

export type ReplicationOpFlow = PreviewFlow<ReplicationOp>

/** Replica controls: masked preview from /server/replication/preview, execution by /server/replication/execute. */
export function useReplicationOpFlow(): ReplicationOpFlow {
  return usePreviewFlow<ReplicationOp>({
    preview: (op) => unwrap<DdlPreviewResponse>(api.server.replication.preview.$post({ json: { op } })),
    execute: (op) => unwrap<UserOpResponse>(api.server.replication.execute.$post({ json: { op } })),
    invalidate: (key) => key[0] === 'server',
  })
}
