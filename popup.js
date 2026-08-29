import { getSettings, isLockableUrl, isNewTabUrl } from "./settings.js";

const el = {
  enabled: document.getElementById("enabled"),
  activateNewTab: document.getElementById("activateNewTab"),
  protectNewTab: document.getElementById("protectNewTab"),
  state: document.getElementById("state"),
  status: document.getElementById("status"),
};

let statusTimer = null;

function flash(message) {
  el.status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.status.textContent = "";
  }, 1200);
}

// 保護が効いていないときだけ理由を出す。効いているときは何も言わない。
function stateMessage(tab, settings) {
  if (!settings.enabled) return "保護は現在オフです。";
  if (!tab.pinned) {
    return "このタブは固定されていません。タブを右クリック →「固定」で保護されます。";
  }
  if (!isLockableUrl(tab.url, settings.protectNewTab)) {
    return isNewTabUrl(tab.url)
      ? "固定タブですが、新しいタブページは保護対象外です。下の設定でオンにできます。"
      : "固定タブですが、まだページが開かれていないため保護対象がありません。";
  }
  return "";
}

async function renderState(settings) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const message = stateMessage(tab, settings);
  el.state.textContent = message;
  el.state.classList.toggle("hidden", message === "");
}

async function save(patch) {
  await chrome.storage.sync.set(patch);
  flash("保存しました");
  await renderState(await getSettings());
}

async function init() {
  const settings = await getSettings();
  el.enabled.checked = settings.enabled;
  el.activateNewTab.checked = settings.activateNewTab;
  el.protectNewTab.checked = settings.protectNewTab;
  await renderState(settings);

  el.enabled.addEventListener("change", () =>
    save({ enabled: el.enabled.checked })
  );
  el.activateNewTab.addEventListener("change", () =>
    save({ activateNewTab: el.activateNewTab.checked })
  );
  el.protectNewTab.addEventListener("change", () =>
    save({ protectNewTab: el.protectNewTab.checked })
  );
}

init();
