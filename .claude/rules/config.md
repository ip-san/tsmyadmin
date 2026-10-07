---
paths:
  - "apps/api/src/config.ts"
  - ".env.example"
  - "docs/deployment.md"
  - "docs/en/deployment.md"
  - "docs/hosting.md"
  - "apps/api/src/platform-conformance.test.ts"
---

# 設定（環境変数・置き場所）のルール

- 環境変数を追加したら `apps/api/src/config.ts`・`.env.example`・`docs/deployment.md` の 3 か所を同時に更新する（表は deployment.md だけに置き、他は参照する）。英訳 `docs/en/deployment.md` も直し、`bun run docs:sync` でハッシュを打ち直す
- 対応する置き場所（リバースプロキシ / クラウド）を `docs/hosting.md` に足したら、`apps/api/src/platform-conformance.test.ts` の `PLATFORMS` にも同じ行を足す（前段がクライアント IP をどう伝えるかは静かに壊れるため、テストで押さえる）
