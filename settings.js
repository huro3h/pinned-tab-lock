// 設定と、サイト同一判定のロジック。
// background と popup の両方から読むので独立モジュールにしている。

export const DEFAULTS = {
  enabled: true,
  // 新しいタブページを固定したときも保護するか。既定はオフ。
  // オンにすると「新しいタブを固定してから URL を開く」手順が踏めなくなるため、
  // メモや時計を出す新しいタブを固定したままにしたい人向けの設定。
  protectNewTab: false,
  // 別サイトを逃がした新しいタブにすぐ切り替えるか。
  // オフにするとバックグラウンドで開き、固定タブを見たままでいられる。
  activateNewTab: true,
};

export async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

// 本当に何も読み込まれていない状態。遷移の途中でも現れるので常にロック対象外。
const EMPTY_URL = /^about:/i;

// ブラウザの新しいタブページ。protectNewTab 次第でロック対象になる。
// 新しいタブを別の拡張で置き換えている場合の URL は chrome-extension:// なので
// ここには該当せず、設定に関わらずロック対象になる。
const NEW_TAB_URL =
  /^(chrome|brave|edge|vivaldi|opera):\/\/(newtab|new-tab-page)\/?$/i;

// スキームは問わない。chrome-extension:// や file:// の固定タブも保護する。
export function isLockableUrl(url, protectNewTab = false) {
  if (!url) return false;
  if (EMPTY_URL.test(url)) return false;
  if (!protectNewTab && isNewTabUrl(url)) return false;
  return siteKeyOf(url) !== null;
}

export function isNewTabUrl(url) {
  return typeof url === "string" && NEW_TAB_URL.test(url);
}

// 同一サイトかを比べるためのキー。スキーム + ホストで見る。
//   https://example.com/a      -> "https://example.com"
//   chrome-extension://abc/x   -> "chrome-extension://abc"  (拡張ごとに別サイト)
//   chrome://extensions        -> "chrome://extensions"     (内部ページはページ名がホスト)
//   file:///Users/me/a.html    -> "file://"                 (ローカルファイルは一括り)
export function siteKeyOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// 固定タブ (lockedUrl を表示中) で targetUrl への遷移を許してよいか。
export function isAllowedNavigation(targetUrl, lockedUrl, protectNewTab = false) {
  // 守る対象がまだ無いなら何も制限しない。
  if (!isLockableUrl(lockedUrl, protectNewTab)) return true;
  // about:blank などページ遷移の途中状態は触らない。
  if (typeof targetUrl === "string" && EMPTY_URL.test(targetUrl)) return true;

  const target = siteKeyOf(targetUrl);
  if (!target) return false;

  return target === siteKeyOf(lockedUrl);
}
