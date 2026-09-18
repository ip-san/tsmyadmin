# code-reviewer-agent メモリ

## web: ミューテーションのエラーフィードバック欠落パターン

- 場所: `apps/web/src/features/sql/use-saved-queries.ts`（`saveMutation`/`removeMutation`）。`onSuccess` はあるが `onError` がなく、フック自体が `error`/`isPending` を呼び出し側に返していない。`SqlPanels.tsx` の `SavedQueriesPanel` はエラー表示を一切持たない。
- この codebase の規約: `RowDialogs.tsx`（`error={update.error}` を `RowForm` に渡す）、`RowsGrid.tsx:289`（`error={remove.error}` を確認ダイアログへ）のように、`useMutation` のエラー状態を必ず呼び出し側 UI に渡して `ErrorBox` 等で表示している。この規約からの逸脱は Warning 相当。
- 注意: `main.tsx` の `MutationCache.onError` はグローバルに 401 を捕まえて `/login` へリダイレクトするので、「サイレントに失敗する」のは 401 以外（ネットワークエラー、500、`UNSUPPORTED` 400 など）に限られる。指摘時はこの限定を明記すること。

## web: セッション/クエリキャッシュのアカウント分離は検証済み・誤検出注意

- `queryClient.clear()` は `login.tsx`（ログイン成功時）と `_app.tsx`（ログアウト時）の両方にある。セッション期限切れ（`main.tsx` の `onUnauthorized`）は `clear()` を呼ばず `session` クエリだけ `null` にするが、次のログイン成功時に必ず `clear()` されるため実害のある漏洩経路にはならない（Critical/Warning にしない）。
- `useSavedQueries(scope, onServer)` の `scope`（`dialect.host.port`）は `SqlConsole` が使われている限り、サーバー切り替え = 必ず `/login` を経由 = `_app` レイアウトの完全アンマウントを伴うため、マウントしたまま `scope` だけ変わって古いブックマークが残る、という不具合は現状の画面構成では再現しない（`routes/_app.tsx` の `beforeLoad` が `session` を route context に積む設計）。将来「サーバーをその場で切り替える UI」ができたら要再検証。
- 例外的に残る経路: **別タブでログアウト→別アカウントでログイン**すると、Cookie を共有する既存タブは何もしていなくても次のリクエストから新アカウントのデータ（保存済みクエリに限らずデータベース一覧なども含む）を受け取る。これは Cookie ベースセッション全体に共通する性質でありこの PR 固有の欠陥ではないので Info 止まりでよい。

## 誤検出にしないでよいパターン（本 diff で確認）

- ローカル保存モードでの `id: ''` は意図的（`SavedQuerySchema` の `id` はサーバー採番、ブラウザ側は空文字）。`key={q.id || q.name}` はこれを前提にしており問題なし。
- サーバー側 `SavedQueryStore.save()` は名前で dedupe（`existing = list().find(name)` → update/insert 分岐）するため、`entries.find(name)` が二重登録で迷子になることはない。
- ローカルストレージのスコープキー（`dialect.host.port`、ユーザー名を含まない）は本 diff より前からの既存設計。同一ブラウザで同じホストに複数アカウントでログインした場合の越境閲覧はこの機能追加が動機になっている既知の制約であり、この diff のレビューでは対象外（言及するとしても Info 止め、あるいは省略）。

## adapter: buildQuery/conditionSql の literal 経路と keyParam の前提ズレ（BIT）

- `packages/adapter/src/base.ts` の `conditionSql`/`keyParam` は元々「`Params.add()` が返すプレースホルダに、ドライバへ渡す実バイト値（`toDbValue` 済み）がバインドされる」ことを前提にした CAST（BIT は `CONV(HEX(placeholder),16,10)`）。`buildQuery`（クエリビルダー）はこれを「引用符付きリテラル文字列」経路（`literal = mysqlLiteral(String(v))` 等、base.ts:659）に転用しているが、BIT だけは前提が崩れる: `QueryBuilderConditionSchema.value`（packages/shared/src/schemas/query-builder.ts:28-36）が `z.string()` のみで `$bin`（BinaryCell）を運べないため、ユーザーが "128" のような10進文字列を入れると `HEX('128')` は文字列 "128" の ASCII バイトの16進になり、意図した BIT 値と一致しない SQL になる（実機確認済み: `types_all.bit_col`（実値 170 = X'AA'）に対し `eq '170'` で 0 件になる）。DECIMAL/FLOAT/INT/BIGINT/JSON はこの経路でも文字列→CAST が素直に効くので問題なし。BIT だけが特殊。
- `test/conformance.ts` の `describe('buildQuery')` は JSON の cast は検証しているが BIT のケースがない（見た目は「型ごとのキャストを検証しています」で網羅感があるので要注意、次回レビューでも同じ抜けが再発しやすい）。
- 教訓: `keyParam` を新しい呼び出し経路（値がリテラル文字列になる経路）に転用するときは、各方言の cast 分岐を「プレースホルダ＝バインドパラメータ」前提と「プレースホルダ＝クォート済みリテラル」前提の両方で個別に検証すること。バイナリ系（BIT/BLOB/bytea）は特に危険。

## adapter: joinPlan は同じテーブル間に複数 FK があると先勝ちで無言選択

- `packages/adapter/src/base.ts` の `joinPlan`（links.find、Array.prototype.find は最初にマッチしたリンクを採用）は、2 テーブル間に FK が複数本ある場合（例: `orders.created_by` と `orders.updated_by` が両方 `users.id` を指す）にどちらか一方だけを無言で選ぶ。選択は `describeTable` が返す `foreignKeys` の順序（MySQL: `ORDER BY CONSTRAINT_NAME`、PostgreSQL: `ORDER BY con.conname`）に依存し、命名規則が方言間で異なれば同じ論理スキーマでも MySQL と PostgreSQL で違う FK が選ばれ得る（未検証だが命名規則の違いから見て現実的な差異）。エラーにはならず、テスト（`join-plan.test.ts`、conformance の `buildQuery`）にもこのケースがない。自己参照 FK（`fk.refTable !== from` で除外）は別途安全に弾かれている。
- 次回このあたりを触ったら、複数 FK 間の曖昧性を「エラーにする」か「選択できるようにする」か方針が変わっていないか確認する。

## web: aria-label を「値そのもの」の入れ物に使う誤り（SecondFactorPage）

- `apps/web/src/features/auth/SecondFactorPage.tsx:75` の `<p aria-label={t.secretLabel}>{setup.secret}</p>` は、`<p>`（暗黙ロール `paragraph`）に `aria-label` を付けている。ARIA 1.2 では `paragraph` は Name From: prohibited で、axe-core は `aria-prohibited-attr` として検出しうる。実害は AT/ブラウザの組み合わせ依存（Chrome は label をアクセシブルネームとして露出するなど挙動が割れる）なので「読み上げられない可能性がある」という言い方に留めること（「絶対読めない」と断定しない）。
- この codebase には既に正しいパターンがある: `apps/web/src/components/ui/Feedback.tsx` の `Badge`（`title` を hover 用に残しつつ `sr-only` の `<span>` で説明を別出しし、可視テキストを潰さない）。値そのものを見せたい要素には `aria-label` ではなく `<span className="sr-only">ラベル: </span>` + 可視テキストを使うべき。次に類似コード（秘密鍵・トークン・URI など「値がそのままコンテンツ」なテキスト）を見たら同じ観点でチェックする。

## web: `locale.sql.copied` を SQL 結果コピー以外で使い回す誤り

- `SecondFactorPage.tsx:97` が回復用コードのコピー成功表示に `locale.sql.copied` を再利用しているが、その文言は ja/en とも「クリップボードにコピーしました（**タブ区切り**）」/ "Copied to the clipboard (**tab-separated**)"（`ja.ts:413`, `en.ts:418`）で、SQL 結果グリッド専用の説明。回復用コードは改行区切り（`join('\n')`）でタブ区切りではなく、文脈も無関係。コピー成功文言を使い回すときは「対象データの形式に言及していないか」を必ず確認する。
- 同じファイルはコピー失敗時のフィードバックも欠落している（`copyText(...).then(() => setCopied(true), () => setCopied(false))` で失敗時は成功前と同じ空表示になる）。対照として `apps/web/src/features/sql/ResultActions.tsx`（`copied: 'done' | 'failed' | null` の3値 + `locale.sql.copyFailed`）が正しい既存パターン。コピー機能を新規に足すレビューでは必ず ResultActions.tsx と比較する。

## web: 状態遷移でフォーカスされていた要素が unmount されると focus が body に落ちる（フィードバック無音化）

- `SecondFactorPage.tsx` は `begin`/`confirm`/`disable` の各ミューテーション成功時に、直前までフォーカスがあったボタン（Enrol ボタン等）を含むブランチごと unmount して別の分岐に切り替える。結果は静的な `<p>`（`t.enrolled(...)` 等）で、live region でも見出しへのフォーカス移動でもないため、フォーカスは `<body>` に落ち、成功も内容の変化もスクリーンリーダーに一切アナウンスされない（disable 成功時は「解除できました」に相当する文言自体が存在しない）。
- `autoFocus` を新しい入力欄に付けるのは必ずしも正しい修正ではない（例: confirm 前は秘密鍵・回復用コードを先に読む必要があるので、コード入力欄に autoFocus すると読むべき内容を飛ばしてしまう）。正しい修正は「一時的な成功 Notice(role="status") を出す」+「見出し等に `tabIndex={-1}` を振ってフォーカスを移す」の組み合わせ。LoginForm.tsx の `codeNeeded` → `autoFocus` はボタンが unmount されない別パターンなので単純に真似ない。
- レビュー時のチェックリスト: ミューテーション成功時に (1) それまでフォーカスがあった要素が unmount されるか、(2) 新しい分岐に成功を示す live region があるか、を必ず両方確認する。片方だけ見ると見逃す。

## e2e: `/security`（2FA ページ）が a11y スイート未収載

- `e2e/a11y.spec.ts` は login / server / database / browse / structure / SQL / insert / events / operations 等を網羅しているが `/security` への `scan()` 呼び出しが無い。2FA 機能追加時に axe ゲートへの追加を忘れた状態が確認できた（2026-09 時点）。2FA 関連の PR をレビューするときは a11y.spec.ts への追加有無を必ず確認する。

## web: main.tsx の onUnauthorized は「認証切れ」以外の 401 も無差別に握り潰す

- `apps/web/src/main.tsx:17-22` の `onUnauthorized` は `error.status !== 401` しか見ておらず、`ApiErrorCode` は見ていない。コメント（`main.tsx:12-16`）は `UNAUTHENTICATED` / `AUTH_FAILED` を想定しているが、`apps/api/src/lib/errors.ts` の `STATUS_BY_CODE` で 401 にマップされる**新しいコード**（例: `SECOND_FACTOR_REQUIRED` / `SECOND_FACTOR_INVALID`）は、それが `/login` 以外の**認証済み画面**から飛んだ場合にも同じ扱い（セッションを null にして `/login?expired=true` へ強制遷移）を受ける。
- 2FA 実装（a595325〜9d336f6）で実際に発生: `/security` でのコード確認・解除ミス、および `TSMYADMIN_REQUIRE_2FA` 下で未登録アカウントが `/` 等の保護ルートに触れた場合の両方が、この無差別処理でログイン画面に飛ばされる。後者は `DbTree`（`_app.tsx` のレイアウトに常駐、`enabled` 条件なしで `databasesQuery` を叩く）が `/security` 自体でも発火するため、機能が UI 経由で到達不能になる重大度。
- 教訓: `STATUS_BY_CODE` に 401 を返す新コードを足すとき（今後 WebAuthn 等の別要因を足す場合も含む）は、それが「未認証（グローバルにログアウトしてよい）」なのか「認証済みだが追加の手続きが要る（ログアウトしてはいけない）」なのかを `onUnauthorized` 側で分岐しているか必ず確認する。次回もこのファイルは「404 相当の分岐漏れ」が起きやすい場所として要チェック。

## adapter: MySQL canManageAccount の SYSTEM_USER 要件は「対象非依存」で意図的・テストで固定済み（Critical に格上げしない）

- `packages/adapter/src/mysql/users.ts` の `mysqlCanManageAccount` は、対象アカウント（`name` 引数）が実際に SYSTEM_USER を持つかを見ず、常に「自分が SYSTEM_USER を持っているか」だけをサーバーが対応していれば要求する。実機検証済み（MySQL 8.4.11）: `CREATE USER` のみを持つ管理者アカウントは、SYSTEM_USER を持たない普通のアカウントの `ALTER USER ... IDENTIFIED BY` に実際には成功する（本物の MySQL の挙動）のに、アプリの `canManageAccount` は false を返す。これは fail-closed 方向（過剰に制限）であり、over-permissive ではないので Critical/Warning の「認可の穴」には当たらない。`test/conformance.ts` の `expect(await admin.canManageAccount('tsmyadmin')).toBe(mariadb)`（8.4 では false 期待）で契約として固定されている＝意図的な設計。次にこの箇所をレビューするときは「対象依存にすべき」という指摘を Critical にしない。実務上の懸念は「CREATE USER はあるが SYSTEM_USER までは持たない、という比較的よくある権限構成の運用者には、この機能が事実上使えない」という UX 上の Warning に留める。

## adapter: バージョン文字列パーサが NaN で「安全側に倒れない」唯一の穴（`hasSystemUser`）

- `packages/adapter/src/mysql/users.ts` の `hasSystemUser`: `version.split(/[.-]/).map(Number)` の分割要素が数値に変換できない場合（配列に要素自体は存在するので分割代入のデフォルト値 `= 0` は発動しない）、`Number(...)` は `NaN` になる。`NaN >= 16` は常に `false` になるため、`8.0.<非数値>` のようなバージョン文字列だと `hasSystemUser` が `false`（＝ SYSTEM_USER 不要）を返し、`mysqlCanManageAccount` が要求を緩める方向に倒れる。この機能の中で唯一「壊れた入力が安全側でなく危険側に倒れる」経路。実 MySQL 8.4.11 の `VERSION()` は綺麗な数値なので再現できないが、MySQL 互換プロキシ/フォーク（ProxySQL、Vitess、一部のクラウド管理型 MySQL 等）が非標準の `VERSION()` 文字列を返す場合に理論上該当しうる。次に類似のバージョン文字列パースを見たら「配列の欠落要素」と「NaN になる要素」を分けて考え、NaN 側もフェイルクローズ（未知の形式は「保護機能あり」とみなす）にすべきという指摘をする。

## e2e a11y: 既存ページに乗る「条件付き新規 UI」はテストのセットアップ次第で一切スキャンされない

- `e2e/a11y.spec.ts:93-95` は `/users` を fixture アカウント（tsmyadmin、常にフル権限）でログインした直後・何も 2FA 登録されていない状態でスキャンする。8b1973a で追加された `SecondFactorReset` のバッジ／ボタン／確認ダイアログは `resettable.has(u.name)`（= 誰かが 2FA 登録済みでこのアカウントが解除できる）が真のときだけ描画されるため、このテストでは常に空集合になり新規 UI 要素は一度も axe でスキャンされない。同種のパターンは過去に「/security ページ自体が a11y スイート未収載」として記録済みだが、今回は「ページはスキャンされているが、ページ内の条件付き要素だけがセットアップ不足で素通りする」という一段階違う形。ダイアログの開いた状態を別途スキャンする既存パターンは `e2e/a11y.spec.ts:36-38`（テーブル削除ダイアログ）や `:125-127`。次に「既存の a11y スキャン対象ページに機能を追加した」PR を見たら、その新規要素が実際にそのテストのシナリオで描画される状態になっているかを必ず確認する（ページ到達だけでは不十分）。

## api: `proven()` 後の再読込みで `version` を捨てると CAS が消える（second-factor.ts の削除系ルートに実在した／128d315）

- パターン: `const { version: _read, ...current } = (await store.get(session.config)) ?? factor` のように `store.get()` の結果から `version` を分割代入で明示的に捨て、その `current` から作った値をそのまま `store.set(session.config, left)` に渡す。`SecondFactor.version` は optional で、`SqliteSecondFactors.set` / `RedisSecondFactors.set`（`apps/api/src/session/second-factor.ts`, `redis-store.ts`）は「`version === undefined` なら無条件書き込み（CAS なし）」という契約なので、これは意図せず「盲目上書き」になる。`proven()` 自身の書き込み（TOTP の `lastStep` 更新や passkey の `counter` 更新）はちゃんと CAS されているが、**その直後の「再読込み→最終的な状態変更の書き込み」だけが無防備**という非対称な壊れ方をする。
- 128d315（パスキー追加）で実際に確認: `DELETE /second-factor/totp`（`second-factor.ts:344-347` 付近）と `DELETE /second-factor/passkeys/:id`（`:439-442` 付近）の両方がこのパターン。親コミットには「1 つの方法だけ外す」操作自体が存在せず（`store.clear()` で全消去のみ）、このバグは passkey 対応で「部分的な削除」を実装したときに新規発生している。
- 実証方法: 実際の `Promise.all` による同時 HTTP リクエストは、この Hono + `node:sqlite`（同期 API を async でラップ）環境では素直に直列化されてしまい、狙った位置での割り込みが起きなかった（片方が完全に完了してからもう片方が実行された）。確実に再現できたのは、`store.secondFactor.set` をラップして「`version === undefined` の呼び出し（＝脆弱な最終書き込み）が来た最初の瞬間に、正しく CAS された『別タブからの同時書き込み』を先に差し込む」という決定的な手法。これで「別タブが正しく CAS 書き込みに成功した直後、脆弱なルートの無条件上書きがそれを消す」ことを確定的に示せた。次にこの種の「読み直してから書く」パターンを見たら、まずコードを読んで `version` の受け渡しを追い、必要なら同じフック手法で決定的に再現する（`Promise.all` だけに頼らない）。
- 修正方針: 再読込みした結果の `version` を捨てずに `left` へ引き継ぎ、`store.set` が `false` を返した場合（＝競合で書き込めなかった場合）を 409 相当のエラーにするか、1 回だけ再試行する。
- 隣接して見つかったミラー型のバグ（未実証・コードリーディングのみ）: `POST /second-factor/confirm`（`:307`）と `POST /second-factor/passkeys/confirm`（`:412`）は逆に `store.set(...)` の戻り値（CAS 成功/失敗の bool）を握りつぶしている。2 つ目以降の方式追加（`existing` が non-null＝version あり）で、書き込みの直前に別の変更が入っていると `set` は `false` を返すが、ルートはそれを無視して 201 + `enrolled`/`passkey_added` ログを返す。ただし `secondFactorStatus` はこの直後に `store.get` で実際の状態を読み直して返すので、レスポンスの JSON 自体は（矛盾した）実データを反映する——ステータスコードと監査ログだけが実際には起きていない成功を主張する、という一段軽いバージョン。

## api: 9f074f5（changeFactor への集約）後も `store.clear()` だけは CAS が効かない（2巡目で発見・実証済み）

- 128d315 の CAS 欠落（上のエントリ）は 9f074f5 で `changeFactor()`（read→apply→CAS書き込み、衝突なら3回まで読み直し、だめなら `CONFLICT` 409）に直されたが、`apply(current)` が `null` を返す分岐（＝残り0方式になる＝ `SecondFactor` を丸ごと消す）だけは `store.clear(config)` を呼ぶ。`SecondFactors.clear(config): Promise<void>` はインターフェース上 CAS パラメータを持たないため、この分岐だけは読み直しも再試行もされない無条件削除のまま。`DELETE /second-factor/totp`（最後の1方式を外すとき）、`DELETE /second-factor/passkeys/:id`（同）、`DELETE /second-factor`（全解除ルート、`changeFactor` を経由せず直接 `store.clear`）の3箇所すべてが同じ制約を共有する。
- 実証済み: `store.clear()` をフックして「削除ルートの読み直し直後・実際の clear() 実行直前」に、正しく CAS された別タブの追加書き込みを差し込むと、その追加ごとアカウントの2FA状態が丸ごと消える（`final stored factor: null`）。旧バグ（1方式だけ消える）より影響範囲が広い（factor全体が消える）。
- 教訓: 「read→apply→CAS write」に集約するリファクタは、`null`（＝全削除）に相当する分岐だけ別の非CAS経路（`clear()`）に逃げがちなので、CAS化のレビューでは「削除ブランチ」を必ず個別にチェックする。今回のケースでは `SecondFactors.clear()` 自体に expected version を渡せるようにしない限り、根本修正には3ストア実装（Memory/Sqlite/Redis）全部の変更が要る。

## api: `SecondFactors.clear()` の CAS 欠落は 3157765 で修正確認済み（3巡目）

- 前エントリで指摘した「`changeFactor` の `null` 分岐と `DELETE /second-factor` が無条件 `store.clear()` を使う」ギャップは 3157765 で解消。`SecondFactors.clear(config, version?): Promise<boolean>` に signature変更し、Sqlite（同期の get→比較→delete）・Redis（Lua `DEL_IF_UNCHANGED`）双方で実装、`changeFactor` は `clear` が `false`（競合）を返したら `continue` して読み直す。操作者による強制リセット（`/second-factor/accounts/reset` の `store.clear(target)`、version 省略）は意図的に無条件のまま残しており、これは正しい（運用者権限による上書きは常に勝ってよい）。
- 自分の再現手順（`clear()` をフックして直前に別タブの CAS 追加を差し込む）をそのまま新コードに当てて再実行し、追加が生き残ること（`changeFactor` が競合を検知して読み直し、正しく「削除対象＋残った新規分」を再計算する）を確認した。
- 教訓: body-limit（`apps/api/src/app.ts` の `apiBodyLimit`: `/api/session` は 64KB、他の JSON ルートは 1MB）が、`PasskeyResponseSchema.response` のような「キー数上限のない `z.record`」を外側から実質的に縛っている。個々のフィールドに上限がある Zod スキーマでも、外側のトランスポート層の制限とセットで評価すること。
