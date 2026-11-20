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
      --text: #f4f1ea; --muted: #a8a2b4; --faint: #6f6a7c; --hair: rgba(255, 255, 255, 0.07);
      --warm: #f59e0b; --warm-2: #fb923c; --warm-text: #ffc46b; --good: #4ade80; --danger: #f87171; --field: rgba(255, 255, 255, 0.05);
      color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.35;
    }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; color: inherit; }
    .wrap { display: flex; flex-direction: column; gap: 26px; }
    h2 { margin: 0 0 4px; font-size: 1.1rem; }
    .hint { margin: 0 0 12px; color: var(--muted); font-size: 0.9rem; }

    /* Banner */
    .hero { position: relative; overflow: hidden; border-radius: 24px; padding: 22px 20px 20px; color: #fff8ee;
            background: radial-gradient(circle at 85% 15%, rgba(255,214,140,0.35), transparent 45%),
                        linear-gradient(140deg, #7c2d12 0%, #b45309 55%, #d97706 100%); }
    .hero-emoji { font-size: 2.6rem; line-height: 1; margin-bottom: 8px; }
    .hero h1 { margin: 0; font-size: 1.7rem; line-height: 1.15; letter-spacing: -0.01em; overflow-wrap: anywhere; }
    .hero-when { margin-top: 6px; font-size: 0.95rem; opacity: 0.95; }
    .hero-when b { font-weight: 700; }
    .hero-notes { margin: 12px 0 0; white-space: pre-wrap; font-size: 0.95rem; overflow-wrap: anywhere; }
    .hero-people { margin-top: 14px; display: flex; align-items: center; gap: 10px; font-size: 0.88rem; }
    .stack { display: flex; }
    .stack .avatar { margin-left: -6px; box-shadow: 0 0 0 2px #b45309; }
    .stack .avatar:first-child { margin-left: 0; }
    .hero-actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
    .hero-btn { appearance: none; border: none; border-radius: 999px; padding: 10px 18px; font-weight: 700; font-size: 0.95rem;
                cursor: pointer; background: #fff8ee; color: #7c2d12; }
    .hero-btn:hover { background: #ffffff; }
    .hero-btn.ghost { background: rgba(0,0,0,0.2); color: #fff8ee; }
    .hero-off { margin-top: 14px; font-size: 0.9rem; display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
    .hero-links { margin-top: 14px; display: flex; gap: 6px 18px; flex-wrap: wrap; }
    .hero .link { color: #ffe7c2; text-decoration: underline; text-underline-offset: 3px; font-weight: 600; }
    .hero-opts { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.2); display: flex; flex-direction: column;
                 gap: 8px; font-size: 0.85rem; }
    .hero-opts .opt { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .hero input[type=text], .hero input[type=date], .hero textarea { background: rgba(0,0,0,0.28); border-color: rgba(255,255,255,0.25); color: #fff8ee; }
    .hero input::placeholder, .hero textarea::placeholder { color: rgba(255,248,238,0.6); }
    .hero .btn { background: rgba(0,0,0,0.25); border-color: rgba(255,255,255,0.3); color: #fff8ee; }
    .hero .btn-warm { background: #fff8ee; color: #7c2d12; }
    .rename { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    .rename-hint { font-size: 0.82rem; opacity: 0.9; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }

    .avatar { width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--c); color: #1a1208; display: inline-flex;
              align-items: center; justify-content: center; font-weight: 800; font-size: 0.8rem; }
    .avatar.sm { width: 22px; height: 22px; font-size: 0.68rem; }

    /* Buttons & fields */
    .btn { appearance: none; border: 1px solid var(--hair); background: var(--field); border-radius: 12px; padding: 10px 16px;
           font-size: 0.92rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .btn:hover { background: rgba(255,255,255,0.09); }
    .btn-warm { background: linear-gradient(135deg, var(--warm), var(--warm-2)); border: none; color: #2a1605; }
    .link { appearance: none; background: none; border: none; padding: 0; color: var(--warm-text); cursor: pointer; font-size: 0.85rem; font-weight: 600; }
    .link.quiet { color: var(--muted); font-weight: 500; }
    .link.danger { color: var(--danger); font-weight: 500; }
    input[type=text], input[type=date], select, textarea {
      width: 100%; background: var(--field); border: 1px solid var(--hair); border-radius: 12px; padding: 11px 13px; font-size: 1rem; min-width: 0;
    }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--warm); }
    textarea { resize: vertical; }
    .row { display: flex; gap: 8px; }
    .row > input { flex: 1; }
    .stack-form { display: flex; flex-direction: column; gap: 10px; }

    /* Join */
    .join { border-radius: 18px; padding: 18px; background: rgba(245, 158, 11, 0.10); }

    /* Summary */
    .bar { height: 8px; border-radius: 999px; background: var(--field); overflow: hidden; display: flex; }
    .bar span { display: block; height: 100%; transition: width 0.4s ease; }
    .bar .b-ready { background: var(--good); }
    .bar .b-claimed { background: var(--warm); }
    .summary-text { margin-top: 10px; font-size: 0.95rem; color: var(--muted); }
    .summary-text b { color: var(--text); }
    .summary-mine { margin-top: 4px; font-size: 0.9rem; color: var(--muted); }

    /* "What are you bringing?" */
    .bring-form { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 2px; border-bottom: 1.5px solid var(--hair); }
    .bring-form:focus-within { border-bottom-color: var(--warm); }
    .bring-form .plus { width: 34px; flex: none; text-align: center; font-size: 1.5rem; color: var(--warm); font-weight: 300; }
    .bring-form input { flex: 1; background: none; border: none; padding: 12px 0; font-size: 1.05rem; }
    .bring-form .btn-warm { padding: 8px 16px; border-radius: 999px; }

    /* The list */
    .course { margin-top: 26px; }
    .course-title { display: flex; align-items: baseline; gap: 8px; margin: 0 0 2px; font-size: 1rem; font-weight: 800; }
    .course-title .count { color: var(--faint); font-weight: 600; font-size: 0.85rem; }
    ul.list { list-style: none; margin: 0; padding: 0; }
    .entry { border-bottom: 1px solid var(--hair); }
    .line { display: flex; align-items: center; gap: 12px; min-height: 58px; padding: 8px 2px; }
    .mark { width: 34px; height: 34px; flex: none; display: grid; place-items: center; background: none; border: none; padding: 0; cursor: pointer;
            border-radius: 50%; }
    .mark:focus-visible { outline: 2px solid var(--warm); outline-offset: 2px; }
    .ring { width: 24px; height: 24px; border-radius: 50%; border: 2px dashed #57506a; display: grid; place-items: center; }
    .m-open:hover .ring { border-color: var(--warm); }
    .m-mine .ring { border: 2.5px solid var(--c); }
    .m-mine .ring svg { width: 15px; height: 15px; opacity: 0; transition: opacity 0.15s; }
    .m-mine:hover .ring svg { opacity: 0.5; }
    .check { width: 32px; height: 32px; }
    .check path, .ring path { fill: none; stroke: var(--good); stroke-width: 3.4; stroke-linecap: round; stroke-linejoin: round; }
    .m-ready .check { animation: pop 0.25s ease-out; }
    @keyframes pop { from { transform: scale(0.6); } to { transform: scale(1); } }
    .text { flex: 1; min-width: 0; cursor: pointer; background: none; border: none; padding: 0; text-align: left; }
    .name { display: block; font-size: 1.05rem; font-weight: 600; overflow-wrap: anywhere; }
    .entry.ready .name { color: var(--muted); }
    .sub { display: block; margin-top: 2px; font-size: 0.84rem; color: var(--muted); }
    .sub .who { color: var(--c); font-weight: 700; }
    .sub .needs { color: var(--faint); }
    .sub .ok { color: var(--good); font-weight: 600; }
    .bring { appearance: none; background: none; border: none; color: var(--warm-text); font-weight: 700; font-size: 0.9rem; cursor: pointer;
             padding: 10px 4px; white-space: nowrap; }
    .bring:hover { color: var(--warm); }
    .add-line { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 4px 2px; }
    .add-line .plus { width: 34px; flex: none; text-align: center; font-size: 1.3rem; color: var(--faint); }
    .add-line .link { color: var(--faint); font-weight: 500; font-size: 0.92rem; }
    .add-line .link:hover { color: var(--warm-text); }
    .add-line form { flex: 1; }

    .details { padding: 0 2px 16px 48px; display: flex; flex-direction: column; gap: 12px; }
    .details-notes { white-space: pre-wrap; font-size: 0.92rem; overflow-wrap: anywhere; color: var(--text); }
    .details-actions { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
    .people-on { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .people-on li { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
    .people-on .ok { color: var(--good); font-weight: 600; font-size: 0.82rem; }
    .who-select { display: flex; align-items: center; gap: 10px; font-size: 0.88rem; color: var(--muted); }
    .who-select select { width: auto; padding: 7px 10px; font-size: 0.9rem; }

    /* Chat */
    .section-title { margin: 0 0 12px; font-size: 1rem; font-weight: 800; }
    .chat { display: flex; flex-direction: column; gap: 12px; }
    .msg { display: flex; gap: 10px; align-items: flex-start; }
    .msg-body { flex: 1; min-width: 0; }
    .msg-meta { font-size: 0.78rem; color: var(--faint); display: flex; gap: 8px; align-items: baseline; }
    .msg-meta b { color: var(--text); font-size: 0.85rem; }
    .msg-text { font-size: 0.95rem; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
    .chat-form { display: flex; gap: 8px; align-items: flex-end; }
    .chat-form textarea { min-height: 44px; height: 44px; }
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
      .details { padding-left: 46px; }
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
    // Sign-ups. An item wants 1 person (default), a set number, or anyone who likes (wanted = 0).
    _myClaim(item) { return this._state.me ? (item.claims || []).find((c) => c.participantId === this._state.me) || null : null; }
    _isMine(item) { return !!this._myClaim(item); }
    _wanted(item) { return item.wanted == null ? 1 : item.wanted; }
    _isMulti(item) { return this._wanted(item) !== 1; }
    _full(item) { const w = this._wanted(item); return w > 0 && (item.claims || []).length >= w; }
    _covered(item) { const n = (item.claims || []).length; return n > 0 && (this._wanted(item) === 0 || n >= this._wanted(item)); }
    _ready(item) { return this._covered(item) && item.claims.every((c) => c.done); }
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
      return `<div class="error"><div class="big">\u{1F37D}️</div><h2>This menu isn't available</h2><p class="hint">${esc(this._error)}</p></div>`;
    }

    // How a dish looks to you: "open" (there's room for you), "mine" (you're bringing it / some of it),
    // "ready" (your part is ready, or it's all ready), "theirs" (others have it covered).
    _stateOf(item) {
      const mine = this._myClaim(item);
      if (mine) return mine.done ? "ready" : "mine";
      if (!this._full(item)) return "open";
      return this._ready(item) ? "ready" : "theirs";
    }

    _check(cls = "check") {
      return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
    }

    _renderMenu() {
      const s = this._state;
      const me = this._person(s.me);
      return `<div class="wrap">
        ${this._renderHero(me)}
        ${!s.host && !me ? this._renderJoin() : ""}
        ${s.items.length ? this._renderSummary() : ""}
        <div>
          ${me ? this._renderBring() : ""}
          ${this._renderCourses()}
        </div>
        ${this._renderChat()}
        ${s.canManage ? `<div class="center"><button class="link quiet" data-act="delete-menu">Delete this menu</button></div>` : ""}
      </div>`;
    }

    _renderHero(me) {
      const { menu, host, participants, canManage } = this._state;
      if (this._editingMenu) {
        return `<section class="hero"><form class="stack-form" data-form="menu">
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

      let invite = "";
      if (host && menu.shareEnabled) {
        invite = `<div class="hero-actions">
          <button class="hero-btn" data-act="copy-link">\u{1F517} Copy invite link</button>
          ${navigator.share ? `<button class="hero-btn ghost" data-act="native-share">Share…</button>` : ""}
        </div>`;
      } else if (host) {
        invite = `<div class="hero-off">\u{1F512} The invite link is off, so only your family can see this.
          ${canManage ? `<button class="link" data-act="share-on">Turn it back on</button>` : ""}</div>`;
      }

      const links = [];
      if (host && me) {
        links.push(`<button class="link" data-act="edit-menu">Edit details</button>`);
        links.push(`<button class="link" data-act="rename">Your name here: ${esc(me.name)}</button>`);
        if (canManage && menu.shareEnabled) links.push(`<button class="link" data-act="toggle-link-opts">Link options</button>`);
      }
      if (!host && me) links.push(`<button class="link" data-act="rename">Not ${esc(me.name)}? Change name</button>`);

      const opts = this._linkOpts && canManage && menu.shareEnabled
        ? `<div class="hero-opts">
             <div class="opt"><span>Stop anyone else from using the link</span><button class="link" data-act="share-off">Turn off</button></div>
             <div class="opt"><span>Sent it to the wrong person? Get a new link (the old one stops working)</span><button class="link" data-act="regen-link">New link</button></div>
           </div>`
        : "";

      let rename = "";
      if (this._renaming && me) {
        const { profileName, customName } = this._state;
        const hint = host
          ? `<div class="rename-hint">How you show up to everyone on this menu. Your family profile stays “${esc(profileName)}”.
               ${customName ? `<button type="button" class="link" data-act="reset-name">Use “${esc(profileName)}” again</button>` : ""}</div>`
          : "";
        rename = `<form class="rename" data-form="rename">
            <div class="row">
              <input type="text" name="name" data-draft="rename" maxlength="40" value="${esc(me.name)}" placeholder="Your name" required />
              <button class="btn" type="submit">Save</button>
            </div>
            ${hint}
          </form>`;
      }

      return `<section class="hero">
        <div class="hero-emoji" aria-hidden="true">${emojiFor(menu.title)}</div>
        <h1>${esc(menu.title)}</h1>
        ${menu.eventDate ? `<div class="hero-when"><b>${esc(formatDate(menu.eventDate))}</b>${left ? ` · ${esc(left)}` : ""}</div>` : ""}
        ${menu.notes ? `<p class="hero-notes">${esc(menu.notes)}</p>` : ""}
        ${people}
        ${invite}
        ${links.length ? `<div class="hero-links">${links.join("")}</div>` : ""}
        ${opts}
        ${rename}
      </section>`;
    }

    _renderJoin() {
      return `<section class="join">
        <h2>\u{1F44B} Hi! What's your name?</h2>
        <p class="hint">So everyone knows who's bringing what.</p>
        <form class="row" data-form="join">
          <input type="text" name="name" data-draft="join-name" maxlength="40" placeholder="Your name" autocomplete="given-name" required />
          <button class="btn btn-warm" type="submit">Join</button>
        </form>
      </section>`;
    }

    _renderSummary() {
      const items = this._state.items;
      const total = items.length;
      const ready = items.filter((i) => this._ready(i)).length;
      const covered = items.filter((i) => this._covered(i)).length;
      const needed = total - covered;
      const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
      const mine = items.filter((i) => this._isMine(i));
      const mineReady = mine.filter((i) => this._myClaim(i).done).length;
      let mineLine = "";
      if (mine.length) {
        mineLine = `<div class="summary-mine">You're bringing <b>${mine.length}</b> ${mine.length === 1 ? "thing" : "things"}${mineReady === mine.length
          ? ", all ready \u{1F389}"
          : `. Tap the circle next to each one when it's ready.`}</div>`;
      }
      return `<section>
        <div class="bar" aria-hidden="true"><span class="b-ready" style="width:${pct(ready)}"></span><span class="b-claimed" style="width:${pct(covered - ready)}"></span></div>
        <div class="summary-text">${needed
          ? `<b>${covered} of ${total}</b> covered`
          : `<b>Everything's covered</b> \u{1F389}`}${ready ? ` · ${ready} ready` : ""}</div>
        ${mineLine}
      </section>`;
    }

    _renderBring() {
      const list = this._suggestions.length
        ? `<datalist id="sm-suggestions">${this._suggestions.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>` : "";
      return `<form class="bring-form" data-form="bring">
        <span class="plus" aria-hidden="true">+</span>
        <input type="text" name="name" data-draft="bring-name" maxlength="120" placeholder="What are you bringing?" aria-label="What are you bringing?" ${list ? `list="sm-suggestions"` : ""} />
        <button class="btn btn-warm" type="submit">Add</button>
        ${list}
      </form>`;
    }

    _renderCourses() {
      const s = this._state;
      if (!s.items.length && !s.me) return `<div class="empty">Nothing on the menu yet.</div>`;
      // Show courses that have something, plus all of them on an empty menu so there's somewhere to start.
      const courses = Object.keys(COURSES).filter((c) => !s.items.length || s.items.some((i) => this._courseOf(i) === c) || this._addingIn === c);
      return courses.map((c) => {
        const info = COURSES[c];
        const items = s.items.filter((i) => this._courseOf(i) === c);
        let add = "";
        if (s.me && this._addingIn === c) {
          add = `<div class="add-line"><span class="plus" aria-hidden="true">+</span>
            <form class="row" data-form="add-needed" data-course="${c}">
              <input type="text" name="name" data-draft="need-${c}" maxlength="120" placeholder="${esc(`Add ${info.one}…`)}" />
              <button class="btn" type="submit">Add</button>
            </form></div>`;
        } else if (s.me) {
          add = `<div class="add-line"><span class="plus" aria-hidden="true">+</span><button class="link" data-act="add-in" data-course="${c}">Add ${esc(info.one)}</button></div>`;
        }
        return `<section class="course">
          <h3 class="course-title"><span aria-hidden="true">${info.icon}</span>${esc(info.label)}${items.length ? `<span class="count">${items.length}</span>` : ""}</h3>
          ${items.length ? `<ul class="list">${items.map((i) => this._renderItem(i)).join("")}</ul>` : ""}
          ${add}
        </section>`;
      }).join("");
    }

    // "You, Alex ✓ and Sam", each name in their color (you first; ✓ = their part is ready).
    _peopleOn(item, { ticks = true } = {}) {
      const me = this._state.me;
      const claims = [...item.claims].sort((a, b) => (b.participantId === me) - (a.participantId === me));
      const parts = claims.map((c) => {
        const p = this._person(c.participantId);
        const name = c.participantId === me ? "You" : p ? p.name : "Someone";
        return `<span class="who" style="--c:${safeColor(p?.color)}">${esc(name)}</span>${ticks && c.done ? ` <span class="ok">✓</span>` : ""}`;
      });
      if (parts.length <= 1) return parts.join("");
      return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    }

    _renderItem(item) {
      const st = this._stateOf(item);
      const id = esc(item.id);
      const open = this._openItem === item.id;
      const multi = this._isMulti(item);
      const wanted = this._wanted(item);
      const mine = this._myClaim(item);
      const first = this._person(item.claims[0]?.participantId);
      const myColor = safeColor(this._person(this._state.me)?.color);
      const n = this._commentsFor(item.id).length;

      let mark;
      if (st === "open") {
        mark = `<button class="mark m-open" data-act="mark" data-id="${id}" aria-label="${multi ? "Tap to bring some" : "Still needed. Tap if you'll bring it"}"><span class="ring"></span></button>`;
      } else if (st === "mine") {
        mark = `<button class="mark m-mine" style="--c:${myColor}" data-act="mark" data-id="${id}" aria-label="Mark as ready"><span class="ring">${this._check("")}</span></button>`;
      } else if (st === "theirs") {
        mark = `<button class="mark m-theirs" data-act="toggle-details" data-id="${id}" aria-label="${esc(first ? first.name : "Someone")} is bringing this">${this._avatar(first)}</button>`;
      } else {
        mark = `<button class="mark m-ready" data-act="${mine ? "mark" : "toggle-details"}" data-id="${id}" aria-label="${mine ? "Ready. Tap to undo" : "Ready"}">${this._check()}</button>`;
      }

      let sub = "";
      if (!multi) {
        if (st === "mine") sub = `<span class="who" style="--c:${myColor}">You're</span> bringing this`;
        else if (st === "theirs") sub = `${this._peopleOn(item)} is bringing this`;
        else if (st === "ready") sub = `<span class="ok">Ready</span> · ${this._peopleOn(item, { ticks: false })}`;
      } else if (!item.claims.length) {
        sub = `<span class="needs">${wanted === 0 ? "Anyone can bring some" : `Needs ${wanted} people`}</span>`;
      } else {
        const count = wanted === 0 ? "more welcome" : this._full(item) ? `all ${wanted} covered` : `${item.claims.length} of ${wanted}`;
        const allReady = this._ready(item);
        sub = `${allReady ? `<span class="ok">Ready</span> · ` : ""}${this._peopleOn(item, { ticks: !allReady })} · <span class="needs">${count}</span>`;
      }
      const extras = [];
      if (n) extras.push(`\u{1F4AC} ${n}`);
      if (item.notes && !open) extras.push("\u{1F4DD} note");
      sub = [sub, ...extras].filter(Boolean).join(" · ");

      const cta = st === "open" ? `<button class="bring" data-act="claim" data-id="${id}">${multi ? "Count me in" : "I'll bring it"}</button>` : "";
      return `<li class="entry ${st}">
        <div class="line">
          ${mark}
          <button class="text" data-act="toggle-details" data-id="${id}" aria-expanded="${open}">
            <span class="name">${esc(item.name)}</span>
            ${sub ? `<span class="sub">${sub}</span>` : ""}
          </button>
          ${cta}
        </div>
        ${open ? this._renderDetails(item) : ""}
      </li>`;
    }

    _wantedOptions(current) {
      const opts = [[1, "Just one person"], [2, "2 people"], [3, "3 people"], [4, "4 people"], [5, "5 people"], [6, "6 people"], [8, "8 people"], [10, "10 people"], [0, "Anyone who wants to"]];
      if (!opts.some(([v]) => v === current)) opts.splice(-1, 0, [current, `${current} people`]);
      return opts.map(([v, l]) => `<option value="${v}" ${v === current ? "selected" : ""}>${l}</option>`).join("");
    }

    _renderDetails(item) {
      const s = this._state;
      const id = esc(item.id);
      if (this._editingItem === item.id) {
        return `<div class="details"><form class="stack-form" data-form="edit-item" data-id="${id}">
          <input type="text" name="name" data-draft="edit-name-${id}" maxlength="120" value="${esc(item.name)}" required />
          <div class="row">
            <select name="category" data-draft="edit-cat-${id}" aria-label="Course">
              ${Object.entries(COURSES).map(([k, v]) => `<option value="${k}" ${k === this._courseOf(item) ? "selected" : ""}>${v.icon} ${esc(v.label)}</option>`).join("")}
            </select>
            <select name="wanted" data-draft="edit-wanted-${id}" aria-label="How many people can bring it?">${this._wantedOptions(this._wanted(item))}</select>
          </div>
          <textarea name="notes" data-draft="edit-notes-${id}" rows="2" maxlength="1000" placeholder="Notes: how much, recipe link, gluten-free…">${esc(item.notes)}</textarea>
          <div class="row"><button class="btn btn-warm" type="submit">Save</button><button class="btn" type="button" data-act="cancel-edit">Cancel</button></div>
        </form></div>`;
      }
      const mine = this._myClaim(item);
      const multi = this._isMulti(item);
      const actions = [];
      if (s.me) {
        if (mine) {
          actions.push(`<button class="link" data-act="toggle-ready" data-id="${id}">${mine.done ? "Not ready after all" : multi ? "✓ My part is ready" : "✓ Mark as ready"}</button>`);
          actions.push(`<button class="link quiet" data-act="unclaim" data-id="${id}">I can't bring it anymore</button>`);
        }
        actions.push(`<button class="link quiet" data-act="edit-item" data-id="${id}">${item.notes ? "Edit" : "Edit / add a note"}</button>`);
        if (this._canDeleteItem(item)) actions.push(`<button class="link quiet" data-act="delete-item" data-id="${id}">Remove</button>`);
      }

      // Family members can see and change who's on it.
      let who = "";
      if (s.host && s.me && !multi) {
        const current = item.claims[0]?.participantId || "";
        who = `<label class="who-select">Who's bringing it?
             <select data-act="assign" data-id="${id}"><option value="">Nobody yet</option>
               ${s.participants.map((p) => `<option value="${esc(p.id)}" ${p.id === current ? "selected" : ""}>${esc(p.id === s.me ? `${p.name} (you)` : p.name)}</option>`).join("")}
             </select></label>`;
      } else if (multi && item.claims.length) {
        const rows = item.claims.map((c) => {
          const p = this._person(c.participantId);
          const name = c.participantId === s.me ? "You" : p ? p.name : "Someone";
          return `<li>${this._avatar(p, "sm")}<span>${esc(name)}</span>${c.done ? `<span class="ok">✓ ready</span>` : ""}
            ${s.host && s.me && c.participantId !== s.me ? `<button class="link quiet" data-act="remove-claim" data-id="${id}" data-pid="${esc(c.participantId)}">take off</button>` : ""}</li>`;
        }).join("");
        const addable = s.host && s.me && !this._full(item) ? s.participants.filter((p) => !item.claims.some((c) => c.participantId === p.id)) : [];
        who = `<ul class="people-on">${rows}</ul>${addable.length
          ? `<label class="who-select">Add someone:
               <select data-act="add-person" data-id="${id}"><option value="">Pick a person…</option>
                 ${addable.map((p) => `<option value="${esc(p.id)}">${esc(p.id === s.me ? `${p.name} (you)` : p.name)}</option>`).join("")}
               </select></label>` : ""}`;
      }
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
      return `<section><h3 class="section-title">\u{1F4AC} Chat</h3>${this._renderThread(null)}</section>`;
    }

    // ---- Events ----

    _needName() {
      this._showToast("Add your name first so people know who's bringing it");
      this._focusDraft("join-name");
    }

    // Sign-up actions, updated on screen right away and confirmed by the next state load.
    _claimPath(item, pid) { return `/items/${encodeURIComponent(item.id)}/claims${pid ? `/${encodeURIComponent(pid)}` : ""}`; }
    _signUp(item, pid = this._state.me) {
      const body = pid === this._state.me ? {} : { participantId: pid };
      return this._do("POST", this._claimPath(item), body, {
        optimistic: () => {
          if (!this._isMulti(item) && pid !== this._state.me) item.claims = []; // family reassigning a one-person dish
          if (!item.claims.some((c) => c.participantId === pid)) item.claims.push({ participantId: pid, done: false, createdAt: new Date().toISOString() });
        },
      });
    }
    _setMyDone(item, done) {
      return this._do("PUT", this._claimPath(item, "me"), { done }, { optimistic: () => { const c = this._myClaim(item); if (c) c.done = done; } });
    }
    _dropOut(item, pid) {
      const path = this._claimPath(item, pid === this._state.me ? "me" : pid);
      return this._do("DELETE", path, undefined, { optimistic: () => { item.claims = item.claims.filter((c) => c.participantId !== pid); } });
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
        case "mark": {
          // The circle next to a dish moves it along: needed -> you're bringing it -> ready (and back).
          const item = this._item(id);
          if (!item) return;
          const st = this._stateOf(item);
          if (st === "open") {
            if (!s.me) return this._needName();
            this._signUp(item);
          } else if (this._isMine(item)) {
            this._setMyDone(item, !this._myClaim(item).done);
          } else {
            this._openItem = this._openItem === id ? null : id;
            this.render();
          }
          break;
        }
        case "claim": {
          if (!s.me) return this._needName();
          const item = this._item(id);
          if (item) this._signUp(item);
          break;
        }
        case "unclaim": {
          const item = this._item(id);
          if (item) this._dropOut(item, s.me);
          break;
        }
        case "remove-claim": {
          const item = this._item(id);
          const p = this._person(el.dataset.pid);
          if (item && confirm(`Take ${p ? p.name : "them"} off "${item.name}"?`)) this._dropOut(item, el.dataset.pid);
          break;
        }
        case "toggle-ready": {
          const item = this._item(id);
          if (item && this._isMine(item)) this._setMyDone(item, !this._myClaim(item).done);
          break;
        }
        case "edit-item":
          this._editingItem = id;
          this._clearDrafts(`edit-name-${id}`, `edit-cat-${id}`, `edit-wanted-${id}`, `edit-notes-${id}`);
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
        case "reset-name": {
          this._renaming = false;
          this._clearDrafts("rename");
          const me = this._person(s.me);
          await this._do("PUT", "/me", { name: "" }, { optimistic: () => { if (me) me.name = s.profileName; } });
          break;
        }
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
      const item = this._item(el.dataset.id);
      if (!item) return;
      if (el.dataset.act === "assign") {
        // One-person dish: family picks who's bringing it (or nobody).
        if (el.value) this._signUp(item, el.value);
        else this._do("PUT", `/items/${encodeURIComponent(item.id)}`, { claimedBy: null }, { optimistic: () => { item.claimedBy = null; item.claims = []; } });
      } else if (el.dataset.act === "add-person" && el.value) {
        this._signUp(item, el.value);
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
          const me = this._person(s.me);
          await this._do("PUT", "/me", { name }, { optimistic: () => { if (me) me.name = name; } });
          break;
        }
        case "bring": {
          // "I'm bringing X": sign up if it's already on the menu with room for you, otherwise add it as yours.
          const name = val("name");
          if (!name) return this._focusDraft("bring-name");
          this._clearDrafts("bring-name");
          form.querySelector("[name=name]").value = "";
          const existing = s.items.find((i) => i.name.trim().toLowerCase() === name.toLowerCase() && !this._isMine(i) && !this._full(i));
          if (existing) {
            if (await this._signUp(existing)) this._showToast(`Thanks! You're bringing ${existing.name}`, true);
          } else {
            const category = guessCourse(name);
            await this._do("POST", "/items", { name, category, claimedBy: s.me }, {
              optimistic: () => s.items.push({ id: `tmp-${Date.now()}`, name, category, notes: "", wanted: 1, claims: [{ participantId: s.me, done: false }], addedBy: s.me, createdAt: new Date().toISOString() }),
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
            optimistic: () => s.items.push({ id: `tmp-${Date.now()}`, name, category: course, notes: "", wanted: 1, claims: [], addedBy: s.me, createdAt: new Date().toISOString() }),
          });
          break;
        }
        case "edit-item": {
          const id = form.dataset.id;
          const name = val("name");
          if (!name) return;
          const body = { name, category: val("category"), wanted: Number(val("wanted") || 1), notes: String(fd.get("notes") || "").trim() };
          this._editingItem = null;
          this._clearDrafts(`edit-name-${id}`, `edit-cat-${id}`, `edit-wanted-${id}`, `edit-notes-${id}`);
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
