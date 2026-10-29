<div align="center">

<img src="docs/images/power-logo-v2.svg" alt="SwitchBot Controlのロゴ：電源マーク" width="112" height="112">

# SwitchBot Control

**チャットから、機器の状態確認と電源操作を。**

Cloudflare Workersで動く、SwitchBot機器向けのMCPサーバー。  
自宅PCを起動していなくても、登録した機器へアクセスできます。

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?labelColor=172B3A)
![OAuth認証](https://img.shields.io/badge/認証-OAuth-58D6BD?labelColor=172B3A)
![Node.js 24以上](https://img.shields.io/badge/Node.js-24%2B-58D6BD?labelColor=172B3A)
[![MIT License](https://img.shields.io/badge/License-MIT-58D6BD?labelColor=172B3A)](LICENSE)

[できること](#できること) · [使い始める](#使い始める) · [機器を追加する](#機器を追加する) · [PCの電源管理](#pcの電源管理) · [開発と運用](#開発と運用)

</div>

---

「登録している機器を教えて」「デスクライトをつけて」「PC用プラグの状態を確認して」。  
OAuthで接続したMCPクライアントから、登録した機器の一覧・状態確認・電源ON／OFFを実行できます。

**自分のCloudflareアカウントへ配置して使う、単一所有者向けの構成です。** 利用者自身のSwitchBot API情報と、連携専用のパスワードを設定します。

## できること

| 機能 | 内容 |
| --- | --- |
| **登録機器をまとめて確認** | 機器の名前・登録key・許可された操作を一覧で取得 |
| **状態を確認** | 登録した機器の電源状態などを取得。返る項目は機種によって異なります |
| **電源をON／OFF** | SwitchBot公式APIを通じて、対応機器へ電源操作を送信 |
| **操作対象を限定** | `DEVICES_JSON` で機器ごとに状態取得・ON・OFFを許可 |
| **OAuthで接続** | PKCE、動的クライアント登録（DCR）、CIMDに対応 |
| **PC用プラグのOFFを制御** | `requiresShutdown: true` の機器は、呼び出し側の正常終了確認が必須 |

対応する操作は**状態取得と `turnOn`／`turnOff`**です。調光・温度設定・カーテン開閉などの専用コマンドは実装していません。機器ごとの公式API対応範囲に合わせて登録してください。

### どこで動く？

| 場所 | 役割 |
| --- | --- |
| **MCPクライアント** | チャットなどから操作を依頼し、OAuthで接続 |
| **Cloudflare Workers** | 認証と許可操作を確認し、SwitchBot公式APIを呼び出す |
| **Cloudflare KV** | OAuthの接続情報を保存 |
| **SwitchBot公式API・機器** | 状態取得と電源操作を受け付ける |

機器操作のサーバーはCloudflare上で動きます。自宅PCでこのMCPサーバーを常時稼働させる必要はありません。

## 使い始める

**機器を準備 → Workerを配置 → SecretsとKVを設定 → MCPクライアントに接続**の順で進めます。

| 用意するもの | 用途 |
| --- | --- |
| SwitchBotアカウントと対応機器 | アプリで機器を登録し、API Token・Secret・機器IDを取得 |
| Cloudflareアカウント | WorkerとOAuth専用のKV namespaceを作成 |
| Node.js 24以上・npm | ソースの依存関係を取得してWorkerをビルド |
| OAuth対応のMCPクライアント | 配置したWorkerの `/mcp` へ接続 |

### 1. SwitchBot側の準備

1. SwitchBotアプリで、使用する機器を同じ所有者アカウントに登録します。プラグミニ（JP）は2.4GHz Wi-Fiに接続し、用途がわかる名前を付けます。
2. SwitchBotアプリの開発者向けオプションから、公式APIのTokenとSecretを取得します。アプリV9以降の公式手順は「プロフィール → 設定（Preferences）→ About → App Versionを10回タップ → Developer Options → Get Token」です。表示名はアプリの言語・版で異なります。
3. 公式APIの署名付き `GET https://api.switch-bot.com/v1.1/devices` で機器一覧を取得し、名前と機種を照合して `deviceId` を確認します。この値を登録JSONの `id` に使います。署名方法は[SwitchBot公式API](https://github.com/OpenWonderLabs/SwitchBotAPI#authentication)を参照してください。

このMCPの `list_devices` は、登録済みの機器だけを返します。SwitchBotアカウント内の新しい機器を自動検出する機能ではありません。Token・Secret・機器IDや実際の登録JSONは、公開リポジトリへ追加しないでください。

### 2. ビルドしてWorkerを配置

ソースを取得し、まず同梱の例示設定でビルドとテストを行います。

```sh
git clone https://github.com/kkoch5t2/switchbot-control.git
cd switchbot-control
npm ci
npm test
npm run build
WORKER_FILE=./worker.js npm test
npm run test:runtime
```

1. CloudflareにWorkerを作成し、公開URLを確認します。
2. `src.mjs` の `PRODUCTION_ORIGIN` を、そのWorkerのHTTPS originに変更します。例示値は `https://switchbot-control.example.com` です。末尾の `/` や `/mcp` は付けません。
3. `npm run build` で `worker.js` を生成します。
4. Workerのコード編集画面に、生成した `worker.js` を配置します。JavaScriptモジュール形式のWorkerとして実行してください。
5. 下記のSecretsとKV bindingを設定します。
6. Runtimeのcompatibility flagに `global_fetch_strictly_public` を追加します。元の配置で使用したcompatibility dateは `2026-10-21` です。
7. 自分のWorkerの `/health` で `ready: true` を確認します。

`ready: true` はWorker内の設定チェックの結果です。SwitchBotへの接続や実機操作の成功を示すものではありません。MCPへのOAuth接続後、機器一覧と個別の状態取得も確認します。

同梱の `worker.js` は例示originでビルドしたものです。自分のoriginへ変更して再ビルドしてください。別originへの要求を拒否する設計です。テストも例示originを使うため、origin変更後にテストする場合は `test.mjs` と `runtime-smoke.mjs` のoriginも同じ値に合わせます。

### 3. SecretsとKVを設定

WorkerのVariables and Secretsに、次の4項目をSecretとして設定します。実際の値をソースやGitへ書き込まないでください。

| 名前 | 内容 |
|---|---|
| `SWITCHBOT_TOKEN` | SwitchBot公式API Token |
| `SWITCHBOT_SECRET` | SwitchBot公式API Secret |
| `OWNER_PASSWORD` | このMCP連携専用のパスワード。24文字以上・最大512文字 |
| `DEVICES_JSON` | 操作対象の機器と許可操作を登録するJSON |

OAuth情報専用のKV namespaceを作成し、Workerのbinding名 `OAUTH_KV` で接続します。他のアプリのKVと共有しないでください。

`DEVICES_JSON` の例（IDは実際の機器IDへ置換）:

```json
{
  "pc": {
    "name": "PC電源",
    "id": "REPLACE_WITH_DEVICE_ID",
    "actions": ["status", "on", "off"],
    "requiresShutdown": true
  },
  "desk_lamp": {
    "name": "デスクライト",
    "id": "REPLACE_WITH_OTHER_DEVICE_ID",
    "actions": ["status", "on", "off"]
  }
}
```

keyは小文字英数字から始め、小文字英数字・ハイフン・アンダースコアで64文字以内にします。`actions` は実機が公式APIで対応する操作だけを指定してください。この実装は状態取得と `turnOn` / `turnOff` に対応します。調光、温度設定、カーテン開閉などの専用コマンドは実装していません。

### 4. MCPクライアントに接続

- サーバーURL: 自分のWorkerのHTTPS URLに `/mcp` を付けたもの。
- 認証: OAuth（動的クライアント登録に対応）。
- 許可画面: 自分で設定した `OWNER_PASSWORD` を入力して接続を許可。

動的クライアント登録（DCR）を利用する場合、固定のClient ID・Client Secretは設定不要です。状態取得には `devices:read`、電源操作には加えて `devices:control` の許可が必要です。

CloudflareやSwitchBotのログインパスワードを入力するものではありません。

接続後は、まず `list_devices` と `get_device_status` で登録内容と状態を確認します。電源操作を試す場合は、対象機器と現在の状態を確認してから実行してください。

## 機器を追加する

1. 既存の機器と同じSwitchBotアカウントに新しい機器を登録し、公式APIの機器一覧で `deviceId` を確認します。同じアカウントなら既存のAPI Token・Secretを使用できます。
2. 非公開で保管している登録JSONに、新しいkeyと設定を追記します。**既存のkey・ID・許可操作を残し、登録一覧全体を更新します。** PC用プラグには `requiresShutdown: true` を付けます。
3. CloudflareのWorker設定で、Secret **`DEVICES_JSON` の値を更新して反映**します。手元のJSONやGitHubのサンプルを編集するだけでは、本番の登録は変わりません。
4. MCPから `list_devices` を呼び、新旧両方の機器を確認します。続いてそれぞれのkeyで `get_device_status` を呼び、名前・状態・エラーの有無を確認します。

機器追加だけなら、別Workerの作成、Workerコードの再ビルド、MCPの再登録は不要です。既存のOAuth接続をそのまま利用できます。

実際の登録JSONはアクセスを制限した非公開の場所で管理してください。Cloudflareに保存したSecretの値は、APIから再取得できません。このリポジトリには機器登録の例だけを置きます。

## PCの電源管理

> **プラグのOFFは電源の切断です。OSの正常シャットダウンと停止を確認してから実行してください。**

### プラグONで自動起動させる

スマートプラグのONは給電の開始です。PCを自動起動させる場合は、ご利用のPCが通電復帰時の起動に対応し、必要なBIOS/UEFI設定が有効になっていることを各自で確認してください。設定方法は機種によって異なるため、メーカーの案内を参照してください。

実運用の前に、OSの正常シャットダウンと停止を確認したうえでプラグをOFF→ONし、本体ボタンを押さずに起動することを各自の環境で確認してください。OS起動後のリモート接続や必要なサービスの自動復帰も確認します。

**このMCPにはOSのシャットダウン機能はありません。** OS側の操作は別の管理手段で行い、正常終了を確認してからプラグをOFFにしてください。ネットワーク応答がないことだけを、正常終了の証拠にしないでください。

### 停止するときの順序

1. 別の管理手段でPCのOSを正常シャットダウンします。
2. OSが正常終了し、停止したことを確認します。
3. `set_device_power` に `power: "off"` と `shutdown_confirmed: true` を渡します。
4. `get_device_status` でプラグがOFFになったことを確認します。

`shutdown_confirmed` は**呼び出し側の確認申告**です。Worker自身がOSの停止を自動検証する仕組みではありません。

## 開発と運用

### MCPツール

| ツール | 内容 |
|---|---|
| `list_devices` | 登録済みのkey・名前・許可操作を取得。機器IDは返しません |
| `get_device_status` | `device` に登録keyを指定して状態を取得 |
| `set_device_power` | `device` と `power: "on"` または `"off"` を指定 |

`requiresShutdown: true` の機器をOFFにするには、PCのOSを正常終了し、停止を確認してから `shutdown_confirmed: true` を渡します。この引数は呼び出し側の確認申告であり、Worker自身がOSの停止を自動検証するものではありません。

SwitchBot APIの受付成功と実機の状態変更完了は別です。操作後は `get_device_status` で確認してください。タイムアウト時も状態を確認してから再操作します。

<details>
<summary><strong>認証・接続の管理</strong></summary>

Cloudflare公式 `@cloudflare/workers-oauth-provider` 1.2.3を使用します。権限は `devices:read` / `devices:control` / `offline_access`。アクセストークンは1時間、リフレッシュトークンは30日が上限です。

所有者パスワードを変更しても、発行済みOAuthトークンは即座には失効しません。即時停止は専用KV内のOAuth記録を削除するか、Workerを停止して行います。許可画面はOrigin・Cookie・一度限りの許可情報を検証します。

</details>

<details>
<summary><strong>テストの範囲</strong></summary>

`npm test` は、OAuth・PKCE・許可画面の再利用拒否・権限制御・未登録機器の拒否・PC電源OFFの確認・SwitchBot API署名を確認します。SwitchBot API通信はモックで、実機の電源は変更しません。

`npm run test:runtime` は、Miniflare/workerdで生成済みWorkerを実行し、OAuthとMCPの流れを確認します。実際のCloudflare環境やSwitchBot実機の動作確認を代替するものではありません。

</details>

<details>
<summary><strong>主なファイル</strong></summary>

| ファイル | 内容 |
|---|---|
| `src.mjs` | サーバーのソース |
| `worker.js` | 依存ライブラリを含む生成済みWorker |
| `build.mjs` | ビルド処理 |
| `test.mjs` | OAuth・MCP・機器操作のテスト |
| `runtime-smoke.mjs` | workerdでの動作確認 |
| `THIRD_PARTY_LICENSES.txt` | 同梱する第三者コードのライセンス |

</details>

## ライセンス・参照先

[MIT License](LICENSE)。第三者コードの条件は [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) を参照してください。

このプロジェクトはSwitchBot公式の製品ではありません。READMEのロゴは、このプロジェクト用の独自アイコンです。

- [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
- [SwitchBot公式API](https://github.com/OpenWonderLabs/SwitchBotAPI)
