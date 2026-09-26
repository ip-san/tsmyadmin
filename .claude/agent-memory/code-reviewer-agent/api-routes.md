# code-reviewer-agent メモリ: apps/api/src/routes 等

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
- **2026-09: この3エントリ（128d315 → 9f074f5 → 3157765）の教訓は `.claude/rules/api-routes.md`（「保存項目の同時書き込みは CAS を通す」節）と `self-review` の項目14に昇格済み。** `paths: apps/api/src/**` に一致するため、以後このディレクトリを読み書きするセッションには rules 側が自動で提示される。ただし `RedisSavedQueries` の per-kind cap レース（下のエントリ）はまだ未修正・未昇格のまま。


## api: XML エクスポートは孤立サロゲートを検出できず「値を失わない」設計目標が UTF-8 変換時に静かに破れる（b785ef4 で実機確認済み）

- 場所: apps/api/src/lib/export-formats.ts の xmlUnrepresentable()。制御文字（0x20未満、tab/LF/CR以外）と 0xfffe/0xffff はチェックしているが、サロゲート範囲 0xD800-0xDFFF を一切見ていない。孤立サロゲート（対になっていない UTF-16 コード単位。例: \uD800 単体）を含む文字列は xmlUnrepresentable が false を返すため base64 フォールバックに回らず、xmlEscape()（&/</>/" のみエスケープ）でそのまま埋め込まれる。
- 実害: 最終的にレスポンスは apps/api/src/lib/export.ts の toReadableStream() が new TextEncoder().encode() で UTF-8 バイト列に変換する。TextEncoder は孤立サロゲートを U+FFFD（REPLACEMENT CHARACTER）に静かに置き換える仕様（WHATWG Encoding 標準）なので、元の値は失われる。コミットメッセージの「値を失わない」という設計目標（制御文字を base64 に回す理由そのもの）が、孤立サロゲートというケースだけ抜け落ちて破れている。
- 検証済み（標準の TextEncoder / String.prototype.charCodeAt の仕様に基づくため環境非依存）: 'abc' + 孤立サロゲート + 'def' は xmlUnrepresentable で false、TextEncoder().encode(...) の結果は元のコード単位の代わりに U+FFFD の UTF-8 バイト列を含む。
- 対照: 同じ値を YAML 側の yamlValue()（JSON.stringify(text(cell)) 経由）に通すと、JSON.stringify は ES2019 以降サロゲート単体をテキストのバックスラッシュ表記（6文字の ASCII、例: \uD800 という文字列そのもの）にエスケープする仕様があるため、後段の TextEncoder に渡っても壊れない。XML 側だけ独自のエスケープ関数（xmlEscape）を持っていて、この保護がない。
- テストの抜け: apps/api/src/lib/export.test.ts の xml のテストは制御文字（bell = \u0007）はカバーしているが孤立サロゲートのケースがない。
- 正しくは「対になっていないサロゲートだけ」を検出すべき（有効なサロゲートペア＝絵文字等の補助面文字はそのまま UTF-8 化できるので、ペア全体を無差別に base64 に回すと不要な base64 化が増える）。次にこのファイルを触ったら、孤立サロゲート検出のテストケースを必ず追加する。

## api: RedisSavedQueries の per-kind cap 計算が read→write の外側にあるため、同時書き込みでキャップを一時的に超える（79b1dc3 で確認）

- `apps/api/src/session/redis-store.ts` の `RedisSavedQueries.save()` は `mine = await this.list(...)`（複数の GET を順にawaitする、アトミックでない読み取り）で得た古いスナップショットから `overCap()` の victims を計算し、その後の `multi()` に isert/evictをまとめて詰めて実行する。read と write の間に他の書き込みが割り込める（CAS や WATCH が無い）ため、2 つの同時 `save()`（同じ kind、新規追加）がどちらも「まだ上限未満」というスナップショットを見て、両方が evict なしで insert すると、per-kind cap を一時的に超える。次の（非同時）書き込みで `overCap` が古い分もまとめて刈るので自己修復するが、同時リクエストを送り続ける限り上限を回避できる。
- 対照: `SqliteSavedQueries.save()` は同じロジックだが `BEGIN IMMEDIATE` の中で読み直し不要な単一コネクション・同期 API（node:sqlite）なので、Hono + 単一プロセスの前提では事実上直列化される（過去の second-factor.ts の検証と同じ経験則）。Redis はマルチレプリカ前提なのでこの前提が効かず、Redis 側だけがこのレースを実際に踏む。
- テストの欠落: `apps/api/src/session/conformance.ts` の `'caps stored items per kind'` テストは完全に逐次（`for` ループで `await` を挟む）なので、このレースを検出できない。狙って再現するには `redis.multi` や `list()` の GET をフックして片方の `save()` の書き込み直前にもう片方の `save()` を差し込む必要がある（second-factor.ts のときと同じ決定的フック手法が使えるはず、未実証）。
- 修正方針: victims の計算を書き込みトランザクションの中に持ち込む（例: `WATCH` + `MULTI/EXEC` で index の変化を検知して再試行する、または Lua スクリプトで list 取得〜evict〜insert を一括のサーバーサイド処理にする）。
