---
paths:
  - "apps/web/**"
---

# Web（apps/web）のルール

## 置き場所

| 場所 | 置くもの |
|------|----------|
| `routes/` | URL・パラメータ・検索クエリの受け渡しだけ。画面の実体は `features/` を呼ぶ薄い受け口（目安 100 行以下）。`routeTree.gen.ts` は生成物なので手で触らない |
| `features/<領域>/` | 1 つの領域の画面・フック・純粋関数。**features 同士は import しない**（共有は `components/` と `lib/`。`check:arch` が fail する） |
| `components/` | 複数の feature で使う UI（`ddl/PreviewDialog`、`cells/`、`ui/` など） |
| `lib/` | UI を持たない共有部品（API クライアント `api.ts`、クエリ定義 `queries.ts`、`preview-flow.ts` など） |
| `config/` | ロケール（`locales/{ja,en}.ts`）など |

使う側が 1 つの feature だけのモジュールは、`lib/` ではなくその feature に置く（共有されるまで共有しない）。

## サーバーとのやりとり

- API は `lib/api.ts` の `hc<AppType>` 経由でだけ呼ぶ。生の `fetch` を書かない（ダウンロードのようにブラウザのナビゲーションで開く GET は、URL ビルダー + `<a href>` が例外）
- サーバーの状態は TanStack Query が唯一の持ち主。クエリ定義は `lib/queries.ts` に `queryOptions` で置く。フォームは初期値としてクエリの値を一度だけ写し、`useEffect` で再同期しない
- 書き込みのあとに全部を取り直したいときは `invalidateDatabaseData(queryClient)`（session 以外を無効化する）を使い、`key[0] !== 'session'` を各所に書き直さない
- DDL・アカウント操作は `usePreviewFlow` + `PreviewDialog` を通す。プレビューなしで実行する UI を作らない

## 画面を足すとき

- UI の文字列は `config/locales/{ja,en}.ts` の両方に定義し、`locale.*` で参照する（`en.ts` は `satisfies Locale` で形が揃う）。Tailwind の色指定には `dark:` を付ける
- `e2e/routes-a11y.spec.ts` は生成されたルート木の全画面を初期状態で検査する（画面を足すと自動で対象になる）。ダイアログ・結果・登録中のような状態つきの画面は `e2e/a11y.spec.ts` に足して `scan(page)` を通す
- コンポーネントは 300 行を超えると `check:arch` が警告する。状態の流れ（ストリーミング実行、逐次検索、パンとズームなど）は custom hook に、計算は純粋関数に出す
