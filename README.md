# NetNovelEditor

Solid + Hono / Cloudflare Workers + Turso の小説エディターです。Googleで会員登録・ログインできます。未ログインでも端末内で編集できます。

## 開発

```sh
bun install
cp .dev.vars.example .dev.vars
```

`.dev.vars` に開発用TursoとGoogle OAuthの認証情報を設定し、`bun run dev` で起動します。フロントエンドにシークレットを渡す `VITE_` プレフィックスは使用しません。

## Google OAuth設定

1. Google Cloud Console / Google Auth Platformで同意画面を設定します。テスト公開中の場合は利用するGoogleアカウントをテストユーザーに追加してください。
2. OAuthクライアント（アプリケーションの種類: **ウェブアプリケーション**）を作成します。
3. 「承認済みのリダイレクトURI」に以下を登録します（末尾スラッシュなし）。
   - 開発: `http://localhost:5173/api/auth/google/callback`
   - 本番: `https://nne.taisan11.dev/api/auth/google/callback`
4. クライアントIDを `GOOGLE_ID`、シークレットを `GOOGLE_SECRET` に設定します。`GOOGLE_REDIRECT_URI` は実際のアクセス元と同一オリジンにしてください。開発ポートを変更した場合はGoogle側と `.dev.vars` の両方を変更します。

本番では次のシークレットを設定します。

```sh
bunx wrangler secret put GOOGLE_ID
bunx wrangler secret put GOOGLE_SECRET
bunx wrangler secret put JWT_SECRET
bunx wrangler secret put TURSO_TOKEN
```

`JWT_SECRET` は十分に長いランダム値にしてください（例: `openssl rand -hex 32`）。本番の `GOOGLE_REDIRECT_URI` と `TURSO_URL` は `wrangler.jsonc` で設定します。

設定画面の「Googleで登録・ログイン」から認証します。初回は会員を自動作成し、次回以降は同じGoogle IDの会員としてログインします。メールアドレスが変わっても同じ会員です。確認済みメールのみ許可し、GoogleトークンはDBやブラウザに保存しません。セッションは7日間のHttpOnly Cookieです。

## DBの準備・旧認証からの移行

DBコマンドは `.env` の `TURSO_URL` / `TURSO_TOKEN` を使用します（`.dev.vars` とは別です）。実行前に対象DBを確認してください。

- **新規DB**: `bun run db:mg`
- **旧ID・パスワード認証のDB**: バックアップ後、次のコマンドを実行します。

```sh
bun run db:migrate-google --confirm-reset
```

**旧DB移行は既存の全ユーザーとクラウド上の全作品・全話を削除します。** トランザクション内で認証テーブルを置き換えます。移行済みなら何も変更しません。既存DBに先に `db:mg` を実行しないでください。移行完了後に新コードをデプロイしてください。旧セッションは無効になります。

端末内の作品は削除しません。必要なら設定画面でバックアップ・インポートしてください。ログイン後は端末内の未送信作品を自動同期します。共有端末・別アカウントへの切り替えでは、この端末内データも同期対象になる点に注意してください。

## 検証・デプロイ

### 設定同期とプラン

表示設定（フォントサイズ・行の高さ・縦書き・テーマ）もログイン中は同期します。保存済みの変更は2秒の待機でまとめて送信し、連続保存中も最大15秒で送信を開始します（通信失敗・非表示・オフライン時を除く）。自動同期同士は最低5秒空け、変更のない画面移動・復帰では直近60秒の同期結果を再利用します。画面表示中の定期確認は90秒を基準に、変更がなければ最大15分まで間隔を延ばします。ログイン確認も5分間再利用し、通信失敗時は30秒から最大15分の間隔で再試行します。手動同期はこれらの待機を省略します。

設定と作品は通常1回のリクエストで送信し、作品が容量上限で拒否された場合のみ設定を別送します。作品削除は配下の話もサーバーで一括削除するため、話ごとの重複通信はしません。設定の競合は新しい更新を優先し、通信中の変更は未送信のまま保持します。既存の端末設定も初回ログイン時に同期対象になります。端末の時計のずれで変更を取りこぼさないよう、受信には引き続き全件スナップショットを使います。

| プラン | クラウド作品数 | クラウド容量 |
| --- | ---: | ---: |
| 無料（標準） | 10作品 | 10MiB |
| Pro | 1,000作品 | 1GiB |

上限は `shared/plans.ts` で管理します。容量は未削除作品・話のタイトル／プロット／本文のUTF-8バイト数です。削除済みデータは使用量に含めません。上限超過時も端末内の編集・バックアップ・クラウドからの受信・設定同期は利用可能です。プランを下げてもデータは削除せず、上限を超える使用量の増加のみ拒否します。

既存のGoogle認証DBには、**デプロイ前に**次の追加移行を実行してください（既存データの削除なし・再実行可能）。新規DBは `bun run db:mg` でも準備できます。

```sh
bun run db:migrate-cloud --confirm
```

決済・一般ユーザー向けプラン変更APIはありません。管理者が `.env` の対象DBを確認して変更します。ユーザーIDはDBの `users.id`（ログイン中の `/api/auth/me` の `user.id`）です。

```sh
bun run plan:set --user <ユーザーID> --plan pro --confirm
bun run plan:set --user <ユーザーID> --plan free --confirm
```

変更は次回同期時に反映されます。DB用トークンをフロントエンドへ公開しないでください。

```sh
bun test
bun run build
bunx wrangler deploy
```

実際のGoogleログインには上記のOAuthクライアント設定が必要です。
