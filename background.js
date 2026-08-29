import {
  getSettings,
  isAllowedNavigation,
  isLockableUrl,
} from "./settings.js";

// ── ツールバーアイコン ───────────────────────────────────
// setIcon の path には getURL で解決した絶対URLを渡す。service worker から
// 相対パスを渡すと解決先が変わって "Failed to fetch" になることがある。
function iconSet(suffix) {
  return {
    16: chrome.runtime.getURL(`icons/icon16${suffix}.png`),
    32: chrome.runtime.getURL(`icons/icon32${suffix}.png`),
    48: chrome.runtime.getURL(`icons/icon48${suffix}.png`),
    128: chrome.runtime.getURL(`icons/icon128${suffix}.png`),
  };
}

const ICON_ON = iconSet("");
const ICON_OFF = iconSet("-off");

async function refreshActionIcon() {
  const { enabled } = await getSettings();
  chrome.action.setIcon({ path: enabled ? ICON_ON : ICON_OFF });
  chrome.action.setTitle({
    title: enabled
      ? "Pinned Tab Lock — 保護オン"
      : "Pinned Tab Lock — 保護オフ",
  });
}

// ── 固定タブごとの「守るURL」 ───────────────────────────────
// tabId -> 直近にそのタブで正当に開いていた URL。別サイトへ飛ばされたときの戻り先。
// service worker は頻繁に落ちるので storage.session にミラーする
// (session はディスクに書かれず、ブラウザ終了で消える)。
let locks = null;

async function ensureLocks() {
  if (locks) return locks;
  const stored = await chrome.storage.session.get({ locks: {} });
  locks = stored.locks;
  return locks;
}

function persistLocks() {
  chrome.storage.session.set({ locks });
}

// ブロック直後の二重処理よけ。onBeforeNavigate で弾いたのに稀に commit まで
// 進んだ場合、onCommitted 側のバックストップが新しいタブをもう1枚開いてしまうため。
const recentlyBlocked = new Map();
const BLOCK_TTL_MS = 3000;

function markBlocked(tabId, url) {
  recentlyBlocked.set(`${tabId}|${url}`, Date.now());
}

function wasJustBlocked(tabId, url) {
  const key = `${tabId}|${url}`;
  const at = recentlyBlocked.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < BLOCK_TTL_MS) return true;
  recentlyBlocked.delete(key);
  return false;
}

// ── 判定 ─────────────────────────────────────────────────
// 固定タブが守られる状態かを調べ、守るなら戻り先URLを返す。
// アクティブなときだけ守る。バックグラウンドの固定タブまで対象にすると、
// ページ自身が行う遅延リダイレクトを別サイト扱いで弾いてしまうため。
async function resolveLock(tab, settings) {
  if (!tab || !tab.pinned || !tab.active) return null;

  const map = await ensureLocks();
  const known = map[tab.id];
  if (known) return known;

  // 記録がない (SW再起動・Chrome再起動後など) 場合は今開いているURLを守る対象にする。
  if (!isLockableUrl(tab.url, settings.protectNewTab)) return null;
  map[tab.id] = tab.url;
  persistLocks();
  return tab.url;
}

function divert(tab, targetUrl, lockedUrl, settings) {
  markBlocked(tab.id, targetUrl);
  chrome.tabs.create({
    url: targetUrl,
    active: settings.activateNewTab,
    windowId: tab.windowId,
    openerTabId: tab.id,
  });
  // 固定タブを元のページへ戻す。MV3 には遷移をキャンセルするAPIがないため、
  // ここは「打ち消し」であり固定タブは1回リロードされる。
  chrome.tabs.update(tab.id, { url: lockedUrl });
}

// ── 主防御: 遷移が始まる前に打ち消す ─────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // iframe は対象外

  const settings = await getSettings();
  if (!settings.enabled) return;

  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  const lockedUrl = await resolveLock(tab, settings);
  if (!lockedUrl) return;
  if (isAllowedNavigation(details.url, lockedUrl, settings.protectNewTab)) return;

  divert(tab, details.url, lockedUrl, settings);
});

// ── 副防御 + 守るURLの更新 ───────────────────────────────
// サーバーリダイレクトのように onBeforeNavigate の時点では判定できない遷移を拾う。
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab) return;

  const map = await ensureLocks();

  if (!tab.pinned) {
    if (map[details.tabId] !== undefined) {
      delete map[details.tabId];
      persistLocks();
    }
    return;
  }

  const settings = await getSettings();
  const lockedUrl = settings.enabled ? map[details.tabId] : undefined;

  if (
    lockedUrl &&
    tab.active &&
    !wasJustBlocked(details.tabId, details.url) &&
    !isAllowedNavigation(details.url, lockedUrl, settings.protectNewTab)
  ) {
    divert(tab, details.url, lockedUrl, settings);
    return;
  }

  // 許された遷移なので、以後の戻り先はこのURLにする。
  if (
    isLockableUrl(details.url, settings.protectNewTab) &&
    map[details.tabId] !== details.url
  ) {
    map[details.tabId] = details.url;
    persistLocks();
  }
});

// ── ロックの登録・破棄 ───────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.pinned === undefined) return;

  const map = await ensureLocks();
  if (changeInfo.pinned) {
    // 固定した瞬間に開いていたサイトがそのタブの持ち場になる。
    const { protectNewTab } = await getSettings();
    if (isLockableUrl(tab.url, protectNewTab)) map[tabId] = tab.url;
  } else {
    delete map[tabId];
  }
  persistLocks();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await ensureLocks();
  if (map[tabId] === undefined) return;
  delete map[tabId];
  persistLocks();
});

// ── 起動時の同期 ─────────────────────────────────────────
async function bootstrap() {
  const [pinned, settings] = await Promise.all([
    chrome.tabs.query({ pinned: true }),
    getSettings(),
  ]);
  const map = {};
  for (const tab of pinned) {
    if (isLockableUrl(tab.url, settings.protectNewTab)) map[tab.id] = tab.url;
  }
  locks = map;
  persistLocks();
}

chrome.runtime.onStartup.addListener(bootstrap);
chrome.runtime.onInstalled.addListener(bootstrap);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  // protectNewTab を切り替えると、どの固定タブがロック対象かが変わる。
  // 既に固定済みのタブに即座に反映させるため、ロックを取り直す。
  if (changes.protectNewTab) bootstrap();
  if (changes.enabled) refreshActionIcon();
});

// service worker は落ちて起き直るので、起き直すたびにアイコンを現在の状態へ揃える。
refreshActionIcon();
