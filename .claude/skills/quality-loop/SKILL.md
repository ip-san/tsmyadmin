---
name: quality-loop
description: コードレビュー + フルチェック + バンドルサイズ + E2E を一括実行する最終検証ループ。品質ループ、定期チェック、quality loop
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, Skill
argument-hint: "[--skip-review] [--skip-gate] [--dry-run] [--team]"
---

# Quality Loop Skill

コードレビュー → フルチェック → バンドルサイズ → E2E を順に実行し、最終検証ゲートで整合性を保証する統合スキル。
`--team` フラグで最終ゲートをエージェントチームで並列実行し高速化する。

## 引数

`$ARGUMENTS` を空白で分割し、以下のフラグを認識する:

- `--skip-review`: ステップ1（self-review）をスキップ
- `--skip-gate`: ステップ2〜4（最終検証ゲート一式）をスキップ
- `--dry-run`: 各ステップの実行内容のみ報告し、実際には実行しない
- `--team`: ステップ2〜4（最終ゲート）をエージェントチームで並列実行

フラグなしの場合は全ステップを逐次実行する。

---

## 実行モード

### 逐次モード（デフォルト）

```
Step 1: code-review → Step 2: check:all → Step 3: size → Step 4: e2e
```

### チームモード（`--team`）

```
Step 1（逐次）: code-review
    ↓
Step 2〜4（並列）: [check:all] [size] [e2e]
    ↓
結果集約
```

**チームモードの並列実行指示:**

Step 2〜4 では `Agent` ツールを使って `quality-gate` エージェントを **同一メッセージ内で同時に** 起動する（各チェックを個別の `Agent()` 呼び出しにするか、`quality-gate` 1体に3チェックをまとめて依頼するかはタスクの粒度に応じて選ぶ）。全エージェントの完了通知を待ってから結果を集約する。

**モデル明示ルール:** `Agent()` 呼び出しには必ず `model: "sonnet"` を指定する。省略すると親の model を継承し、上位モデルのセッションから起動すると意図せずコストが膨らむ。

---

## Step 1: コードレビュー

**スキップ条件:** `--skip-review` フラグ、または `git diff --name-only` が空（未コミットの変更なし）

1. `/self-review --fix` を実行する（内部で `/code-review` 汎用レビュー + プロジェクト固有チェック13項目を統合実行）
2. 修正後に `bun run typecheck` で型チェックを確認する

---

## Step 2: フルチェック（check:all）

**スキップ条件:** `--skip-gate` フラグ

**前提:** `check:all` は `test:integration` を含むため DB が必要。

```bash
bun run db:up
bun run check:all   # typecheck + lint + test + type-coverage + knip + circular + cpd + check:arch + check:sql-safety + docs:validate + test:integration
```

Step 1 の修正が既存のテスト・アーキテクチャ規約を壊していないかを一括検証する。

---

## Step 3: バンドルサイズ

**スキップ条件:** `--skip-gate` フラグ

```bash
bun run build && bun run size
```

`Initial JS`（`apps/web/dist/assets/index-*.js`）が 300 kB を超過していないか検証。Step 1 のコード修正でバンドルが肥大化していないかの確認。超過時は警告を報告する（自動修正はしない）。

---

## Step 4: E2E テスト

**スキップ条件:** `--skip-gate` フラグ

**前提確認:** `e2e/` にテストファイルが無ければ Playwright を実行せず「スキップ（E2E 未整備）」として報告する。

```bash
ls e2e/*.spec.ts 2>/dev/null && bun run test:e2e
```

1件以上あれば実行し、ユーザーフロー（ログイン → テーブル一覧 → 行編集 → SQL 実行）が壊れていないかを検証する。ユニットテストでは検出できない統合的な問題を捕捉する。

---

## ゲート結果の判定

| チェック | 失敗時の対応 |
|---------|-------------|
| Step 1: self-review | **警告。** `--fix` で自動修正できなかった項目を報告し、手動対応を促す |
| Step 2: check:all | **ブロック。** 結果レポートに NG 理由を項目別に記載し、修正を促す。push してはならない |
| Step 3: size | **警告。** 超過量（kB）を報告。即座のブロックはしないが改善を推奨 |
| Step 4: test:e2e | **ブロック**（テストが存在する場合のみ）。失敗テスト名と理由を報告。`e2e/` が空なら警告なしでスキップ扱い |

---

## 結果レポート

全ステップの結果を以下の形式でまとめて報告する:

```
## Quality Loop 結果

| ステップ | 結果 | 詳細 |
|---------|------|------|
| 1. self-review | 完了/スキップ | Critical N件, Warning N件 修正 |
| 2. check:all | ✅ PASS / ❌ NG | typecheck/lint/test/knip/circular/cpd/arch/sql-safety/docs/integration の内訳 |
| 3. size | ✅ PASS / ⚠️ 超過 | Initial JS: XXX kB（閾値 300 kB） |
| 4. e2e | ✅ PASS / ❌ NG / スキップ(未整備) | 失敗テスト一覧 |

### 実行モード
- 逐次 / チーム（Step 2〜4: Ns、合計: Ns）
```

`--team` 使用時は並列実行時間と、逐次実行との推定比較を記載する。

---

## モデル選択ガイドライン

| 判断の性質 | モデル | 例 |
|-----------|--------|-----|
| 機械的なチェック実行・集計 | Script（モデル不要） | `bun run check:all` の実行と結果パース |
| 複数ファイルにまたがる文脈理解 | Sonnet | コードレビュー、方言パリティ確認、DTO 追随確認 |

`quality-gate` / `code-reviewer-agent` / `test-developer` を `Agent()` から起動する際は、`model: "sonnet"` を明示する。
