/* STREAM 前端逻辑
 * 目录层级：根目录 → 类别(顶栏) → 影片(内容区) → 分集目录/分集视频
 */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const state = {
    items: [],
    root: "",
    scanComplete: true,
    playerMode: "web",          // web | system
    extPlayer: "default",       // default | vlc | mpv | custom（系统播放器模式下生效）
    playerPath: "",             // 自定义播放器路径
    cardSize: "medium",         // small | medium | large
    cardRatio: "16:9",          // 16:9 | 21:9 | 4:3 | 3:4 | 9:16
    cardTitle: false,           // 在卡片上直接显示名称
    coverRev: {},               // show_key → 时间戳，自定义封面后破缓存
    collections: [],            // 自定义栏目 [{name, shows:[cat/show]}]
    history: [],                // 观看历史 [{id, played_at, ...item}]
    query: "",
    view: { type: "home" },     // home | {type:"category",cat} | {type:"show",cat,show}
    showSeason: null,           // 剧集页当前选中季
    playList: [],
    playIndex: -1,
    detailId: null,
    pollTimer: null,
    searchTimer: null,
  };

  const els = {
    navbar: $("#navbar"),
    catNav: $("#catNav"),
    searchInput: $("#searchInput"),
    refreshBtn: $("#refreshBtn"),
    settingsBtn: $("#settingsBtn"),
    loading: $("#loading"),
    hero: $("#hero"),
    heroImg: $("#heroImg"),
    heroCat: $("#heroCat"),
    heroTitle: $("#heroTitle"),
    heroMeta: $("#heroMeta"),
    heroDesc: $("#heroDesc"),
    heroPlay: $("#heroPlay"),
    heroInfo: $("#heroInfo"),
    rows: $("#rows"),
    emptyState: $("#emptyState"),
    playerModal: $("#playerModal"),
    playerClose: $("#playerClose"),
    playerTitle: $("#playerTitle"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    videoEl: $("#videoEl"),
    detailModal: $("#detailModal"),
    detailClose: $("#detailClose"),
    detailImg: $("#detailImg"),
    detailTitle: $("#detailTitle"),
    detailMeta: $("#detailMeta"),
    detailPath: $("#detailPath"),
    detailPlay: $("#detailPlay"),
    settingsModal: $("#settingsModal"),
    settingsClose: $("#settingsClose"),
    rootInput: $("#rootInput"),
    nameModal: $("#nameModal"),
    nameTitle: $("#nameTitle"),
    nameTip: $("#nameTip"),
    nameInput: $("#nameInput"),
    nameError: $("#nameError"),
    nameOk: $("#nameOk"),
    nameCancel: $("#nameCancel"),
    nameClose: $("#nameClose"),
    confirmModal: $("#confirmModal"),
    confirmTitle: $("#confirmTitle"),
    confirmTip: $("#confirmTip"),
    confirmError: $("#confirmError"),
    confirmOk: $("#confirmOk"),
    confirmCancel: $("#confirmCancel"),
    exportDataBtn: $("#exportDataBtn"),
    importDataBtn: $("#importDataBtn"),
    importDataFile: $("#importDataFile"),
    regenThumbsBtn: $("#regenThumbsBtn"),
    lanGroup: $("#lanGroup"),
    lanTip: $("#lanTip"),
    browseBtn: $("#browseBtn"),
    playerModeGroup: $("#playerModeGroup"),
    playerChoiceSection: $("#playerChoiceSection"),
    playerChoiceGroup: $("#playerChoiceGroup"),
    customPathRow: $("#customPathRow"),
    playerPathInput: $("#playerPathInput"),
    browseExeBtn: $("#browseExeBtn"),
    cardSizeGroup: $("#cardSizeGroup"),
    cardRatioGroup: $("#cardRatioGroup"),
    cardTitleGroup: $("#cardTitleGroup"),
    settingsError: $("#settingsError"),
    settingsCancel: $("#settingsCancel"),
    settingsSave: $("#settingsSave"),
    emptySettingsBtn: $("#emptySettingsBtn"),
    toast: $("#toast"),
  };

  // ---------------- 工具 ----------------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const natkey = (s) => String(s).split(/(\d+)/).map((t) =>
    (/^\d+$/.test(t) ? [0, parseInt(t, 10)] : [1, t.toLowerCase()]));

  const natcmp = (a, b) => {
    const ka = natkey(a), kb = natkey(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i][0] !== kb[i][0]) return ka[i][0] - kb[i][0];
      if (ka[i][1] !== kb[i][1]) return ka[i][1] < kb[i][1] ? -1 : 1;
    }
    return ka.length - kb.length;
  };

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function fmtDur(sec) {
    if (!sec && sec !== 0) return "";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  function fmtDate(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
  }

  const PLAY_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const FILM_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="7" y1="4" x2="7" y2="20"/><line x1="17" y1="4" x2="17" y2="20"/><line x1="2" y1="9" x2="7" y2="9"/><line x1="2" y1="15" x2="7" y2="15"/><line x1="17" y1="9" x2="22" y2="9"/><line x1="17" y1="15" x2="22" y2="15"/></svg>`;
  const BACK_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg>`;

  const thumbURL = (item) => `/api/thumb?id=${encodeURIComponent(item.id)}`;

  // 剧目封面：优先自定义封面（后端 /api/poster），r 参数用于更换封面后破缓存
  const posterURL = (item, key) =>
    `/api/poster?show_key=${encodeURIComponent(key)}&first=${encodeURIComponent(item.id)}&r=${state.coverRev[key] || 0}`;

  // 卡片大小/比例/名称 → CSS 变量与 body 类（作用于网格与首页横向行）
  function applyCardPrefs() {
    const rowCards = { small: 8, medium: 6, large: 4 }[state.cardSize] || 6;
    const ratio = String(state.cardRatio || "16:9").replace(":", " / ");
    const rs = document.documentElement.style;
    rs.setProperty("--row-cards", String(rowCards));
    rs.setProperty("--card-ratio", ratio);
    document.body.classList.toggle("card-titles", !!state.cardTitle);
  }

  // ---------------- 数据 ----------------

  async function fetchLibrary() {
    const res = await fetch("/api/library");
    const data = await res.json();
    state.items = data.items;
    state.root = data.root;
    state.scanComplete = data.scan_complete;
  }

  async function fetchConfig() {
    try {
      const data = await (await fetch("/api/config")).json();
      state.lanMode = !!data.lan_mode;
      state.clientLocal = data.client_local !== false;
      // 局域网远程客户端只能网页播放（系统播放器会在服务器端弹窗）
      state.playerMode = data.player_mode === "system" && state.clientLocal ? "system" : "web";
      state.extPlayer = ["default", "vlc", "mpv", "custom"].includes(data.external_player)
        ? data.external_player : "default";
      state.playerPath = data.player_path || "";
      state.cardSize = ["small", "medium", "large"].includes(data.card_size) ? data.card_size : "medium";
      state.cardRatio = ["16:9", "21:9", "4:3", "3:4", "9:16"].includes(data.card_ratio) ? data.card_ratio : "16:9";
      state.cardTitle = !!data.card_title;
      state.lanUrl = data.lan_url || "";
      applyCardPrefs();
    } catch { /* 保持默认 */ }
  }

  const categories = () =>
    [...new Set(state.items.map((i) => i.category))].sort(natcmp);

  // 影片分组：cat/show → {cat, show, isMovie, eps, seasons:Map, seasonKeys}
  function groupShows(items) {
    const map = new Map();
    for (const it of items) {
      const key = `${it.category}/${it.show}`;
      if (!map.has(key)) map.set(key, {
        cat: it.category, show: it.show, isMovie: false,
        eps: [], seasons: new Map(),
      });
      const g = map.get(key);
      g.eps.push(it);
      if (it.is_movie) g.isMovie = true;
      const sKey = it.season || "";
      if (!g.seasons.has(sKey)) g.seasons.set(sKey, []);
      g.seasons.get(sKey).push(it);
    }
    for (const g of map.values()) {
      for (const arr of g.seasons.values()) arr.sort((a, b) => natcmp(a.title, b.title));
      g.seasonKeys = [...g.seasons.keys()].sort((a, b) =>
        a === "" ? -1 : b === "" ? 1 : natcmp(a, b));
    }
    return map;
  }

  const showKey = (cat, show) => `${cat}/${show}`;

  // 拉取「我的」数据：自定义栏目 + 观看历史
  async function refreshMineData() {
    try {
      const [c, h] = await Promise.all([
        fetch("/api/collections").then((r) => r.json()),
        fetch("/api/history").then((r) => r.json()),
      ]);
      state.collections = c.items || [];
      state.history = h.items || [];
    } catch { /* 忽略 */ }
  }

  function findShow(cat, show) {
    return groupShows(state.items).get(showKey(cat, show));
  }

  // 非首页视图顶栏实底（内联样式，避免半透明渐变导致内容透出重叠）
  function setNavSolid(on) {
    els.navbar.classList.toggle("solid", on);
    els.navbar.style.setProperty("background-color", on ? "#141414" : "", "important");
    els.navbar.style.setProperty("background-image", on ? "none" : "", on ? "important" : "");
  }

  // ---------------- 视图渲染 ----------------

  function cardShell(posterItem, innerBadge, subHTML, showKeyStr) {
    const src = showKeyStr ? posterURL(posterItem, showKeyStr) : thumbURL(posterItem);
    return `
      <div class="thumb-wrap">
        <div class="thumb-fallback">${FILM_ICON}<span>${esc(posterItem.show || posterItem.title)}</span></div>
        <img data-src="${src}" alt="">
        ${innerBadge}
        <div class="card-overlay">
          <button class="card-play" title="播放">${PLAY_ICON}</button>
          <div class="card-info">
            <div class="card-title">${esc(posterItem.show || posterItem.title)}</div>
            <div class="card-sub">${subHTML || ""}</div>
          </div>
        </div>
      </div>`;
  }

  // 影片卡片（电影 = 单视频直接播；剧集 = 进入详情页）
  function showCardHTML(g) {
    const poster = g.eps[0];
    const badge = g.isMovie
      ? (poster.res_label ? `<span class="badge res">${poster.res_label}</span>` : `<span class="badge res" data-badge hidden></span>`)
      : `<span class="badge res count-chip">${g.eps.length} 集</span>`;
    const sub = g.isMovie
      ? `${fmtDur(poster.duration) || "--:--"}<span class="dot">·</span>${fmtSize(poster.size)}`
      : `${g.seasonKeys.length > 1 || g.seasonKeys[0] !== "" ? g.seasonKeys.length + " 季" : "正片"}<span class="dot">·</span>${g.eps.length} 集`;
    return `
      <div class="card show-card" data-show="${esc(showKey(g.cat, g.show))}" data-cat="${esc(g.cat)}">
        ${cardShell(poster, badge, sub, showKey(g.cat, g.show))}
      </div>`;
  }

  // 分集卡片（点击直接播放）
  function epCardHTML(item, epIndex) {
    const dur = fmtDur(item.duration);
    return `
      <div class="card ep-card" data-id="${item.id}">
        <div class="thumb-wrap">
          <div class="thumb-fallback">${FILM_ICON}<span>${esc(item.title)}</span></div>
          <img data-src="${thumbURL(item)}" alt="${esc(item.title)}">
          ${epIndex != null ? `<span class="badge res">第 ${epIndex} 集</span>`
            : item.res_label ? `<span class="badge res">${item.res_label}</span>`
            : `<span class="badge res" data-badge hidden></span>`}
          ${item.playable ? "" : `<span class="badge fmt">浏览器不支持</span>`}
          <div class="card-overlay">
            <button class="card-play" title="播放">${PLAY_ICON}</button>
            <div class="card-info">
              <div class="card-title">${esc(item.title)}</div>
              <div class="card-sub">
                <span data-dur>${dur || "--:--"}</span><span class="dot">·</span>
                <span data-size>${fmtSize(item.size)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function rowHTML(name, cardsHTML, actionHTML = "") {
    return `
      <section class="row">
        <div class="row-head">
          <h2 class="row-title">${esc(name)}<span class="explore"></span></h2>
          ${actionHTML}
          <span class="row-count"></span>
        </div>
        <button class="row-arrow left" aria-label="向左">
          <svg viewBox="0 0 24 44" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="17 3 5 22 17 41"/></svg>
        </button>
        <button class="row-arrow right" aria-label="向右">
          <svg viewBox="0 0 24 44" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="7 3 19 22 7 41"/></svg>
        </button>
        <div class="row-scroller">${cardsHTML}</div>
      </section>`;
  }

  // ---- 首页：Hero + 最近添加 + 各类别影片行 ----
  function renderHome() {
    if (!state.items.length) {
      els.hero.classList.add("hidden");
      els.rows.innerHTML = "";
      els.emptyState.classList.remove("hidden");
      return;
    }
    els.emptyState.classList.add("hidden");
    els.hero.classList.remove("hidden");
    renderHero();

    const shows = [...groupShows(state.items).values()].sort((a, b) =>
      a.cat === "其他" ? 1 : b.cat === "其他" ? -1 : natcmp(a.cat, b.cat) || natcmp(a.show, b.show));
    const recent = [...state.items].sort((a, b) => b.mtime - a.mtime).slice(0, 30);
    // 最近添加 + 按类别逐行
    let html = rowHTML("最近添加", recent.map((it) => epCardHTML(it, null)).join(""));
    for (const c of categories()) {
      const cards = shows.filter((g) => g.cat === c).map(showCardHTML).join("");
      if (cards) html += rowHTML(c, cards);
    }
    setNavSolid(false);
    els.rows.classList.remove("searching");
    els.rows.classList.add("home");
    els.rows.innerHTML = html;
    afterRender();
  }

  // ---- 分类页：该类别下所有影片 ----
  function renderCategory(catName) {
    els.hero.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    const shows = [...groupShows(state.items).values()]
      .filter((g) => g.cat === catName)
      .sort((a, b) => natcmp(a.show, b.show));
    const html = `
      <div class="page-head"><h1>${esc(catName)}</h1><div class="sub">${shows.length} 部影片</div></div>
      <div class="results-grid">${shows.map(showCardHTML).join("")}</div>`;
    setNavSolid(true);
    els.rows.classList.remove("searching", "home");
    els.rows.innerHTML = html;
    afterRender();
  }

  // ---- 剧集页：横幅 + 分季标签 + 分集网格 ----
  function renderShow(catName, showName) {
    const g = findShow(catName, showName);
    if (!g) { setView({ type: "home" }); return; }
    els.hero.classList.add("hidden");
    els.emptyState.classList.add("hidden");

    if (state.showSeason == null || !g.seasons.has(state.showSeason)) {
      state.showSeason = g.seasonKeys[0];
    }
    const eps = g.seasons.get(state.showSeason) || [];
    const first = g.eps[0];
    const totalDur = g.eps.reduce((s, e) => s + (e.duration || 0), 0);
    const seasonLabel = (k) => (k === "" ? "正片" : k);

    const tabs = g.seasonKeys.length > 1 || g.seasonKeys[0] !== ""
      ? `<div class="season-tabs">${g.seasonKeys.map((k) =>
          `<button class="season-tab${k === state.showSeason ? " active" : ""}" data-season="${esc(k)}">${esc(seasonLabel(k))}（${g.seasons.get(k).length}）</button>`).join("")}</div>`
      : "";

    const meta = [`<span class="match">${g.eps.length} 集</span>`];
    if (totalDur) meta.push(`<span>总时长 ${fmtDur(totalDur)}</span>`);
    const res = g.eps.find((e) => e.res_label)?.res_label;
    if (res) meta.push(`<span class="tag-pill">${res}</span>`);

    const html = `
      <button class="back-btn" id="backBtn">${BACK_ICON} 返回${esc(catName)}</button>
      <section class="show-banner">
        <div class="hero-bg">
          <img src="${posterURL(first, showKey(catName, showName))}" alt="">
          <div class="hero-fade"></div>
        </div>
        <div class="show-banner-content">
          <div class="hero-tag">
            <span class="hero-brand">STREAM</span>
            <span class="hero-cat">${esc(catName)}</span>
          </div>
          <h1>${esc(showName)}</h1>
          <div class="hero-meta">${meta.join("")}</div>
          <div class="hero-actions">
            <button class="btn btn-play" id="showPlay">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              播放
            </button>
          </div>
        </div>
      </section>
      ${tabs}
      <div class="results-grid" id="epGrid">${eps.map((e, i) => epCardHTML(e, i + 1)).join("")}</div>`;
    // 导航栏保持透底，横幅从页面最顶端铺满；滚动后由全局 .scrolled 逻辑自动切实底
    setNavSolid(false);
    els.rows.classList.remove("searching", "home");
    els.rows.innerHTML = html;

    $("#backBtn").addEventListener("click", () => setView({ type: "category", cat: catName }));
    $("#showPlay").addEventListener("click", () => {
      const list = g.seasons.get(state.showSeason) || [];
      if (list.length) playItem(list[0], list);
    });
    els.rows.querySelectorAll(".season-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.showSeason = tab.dataset.season;
        renderShow(catName, showName);
      });
    });
    afterRender();
  }

  // ---- 我的页：观看历史 + 自定义栏目 ----
  function rowHTMLColl(name, cardsHTML) {
    const inner = cardsHTML || `<div class="col-empty">暂无内容，右键任意剧集卡片可加入</div>`;
    return `
      <section class="row" data-col="${esc(name)}">
        <div class="row-head">
          <h2 class="row-title">${esc(name)}</h2>
          <button class="col-del" data-col-del="${esc(name)}" title="删除栏目">✕</button>
          <span class="row-count"></span>
        </div>
        <button class="row-arrow left" aria-label="向左">
          <svg viewBox="0 0 24 44" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="17 3 5 22 17 41"/></svg>
        </button>
        <button class="row-arrow right" aria-label="向右">
          <svg viewBox="0 0 24 44" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="7 3 19 22 7 41"/></svg>
        </button>
        <div class="row-scroller">${inner}</div>
      </section>`;
  }

  function renderMine() {
    els.hero.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    setNavSolid(true);
    const groups = groupShows(state.items);
    const histItems = state.history
      .map((h) => state.items.find((i) => i.id === h.id))
      .filter(Boolean)
      .slice(0, 30);

    let html = `<div class="page-head"><h1>我的</h1><div class="sub">观看记录与自定义栏目</div></div>`;
    html += histItems.length
      ? rowHTML("历史", histItems.map((it) => epCardHTML(it, null)).join(""),
        `<button class="hist-clear" id="histClearBtn" title="清空观看历史">清空</button>`)
      : `<div class="no-result">暂无观看记录，去首页挑一部影片吧</div>`;
    for (const col of state.collections) {
      const cards = (col.shows || [])
        .map((k) => groups.get(k)).filter(Boolean)
        .map(showCardHTML).join("");
      html += rowHTMLColl(col.name, cards);
    }
    if (!state.collections.length)
      html += `<div class="no-result">还没有自定义栏目，右键任意剧集卡片即可加入</div>`;
    html += `<div class="mine-new"><button class="btn btn-ghost" id="newColBtn">＋ 新建栏目</button></div>`;
    els.rows.classList.remove("searching", "home");
    els.rows.innerHTML = html;
    afterRender();
    const nb = $("#newColBtn");
    if (nb) nb.addEventListener("click", () => createCollection());
    const hc = $("#histClearBtn");
    if (hc) hc.addEventListener("click", clearHistory);
  }

  async function clearHistory() {
    const ok = await askConfirm({
      title: "清空观看历史",
      tip: "将删除全部观看记录，此操作不可恢复。",
      okText: "清空",
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/history", { method: "DELETE" });
      if (!res.ok) { toast("清空失败"); return; }
      state.history = [];
      renderView();
      toast("已清空观看历史");
    } catch { toast("清空失败"); }
  }

  // ---- 自定义输入弹窗（代替浏览器 prompt）----
  let nameModalDone = null;

  function closeNameModal() {
    els.nameModal.classList.add("hidden");
    if (nameModalDone) { const d = nameModalDone; nameModalDone = null; d(null); }
  }

  function askName(opts = {}) {
    return new Promise((resolve) => {
      els.nameTitle.textContent = opts.title || "新建栏目";
      els.nameTip.textContent = opts.tip || "为栏目取一个名称";
      els.nameOk.textContent = opts.okText || "创建";
      els.nameInput.value = "";
      els.nameError.classList.add("hidden");
      els.nameModal.classList.remove("hidden");
      els.nameInput.focus();
      nameModalDone = resolve;
      const submit = () => {
        const v = els.nameInput.value.trim();
        if (!v) {
          els.nameError.textContent = "名称不能为空";
          els.nameError.classList.remove("hidden");
          return;
        }
        els.nameModal.classList.add("hidden");
        nameModalDone = null;
        resolve(v);
      };
      els.nameOk.onclick = submit;
      els.nameCancel.onclick = closeNameModal;
      els.nameClose.onclick = closeNameModal;
      els.nameInput.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    });
  }

  // ---- 确认弹窗（代替浏览器 confirm）----
  let confirmModalDone = null;

  function closeConfirmModal() {
    els.confirmModal.classList.add("hidden");
    if (confirmModalDone) { const d = confirmModalDone; confirmModalDone = null; d(false); }
  }

  function askConfirm(opts = {}) {
    return new Promise((resolve) => {
      els.confirmTitle.textContent = opts.title || "确认操作";
      els.confirmTip.textContent = opts.tip || "";
      els.confirmOk.textContent = opts.okText || "确定";
      els.confirmError.classList.add("hidden");
      els.confirmModal.classList.remove("hidden");
      els.confirmOk.focus();
      confirmModalDone = resolve;
      els.confirmOk.onclick = () => {
        els.confirmModal.classList.add("hidden");
        confirmModalDone = null;
        resolve(true);
      };
      els.confirmCancel.onclick = closeConfirmModal;
    });
  }

  async function createCollection() {
    const name = await askName();
    if (!name) return;
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await res.json();
      if (!res.ok) { toast(d.detail || "创建失败"); return; }
      await refreshMineData();
      renderView();
      toast(`已创建栏目「${name}」`);
    } catch { toast("创建失败"); }
  }

  // ---- 搜索 ----
  function renderSearch() {
    const q = state.query.trim().toLowerCase();
    els.hero.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    els.rows.classList.add("searching");
    if (!q) { setView(state.lastView || { type: "home" }); return; }
    const hits = state.items.filter((it) =>
      it.title.toLowerCase().includes(q) || it.show.toLowerCase().includes(q)
      || it.category.toLowerCase().includes(q));
    let html = `<div class="page-head"><h1>搜索结果</h1><div class="sub">「${esc(state.query)}」— ${hits.length} 个视频</div></div>`;
    html += hits.length
      ? `<div class="results-grid">${hits.map((it) => epCardHTML(it, null)).join("")}</div>`
      : `<div class="no-result">没有找到与「${esc(state.query)}」匹配的视频</div>`;
    setNavSolid(true);
    els.rows.classList.remove("home");
    els.rows.innerHTML = html;
    afterRender();
  }

  function setView(view) {
    state.view = view;
    state.showSeason = null;
    renderView();
    window.scrollTo({ top: 0 });
  }

  function renderView() {
    renderNav();
    if (state.view.type === "category") renderCategory(state.view.cat);
    else if (state.view.type === "show") renderShow(state.view.cat, state.view.show);
    else if (state.view.type === "mine") renderMine();
    else renderHome();
  }

  function renderHero() {
    const withMeta = state.items.filter((i) => i.duration);
    const pool = withMeta.length ? withMeta : state.items;
    if (!pool.length) { els.hero.classList.add("hidden"); return; }
    const item = pool[Math.floor(Math.random() * pool.length)];
    els.hero.dataset.id = item.id;
    els.heroCat.textContent = `${item.category} · ${item.show}`;
    els.heroTitle.textContent = item.is_movie ? item.title : `${item.show} · ${item.title}`;
    els.heroImg.src = thumbURL(item);
    const meta = [];
    if (item.res_label) meta.push(`<span class="match">${item.res_label}</span>`);
    if (item.duration) meta.push(`<span>${fmtDur(item.duration)}</span>`);
    meta.push(`<span class="tag-pill">${item.ext.toUpperCase()}</span>`);
    meta.push(`<span>${fmtSize(item.size)}</span>`);
    meta.push(`<span>${fmtDate(item.mtime)}</span>`);
    els.heroMeta.innerHTML = meta.join("");
    els.heroDesc.textContent = item.relpath;
  }

  // ---- 顶栏导航 ----
  function renderNav() {
    const cats = categories();
    let html = `<a href="#" data-view="home" class="${state.view.type === "home" ? "active" : ""}">首页</a>`;
    for (const c of cats) {
      const active = state.view.type !== "home" && state.view.type !== "mine" && state.view.cat === c;
      html += `<a href="#" data-view="cat:${c}" class="${active ? "active" : ""}">${esc(c)}</a>`;
    }
    html += `<a href="#" data-view="mine" class="${state.view.type === "mine" ? "active" : ""}">我的</a>`;
    els.catNav.innerHTML = html;
  }

  els.catNav.addEventListener("click", async (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    const v = a.dataset.view;
    if (v === "home") setView({ type: "home" });
    else if (v === "mine") {
      await refreshMineData();
      setView({ type: "mine" });
    } else setView({ type: "category", cat: v.slice(4) });
  });

  // ---------------- 渲染后统一绑定 ----------------

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      io.unobserve(img);
      img.src = img.dataset.src;
      img.addEventListener("load", () => {
        img.classList.add("loaded");
        const fb = img.parentElement.querySelector(".thumb-fallback");
        if (fb) fb.remove();
      });
    }
  }, { rootMargin: "300px" });

  function afterRender() {
    els.rows.querySelectorAll("img[data-src]").forEach((img) => io.observe(img));
    bindRowArrows();
    bindCardClicks();
  }

  function bindRowArrows() {
    els.rows.querySelectorAll(".row").forEach((row) => {
      const scroller = row.querySelector(".row-scroller");
      const [left, right] = row.querySelectorAll(".row-arrow");
      const updateArrows = () => {
        left.classList.toggle("visible", scroller.scrollLeft > 10);
        right.classList.toggle("visible",
          scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 10);
      };
      scroller.addEventListener("scroll", updateArrows, { passive: true });
      updateArrows();
      left.addEventListener("click", () => scroller.scrollBy({ left: -scroller.clientWidth * 0.9 }));
      right.addEventListener("click", () => scroller.scrollBy({ left: scroller.clientWidth * 0.9 }));
    });
  }

  let rowsBound = false;
  function bindCardClicks() {
    if (rowsBound) return;  // els.rows 不会被替换，只绑定一次，避免外部播放器被重复唤起
    rowsBound = true;
    els.rows.addEventListener("click", (ev) => {
      const delBtn = ev.target.closest("[data-col-del]");
      if (delBtn) {
        const name = delBtn.dataset.colDel;
        if (confirm(`删除栏目「${name}」？`)) {
          fetch(`/api/collections?name=${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(refreshMineData)
            .then(() => { renderView(); toast("栏目已删除"); })
            .catch(() => toast("删除失败"));
        }
        return;
      }
      const showCard = ev.target.closest(".show-card");
      if (showCard) {
        const [cat, show] = showCard.dataset.show.split(/\/(.+)/);
        const g = findShow(cat, show);
        if (!g) return;
        if (g.isMovie && g.eps.length === 1) {
          playItem(g.eps[0], [g.eps[0]]);          // 单部电影 → 直接播
        } else if (ev.target.closest(".card-play")) {
          const first = g.seasons.get(g.seasonKeys[0]) || [];
          if (first.length) playItem(first[0], first); // 剧集播放键 → 第一集
        } else {
          setView({ type: "show", cat, show });        // 剧集 → 详情页
        }
        return;
      }
      const epCard = ev.target.closest(".ep-card");
      if (epCard) {
        const item = state.items.find((i) => i.id === epCard.dataset.id);
        if (!item) return;
        const grid = epCard.closest(".results-grid, .row-scroller");
        const list = grid
          ? [...grid.querySelectorAll(".ep-card")].map((c) =>
              state.items.find((i) => i.id === c.dataset.id)).filter(Boolean)
          : [item];
        playItem(item, list.length ? list : [item]);
      }
    });
  }

  // ---------------- 播放 ----------------

  function playItem(item, list) {
    // 记录观看历史（网页/系统播放器都记录）
    fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id }),
    }).catch(() => {});
    if (state.playerMode === "system") {
      fetch(`/api/open-external?id=${encodeURIComponent(item.id)}`, { method: "POST" })
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).detail || "failed");
          toast(`已用系统播放器打开：${item.title}`);
        })
        .catch(() => toast("无法启动系统播放器"));
      return;
    }
    openPlayer(item, list);
  }

  function openPlayer(item, list) {
    state.playList = list;
    state.playIndex = list.findIndex((i) => i.id === item.id);
    els.playerModal.classList.add("open");
    document.body.classList.add("no-scroll");
    els.videoEl.src = `/api/video?id=${encodeURIComponent(item.id)}`;
    els.playerTitle.innerHTML =
      `${esc(item.show && !item.is_movie ? `${item.show} · ${item.title}` : item.title)}<small>${esc(item.category)}</small>`;
    els.videoEl.play().catch(() => {});
    updateSwitchBtns();
    setTimeout(() => { const h = $(".player-hint"); if (h) h.style.opacity = "0"; }, 3500);
  }

  function closePlayer() {
    els.videoEl.pause();
    els.videoEl.removeAttribute("src");
    els.videoEl.load();
    els.playerModal.classList.remove("open");
    document.body.classList.remove("no-scroll");
  }

  function step(dir) {
    const next = state.playIndex + dir;
    if (next < 0 || next >= state.playList.length) return;
    openPlayer(state.playList[next], state.playList);
  }

  function updateSwitchBtns() {
    els.prevBtn.disabled = state.playIndex <= 0;
    els.nextBtn.disabled = state.playIndex >= state.playList.length - 1;
  }

  function openDetail(item) {
    state.detailId = item.id;
    els.detailImg.src = thumbURL(item);
    els.detailTitle.textContent = item.is_movie || !item.show ? item.title : `${item.show} · ${item.title}`;
    const meta = [];
    meta.push(`<span class="match">${item.playable ? "可播放" : "需转码"}</span>`);
    if (item.res_label) meta.push(`<span>${item.res_label} (${item.width}×${item.height})</span>`);
    if (item.duration) meta.push(`<span>${fmtDur(item.duration)}</span>`);
    meta.push(`<span class="tag-pill">${item.ext.toUpperCase()}</span>`);
    meta.push(`<span>${fmtSize(item.size)}</span>`);
    meta.push(`<span>添加于 ${fmtDate(item.mtime)}</span>`);
    els.detailMeta.innerHTML = meta.join("");
    els.detailPath.textContent = item.relpath;
    els.detailModal.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  function closeDetail() {
    state.detailId = null;
    els.detailModal.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }

  const setRadio = (group, val) => {
    const r = group && group.querySelector(`input[value="${val}"]`);
    if (r) r.checked = true;
  };

  // 播放方式/播放器选择联动显示
  function updatePlayerChoiceUI() {
    const isSystem = els.playerModeGroup.querySelector("input[name=playerMode]:checked")?.value === "system";
    els.playerChoiceSection.hidden = !isSystem;
    const ep = els.playerChoiceGroup.querySelector("input[name=extPlayer]:checked")?.value || "default";
    els.customPathRow.classList.toggle("hidden", ep !== "custom");
  }

  // 局域网模式提示文案（开启时显示实际访问地址）
  function updateLanUI() {
    const on = els.lanGroup.querySelector("input[name=lanMode]:checked")?.value === "on";
    els.lanTip.textContent = on
      ? `局域网设备可通过 ${state.lanUrl || "http://<本机IP>:8501"} 访问（重启应用后生效）；远程设备无法修改媒体目录`
      : "开启后同一局域网内的设备可访问本媒体库（重启应用后生效）";
  }

  async function openSettings() {
    els.rootInput.value = state.root;
    els.settingsError.classList.add("hidden");
    setRadio(els.playerModeGroup, state.playerMode);
    setRadio(els.playerChoiceGroup, state.extPlayer);
    setRadio(els.cardSizeGroup, state.cardSize);
    setRadio(els.cardRatioGroup, state.cardRatio);
    setRadio(els.cardTitleGroup, state.cardTitle ? "on" : "off");
    setRadio(els.lanGroup, state.lanMode ? "on" : "off");
    els.playerPathInput.value = state.playerPath;
    // 局域网远程客户端：锁定媒体目录（仅本机可改）+ 禁用系统播放器
    const remote = !state.clientLocal;
    els.rootInput.disabled = remote;
    els.browseBtn.disabled = remote;
    if (remote) els.rootInput.placeholder = "局域网模式下仅本机可修改媒体目录";
    const sysRadio = els.playerModeGroup.querySelector('input[name=playerMode][value=system]');
    sysRadio.disabled = remote;
    sysRadio.closest(".radio-item").querySelector(".radio-desc").textContent =
      remote ? "局域网模式下仅本机可使用" : "调用下方选择的外部播放器打开";
    if (remote && state.playerMode === "system") setRadio(els.playerModeGroup, "web");
    updatePlayerChoiceUI();
    updateLanUI();
    els.settingsModal.classList.remove("hidden");
    if (!remote) els.rootInput.focus();
  }

  function closeSettings() {
    els.settingsModal.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }

  // 元数据补丁：后台扫描进行中只更新时长/清晰度，不重绘
  function patchMeta() {
    const byId = new Map(state.items.map((i) => [i.id, i]));
    els.rows.querySelectorAll(".card[data-id]").forEach((card) => {
      const item = byId.get(card.dataset.id);
      if (!item) return;
      const durEl = card.querySelector("[data-dur]");
      const dur = fmtDur(item.duration);
      if (durEl && dur) durEl.textContent = dur;
      const badge = card.querySelector("[data-badge]");
      if (badge && item.res_label) {
        badge.textContent = item.res_label;
        badge.hidden = false;
      }
      if (!item.playable && !card.querySelector(".badge.fmt")) {
        card.querySelector(".thumb-wrap").insertAdjacentHTML("beforeend", `<span class="badge fmt">浏览器不支持</span>`);
      }
    });
    if (els.hero.dataset.id && state.view.type === "home") {
      const heroItem = byId.get(els.hero.dataset.id);
      if (heroItem) renderHero();
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.scanComplete) return;
    state.pollTimer = setTimeout(async () => {
      await fetchLibrary();
      patchMeta();
      if (!state.items.length) renderView();
      schedulePoll();
    }, 5000);
  }

  // ---------------- 全局事件 ----------------

  window.addEventListener("scroll", () => {
    els.navbar.classList.toggle("scrolled", window.scrollY > 30);
  }, { passive: true });

  els.searchInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.query = els.searchInput.value;
      if (state.query) renderSearch();
      else { renderView(); }
    }, 220);
  });

  els.refreshBtn.addEventListener("click", async () => {
    els.refreshBtn.classList.add("spinning");
    try {
      await fetch("/api/scan", { method: "POST" });
      await fetchLibrary();
      renderView();
      schedulePoll();
      toast(state.scanComplete ? `媒体库已刷新：${state.items.length} 个视频` : "正在后台扫描媒体库…");
    } finally {
      setTimeout(() => els.refreshBtn.classList.remove("spinning"), 600);
    }
  });

  els.settingsBtn.addEventListener("click", openSettings);
  els.emptySettingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);
  els.settingsCancel.addEventListener("click", closeSettings);
  els.lanGroup.addEventListener("change", updateLanUI);

  // 个人数据导出 / 导入
  els.exportDataBtn.addEventListener("click", () => {
    window.location.href = "/api/data/export";
  });
  els.importDataBtn.addEventListener("click", () => els.importDataFile.click());
  els.importDataFile.addEventListener("change", async () => {
    const f = els.importDataFile.files[0];
    els.importDataFile.value = "";
    if (!f) return;
    let data;
    try {
      data = JSON.parse(await f.text());
    } catch {
      toast("文件不是有效的 JSON");
      return;
    }
    try {
      const res = await fetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const d = await res.json();
      if (!res.ok) { toast(d.detail || "导入失败"); return; }
      await refreshMineData();
      renderNav();
      if (state.view.type === "mine") renderView();
      closeSettings();
      toast(`已导入：${d.history} 条历史，${d.collections} 个栏目${d.config ? "，设置" : ""}`);
    } catch {
      toast("导入失败");
    }
  });

  // 重新生成预览图
  els.regenThumbsBtn.addEventListener("click", async () => {
    const ok = await askConfirm({
      title: "重新生成预览图",
      tip: "将删除全部自动生成的封面并重新提取，耗时较长（后台进行，期间封面会陆续更新）。确定继续吗？",
      okText: "重新生成",
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/regen-thumbs", { method: "POST" });
      if (!res.ok) { toast("操作失败"); return; }
      closeSettings();
      toast("已开始重新生成预览图（后台进行中）");
    } catch {
      toast("操作失败");
    }
  });

  // 原生文件夹选择对话框（由本地服务器弹出）
  els.browseBtn.addEventListener("click", async () => {
    const original = els.browseBtn.innerHTML;
    els.browseBtn.disabled = true;
    els.browseBtn.innerHTML = "选择中…";
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const data = await res.json();
      if (data.path) {
        els.rootInput.value = data.path;
        els.settingsError.classList.add("hidden");
        els.rootInput.focus();
      }
    } catch {
      toast("无法打开文件夹选择器");
    } finally {
      els.browseBtn.disabled = false;
      els.browseBtn.innerHTML = original;
    }
  });

  // 播放方式 / 播放器选择联动
  els.playerModeGroup.addEventListener("change", updatePlayerChoiceUI);
  els.playerChoiceGroup.addEventListener("change", updatePlayerChoiceUI);

  // 原生程序（exe）选择对话框
  els.browseExeBtn.addEventListener("click", async () => {
    const original = els.browseExeBtn.innerHTML;
    els.browseExeBtn.disabled = true;
    els.browseExeBtn.innerHTML = "选择中…";
    try {
      const res = await fetch("/api/pick-exe", { method: "POST" });
      const data = await res.json();
      if (data.path) els.playerPathInput.value = data.path;
    } catch {
      toast("无法打开文件选择器");
    } finally {
      els.browseExeBtn.disabled = false;
      els.browseExeBtn.innerHTML = original;
    }
  });

  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });

  els.settingsSave.addEventListener("click", async () => {
    const root = els.rootInput.value.trim();
    const mode = els.playerModeGroup.querySelector("input[name=playerMode]:checked")?.value || "web";
    const ext = els.playerChoiceGroup.querySelector("input[name=extPlayer]:checked")?.value || "default";
    const size = els.cardSizeGroup.querySelector("input[name=cardSize]:checked")?.value || "medium";
    const ratio = els.cardRatioGroup.querySelector("input[name=cardRatio]:checked")?.value || "16:9";
    const showTitle = els.cardTitleGroup.querySelector("input[name=cardTitle]:checked")?.value === "on";
    const lan = els.lanGroup.querySelector("input[name=lanMode]:checked")?.value === "on";
    const playerPath = els.playerPathInput.value.trim();
    if (!root) {
      els.settingsError.textContent = "请输入文件夹路径";
      els.settingsError.classList.remove("hidden");
      return;
    }
    if (mode === "system" && ext === "custom" && !playerPath) {
      els.settingsError.textContent = "选择自定义播放器时需要填写程序路径";
      els.settingsError.classList.remove("hidden");
      return;
    }
    els.settingsSave.disabled = true;
    const lanChanged = lan !== state.lanMode;
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_root: root, player_mode: mode,
          external_player: ext, player_path: playerPath,
          card_size: size, card_ratio: ratio, card_title: showTitle,
          lan_mode: lan,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "保存失败");
      const rootChanged = data.media_root !== state.root;
      state.playerMode = data.player_mode;
      state.extPlayer = data.external_player;
      state.playerPath = data.player_path;
      state.cardSize = data.card_size;
      state.cardRatio = data.card_ratio;
      state.cardTitle = !!data.card_title;
      state.lanMode = !!data.lan_mode;
      applyCardPrefs();
      closeSettings();
      toast(lanChanged ? "设置已保存，重启应用后局域网访问生效" : "设置已保存");
      if (rootChanged) {
        await fetchLibrary();
        schedulePoll();
      }
      renderView();
    } catch (err) {
      els.settingsError.textContent = err.message;
      els.settingsError.classList.remove("hidden");
    } finally {
      els.settingsSave.disabled = false;
    }
  });

  // ---------------- 右键菜单：自定义封面 ----------------

  const ctxMenu = document.createElement("div");
  ctxMenu.id = "ctxMenu";
  ctxMenu.className = "ctx-menu hidden";
  document.body.appendChild(ctxMenu);

  const hideCtx = () => ctxMenu.classList.add("hidden");

  els.rows.addEventListener("contextmenu", (e) => {
    const card = e.target.closest(".show-card");
    if (!card || !card.dataset.show) return;
    e.preventDefault();
    const key = card.dataset.show;
    const colName = card.closest(".row")?.dataset.col || null;  // 在某栏目行内
    let html = `
      <button data-act="custom">自定义封面…</button>
      <button data-act="reset">恢复默认封面</button>`;
    if (colName) {
      html += `<button data-act="remove" data-col="${esc(colName)}">从「${esc(colName)}」移除</button>`;
    } else {
      if (state.collections.length) {
        html += `<div class="ctx-sep"></div>`;
        for (const c of state.collections)
          html += `<button data-act="add" data-col="${esc(c.name)}">加入「${esc(c.name)}」</button>`;
      }
      html += `<button data-act="new">＋ 新建栏目…</button>`;
    }
    ctxMenu.innerHTML = html;
    ctxMenu.dataset.showKey = key;
    ctxMenu.classList.remove("hidden");
    const { innerWidth: w, innerHeight: h } = window;
    const mw = 200, mh = ctxMenu.children.length * 38 + 20;
    ctxMenu.style.left = Math.min(e.clientX, w - mw) + "px";
    ctxMenu.style.top = Math.min(e.clientY, h - mh) + "px";
  });

  ctxMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const key = ctxMenu.dataset.showKey;
    const act = btn.dataset.act;
    hideCtx();
    if (!key || !act) return;
    try {
      if (act === "custom") {
        const data = await (await fetch("/api/pick-image", { method: "POST" })).json();
        if (!data.path) return;  // 用户取消
        const res = await fetch("/api/custom-cover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ show_key: key, image_path: data.path }),
        });
        const d = await res.json();
        if (!res.ok) { toast(d.detail || "设置封面失败"); return; }
        state.coverRev[key] = Date.now();
        renderView();
        toast("封面已更新");
      } else if (act === "reset") {
        await fetch(`/api/custom-cover?show_key=${encodeURIComponent(key)}`, { method: "DELETE" });
        state.coverRev[key] = Date.now();
        renderView();
        toast("已恢复默认封面");
      } else if (act === "add" || act === "remove") {
        const name = btn.dataset.col;
        const res = await fetch("/api/collections/item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, show_key: key, action: act }),
        });
        const d = await res.json();
        if (!res.ok) { toast(d.detail || "操作失败"); return; }
        await refreshMineData();
        if (state.view.type === "mine") renderView();
        toast(act === "add" ? `已加入「${name}」` : `已从「${name}」移除`);
      } else if (act === "new") {
        const name = await askName();
        if (!name) return;
        const res = await fetch("/api/collections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const d = await res.json();
        if (!res.ok) { toast(d.detail || "创建失败"); return; }
        await fetch("/api/collections/item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, show_key: key, action: "add" }),
        });
        await refreshMineData();
        if (state.view.type === "mine") renderView();
        toast(`已创建并加入「${name}」`);
      }
    } catch {
      toast("操作失败");
    }
  });

  window.addEventListener("click", hideCtx);
  window.addEventListener("scroll", hideCtx, true);
  window.addEventListener("blur", hideCtx);

  els.heroPlay.addEventListener("click", () => {
    const item = state.items.find((i) => i.id === els.hero.dataset.id);
    if (item) {
      const pool = item.is_movie ? [item] : (findShow(item.category, item.show)?.seasons.get(item.season || "") || [item]);
      playItem(item, pool.length ? pool : [item]);
    }
  });
  els.heroInfo.addEventListener("click", () => {
    const item = state.items.find((i) => i.id === els.hero.dataset.id);
    if (item) openDetail(item);
  });
  els.heroImg.addEventListener("error", () => { els.heroImg.style.display = "none"; });
  els.heroImg.addEventListener("load", () => { els.heroImg.style.display = ""; });

  els.playerClose.addEventListener("click", closePlayer);
  els.prevBtn.addEventListener("click", () => step(-1));
  els.nextBtn.addEventListener("click", () => step(1));
  els.videoEl.addEventListener("ended", () => {
    if (state.playIndex < state.playList.length - 1) step(1);
  });

  els.detailClose.addEventListener("click", closeDetail);
  els.detailModal.addEventListener("click", (e) => {
    if (e.target === els.detailModal) closeDetail();
  });
  els.detailPlay.addEventListener("click", () => {
    const item = state.items.find((i) => i.id === state.detailId);
    closeDetail();
    if (item) playItem(item, [item]);
  });

  document.addEventListener("keydown", (e) => {
    const playerOpen = els.playerModal.classList.contains("open");
    if (e.key === "Escape") {
      if (playerOpen) closePlayer();
      else if (!els.nameModal.classList.contains("hidden")) closeNameModal();
      else if (!els.confirmModal.classList.contains("hidden")) closeConfirmModal();
      else if (!els.detailModal.classList.contains("hidden")) closeDetail();
      else if (!els.settingsModal.classList.contains("hidden")) closeSettings();
      else if (state.view.type === "show") setView({ type: "category", cat: state.view.cat });
      else if (state.view.type === "category" || state.view.type === "mine") setView({ type: "home" });
      return;
    }
    if (!playerOpen) return;
    const v = els.videoEl;
    if (e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    else if (e.key === "ArrowLeft") { v.currentTime = Math.max(0, v.currentTime - 10); }
    else if (e.key === "ArrowRight") { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
    else if (e.key.toLowerCase() === "f") {
      document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.();
    }
  });

  // ---------------- 启动 ----------------
  // 客户端版使用 Win11 原生窗口（系统标题栏 + 深色模式），无需前端自绘窗口控件。

  (async function init() {
    try {
      await Promise.all([fetchLibrary(), fetchConfig(), refreshMineData()]);
    } catch {
      toast("无法连接服务器");
      return;
    }
    els.loading.classList.add("hidden");
    renderView();
    schedulePoll();
  })();
})();
