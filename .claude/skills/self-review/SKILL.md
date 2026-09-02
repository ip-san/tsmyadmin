---
name: self-review
description: 汎用コードレビュー + プロジェクト固有チェックの統合レビュー。セルフレビュー、レビュー、チェック
allowed-tools: Bash, Grep, Glob, Read, Skill, Agent
argument-hint: "[--fix] [--skip-code-review] [--team]"
context: fork
---

# Self-Review Skill

`/code-review`（汎用）を内部で呼び出した後、tsmyadmin 固有のミスパターンチェックを実行する統合レビュースキル。

## 引数

- なし: 汎用レビュー + プロジェクトチェック（報告のみ）
- `--fix`: 検出した問題を自動修正する
- `--skip-code-review`: 汎用レビューをスキップし、プロジェクトチェックのみ実行
- `--team`: チームモード。Step 0 と Step 1 を並列実行し、Step 1 内の独立チェック項目もエージェントで並列化

## 構成

### 逐次モード（デフォルト）
```
/self-review
├── Step 0: /code-review を実行（汎用: コード品質, React/TS, a11y, perf）
└── Step 1: プロジェクト固有チェック（13項目を順次実行）
```

### チームモード（`--team`）
```
/self-review --team
├── 並列 Phase A:
│   ├── Agent: /code-review（汎用レビュー）
│   └── 並列 Phase B（プロジェクト固有チェック）:
│       ├── Agent: sql-adapter-checks → check:sql-safety + check:arch + 方言パリティ + Adapter契約
│       ├── Agent: dto-web-checks     → 共有DTO追随 + ダークモード + ハードコード日本語
│       └── Agent: meta-checks        → テスト命名 + hooks旧参照 + テスト内ハードコード + circular
└── 結果集約 → --fix なら修正実行
```

Phase A の `/code-review` と Phase B の3エージェントは全て `run_in_background: true` で同時起動する。
全エージェント完了後に結果を集約し、`--fix` 指定時は検出された問題を修正する。

**棲み分け:**
- `/code-review`（`~/.claude/skills/`）: 汎用。全プロジェクト共通。カスタムしない
- `/self-review`（`.claude/skills/`）: プロジェクト固有。過去のミスから学んだ教訓

## Step 0: 汎用コードレビュー

**スキップ条件:** `--skip-code-review` フラグ

`/code-review` スキルを実行する。未コミット変更がある場合のみ実行し、変更がなければスキップする。

## Step 1: プロジェクト固有チェック

### 1. SQL 文字列補間

```bash
bun run check:sql-safety
```

**判定:** これが正のソース。`scripts/check-sql-safety.mjs` は `SQL_BUILDER_ALLOWLIST`（`base.ts` / `sql/*` / `*/ddl.ts` / `*/adapter.ts`）以外での SQL キーワードを含むテンプレート補間・文字列連結を検出する。以下は変更差分だけを素早く見る補助 grep（本チェックの代わりにはしない）:

```bash
git diff --name-only HEAD | grep -E '\.tsx?$' | xargs grep -ln 'SELECT\|INSERT\|UPDATE\|DELETE' 2>/dev/null
```

### 2. ドライバ import 隔離

```bash
bun run check:arch
```

**判定:** `mysql2` / `pg` の import が `packages/adapter/src/**` の外にないか。`apps/web` は DB ドライバに一切触れてはならない。

### 3. 方言パリティ

`packages/adapter/src/mysql/{adapter,ddl,introspect,values}.ts` の変更が `postgres/` の同名ファイルに反映されているか。

```bash
changed=$(git diff --name-only HEAD)
echo "$changed" | grep 'packages/adapter/src/mysql/' | sed 's|/mysql/|/postgres/|' | while read -r f; do
  echo "$changed" | grep -qx "$f" || echo "方言パリティ未確認: postgres 側が未変更 → $f"
done
echo "$changed" | grep 'packages/adapter/src/postgres/' | sed 's|/postgres/|/mysql/|' | while read -r f; do
  echo "$changed" | grep -qx "$f" || echo "方言パリティ未確認: mysql 側が未変更 → $f"
done
```

**判定:** 出力があれば「意図的な片方言のみの変更か」を確認する（例: 方言固有バグ修正）。意図的でなければ NG。

### 4. Adapter 契約の増分チェック

`DatabaseAdapter` にメソッドを追加したら `ADAPTER_METHOD_NAMES`（`packages/adapter/src/types.ts`）と `test/conformance.ts` の `describe('<method>')` が揃っているか。

```bash
grep -A 20 'ADAPTER_METHOD_NAMES' packages/adapter/src/types.ts
grep "describe('" packages/adapter/src/test/conformance.ts
```

### 5. DdlOp スナップショット

```bash
grep -A 10 'SAMPLE_OPS' packages/adapter/src/test/ddl.test.ts | head -20
```

**判定:** `SAMPLE_OPS` の型が `Record<DdlOp['op'], DdlOp>` なので追加漏れはコンパイルエラーになるはずだが、`bun run typecheck` で確認する。

### 6. 共有 DTO の追随

```bash
git diff --name-only HEAD | grep '^packages/shared/src/'
```

**判定:** 1件以上あれば、対応する `apps/api/src/routes/**` のバリデータと `apps/web` 側の呼び出し（`hc<AppType>` 経由）が同じ diff に含まれているか確認する。web が生の `fetch()` で新エンドポイントを叩いていたら NG。

### 7. ハードコード日本語

```bash
grep -rn '[ぁ-んァ-ヶ一-龠]' apps/web/src --include='*.tsx' 2>/dev/null | grep -v 'locales/ja' | grep -v '\.test\.'
```

**判定:** `apps/web/src/config/locales/ja.ts` を経由しない直書き日本語。検出されたら NG（`ja.ts` に追加して `locale.*` で参照する）。

### 8. Tailwind ダークモード漏れ

```bash
grep -rn 'bg-\(red\|blue\|gray\|slate\|stone\)-[0-9]\{3\}\|text-\(red\|blue\|gray\|slate\|stone\)-[0-9]\{3\}' apps/web/src --include='*.tsx' 2>/dev/null | grep -v 'dark:'
```

**判定:** CLAUDE.md の規約（Tailwind 色指定には `dark:` 対応必須）に反する箇所。コンポーネントが少ない現段階では検出0件でもよい。

### 9. テスト内のハードコード数値

```bash
grep -rn 'toBe([0-9]\{3,\})' apps packages --include='*.test.*' 2>/dev/null | grep -v node_modules | grep -v 'status).toBe('
```

**判定:** ルート数・カラム数など変動しうる値がハードコードされていたら、`scripts/validate-docs.mjs` の統計マーカーのように動的取得へ寄せるべきか検討する。

### 10. hooks/設定ファイル内の旧コマンド参照

```bash
grep -n 'npm test\|npm run\|yarn ' .claude/settings.json .claude/settings.local.json 2>/dev/null
```

**判定:** このプロジェクトは bun 統一。`npm`/`yarn` が残っていたら `bun run` に修正すべき。

### 11. 統合テストの命名規則

```bash
git diff --name-only HEAD | grep -E '\.test\.tsx?$' | grep -v '\.integration\.test\.' | xargs grep -l "mysql2\|from 'pg'" 2>/dev/null
```

**判定:** DB に直接依存するテストが `*.integration.test.ts` 以外の名前で追加されていないか。命名を誤ると `bun run test`（DB不要）や pre-commit で誤って実行され失敗する。

### 12. 型安全性

```bash
grep -rn ': any\|as any' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -v '\.test\.'
```

### 13. 循環依存

```bash
bun run circular
```

## 出力フォーマット

```
## Self-Review 結果

### Step 0: 汎用コードレビュー
（/code-review の出力）

### Step 1: プロジェクト固有チェック
| # | チェック項目 | 結果 | 詳細 |
|---|------------|------|------|
| 1 | SQL 文字列補間 | OK / NG (N件) | ファイル:行 |
| 2 | ドライバ import 隔離 | OK / NG (N件) | ファイル:行 |
| 3 | 方言パリティ | OK / 要確認 (N件) | mysql/postgres 未整合ファイル |
| 4 | Adapter 契約 | OK / NG | 未追加のメソッド名 |
| 5 | DdlOp スナップショット | OK / 要確認 | |
| 6 | 共有 DTO 追随 | OK / NG | 未追随の routes/callers |
| 7 | ハードコード日本語 | OK / NG (N件) | locale 未使用の直書き |
| 8 | ダークモード | OK / NG (N件) | dark: 欠落箇所 |
| 9 | テスト内ハードコード | OK / NG (N件) | 動的取得すべき数値 |
| 10 | hooks 旧コマンド参照 | OK / NG | npm/yarn→bun |
| 11 | 統合テスト命名 | OK / NG | DB依存だが命名違反のファイル |
| 12 | 型安全性（any） | OK / NG (N件) | ファイル:行 |
| 13 | 循環依存 | OK / NG | サイクル一覧 |
```

`--fix` 指定時は NG 項目を自動修正し、修正内容を報告する。修正後は `bun run check` で回帰がないか確認する。
