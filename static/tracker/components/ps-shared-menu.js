// ps-shared-menu: a shared potluck menu. Everyone sees what's on the menu, signs up to bring things,
// ticks off what's ready and chats. Self-contained (no core.js) so the guest page at /m/<token> can use it.
//
//   <ps-shared-menu token="...">     guest view through a shared link (API under /api/m/<token>)
//   <ps-shared-menu menu-id="...">   family view inside the app (API under /api/shared-menus/<id>)
//
// Optional property `suggestions` (array of strings) feeds the "What are you bringing?" autocomplete.
// Fires "menu-deleted" (bubbles, composed) after a parent deletes the menu.
(() => {
  const COURSES = {
    appetizers: { icon: "\u{1F9C0}", label: "Appetizers", one: "an appetizer" },
    mains: { icon: "\u{1F357}", label: "Main dishes", one: "a main dish" },
    sides: { icon: "\u{1F954}", label: "Sides", one: "a side" },
    desserts: { icon: "\u{1F967}", label: "Desserts", one: "a dessert" },
    drinks: { icon: "\u{1F377}", label: "Drinks", one: "a drink" },
    other: { icon: "\u{1F9FA}", label: "Everything else", one: "something" },
  };

  // Best guess at a dish's course from its name, so people don't have to pick one.
  const GUESSES = [
    ["desserts", /\b(pies?|cakes?|cookies?|brownies?|desserts?|ice cream|pudding|tarts?|cobbler|crisp|crumble|cheesecake|whipped|cupcakes?|fudge|candy|chocolate|sweets?|macarons?|donuts?)\b/i],
    ["drinks", /\b(wine|beers?|cider|juice|soda|water|coffee|tea|cocktails?|punch|champagne|prosecco|lemonade|drinks?|bourbon|whiske?y|sparkling|kombucha|eggnog|seltzer)\b/i],
    ["appetizers", /\b(cheese|crackers?|dips?|chips|crudit[eé]s?|appetizers?|charcuterie|olives|nuts|deviled|hummus|salsa|bruschetta|snacks?|platter)\b/i],
    ["mains", /\b(turkey|ham|roast|chicken|beef|brisket|lasagna|salmon|fish|pork|lamb|tofurky|prime rib|main|duck|meatloaf|tenderloin)\b/i],
    ["sides", /\b(potato(es)?|stuffing|dressing|salad|beans?|rolls?|bread|cranberr(y|ies)|gravy|corn|mac|squash|carrots?|brussels|sprouts|yams?|veggies|vegetables?|rice|biscuits?|casserole|slaw|greens|soup)\b/i],
    ["other", /\b(ice|plates?|napkins?|cups?|chairs?|containers?|foil|utensils?|forks?|tables?|tablecloth|candles?|flowers?|games?)\b/i],
  ];
  const guessCourse = (name) => (GUESSES.find(([, re]) => re.test(name)) || ["other"])[0];

  const OCCASIONS = [
    [/thanksgiving|friendsgiving|turkey/i, "\u{1F983}"], [/christmas|xmas|holiday/i, "\u{1F384}"], [/birthday|bday/i, "\u{1F382}"],
    [/bbq|barbecue|cookout|grill/i, "\u{1F356}"], [/picnic/i, "\u{1F9FA}"], [/brunch|breakfast/i, "\u{1F95E}"],
    [/new year/i, "\u{1F386}"], [/easter/i, "\u{1F423}"], [/halloween/i, "\u{1F383}"], [/hanukkah|chanukah/i, "\u{1F54E}"],
    [/pizza/i, "\u{1F355}"], [/taco/i, "\u{1F32E}"],
  ];
  const emojiFor = (title) => (OCCASIONS.find(([re]) => re.test(title || "")) || [null, "\u{1F37D}️"])[1];

  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeColor = (c) => (COLOR_RE.test(c || "") ? c : "#8b8fa8");

  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function formatDate(ymd) {
    return ymd ? new Date(ymd + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "";
  }
  function daysUntil(ymd) {
    return Math.round((new Date(ymd + "T12:00:00") - new Date(localToday() + "T12:00:00")) / 86400000);
  }
  function countdown(ymd) {
    if (!ymd) return "";
    const d = daysUntil(ymd);
    if (d === 0) return "It's today! \u{1F389}";
    if (d === 1) return "Tomorrow!";
    if (d > 1) return `${d} days to go`;
    return "";
  }
  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function joinNames(names) {
    if (names.length <= 1) return names.join("");
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
    return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
  }

  const STYLES = `
    :host {
      display: block;
      --card: #16141f; --card-2: #1e1b2a; --line: #2c2838; --text: #f4f1ea; --muted: #a8a2b4; --faint: #6f6a7c;
      --warm: #f59e0b; --warm-2: #fb923c; --warm-soft: rgba(245, 158, 11, 0.14); --good: #4ade80; --danger: #f87171;
      color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.35;
    }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; color: inherit; }
    .wrap { display: flex; flex-direction: column; gap: 16px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 16px; }
    h2 { margin: 0 0 4px; font-size: 1.05rem; }
    .hint { margin: 0 0 12px; color: var(--muted); font-size: 0.88rem; }

    /* Banner */
    .hero { position: relative; overflow: hidden; border-radius: 24px; padding: 22px 20px 20px; color: #fff8ee;
            background: radial-gradient(circle at 85% 15%, rgba(255,214,140,0.35), transparent 45%),
                        linear-gradient(140deg, #7c2d12 0%, #b45309 55%, #d97706 100%); }
    .hero-emoji { font-size: 2.6rem; line-height: 1; margin-bottom: 8px; }
    .hero h1 { margin: 0; font-size: 1.7rem; line-height: 1.15; letter-spacing: -0.01em; overflow-wrap: anywhere; }
    .hero-when { margin-top: 6px; font-size: 0.95rem; opacity: 0.92; }
    .pill { display: inline-block; margin-top: 10px; padding: 4px 12px; border-radius: 999px; background: rgba(0,0,0,0.22);
            font-weight: 700; font-size: 0.85rem; }
    .hero-notes { margin: 12px 0 0; white-space: pre-wrap; font-size: 0.95rem; overflow-wrap: anywhere; }
    .hero-people { margin-top: 14px; display: flex; align-items: center; gap: 10px; font-size: 0.85rem; }
    .stack { display: flex; }
    .stack .avatar { margin-left: -6px; box-shadow: 0 0 0 2px #b45309; }
    .stack .avatar:first-child { margin-left: 0; }
    .hero-links { margin-top: 12px; display: flex; gap: 16px; flex-wrap: wrap; }
    .hero .link { color: #ffe7c2; text-decoration: underline; text-underline-offset: 3px; }

    .avatar { width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--c); color: #1a1208; display: inline-flex;
              align-items: center; justify-content: center; font-weight: 800; font-size: 0.8rem; }
    .avatar.sm { width: 22px; height: 22px; font-size: 0.68rem; }

    /* Buttons & fields */
    .btn { appearance: none; border: 1px solid var(--line); background: var(--card-2); border-radius: 14px; padding: 11px 18px;
           font-size: 0.95rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .btn:hover { border-color: #443e55; }
    .btn-warm { background: linear-gradient(135deg, var(--warm), var(--warm-2)); border: none; color: #2a1605; }
    .btn-warm:hover { filter: brightness(1.06); }
    .btn-big { width: 100%; padding: 14px; font-size: 1rem; }
    .link { appearance: none; background: none; border: none; padding: 0; color: var(--warm); cursor: pointer; font-size: 0.85rem; font-weight: 600; }
    .link.quiet { color: var(--muted); font-weight: 500; }
    .link.danger { color: var(--danger); }
    input[type=text], input[type=date], select, textarea {
      width: 100%; background: #0f0d16; border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; font-size: 1rem; min-width: 0;
    }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--warm); }
    textarea { resize: vertical; }
    .row { display: flex; gap: 8px; }
    .row > input { flex: 1; }
    .stack-form { display: flex; flex-direction: column; gap: 10px; }

    /* Join */
    .join { border-color: rgba(245, 158, 11, 0.5); background: linear-gradient(180deg, rgba(245,158,11,0.10), var(--card) 70%); }
    .join h2 { font-size: 1.2rem; }

    /* Invite */
    .invite-btns { display: flex; gap: 8px; }
    .invite-btns .btn-warm { flex: 1; }
    .link-opts { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; font-size: 0.85rem; color: var(--muted); }
    .link-opts .opt { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .link-off { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .card-foot { margin-top: 10px; text-align: center; }

    /* Your list */
    .mine-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .mine-item { display: flex; align-items: center; gap: 12px; padding: 10px 4px; cursor: pointer; border-radius: 12px; }
    .mine-item:hover { background: var(--card-2); }
    .tick { width: 26px; height: 26px; flex: none; border-radius: 8px; border: 2px solid #4a4458; display: inline-flex; align-items: center;
            justify-content: center; font-weight: 900; font-size: 0.85rem; color: transparent; }
    .mine-item.ready .tick { background: var(--good); border-color: var(--good); color: #052e14; }
    .mine-item.ready .mine-name { color: var(--muted); text-decoration: line-through; }
    .mine-name { font-weight: 600; overflow-wrap: anywhere; }
    .all-ready { margin-top: 8px; color: var(--good); font-weight: 600; font-size: 0.9rem; }

    /* Progress */
    .progress-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .progress-line b { font-size: 1.15rem; }
    .bar { height: 12px; border-radius: 999px; background: #0f0d16; overflow: hidden; }
    .bar span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--warm), var(--good)); transition: width 0.4s ease; }
    .progress-sub { margin-top: 10px; font-size: 0.9rem; color: var(--muted); }

    /* Courses */
    .course-head { display: flex; align-items: center; gap: 8px; margin: 2px 4px 8px; font-size: 1rem; font-weight: 800; }
    .course-head .count { color: var(--faint); font-weight: 600; font-size: 0.85rem; }
    ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .item { background: var(--card); border: 1px solid var(--line); border-radius: 16px; }
    .item.needed { border-style: dashed; border-color: #3d3650; }
    .item-row { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; }
    .item-main { flex: 1; min-width: 0; cursor: pointer; background: none; border: none; padding: 0; text-align: left; }
    .item-name { display: block; font-weight: 650; font-size: 1rem; overflow-wrap: anywhere; }
    .item-extra { margin-top: 3px; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 0.8rem; color: var(--muted); }
    .ready-tag { color: var(--good); font-weight: 700; }
    .bringer { display: inline-flex; align-items: center; gap: 7px; font-size: 0.88rem; font-weight: 600; max-width: 140px; }
    .bringer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bring-btn { appearance: none; border: 1.5px solid var(--warm); background: var(--warm-soft); color: #ffd28a; border-radius: 999px;
                 padding: 7px 14px; font-size: 0.85rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .bring-btn:hover { background: rgba(245, 158, 11, 0.24); }
    .add-to-course { margin: 8px 4px 0; }
    .add-to-course .link { color: var(--muted); font-weight: 500; }
    .add-to-course .link:hover { color: var(--warm); }
    .add-inline { margin-top: 8px; }

    .details { border-top: 1px solid var(--line); padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 14px; }
    .details-notes { white-space: pre-wrap; font-size: 0.92rem; overflow-wrap: anywhere; }
    .details-actions { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
    .who-select { display: flex; align-items: center; gap: 10px; font-size: 0.88rem; color: var(--muted); }
    .who-select select { width: auto; padding: 8px 12px; font-size: 0.9rem; }

    /* Chat */
    .chat { display: flex; flex-direction: column; gap: 12px; }
    .msg { display: flex; gap: 10px; align-items: flex-start; }
    .msg-body { flex: 1; min-width: 0; }
    .msg-meta { font-size: 0.78rem; color: var(--faint); display: flex; gap: 8px; align-items: baseline; }
    .msg-meta b { color: var(--text); font-size: 0.85rem; }
    .msg-text { font-size: 0.95rem; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
    .chat-form { display: flex; gap: 8px; align-items: flex-end; }
    .chat-form textarea { min-height: 46px; height: 46px; }
    .quiet-note { font-size: 0.88rem; color: var(--faint); }

    .center { text-align: center; }
    .empty { text-align: center; padding: 28px 12px; color: var(--muted); }
    .error { text-align: center; padding: 40px 18px; }
    .error .big { font-size: 2.6rem; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #2a1418; border: 1px solid #6b2d36;
             color: #ffd9de; padding: 12px 18px; border-radius: 14px; font-size: 0.92rem; z-index: 1000; max-width: calc(100vw - 32px);
             box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .toast.ok { background: #13281c; border-color: #2d6b45; color: #d3f9df; }
    @media (max-width: 480px) {
      .hero { padding: 20px 16px 18px; }
      .hero h1 { font-size: 1.5rem; }
      .bringer { max-width: 108px; }
      .item-row { padding: 11px 10px 11px 14px; }
    }
  `;

  class PsSharedMenu extends HTMLElement {
    static get observedAttributes() { return ["token", "menu-id"]; }
    static emojiFor(title) { return emojiFor(title); }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._state = null;
      this._error = null;
      this._openItem = null; // item whose details are showing
      this._editingItem = null;
      this._editingMenu = false;
      this._renaming = false;
      this._addingIn = null; // course with its "+ Add ..." box open
      this._linkOpts = false;
      this._drafts = {};
      this._toast = null;
      this._suggestions = [];
      this._es = null;
      this._retry = 0;
      this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
      this.shadowRoot.addEventListener("submit", (e) => this._onSubmit(e));
      this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
      this.shadowRoot.addEventListener("keydown", (e) => this._onKeydown(e));
      this._onVisible = () => { if (document.visibilityState === "visible" && this.isConnected) this._load(); };
    }

    set suggestions(list) { this._suggestions = Array.isArray(list) ? list.slice(0, 500) : []; if (this._state) this.render(); }

    get _base() {
      const token = this.getAttribute("token");
      if (token) return `/api/m/${encodeURIComponent(token)}`;
      const id = this.getAttribute("menu-id");
      return id ? `/api/shared-menus/${encodeURIComponent(id)}` : null;
    }

    connectedCallback() {
      document.addEventListener("visibilitychange", this._onVisible);
      this._load();
      this._connect();
    }

    disconnectedCallback() {
      document.removeEventListener("visibilitychange", this._onVisible);
      this._disconnect();
    }

    attributeChangedCallback(_name, oldV, newV) {
      if (oldV === newV || !this.isConnected) return;
      this._state = null; this._error = null; this._openItem = null; this._editingItem = null; this._drafts = {};
      this._disconnect();
      this._load();
      this._connect();
    }

    // ---- Data ----

    async _api(method, path, body) {
      const res = await fetch(this._base + path, {
        method, credentials: "same-origin",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(json.error || `HTTP ${res.status}`); err.status = res.status; err.body = json; throw err; }
      return json;
    }

    async _load() {
      if (!this._base) return;
      const base = this._base;
      try {
        const state = await this._api("GET", "/state");
        if (base !== this._base) return;
        this._state = state;
        this._error = null;
      } catch (e) {
        if (base !== this._base) return;
        if (e.status === 404 || e.status === 401 || e.status === 403) { this._error = e.message; this._state = null; this._disconnect(); }
        else if (!this._state) this._error = "Couldn't load the menu. Check your connection and try again.";
      }
      this.render();
    }

    _scheduleLoad() {
      clearTimeout(this._loadTimer);
      this._loadTimer = setTimeout(() => this._load(), 120);
    }

    _connect() {
      if (this._es || !this._base || typeof EventSource === "undefined") return;
      const es = new EventSource(this._base + "/stream");
      this._es = es;
      es.addEventListener("menu:changed", () => this._scheduleLoad());
      es.onopen = () => { if (this._retry > 0) this._scheduleLoad(); this._retry = 0; };
      es.onerror = () => {
        es.close();
        if (this._es !== es) return;
        this._es = null;
        if (this._error) return;
        const delay = Math.min(30000, 2000 * 2 ** this._retry++);
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => { if (this.isConnected) { this._load(); this._connect(); } }, delay);
      };
    }

    _disconnect() {
      clearTimeout(this._reconnectTimer);
      if (this._es) { this._es.close(); this._es = null; }
    }

    async _do(method, path, body, { optimistic, okMessage } = {}) {
      if (optimistic) { optimistic(); this.render(); }
      try {
        const out = await this._api(method, path, body);
        if (okMessage) this._showToast(okMessage, true);
        return out;
      } catch (e) {
        if (e.body?.needsJoin && this._state) this._state.me = null;
        this._showToast(e.message || "Something went wrong");
        return null;
      } finally {
        this._load();
      }
    }

    _showToast(msg, ok = false) {
      this._toast = { msg, ok };
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this._toast = null; this.render(); }, 3200);
      this.render();
    }

    // ---- Helpers ----

    _person(id) { return this._state?.participants.find((p) => p.id === id) || null; }
    _item(id) { return this._state?.items.find((i) => i.id === id); }
    _isMine(item) { return !!this._state.me && item.claimedBy === this._state.me; }
    _canDeleteItem(item) { return !!this._state.me && (this._state.host || item.addedBy === this._state.me); }
    _canDeleteComment(c) { return !!this._state.me && (this._state.host || c.participantId === this._state.me); }
    _commentsFor(itemId) { return this._state.comments.filter((c) => (c.itemId || null) === (itemId || null)); }
    _courseOf(item) { return COURSES[item.category] ? item.category : "other"; }
    _shareUrl() { return location.origin + this._state.menu.sharePath; }

    _avatar(p, size = "") {
      const name = p ? p.name : "?";
      return `<span class="avatar ${size}" style="--c:${safeColor(p?.color)}" title="${esc(name)}">${esc((name.trim()[0] || "?").toUpperCase())}</span>`;
    }

    // Keep typed-but-unsent text (and focus) across re-renders triggered by live updates.
    _saveDrafts() {
      const sr = this.shadowRoot;
      for (const el of sr.querySelectorAll("[data-draft]")) this._drafts[el.dataset.draft] = el.value;
      const a = sr.activeElement;
      this._focus = a && a.dataset?.draft ? { key: a.dataset.draft, start: a.selectionStart, end: a.selectionEnd } : null;
    }

    _restoreDrafts() {
      const sr = this.shadowRoot;
      for (const el of sr.querySelectorAll("[data-draft]")) {
        const v = this._drafts[el.dataset.draft];
        if (v !== undefined) el.value = v;
      }
      if (this._focus) {
        const el = sr.querySelector(`[data-draft="${CSS.escape(this._focus.key)}"]`);
        if (el) {
          el.focus();
          try { if (this._focus.start != null) el.setSelectionRange(this._focus.start, this._focus.end); } catch {}
        }
      }
    }

    // Forget drafts and blank their inputs too; otherwise the next render saves the old text right back.
    _clearDrafts(...keys) {
      for (const k of keys) {
        delete this._drafts[k];
        const el = this.shadowRoot.querySelector(`[data-draft="${CSS.escape(k)}"]`);
        if (el && el.tagName !== "SELECT") el.value = "";
      }
    }

    _focusDraft(key) { this.shadowRoot.querySelector(`[data-draft="${CSS.escape(key)}"]`)?.focus(); }

    // ---- Render ----

    render() {
      this._saveDrafts();
      let body;
      if (this._error) body = this._renderError();
      else if (!this._state) body = `<div class="empty">Loading the menu…</div>`;
      else body = this._renderMenu();
      this.shadowRoot.innerHTML = `<style>${STYLES}</style>${body}${this._toast ? `<div class="toast ${this._toast.ok ? "ok" : ""}" role="status">${esc(this._toast.msg)}</div>` : ""}`;
      this._restoreDrafts();
    }

    _renderError() {
      return `<div class="card error"><div class="big">\u{1F37D}️</div><h2>This menu isn't available</h2><p class="hint">${esc(this._error)}</p></div>`;
    }

    _renderMenu() {
      const s = this._state;
      const me = this._person(s.me);
      return `<div class="wrap">
        ${this._renderHero(me)}
        ${!s.host && !me ? this._renderJoin() : ""}
        ${s.host ? this._renderInvite() : ""}
        ${me ? this._renderMine() : ""}
        ${me ? this._renderBring() : ""}
        ${s.items.length ? this._renderProgress() : ""}
        ${this._renderCourses()}
        ${this._renderChat()}
        ${s.canManage ? `<div class="center"><button class="link quiet" data-act="delete-menu">Delete this menu</button></div>` : ""}
      </div>`;
    }

    _renderHero(me) {
      const { menu, host, participants } = this._state;
      if (this._editingMenu) {
        return `<section class="card"><form class="stack-form" data-form="menu">
          <h2>Edit details</h2>
          <input type="text" name="title" data-draft="menu-title" maxlength="120" value="${esc(menu.title)}" placeholder="What's the occasion?" required />
          <input type="date" name="eventDate" data-draft="menu-date" value="${esc(menu.eventDate)}" />
          <textarea name="notes" data-draft="menu-notes" rows="3" maxlength="2000" placeholder="Anything people should know? Time, address, allergies…">${esc(menu.notes)}</textarea>
          <div class="row"><button class="btn btn-warm" type="submit">Save</button><button class="btn" type="button" data-act="cancel-menu">Cancel</button></div>
        </form></section>`;
      }
      const left = countdown(menu.eventDate);
      // Put "you" first: "You, Alex and Sam are planning".
      const ordered = [...participants].sort((a, b) => (b.id === this._state.me) - (a.id === this._state.me));
      const names = ordered.map((p) => (p.id === this._state.me ? "you" : p.name));
      let sentence = "";
      if (names.length === 1) sentence = names[0] === "you" ? "Just you so far" : `${names[0]} is planning`;
      else if (names.length > 1) sentence = `${joinNames(names)} are planning`;
      sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
      const people = participants.length
        ? `<div class="hero-people"><span class="stack">${ordered.slice(0, 6).map((p) => this._avatar(p, "sm")).join("")}</span><span>${esc(sentence)}</span></div>`
        : "";
      const links = [];
      if (host && me) links.push(`<button class="link" data-act="edit-menu">Edit details</button>`);
      if (!host && me) links.push(`<button class="link" data-act="rename">Not ${esc(me.name)}? Change name</button>`);
      const rename = this._renaming && me
        ? `<form class="row" data-form="rename" style="margin-top:12px">
             <input type="text" name="name" data-draft="rename" maxlength="40" value="${esc(me.name)}" required />
             <button class="btn" type="submit">Save</button>
           </form>`
        : "";
      return `<section class="hero">
        <div class="hero-emoji" aria-hidden="true">${emojiFor(menu.title)}</div>
        <h1>${esc(menu.title)}</h1>
        ${menu.eventDate ? `<div class="hero-when">${esc(formatDate(menu.eventDate))}</div>` : ""}
        ${left ? `<div class="pill">${esc(left)}</div>` : ""}
        ${menu.notes ? `<p class="hero-notes">${esc(menu.notes)}</p>` : ""}
        ${people}
        ${links.length ? `<div class="hero-links">${links.join("")}</div>` : ""}
        ${rename}
      </section>`;
    }

    _renderJoin() {
      return `<section class="card join">
        <h2>\u{1F44B} Hi! What's your name?</h2>
        <p class="hint">So everyone knows who's bringing what.</p>
        <form class="row" data-form="join">
          <input type="text" name="name" data-draft="join-name" maxlength="40" placeholder="Your name" autocomplete="given-name" required />
          <button class="btn btn-warm" type="submit">Join</button>
        </form>
      </section>`;
    }

    _renderInvite() {
      const { menu, canManage } = this._state;
      if (!menu.shareEnabled) {
        return `<section class="card link-off">
          <div><h2>\u{1F512} Invite link is off</h2><p class="hint" style="margin:0">Only your family can see this menu right now.</p></div>
          ${canManage ? `<button class="btn" data-act="share-on">Turn it back on</button>` : ""}
        </section>`;
      }
      const opts = this._linkOpts && canManage
        ? `<div class="link-opts">
             <div class="opt"><span>Stop anyone else from using the link</span><button class="link danger" data-act="share-off">Turn off</button></div>
             <div class="opt"><span>Sent it to the wrong person? Get a new link (the old one stops working)</span><button class="link" data-act="regen-link">New link</button></div>
           </div>`
        : "";
      return `<section class="card">
        <h2>Invite people</h2>
        <p class="hint">Send them the link. They can see the menu, sign up to bring something and chat. No account needed.</p>
        <div class="invite-btns">
          <button class="btn btn-warm" data-act="copy-link">\u{1F517} Copy invite link</button>
          ${navigator.share ? `<button class="btn" data-act="native-share">Share…</button>` : ""}
        </div>
        ${canManage ? `<div class="card-foot"><button class="link quiet" data-act="toggle-link-opts">${this._linkOpts ? "Hide link options" : "Link options"}</button></div>` : ""}
        ${opts}
      </section>`;
    }

    _renderMine() {
      const mine = this._state.items.filter((i) => this._isMine(i));
      if (!mine.length) return "";
      const allReady = mine.every((i) => i.done);
      return `<section class="card">
        <h2>\u{1F9FA} You're bringing</h2>
        <p class="hint">Tick things off when they're ready.</p>
        <ul class="mine-list">
          ${mine.map((i) => `<li class="mine-item ${i.done ? "ready" : ""}" data-act="toggle-ready" data-id="${esc(i.id)}" role="checkbox" aria-checked="${i.done}">
            <span class="tick">✓</span><span class="mine-name">${esc(i.name)}</span></li>`).join("")}
        </ul>
        ${allReady ? `<div class="all-ready">All set! \u{1F389}</div>` : ""}
      </section>`;
    }

    _renderBring() {
      const list = this._suggestions.length
        ? `<datalist id="sm-suggestions">${this._suggestions.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>` : "";
      return `<form class="card" data-form="bring">
        <h2>What are you bringing?</h2>
        <div class="row" style="margin-top:10px">
          <input type="text" name="name" data-draft="bring-name" maxlength="120" placeholder="e.g. Mac and cheese" ${list ? `list="sm-suggestions"` : ""} />
          <button class="btn btn-warm" type="submit">Add</button>
        </div>
        ${list}
      </form>`;
    }

    _renderProgress() {
      const items = this._state.items;
      const covered = items.filter((i) => i.claimedBy).length;
      const needed = items.length - covered;
      return `<section class="card">
        <div class="progress-line"><span><b>${covered} of ${items.length}</b> covered</span></div>
        <div class="bar"><span style="width:${((covered / items.length) * 100).toFixed(1)}%"></span></div>
        <div class="progress-sub">${needed
          ? `${needed} ${needed === 1 ? "thing still needs" : "things still need"} someone.${this._state.me ? " Tap <b>I'll bring it</b> on anything you can take." : ""}`
          : "Everything's covered! \u{1F389}"}</div>
      </section>`;
    }

    _renderCourses() {
      const s = this._state;
      if (!s.items.length && !s.me) return `<div class="card empty">Nothing on the menu yet.</div>`;
      // Show courses that have something, plus all of them on an empty menu so there's somewhere to start.
      const courses = Object.keys(COURSES).filter((c) => !s.items.length || s.items.some((i) => this._courseOf(i) === c) || this._addingIn === c);
      return courses.map((c) => {
        const info = COURSES[c];
        const items = s.items.filter((i) => this._courseOf(i) === c);
        const adding = this._addingIn === c;
        const addUi = !s.me ? "" : adding
          ? `<form class="row add-inline" data-form="add-needed" data-course="${c}">
               <input type="text" name="name" data-draft="need-${c}" maxlength="120" placeholder="${esc(`Add ${info.one}…`)}" />
               <button class="btn" type="submit">Add</button>
             </form>`
          : `<div class="add-to-course"><button class="link" data-act="add-in" data-course="${c}">+ Add ${esc(info.one)}</button></div>`;
        return `<section>
          <div class="course-head"><span aria-hidden="true">${info.icon}</span><span>${esc(info.label)}</span>${items.length ? `<span class="count">${items.length}</span>` : ""}</div>
          ${items.length ? `<ul class="items">${items.map((i) => this._renderItem(i)).join("")}</ul>` : ""}
          ${addUi}
        </section>`;
      }).join("");
    }

    _renderItem(item) {
      const open = this._openItem === item.id;
      const n = this._commentsFor(item.id).length;
      let who;
      if (!item.claimedBy) {
        who = `<button class="bring-btn" data-act="claim" data-id="${esc(item.id)}">I'll bring it</button>`;
      } else {
        const p = this._person(item.claimedBy);
        who = `<span class="bringer">${this._avatar(p, "sm")}<span>${this._isMine(item) ? "You" : esc(p ? p.name : "Someone")}</span></span>`;
      }
      const extra = [];
      if (item.done) extra.push(`<span class="ready-tag">✓ Ready</span>`);
      if (n) extra.push(`<span>\u{1F4AC} ${n}</span>`);
      if (item.notes && !open) extra.push(`<span>\u{1F4DD} Note</span>`);
      return `<li class="item ${item.claimedBy ? "" : "needed"}">
        <div class="item-row">
          <button class="item-main" data-act="toggle-details" data-id="${esc(item.id)}" aria-expanded="${open}">
            <span class="item-name">${esc(item.name)}</span>
            ${extra.length ? `<span class="item-extra">${extra.join("")}</span>` : ""}
          </button>
          ${who}
        </div>
        ${open ? this._renderDetails(item) : ""}
      </li>`;
    }

    _renderDetails(item) {
      const s = this._state;
      const id = esc(item.id);
      if (this._editingItem === item.id) {
        return `<div class="details"><form class="stack-form" data-form="edit-item" data-id="${id}">
          <input type="text" name="name" data-draft="edit-name-${id}" maxlength="120" value="${esc(item.name)}" required />
          <select name="category" data-draft="edit-cat-${id}" aria-label="Course">
            ${Object.entries(COURSES).map(([k, v]) => `<option value="${k}" ${k === this._courseOf(item) ? "selected" : ""}>${v.icon} ${esc(v.label)}</option>`).join("")}
          </select>
          <textarea name="notes" data-draft="edit-notes-${id}" rows="2" maxlength="1000" placeholder="Notes: how much, recipe link, gluten-free…">${esc(item.notes)}</textarea>
          <div class="row"><button class="btn btn-warm" type="submit">Save</button><button class="btn" type="button" data-act="cancel-edit">Cancel</button></div>
        </form></div>`;
      }
      const actions = [];
      if (s.me) {
        if (this._isMine(item)) {
          actions.push(`<button class="link" data-act="toggle-ready" data-id="${id}">${item.done ? "Not ready after all" : "✓ Mark as ready"}</button>`);
          actions.push(`<button class="link quiet" data-act="unclaim" data-id="${id}">I can't bring it anymore</button>`);
        }
        actions.push(`<button class="link quiet" data-act="edit-item" data-id="${id}">${item.notes ? "Edit" : "Add a note"}</button>`);
        if (this._canDeleteItem(item)) actions.push(`<button class="link quiet" data-act="delete-item" data-id="${id}">Remove</button>`);
      }
      const who = s.host && s.me
        ? `<label class="who-select">Who's bringing it?
             <select data-act="assign" data-id="${id}"><option value="">Nobody yet</option>
               ${s.participants.map((p) => `<option value="${esc(p.id)}" ${p.id === item.claimedBy ? "selected" : ""}>${esc(p.id === s.me ? `${p.name} (you)` : p.name)}</option>`).join("")}
             </select></label>`
        : "";
      return `<div class="details">
        ${item.notes ? `<div class="details-notes">${esc(item.notes)}</div>` : ""}
        ${who}
        ${actions.length ? `<div class="details-actions">${actions.join("")}</div>` : ""}
        ${this._renderThread(item.id)}
      </div>`;
    }

    _renderThread(itemId) {
      const s = this._state;
      const key = itemId || "general";
      const comments = this._commentsFor(itemId);
      const list = comments.map((c) => {
        const p = this._person(c.participantId);
        return `<div class="msg">${this._avatar(p)}<div class="msg-body">
          <div class="msg-meta"><b>${esc(c.participantId === s.me ? "You" : p ? p.name : "Someone")}</b><span>${esc(timeAgo(c.createdAt))}</span>
            ${this._canDeleteComment(c) ? `<button class="link quiet" style="font-size:0.75rem" data-act="delete-comment" data-id="${esc(c.id)}">delete</button>` : ""}</div>
          <div class="msg-text">${esc(c.body)}</div></div></div>`;
      }).join("");
      const empty = !comments.length ? `<div class="quiet-note">${itemId ? "Questions about this one? Ask here." : "Say hi, ask questions, sort out the details."}</div>` : "";
      const form = s.me
        ? `<form class="chat-form" data-form="comment" data-item="${esc(itemId || "")}">
             <textarea name="body" data-draft="c-${esc(key)}" maxlength="2000" rows="1" placeholder="${itemId ? "Write a comment…" : "Message everyone…"}"></textarea>
             <button class="btn" type="submit">Send</button>
           </form>`
        : "";
      return `<div class="chat">${list}${empty}${form}</div>`;
    }

    _renderChat() {
      return `<section class="card"><h2 style="margin-bottom:12px">\u{1F4AC} Chat</h2>${this._renderThread(null)}</section>`;
    }

    // ---- Events ----

    _needName() {
      this._showToast("Add your name first so people know who's bringing it");
      this._focusDraft("join-name");
    }

    async _onClick(e) {
      const el = e.target.closest("[data-act]");
      if (!el || el.tagName === "SELECT" || !this._state) return;
      const act = el.dataset.act;
      const id = el.dataset.id;
      const s = this._state;
      switch (act) {
        case "toggle-details":
          this._openItem = this._openItem === id ? null : id;
          if (this._openItem !== this._editingItem) this._editingItem = null;
          this.render();
          break;
        case "claim": {
          if (!s.me) return this._needName();
          const item = this._item(id);
          if (item) this._do("PUT", `/items/${encodeURIComponent(id)}`, { claimedBy: s.me }, { optimistic: () => { item.claimedBy = s.me; } });
          break;
        }
        case "unclaim": {
          const item = this._item(id);
          if (item) this._do("PUT", `/items/${encodeURIComponent(id)}`, { claimedBy: null, done: false }, { optimistic: () => { item.claimedBy = null; item.done = false; } });
          break;
        }
        case "toggle-ready": {
          const item = this._item(id);
          if (!item) return;
          const done = !item.done;
          this._do("PUT", `/items/${encodeURIComponent(id)}`, { done }, { optimistic: () => { item.done = done; } });
          break;
        }
        case "edit-item":
          this._editingItem = id;
          this._clearDrafts(`edit-name-${id}`, `edit-cat-${id}`, `edit-notes-${id}`);
          this.render();
          this._focusDraft(`edit-name-${id}`);
          break;
        case "cancel-edit": this._editingItem = null; this.render(); break;
        case "delete-item": {
          const item = this._item(id);
          if (!item || !confirm(`Take "${item.name}" off the menu?`)) return;
          if (this._openItem === id) this._openItem = null;
          this._do("DELETE", `/items/${encodeURIComponent(id)}`, undefined, { optimistic: () => { s.items = s.items.filter((i) => i.id !== id); } });
          break;
        }
        case "delete-comment":
          if (!confirm("Delete this message?")) return;
          this._do("DELETE", `/comments/${encodeURIComponent(id)}`, undefined, { optimistic: () => { s.comments = s.comments.filter((c) => c.id !== id); } });
          break;
        case "add-in":
          this._addingIn = el.dataset.course;
          this.render();
          this._focusDraft(`need-${el.dataset.course}`);
          break;
        case "edit-menu":
          this._editingMenu = true;
          this._clearDrafts("menu-title", "menu-date", "menu-notes");
          this.render();
          break;
        case "cancel-menu": this._editingMenu = false; this.render(); break;
        case "rename":
          this._renaming = !this._renaming;
          this._clearDrafts("rename");
          this.render();
          if (this._renaming) this._focusDraft("rename");
          break;
        case "copy-link": this._copyLink(); break;
        case "native-share":
          navigator.share({ title: s.menu.title, text: `Help plan ${s.menu.title}! Sign up to bring something:`, url: this._shareUrl() }).catch(() => {});
          break;
        case "toggle-link-opts": this._linkOpts = !this._linkOpts; this.render(); break;
        case "share-off":
          if (!confirm("Turn off the invite link? People outside your family won't be able to open the menu until you turn it back on.")) return;
          this._linkOpts = false;
          this._do("POST", "/share", { enabled: false }, { okMessage: "Invite link turned off" });
          break;
        case "share-on": this._do("POST", "/share", { enabled: true }, { okMessage: "Invite link is back on" }); break;
        case "regen-link":
          if (!confirm("Get a new invite link? The old one will stop working, so you'll need to send the new one to everyone again.")) return;
          this._linkOpts = false;
          if (await this._do("POST", "/share", { regenerate: true })) this._showToast("New link ready. Tap “Copy invite link” to send it", true);
          break;
        case "delete-menu":
          if (!confirm(`Delete "${s.menu.title}" for everyone? This can't be undone.`)) return;
          if (await this._do("DELETE", "/", undefined, {})) {
            this.dispatchEvent(new CustomEvent("menu-deleted", { bubbles: true, composed: true }));
          }
          break;
      }
    }

    async _copyLink() {
      const url = this._shareUrl();
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch {}
      if (!ok) { window.prompt("Copy this link and send it to your guests:", url); return; }
      this._showToast("Link copied! Paste it into a text or email", true);
    }

    _onChange(e) {
      const el = e.target;
      if (el.dataset.act === "assign") {
        const item = this._item(el.dataset.id);
        const claimedBy = el.value || null;
        if (item) this._do("PUT", `/items/${encodeURIComponent(item.id)}`, { claimedBy }, { optimistic: () => { item.claimedBy = claimedBy; } });
      }
    }

    _onKeydown(e) {
      // Enter sends a message; Shift+Enter adds a new line.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.matches(".chat-form textarea")) {
        e.preventDefault();
        e.target.form.requestSubmit();
      }
      if (e.key === "Escape") {
        if (this._editingItem) { this._editingItem = null; this.render(); }
        else if (this._addingIn) { this._addingIn = null; this.render(); }
      }
    }

    async _onSubmit(e) {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const val = (k) => String(fd.get(k) || "").trim();
      const s = this._state;
      switch (form.dataset.form) {
        case "join": {
          const name = val("name");
          if (!name) return this._focusDraft("join-name");
          try {
            this._state = await this._api("POST", "/join", { name });
            this._clearDrafts("join-name");
            this._showToast(`Welcome, ${name}! Tap “I'll bring it” on anything you can bring`, true);
          } catch (err) { this._showToast(err.message); }
          break;
        }
        case "rename": {
          const name = val("name");
          if (!name) return;
          this._renaming = false;
          this._clearDrafts("rename");
          await this._do("POST", "/join", { name });
          break;
        }
        case "bring": {
          // "I'm bringing X": claim it if it's already on the menu and free, otherwise add it as yours.
          const name = val("name");
          if (!name) return this._focusDraft("bring-name");
          this._clearDrafts("bring-name");
          form.querySelector("[name=name]").value = "";
          const existing = s.items.find((i) => !i.claimedBy && i.name.trim().toLowerCase() === name.toLowerCase());
          if (existing) {
            await this._do("PUT", `/items/${encodeURIComponent(existing.id)}`, { claimedBy: s.me }, {
              optimistic: () => { existing.claimedBy = s.me; }, okMessage: `Thanks! You're bringing ${existing.name}`,
            });
          } else {
            const category = guessCourse(name);
            await this._do("POST", "/items", { name, category, claimedBy: s.me }, {
              optimistic: () => s.items.push({ id: `tmp-${Date.now()}`, name, category, notes: "", claimedBy: s.me, done: false, addedBy: s.me, createdAt: new Date().toISOString() }),
              okMessage: `Added to ${COURSES[category].label}. Thanks!`,
            });
          }
          break;
        }
        case "add-needed": {
          const course = form.dataset.course;
          const name = val("name");
          if (!name) { this._addingIn = null; this.render(); return; }
          this._clearDrafts(`need-${course}`);
          this._addingIn = null;
          await this._do("POST", "/items", { name, category: course }, {
            optimistic: () => s.items.push({ id: `tmp-${Date.now()}`, name, category: course, notes: "", claimedBy: null, done: false, addedBy: s.me, createdAt: new Date().toISOString() }),
          });
          break;
        }
        case "edit-item": {
          const id = form.dataset.id;
          const name = val("name");
          if (!name) return;
          const body = { name, category: val("category"), notes: String(fd.get("notes") || "").trim() };
          this._editingItem = null;
          this._clearDrafts(`edit-name-${id}`, `edit-cat-${id}`, `edit-notes-${id}`);
          const item = this._item(id);
          await this._do("PUT", `/items/${encodeURIComponent(id)}`, body, { optimistic: () => { if (item) Object.assign(item, body); } });
          break;
        }
        case "comment": {
          const body = String(fd.get("body") || "").trim();
          if (!body) return;
          const itemId = form.dataset.item || null;
          this._clearDrafts(`c-${itemId || "general"}`);
          form.querySelector("textarea").value = "";
          await this._do("POST", "/comments", { body, itemId }, {
            optimistic: () => s.comments.push({ id: `tmp-${Date.now()}`, itemId, participantId: s.me, body, createdAt: new Date().toISOString() }),
          });
          break;
        }
        case "menu": {
          const body = { title: val("title"), eventDate: val("eventDate"), notes: String(fd.get("notes") || "").trim() };
          if (!body.title) return;
          this._editingMenu = false;
          this._clearDrafts("menu-title", "menu-date", "menu-notes");
          await this._do("PUT", "/", body, { optimistic: () => Object.assign(s.menu, body) });
          break;
        }
      }
    }
  }

  if (!customElements.get("ps-shared-menu")) customElements.define("ps-shared-menu", PsSharedMenu);
})();
