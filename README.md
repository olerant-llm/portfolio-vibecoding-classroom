# 教室向けAIものづくりサイト

AIを使った作品制作と作品一覧を中心に、学習者・教室管理者・運営者の画面をまとめたWebアプリです。Firebaseの認証と保存機能、Geminiによる生成、Stripeの購入処理とメール配信を組み合わせています。

## 起動と設定

Node.js 22とFirebase CLIを用意します。自分のFirebaseプロジェクトを作り、`public/firebase-config.js` の見本値を設定してください。`.firebaserc.example` を `.firebaserc` にコピーし、自分のプロジェクト名を設定します。

```sh
cd functions
npm ci
cd ..
firebase emulators:start
```

画面だけを確認する場合も、ログイン・保存・生成には接続設定が必要です。運営者のメールアドレスは `functions/index.js`、`public/firebase-auth.js`、`public/admin.html`、`firestore.rules`、`storage.rules` の `admin@example.com` を同じ管理者の値へ変更してください。GoogleログインとFirestore・Storageも自分のプロジェクトで設定します。

メールを使う場合は `functions/.env.example` を `.env` にコピーして設定します。Gemini・StripeはFirebaseの秘密設定 `GEMINI_API_KEY`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` に登録してください。最初はStripeの試験環境で設定し、購入ボタンの見本リンクも自分のものへ差し替えます。

## 公開版の範囲

元サービスの秘密鍵、メール送信パスワード、アカウント、決済リンク、保存データ、営業資料、配置記録は含みません。Firebaseのブラウザー向け識別情報も見本値です。画像は再配布条件が不明な素材を含めず、この公開版の単純な見本画像に置き換えています。初期の教材・利用者データは含まないため、接続後に管理画面から登録してください。

機能を移植・改修してきた開発版です。実アカウントでの作品一覧、管理者の削除操作、教室管理の一部は原企画でも最終確認が残っています。この公開コピーでは依存部品の追加や動作試験を行っていません。公開運用には認証・権限・料金・メールの設定確認が必要です。

独自プログラムとこの公開版の見本画像はMITライセンスです。外部ライブラリーはそれぞれの利用条件に従います。
