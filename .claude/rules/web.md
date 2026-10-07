---
paths:
  - "apps/web/**"
---

# Web（apps/web）のルール

## 置き場所

| 場所 | 置くもの |
|------|----------|
| `routes/` | URL・パラメータ・検索クエリの受け渡しだけ。画面の実体は `features/` を呼ぶ薄い受け口（目安 100 行以下）。別々の feature の部品を 1 つの画面に並べるのもここ（`children` などで渡す。例: `routes/_app/index.tsx`）。`routeTree.gen.ts` は生成物なので手で触らない |
| `features/<領域>/` | 1 つの領域の画面・フック・純粋関数。**features 同士は import しない**（共有は `components/` と `lib/`。`check:arch` が fail する） |
| `components/` | 複数の feature で使う UI（`ddl/PreviewDialog`、`cells/`、`ui/` など） |
| `lib/` | UI を持たない共有部品（API クライアント `api.ts`、クエリ定義 `queries/`、`preview-flow.ts` など） |
| `config/` | ロケール（`locales/{ja,en}.ts`）など |

使う側が 1 つの feature だけのモジュールは、`lib/` ではなくその feature に置く（共有されるまで共有しない）。

## サーバーとのやりとり

- API は `lib/api.ts` の `hc<AppType>` 経由でだけ呼ぶ。生の `fetch` を書かない（ダウンロードのようにブラウザのナビゲーションで開く GET は、URL ビルダー + `<a href>` が例外）
- サーバーの状態は TanStack Query が唯一の持ち主。クエリ定義は `lib/queries/` に `queryOptions` で置く（API のルートと同じ単位で `session` / `stored` / `databases` / `tables` / `server`。読み込み口は `lib/queries.ts`）。フォームは初期値としてクエリの値を一度だけ写し、`useEffect` で再同期しない
- セッション（誰がどこに接続しているか）の読み方は 2 つある。`/_app` の中の画面は `useRouteContext({ from: '/_app' }).session`（ルートに入った時点の値で、必ずある）。ルーターなしで描画される部品や、登録の完了のように途中で変わる値が要るときは `useQuery(sessionQuery)`（ライブのキャッシュ。取得前は `undefined`）。方言だけなら `useDialect()`（`lib/session.ts`。取得前は MySQL）
- 書き込みのあとに全部を取り直したいときは `invalidateDatabaseData(queryClient)`（session 以外を無効化する）を使い、`key[0] !== 'session'` を各所に書き直さない
- DDL・アカウント操作は `usePreviewFlow` + `PreviewDialog` を通す。プレビューなしで実行する UI を作らない

## 画面を足すとき

- UI の文字列は `config/locales/{ja,en}.ts` の両方に定義し、`locale.*` で参照する（`en.ts` は `satisfies Locale` で形が揃う）。Tailwind の色指定には `dark:` を付ける
- **その DB にある入力欄を出すかは、画面ごとに固有なので `dialect === '…'` でよいが、複数の画面が同じ事実を書くなら、`packages/shared/src/capabilities.ts` の能力（`accountHost`・`events`・`databasesAreSchemas` など）を読むか、共通の部品にする**（例: 移動先を選ぶ `lib/spaces.ts` の `useSpaces`、クォートの `quoteIdentifier` / `quoteLiteral`）。同じ式の写しを画面ごとに持たない。`bun run check:dialect-leaks` が、数が増えると fail する
- **アクセシビリティの検査は 3 層**: ① Biome の a11y ルールは全部 error で、警告 0 を維持する（`bun run lint` は警告でも落ちる）。② `check:contrast` は、デザイン トークンの色の比を見る。③ E2E の axe とレイアウト検査:
  - `e2e/routes-a11y.spec.ts` は、生成されたルート木の**全画面**を初期状態で検査する（画面を足すと自動で対象になる）
  - ダイアログ・結果・登録中のような**状態つきの画面**は `e2e/a11y.spec.ts` に足して `scan(page)` を通す。`a11y.spec.ts` は axe に加え、`e2e/layout-lint.ts` で、矢印の重なり・入力欄と（ラベルのない）チェックボックス・ボタンの高さのずれ・コントロールの重なり・横スクロール・アプリシェルでページが縦に伸びていないか・文字のはみ出し・id の重複・`undefined` の混入を、DOM の幾何で検査する
- 画面を足したら、`bun run test:e2e:coverage` で、その画面のファイルが E2E で実行されているかを見る（`scripts/e2e-coverage.mjs` が、領域ごとの割合と、一度も実行されないファイルを出す。spec の `page` と、`browser.newContext` で作った文脈のページも数える。仕掛けは `e2e/web-coverage.ts` で、ページが自分で再読み込みしても記録が落ちないよう、0.3 秒ごとに記録を取り出す。数字は、実行された文字数の割合（行や分岐ではない）で目安）
- コンポーネントは 300 行を超えると `check:arch` が警告する。状態の流れ（ストリーミング実行、逐次検索、パンとズームなど）は custom hook に、計算は純粋関数に出す
