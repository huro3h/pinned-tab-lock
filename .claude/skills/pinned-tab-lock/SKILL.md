---
name: pinned-tab-lock
description: Pinned Tab Lock (固定タブを別サイトで上書きさせない Chrome 拡張) を改修・デバッグするときに使う。遷移の捕まえ方、ロック状態の持ち方、却下した実装案、テスト手順を記録している。
---

# Pinned Tab Lock 開発メモ

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `background.js` | service worker。遷移の監視・打ち消し・ロック状態の管理 |
| `settings.js` | 設定のデフォルトと「同一サイトか」の判定。background と popup の両方から import |
| `popup.js` / `popup.html` / `popup.css` | ツールバーの設定UI |
| `icons/icon.svg` | アイコンの原本 (ON=青の線画1枚)。OFF はここから色だけ差し替えて生成する |

## 中心にある設計判断

### 守る対象を設定に持たせない

当初は「固定タブで常時開くサイトの URL を設定する」案だったが、ユーザーの要件は
「固定中は同じタブで別サイトを開けない」であって特定サイトの常駐ではなかった。
そのため**固定した瞬間にそのタブが開いていた URL** をロック対象にする方式にした。
設定項目が減り、どのサイトでも同じように使える。

ロック対象は「ホスト」ではなく**完全な URL** で持つ。戻すときに元のページへ正確に
戻せるようにするため。同一サイト内で遷移するたびに `onCommitted` で最新の URL に更新する。

### スキームを問わず保護する

当初は http/https だけを保護対象にしていたが、`chrome-extension://` のページ
(自作の新しいタブ拡張やメモ拡張など) や `file://` を固定して使うケースがあるため、
**スキームによる足切りをやめた**。同一サイトの判定キーは `siteKeyOf()` =
`scheme://host`:

| URL | キー | 効果 |
| --- | --- | --- |
| `https://example.com/a` | `https://example.com` | http と https は別サイト |
| `chrome-extension://abc/x.html` | `chrome-extension://abc` | 拡張ごとに別サイト |
| `chrome://version` | `chrome://version` | 内部ページはページ名がホストなのでページ単位 |
| `file:///Users/me/a.html` | `file://` | ローカルファイルは一括り |

`chrome://` にはホスト権限を与えられないので webNavigation が届かないかと危惧したが、
実機では固定した `chrome://version` の保護も、http 固定タブから `chrome://version` への
遷移を弾いて新しいタブで開き直すのも動いた (`scheme-test.js` で確認済み)。

### 新しいタブの扱いは二段構え

ロック対象外の判定を2つに分けている。

- `EMPTY_URL` (`^about:`) — **常にロック対象外**。`about:blank` は遷移の途中状態としても
  現れるので、ここをロックすると壊れる。設定で覆せないようにしてある。
- `NEW_TAB_URL` (`chrome|brave|edge|vivaldi|opera://(newtab|new-tab-page)`) —
  **`protectNewTab` 設定次第**。既定はオフ (ロックしない)。ここを常時守ると
  「新しいタブを固定してから URL を開く」という普通の手順が踏めなくなるため既定をオフに
  したが、メモや時計を出す新しいタブを固定したままにしたいという要望があり設定にした。

新しいタブを別の拡張で置き換えている場合、`tab.url` は `chrome-extension://` になるので
`NEW_TAB_URL` に該当せず、`protectNewTab` に関わらず最初からロックされる。
これは意図通り (拡張ページを固定しているのだから守るべき)。

`protectNewTab` を切り替えるとどの固定タブがロック対象かが変わるので、
`chrome.storage.onChanged` で `bootstrap()` を回してロックを取り直している。
これが無いと、オフに戻しても既存のロックが残って保護され続ける。

### 遷移をキャンセルできない、という MV3 の制約

MV3 ではブロッキング版 `webRequest` が使えず、**遷移を事前に止める API が存在しない**。
`declarativeNetRequest` で main_frame をブロックすると `ERR_BLOCKED_BY_CLIENT` の
エラーページに遷移してしまい、結局戻す処理が要るので採用しなかった。

採った方式は `webNavigation.onBeforeNavigate` で検知 →
`chrome.tabs.create()` で新しいタブに逃がす → `chrome.tabs.update(tabId, { url: lockedUrl })`
で固定タブを元の URL へ「打ち消す」。副作用として**固定タブが1回リロードされる**。
これは仕様として README に明記済み。

`onCommitted` まで待って `chrome.tabs.goBack()` する案も検討した。bfcache が効けば
リロードを避けられるが、別サイトの中身が一瞬表示される。「別サイトを開かせない」という
要件を優先して onBeforeNavigate 方式にした。

### `onBeforeNavigate` の時点で `tab.url` は遷移前のまま

これが方式全体の前提。遷移中のタブでは `tab.pendingUrl` が遷移先を、`tab.url` が
現在表示中の URL を保持する。実機テストで確認済み (下記)。

### `onCommitted` はバックストップ兼ロック更新

サーバーリダイレクト (短縮URL → 別ホスト) は `onBeforeNavigate` が1回しか発火せず、
最初の URL でしか判定できない。そのため `onCommitted` でも判定し直している。

このとき `onBeforeNavigate` で弾いたものが稀に commit まで進むと**新しいタブが2枚**
開いてしまう。`recentlyBlocked` (tabId|url をキーにした3秒のメモリ上のマップ) で抑止している。

### service worker が落ちる前提の状態管理

ロック状態はメモリ上の `locks` オブジェクトを主に使い、`chrome.storage.session` に
ミラーする。`session` を選んだのはディスクに書かれず、ブラウザ終了で消えるため
(タブ ID はセッションを跨いで無意味になる)。

さらに保険として、記録が無い固定タブに遷移が来たら `tab.url` からその場でロックを
作る (`resolveLock` のフォールバック)。SW 再起動直後でも守れる。

### 設定は3つだけ

`enabled` (保護全体) / `activateNewTab` (逃がしたタブに切り替えるか、既定オン) /
`protectNewTab` (新しいタブページも守るか、既定オフ)。

`activateNewTab` は `divert()` が呼ぶ `chrome.tabs.create({ active })` に渡すだけ。
オフのときは固定タブがアクティブなまま残るので、打ち消しによる**リロードを目の前で
見せることになる**点だけ留意 (別サイトの中身は表示されない)。

初版では以下の3つも設定として持たせたが、ユーザー判断でいずれも削除した。

初版では以下の3つを設定として持たせたが、ユーザー判断でいずれも削除した。
再追加を検討するときのために経緯を残す。

- **「アクティブなときだけ保護する」トグル** — オフにすると裏に回った固定タブの
  自己遷移まで弾ける、という設定だった。しかしブックマークやアドレスバーからの遷移では
  固定タブは必ずアクティブなので、本来の用途では一度も効かない。効くのは
  「バックグラウンドの固定タブをページ自身が別サイトへ動かすとき」の1ケースだけで、
  設定として見合わないと判断して**アクティブ時のみ保護に固定**した。
- **同一サイト判定のモード (ホスト一致 / ドメイン一致)** — ドメイン一致には eTLD+1 が
  必要で、Chrome 拡張から公開サフィックスリストを引く API がないため `co.jp` `co.uk` などを
  自前で列挙する簡易判定を持っていた。削除に伴いこのリストごと不要になった。
  現在は `siteKeyOf()` (スキーム + ホスト) の完全一致のみ。
- **例外的に遷移を許すホストのホワイトリスト** — 別ホストのログイン画面へ飛ぶサイト向けの
  逃げ道だったが、これも削除。その結果、アクティブな固定タブからの別ホストへのログイン
  リダイレクトは新しいタブへ逃がされる。README に制限として明記済み。

判定は `settings.js` の `isAllowedNavigation()` に閉じているので、必要になったら
ここに条件を足すだけで復活できる。

## アイコン

線だけの南京錠。`yt-live-helper` / `yt-quick-filter` に合わせて **fill を使わず
stroke だけ**で描き、**色でオン/オフを表す** (オン `#1A73E8` / オフ `#6E6E6E`)。

**SVG は1枚しか持たない。** 形の定義を二重管理しないよう、OFF 用はビルド時に色を
置換して書き出す。両方を再生成するコマンド:

```bash
for s in 16 32 48 128; do
  rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon$s.png
  sed 's/#1A73E8/#6E6E6E/g' icons/icon.svg | rsvg-convert -w $s -h $s -o icons/icon$s-off.png
done
```

命名は `iconN.png` (=オン、manifest の既定) と `iconN-off.png`。`yt-quick-filter` は
既定オフなので `N.png` / `N-on.png` だが、こちらは既定オンなので逆になっている。

切り替えは `background.js` の `refreshActionIcon()`。`chrome.storage.onChanged` の
`enabled` で呼ぶほか、**service worker の起動時にも毎回呼ぶ**。SW は落ちて起き直るので、
イベント経由だけだと状態とアイコンがずれる。

**`chrome.action.setIcon` の `path` には `chrome.runtime.getURL()` で解決した絶対URLを渡す。**
service worker から相対パスを渡すと解決先が変わって "Failed to fetch" になることがある
(`yt-quick-filter` で踏んだ落とし穴)。

## README のスクリーンショット

`docs/popup.png` は Playwright で実寸 (body 288px) + `deviceScaleFactor: 2` で撮っている。
ポップアップ自身のタブを固定すると「保護が効いている」通常状態 (状態表示が消えてトグルだけ)
になるので、その状態を撮る。README 側は `<img width="288">` で等倍表示に戻している。
UI を変えたら撮り直すこと。

## ポップアップ

トグルは `yt-quick-filter` の `.switch` / `.slider` 方式を踏襲。
`<label class="switch"><input type="checkbox"><span class="slider"></span></label>` の形で、
本物の checkbox を `opacity: 0` で隠してキーボード操作とフォーカスリングを保つ
(`div` にクリックハンドラを付ける方式より素直)。

副作用として **Playwright から `#id` を直接クリックできない** (サイズ0で不可視)。
テストでは `#id + .slider` を叩く。

## ハマりどころ

- **`host_permissions` が必須**。MV3 の `webNavigation` は権限のあるホストのイベント
  しか配信しないため、`"host_permissions": ["<all_urls>"]` が無いと何も起きない。
- **`frameId !== 0` を必ず弾く**。iframe の遷移まで拾うと広告フレームで誤爆する。
- **`siteKeyOf()` は `new URL()` 頼み**。`file://` は host が空文字になるので
  キーが `file://` に潰れる。ローカルファイル間の移動を制限したくなったら
  ここを path 比較に変える必要がある。
- **アクティブ判定 (`tab.active`) を外さない**。バックグラウンドの固定タブまで対象にすると、
  ページ自身が行う遅延リダイレクトを別サイト扱いで弾いてしまう。実測でも
  裏の固定タブの `location.href` 変更が止まることを確認している。
- **打ち消しによる再帰は起きない**。`tabs.update(lockedUrl)` は同一ホストなので
  次の `onBeforeNavigate` では許可され、そこで止まる。

## テスト

### 判定ロジックの単体テスト

`settings.js` は chrome API に依存しないので Node から直接 import できる。
`isAllowedNavigation()` / `registrableDomain()` はこの方法で検証する。

### 実機テスト (Playwright + Brave Browser Nightly)

ワークスペース共通の `browser-testing` skill に従う。リリース版 Chrome は
`--load-extension` を無視するので使わない。

要点:

- 拡張の service worker は `context.serviceWorkers()` で掴める。そこから
  `sw.evaluate(() => chrome.tabs.update(id, { pinned: true }))` でタブを固定できる。
  Playwright 側にタブを固定する API は無いのでこの経路を使う。
- 別サイトの用意にネットワークは不要。ローカル HTTP サーバを1つ立て、
  `http://localhost:PORT` と `http://127.0.0.1:PORT` を「別ホスト」として使い分ける。
- `page.goto()` は CDP の `Page.navigate` = ブラウザ起点の遷移なので、
  アドレスバー入力やブックマーククリックの良い代用になる。
- 打ち消される遷移では `page.goto()` が reject するので `.catch(() => {})` で受ける。

1.0.0 時点で確認済みのケース:

- 同一ホスト遷移は素通し、タブは増えない
- 別ホストは新タブへ退避し、固定タブは元 URL に残る。新タブは1枚だけ
- 固定解除で制限も消える
- 同一ホスト → 別ホストのサーバーリダイレクトも `onCommitted` 側で弾き、タブは増殖しない
- バックグラウンドの固定タブの自己遷移は妨げない
- `chrome-extension://` / `file://` / `chrome://` の固定タブも保護される
