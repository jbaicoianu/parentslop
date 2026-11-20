// ps-shared-menu: a shared potluck menu checklist (add items, claim them, tick them off, comment).
// Self-contained (no core.js) so the guest page at /m/<token> can use it too.
//
//   <ps-shared-menu token="...">     guest view through a shared link (API under /api/m/<token>)
//   <ps-shared-menu menu-id="...">   family view inside the app (API under /api/shared-menus/<id>)
//
// Optional property `suggestions` (array of strings) feeds the add-item autocomplete.
// Fires "menu-deleted" (bubbles, composed) after a parent deletes the menu.
(() => {
  const CATEGORY_INFO = {
    appetizers: ["\u{1F9C0}", "Appetizers"],
    mains: ["\u{1F357}", "Mains"],
    sides: ["\u{1F954}", "Sides"],
    desserts: ["\u{1F967}", "Desserts"],
    drinks: ["\u{1F377}", "Drinks"],
    other: ["\u{1F9FA}", "Supplies & other"],
  };
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeColor = (c) => (COLOR_RE.test(c || "") ? c : "#8b8fa8");

  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function formatDate(ymd) {
    if (!ymd) return "";
    return new Date(ymd + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }
  function countdown(ymd) {
    if (!ymd) return "";
    const days = Math.round((new Date(ymd + "T12:00:00") - new Date(localToday() + "T12:00:00")) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days > 1) return `in ${days} days`;
    if (days === -1) return "yesterday";
    return `${-days} days ago`;
  }
  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const STYLES = `
    :host {
      display: block;
      --bg-card: #12131f; --bg-raised: #1a1c2a; --border: #25273a; --text: #e2e4f0; --muted: #a0a4be;
      --accent: #66d9ef; --good: #4ade80; --danger: #ff6b81;
      color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; color: inherit; }
    .wrap { display: flex; flex-direction: column; gap: 14px; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; padding: 14px; }

    .hero h1 { margin: 2px 0 4px; font-size: 1.45rem; line-height: 1.2; }
    .eyebrow { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .when { color: var(--muted); font-size: 0.88rem; }
    .when b { color: var(--text); font-weight: 600; }
    .menu-notes { margin: 10px 0 0; white-space: pre-wrap; font-size: 0.9rem; line-height: 1.4; }
    .hero-actions { margin-top: 8px; display: flex; gap: 12px; }

    .btn { appearance: none; border: 1px solid var(--border); background: var(--bg-raised); border-radius: 10px;
           padding: 8px 14px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
    .btn:hover { border-color: #3a3d55; }
    .btn:disabled { opacity: 0.5; cursor: default; }
    .btn-primary { background: #1d4b5a; border-color: #2f7a8f; color: #dff7ff; }
    .btn-primary:hover { background: #235a6c; }
    .btn-danger { color: var(--danger); }
    .link { appearance: none; background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: 0.8rem; }
    .link.danger { color: var(--danger); }
    .muted { color: var(--muted); }
    .small { font-size: 0.78rem; }

    input[type=text], input[type=date], select, textarea {
      background: #0d0e16; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; font-size: 0.9rem; min-width: 0;
    }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #2f7a8f; }
    textarea { resize: vertical; width: 100%; }

    .share-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .share-url { flex: 1 1 220px; font-family: ui-monospace, monospace; font-size: 0.8rem !important; color: var(--muted); }
    .share-meta { margin-top: 8px; font-size: 0.78rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
    .share-off { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 0.85rem; }

    .people { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .person { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 3px; border-radius: 999px;
              background: var(--bg-raised); border: 1px solid var(--border); font-size: 0.8rem; }
    .dot { width: 22px; height: 22px; border-radius: 50%; background: var(--c); color: #0b0c12; display: inline-flex;
           align-items: center; justify-content: center; font-weight: 800; font-size: 0.72rem; }
    .person.me { border-color: var(--c); }

    .join h3 { margin: 0 0 4px; font-size: 1rem; }
    .join p { margin: 0 0 10px; font-size: 0.85rem; color: var(--muted); }
    .inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
    .inline-form input[type=text] { flex: 1 1 180px; }

    .progress .bar { height: 8px; border-radius: 999px; background: #0d0e16; overflow: hidden; display: flex; }
    .progress .bar span { display: block; height: 100%; }
    .progress .bar .b-done { background: var(--good); }
    .progress .bar .b-claimed { background: #2f7a8f; }
    .counts { margin-top: 6px; font-size: 0.8rem; color: var(--muted); }

    .filters { display: flex; gap: 2px; background: #0d0e16; border-radius: 12px; padding: 3px; }
    .filter { flex: 1; padding: 7px; border: none; border-radius: 10px; background: transparent; color: var(--muted);
              font-size: 0.82rem; font-weight: 600; cursor: pointer; }
    .filter.active { background: var(--bg-raised); color: var(--text); }

    .add { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .add .add-name { grid-column: 1 / -1; }
    .add-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .claim-check { display: inline-flex; gap: 6px; align-items: center; font-size: 0.82rem; color: var(--muted); cursor: pointer; }

    .cat-head { display: flex; align-items: center; gap: 8px; margin: 4px 2px 6px; font-size: 0.8rem; font-weight: 700;
                text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .cat-head .n { font-weight: 500; opacity: 0.7; }
    .cat-head .link { margin-left: auto; text-transform: none; letter-spacing: 0; }
    ul.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .item { background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px; }
    .item.open { border-color: #34374f; }
    .item-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
    .check { flex: none; width: 24px; height: 24px; border-radius: 7px; border: 2px solid #444a63; background: transparent;
             cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800; color: transparent; padding: 0; }
    .check:disabled { cursor: default; }
    .item.done .check { background: var(--good); border-color: var(--good); color: #062; }
    .item-main { flex: 1; min-width: 0; cursor: pointer; }
    .item-name { font-weight: 600; font-size: 0.95rem; overflow-wrap: anywhere; }
    .item.done .item-name { text-decoration: line-through; color: var(--muted); }
    .item-notes { font-size: 0.78rem; color: var(--muted); margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .item-side { display: flex; align-items: center; gap: 6px; flex: none; }
    .claim { appearance: none; border: 1px dashed #3a3d55; background: transparent; border-radius: 999px; padding: 4px 10px;
             font-size: 0.75rem; font-weight: 600; color: var(--accent); cursor: pointer; white-space: nowrap; }
    .claim:hover { border-color: var(--accent); }
    .claimed { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px 2px 2px; font-size: 0.75rem;
               font-weight: 600; background: color-mix(in srgb, var(--c) 18%, transparent); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
               white-space: nowrap; max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
    .claimed .dot { width: 18px; height: 18px; font-size: 0.62rem; }
    button.claimed { cursor: pointer; color: var(--text); }
    .unclaimed { font-size: 0.75rem; color: #6b6f88; font-style: italic; }
    .icon-btn { appearance: none; border: none; background: transparent; cursor: pointer; font-size: 0.8rem; color: var(--muted);
                padding: 4px 6px; border-radius: 8px; white-space: nowrap; }
    .icon-btn:hover { background: var(--bg-raised); }
    .icon-btn.has { color: var(--text); }

    .item-panel { border-top: 1px solid var(--border); padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
    .panel-actions { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 0.8rem; color: var(--muted); }
    .panel-actions select { padding: 4px 8px; font-size: 0.8rem; }
    .edit-form { display: flex; flex-direction: column; gap: 8px; }
    .edit-form .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .edit-form .row > input[type=text] { flex: 1 1 200px; }
    .form-actions { display: flex; gap: 8px; }

    .thread { display: flex; flex-direction: column; gap: 8px; }
    .comment { display: flex; gap: 8px; align-items: flex-start; }
    .comment .dot { flex: none; margin-top: 1px; }
    .comment-body { flex: 1; min-width: 0; }
    .comment-meta { font-size: 0.75rem; color: var(--muted); display: flex; gap: 8px; align-items: baseline; }
    .comment-meta b { color: var(--text); font-weight: 600; }
    .comment-text { font-size: 0.88rem; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1px; line-height: 1.35; }
    .comment-form { display: flex; gap: 8px; align-items: flex-end; }
    .comment-form textarea { min-height: 38px; height: 38px; }
    .no-comments { font-size: 0.8rem; color: #6b6f88; font-style: italic; }
    .section-title { font-size: 0.85rem; font-weight: 700; margin: 0 0 10px; }

    .empty { text-align: center; padding: 26px 10px; color: var(--muted); font-size: 0.9rem; }
    .error { text-align: center; padding: 34px 16px; }
    .error h2 { margin: 0 0 6px; font-size: 1.1rem; }
    .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: #2a1520; border: 1px solid #6b2d3d;
             color: #ffd6dd; padding: 10px 16px; border-radius: 12px; font-size: 0.85rem; z-index: 1000; max-width: calc(100vw - 32px); }
    .toast.ok { background: #13281c; border-color: #2d6b45; color: #c9f7d8; }
    .danger-zone { text-align: center; padding-top: 4px; }
    @media (max-width: 480px) {
      .item-row { padding: 9px 10px; gap: 8px; }
      .claimed { max-width: 96px; }
    }
  `;

  class PsSharedMenu extends HTMLElement {
    static get observedAttributes() { return ["token", "menu-id"]; }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._state = null;
      this._error = null;
      this._filter = "all"; // all | mine | open
      this._openItem = null; // item id whose panel is expanded
      this._editingItem = null;
      this._editingMenu = false;
      this._renaming = false;
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
        if (e.body?.needsJoin) { this._state.me = null; }
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
    _isMine(item) { return !!this._state.me && item.claimedBy === this._state.me; }
    _canDeleteItem(item) { return !!this._state.me && (this._state.host || item.addedBy === this._state.me); }
    _canDeleteComment(c) { return !!this._state.me && (this._state.host || c.participantId === this._state.me); }
    _commentsFor(itemId) { return this._state.comments.filter((c) => (c.itemId || null) === (itemId || null)); }

    _dot(p) {
      const name = p ? p.name : "?";
      return `<span class="dot" style="--c:${safeColor(p?.color)}">${esc((name.trim()[0] || "?").toUpperCase())}</span>`;
    }

    // Keep typed-but-unsent text (and focus) across re-renders triggered by live updates.
    _saveDrafts() {
      const sr = this.shadowRoot;
      for (const el of sr.querySelectorAll("[data-draft]")) {
        this._drafts[el.dataset.draft] = el.type === "checkbox" ? el.checked : el.value;
      }
      const a = sr.activeElement;
      this._focus = a && a.dataset?.draft ? { key: a.dataset.draft, start: a.selectionStart, end: a.selectionEnd } : null;
    }

    _restoreDrafts() {
      const sr = this.shadowRoot;
      for (const el of sr.querySelectorAll("[data-draft]")) {
        const v = this._drafts[el.dataset.draft];
        if (v === undefined) continue;
        if (el.type === "checkbox") el.checked = !!v; else el.value = v;
      }
      if (this._focus) {
        const el = sr.querySelector(`[data-draft="${CSS.escape(this._focus.key)}"]`);
        if (el) {
          el.focus();
          try { if (this._focus.start != null) el.setSelectionRange(this._focus.start, this._focus.end); } catch {}
        }
      }
    }

    _clearDrafts(...keys) { for (const k of keys) delete this._drafts[k]; }

    // ---- Render ----

    render() {
      this._saveDrafts();
      let body;
      if (this._error) body = this._renderError();
      else if (!this._state) body = `<div class="empty">Loading menu…</div>`;
      else body = this._renderMenu();
      this.shadowRoot.innerHTML = `<style>${STYLES}</style>${body}${this._toast ? `<div class="toast ${this._toast.ok ? "ok" : ""}" role="status">${esc(this._toast.msg)}</div>` : ""}`;
      this._restoreDrafts();
    }

    _renderError() {
      return `<div class="card error"><h2>\u{1F37D}️ Menu unavailable</h2><p class="muted">${esc(this._error)}</p></div>`;
    }

    _renderMenu() {
      const s = this._state;
      const me = this._person(s.me);
      return `<div class="wrap">
        ${this._renderHero()}
        ${s.host ? this._renderShare() : ""}
        ${!s.host && !me ? this._renderJoin() : ""}
        ${this._renderPeople(me)}
        ${s.items.length ? this._renderProgress() : ""}
        ${me ? this._renderAddForm() : ""}
        ${this._renderItems()}
        ${this._renderGeneral()}
        ${s.canManage ? `<div class="danger-zone"><button class="link danger" data-act="delete-menu">Delete this menu</button></div>` : ""}
      </div>`;
    }

    _renderHero() {
      const { menu, host, me } = this._state;
      if (this._editingMenu) {
        return `<section class="card hero"><form class="edit-form" data-form="menu">
          <input type="text" name="title" data-draft="menu-title" maxlength="120" value="${esc(menu.title)}" placeholder="Title" required />
          <div class="row"><input type="date" name="eventDate" data-draft="menu-date" value="${esc(menu.eventDate)}" /></div>
          <textarea name="notes" data-draft="menu-notes" rows="3" maxlength="2000" placeholder="Notes for everyone (time, address, allergies...)">${esc(menu.notes)}</textarea>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><button class="btn" type="button" data-act="cancel-menu">Cancel</button></div>
        </form></section>`;
      }
      const when = menu.eventDate ? `<div class="when">\u{1F4C5} <b>${esc(formatDate(menu.eventDate))}</b> · ${esc(countdown(menu.eventDate))}</div>` : "";
      return `<section class="hero">
        <div class="eyebrow">Shared menu</div>
        <h1>${esc(menu.title)}</h1>
        ${when}
        ${menu.notes ? `<p class="menu-notes">${esc(menu.notes)}</p>` : ""}
        ${host && me ? `<div class="hero-actions"><button class="link" data-act="edit-menu">Edit details</button></div>` : ""}
      </section>`;
    }

    _shareUrl() { return location.origin + this._state.menu.sharePath; }

    _renderShare() {
      const { menu, canManage } = this._state;
      if (!menu.shareEnabled) {
        return `<section class="card share-off"><span class="muted">\u{1F512} Link sharing is off. Only your family can see this menu.</span>
          ${canManage ? `<button class="btn" data-act="share-on">Turn link on</button>` : ""}</section>`;
      }
      return `<section class="card">
        <div class="share-row">
          <input type="text" class="share-url" readonly value="${esc(this._shareUrl())}" aria-label="Share link" />
          <button class="btn btn-primary" data-act="copy-link">Copy link</button>
          ${navigator.share ? `<button class="btn" data-act="native-share">Share…</button>` : ""}
        </div>
        <div class="share-meta"><span>Anyone with this link can add items, claim them and comment.</span>
          ${canManage ? `<button class="link" data-act="share-off">Turn off link</button><button class="link" data-act="regen-link">Make a new link</button>` : ""}
        </div>
      </section>`;
    }

    _renderJoin() {
      return `<section class="card join">
        <h3>\u{1F44B} Who's this?</h3>
        <p>Add your name so everyone can see who's bringing what. You can look around first.</p>
        <form class="inline-form" data-form="join">
          <input type="text" name="name" data-draft="join-name" maxlength="40" placeholder="Your name" autocomplete="given-name" required />
          <button class="btn btn-primary" type="submit">Join</button>
        </form>
      </section>`;
    }

    _renderPeople(me) {
      const s = this._state;
      if (!s.participants.length) return "";
      const chips = s.participants.map((p) => `<span class="person ${p.id === s.me ? "me" : ""}" style="--c:${safeColor(p.color)}">${this._dot(p)}${esc(p.name)}${p.id === s.me ? " <span class='muted'>(you)</span>" : ""}</span>`).join("");
      let rename = "";
      if (!s.host && me) {
        rename = this._renaming
          ? `<form class="inline-form" data-form="rename" style="margin-top:8px">
               <input type="text" name="name" data-draft="rename" maxlength="40" value="${esc(me.name)}" required />
               <button class="btn btn-primary" type="submit">Save</button><button class="btn" type="button" data-act="cancel-rename">Cancel</button>
             </form>`
          : `<div style="margin-top:6px"><button class="link" data-act="rename">Change my name</button></div>`;
      }
      return `<section><div class="people">${chips}</div>${rename}</section>`;
    }

    _renderProgress() {
      const items = this._state.items;
      const total = items.length;
      const done = items.filter((i) => i.done).length;
      const claimed = items.filter((i) => i.claimedBy).length;
      const claimedNotDone = items.filter((i) => i.claimedBy && !i.done).length;
      const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
      const mine = this._state.me ? items.filter((i) => this._isMine(i)).length : 0;
      const open = items.filter((i) => !i.claimedBy).length;
      const f = this._filter;
      return `<section class="progress">
        <div class="bar" aria-hidden="true"><span class="b-done" style="width:${pct(done)}"></span><span class="b-claimed" style="width:${pct(claimedNotDone)}"></span></div>
        <div class="counts">${total} item${total === 1 ? "" : "s"} · ${claimed} claimed · ${done} ready${open ? ` · <b style="color:var(--text)">${open} still need someone</b>` : " · everything's covered \u{1F389}"}</div>
      </section>
      <div class="filters" role="tablist">
        <button class="filter ${f === "all" ? "active" : ""}" data-act="filter" data-filter="all">All (${total})</button>
        ${this._state.me ? `<button class="filter ${f === "mine" ? "active" : ""}" data-act="filter" data-filter="mine">Mine (${mine})</button>` : ""}
        <button class="filter ${f === "open" ? "active" : ""}" data-act="filter" data-filter="open">Unclaimed (${open})</button>
      </div>`;
    }

    _categoryOptions(selected) {
      return this._state.categories.map((c) => `<option value="${esc(c)}" ${c === selected ? "selected" : ""}>${esc((CATEGORY_INFO[c] || ["", c])[1])}</option>`).join("");
    }

    _renderAddForm() {
      const cat = this._drafts["add-cat"] || "mains";
      const list = this._suggestions.length
        ? `<datalist id="sm-suggestions">${this._suggestions.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>` : "";
      return `<form class="card add" data-form="add-item">
        <input type="text" class="add-name" name="name" data-draft="add-name" maxlength="120" placeholder="Add a dish, drink or supply…" ${list ? `list="sm-suggestions"` : ""} required />
        <div class="add-row">
          <select name="category" data-draft="add-cat" aria-label="Category">${this._categoryOptions(cat)}</select>
          <label class="claim-check"><input type="checkbox" name="claim" data-draft="add-claim" /> I'll bring it</label>
        </div>
        <button class="btn btn-primary" type="submit">Add</button>
        ${list}
      </form>`;
    }

    _renderItems() {
      const s = this._state;
      if (!s.items.length) {
        return `<div class="card empty">Nothing on the menu yet.${s.me ? " Add the first dish above." : ""}</div>`;
      }
      let items = s.items;
      if (this._filter === "mine" && s.me) items = items.filter((i) => this._isMine(i));
      if (this._filter === "open") items = items.filter((i) => !i.claimedBy);
      if (!items.length) {
        return `<div class="card empty">${this._filter === "mine" ? "You haven't claimed anything yet." : "Everything has someone on it. \u{1F389}"}</div>`;
      }
      return s.categories.map((cat) => {
        const inCat = items.filter((i) => (s.categories.includes(i.category) ? i.category : "other") === cat);
        if (!inCat.length) return "";
        const [icon, label] = CATEGORY_INFO[cat] || ["", cat];
        return `<section>
          <div class="cat-head"><span>${icon}</span><span>${esc(label)}</span><span class="n">${inCat.length}</span>
            ${s.me ? `<button class="link" data-act="add-in" data-cat="${esc(cat)}">+ Add</button>` : ""}</div>
          <ul class="items">${inCat.map((i) => this._renderItem(i)).join("")}</ul>
        </section>`;
      }).join("");
    }

    _renderClaim(item) {
      const s = this._state;
      if (!item.claimedBy) {
        return s.me ? `<button class="claim" data-act="claim" data-id="${esc(item.id)}">I'll bring it</button>` : `<span class="unclaimed">Unclaimed</span>`;
      }
      const p = this._person(item.claimedBy);
      if (this._isMine(item)) {
        return `<button class="claimed" style="--c:${safeColor(p?.color)}" data-act="unclaim" data-id="${esc(item.id)}" title="Let someone else bring it">${this._dot(p)}You ✕</button>`;
      }
      return `<span class="claimed" style="--c:${safeColor(p?.color)}" title="${esc(p ? p.name : "Someone")} is bringing this">${this._dot(p)}${esc(p ? p.name : "Someone")}</span>`;
    }

    _renderItem(item) {
      const s = this._state;
      const open = this._openItem === item.id;
      const n = this._commentsFor(item.id).length;
      return `<li class="item ${item.done ? "done" : ""} ${open ? "open" : ""}">
        <div class="item-row">
          <button class="check" data-act="toggle-done" data-id="${esc(item.id)}" aria-pressed="${item.done}" title="${item.done ? "Mark as not ready" : "Mark as ready"}" ${s.me ? "" : "disabled"}>✓</button>
          <div class="item-main" data-act="toggle-panel" data-id="${esc(item.id)}">
            <div class="item-name">${esc(item.name)}</div>
            ${item.notes ? `<div class="item-notes">${esc(item.notes)}</div>` : ""}
          </div>
          <div class="item-side">
            ${this._renderClaim(item)}
            <button class="icon-btn ${n ? "has" : ""}" data-act="toggle-panel" data-id="${esc(item.id)}" aria-expanded="${open}" title="Comments">\u{1F4AC}${n ? ` ${n}` : ""}</button>
          </div>
        </div>
        ${open ? this._renderItemPanel(item) : ""}
      </li>`;
    }

    _renderItemPanel(item) {
      const s = this._state;
      const id = esc(item.id);
      let top = "";
      if (this._editingItem === item.id) {
        top = `<form class="edit-form" data-form="edit-item" data-id="${id}">
          <div class="row">
            <input type="text" name="name" data-draft="edit-name-${id}" maxlength="120" value="${esc(item.name)}" required />
            <select name="category" data-draft="edit-cat-${id}">${this._categoryOptions(item.category)}</select>
          </div>
          <textarea name="notes" data-draft="edit-notes-${id}" rows="2" maxlength="1000" placeholder="Notes (recipe link, quantity, dietary info...)">${esc(item.notes)}</textarea>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><button class="btn" type="button" data-act="cancel-edit">Cancel</button></div>
        </form>`;
      } else if (s.me) {
        const added = this._person(item.addedBy);
        const assign = s.host
          ? `<label>Bringing it: <select data-act="assign" data-id="${id}"><option value="">Nobody yet</option>${s.participants.map((p) => `<option value="${esc(p.id)}" ${p.id === item.claimedBy ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>`
          : "";
        top = `<div class="panel-actions">
          ${assign}
          <button class="link" data-act="edit-item" data-id="${id}">${item.notes ? "Edit" : "Edit / add notes"}</button>
          ${this._canDeleteItem(item) ? `<button class="link danger" data-act="delete-item" data-id="${id}">Remove</button>` : ""}
          ${added ? `<span class="small">Added by ${esc(added.name)}</span>` : ""}
        </div>`;
      }
      return `<div class="item-panel">${top}${this._renderThread(item.id)}</div>`;
    }

    _renderThread(itemId) {
      const s = this._state;
      const key = itemId || "general";
      const comments = this._commentsFor(itemId);
      const list = comments.length
        ? comments.map((c) => {
          const p = this._person(c.participantId);
          return `<div class="comment">${this._dot(p)}<div class="comment-body">
            <div class="comment-meta"><b>${esc(p ? p.name : "Someone")}</b><span>${esc(timeAgo(c.createdAt))}</span>
              ${this._canDeleteComment(c) ? `<button class="link danger small" data-act="delete-comment" data-id="${esc(c.id)}">delete</button>` : ""}</div>
            <div class="comment-text">${esc(c.body)}</div></div></div>`;
        }).join("")
        : `<div class="no-comments">${itemId ? "No comments yet." : "No messages yet."}</div>`;
      const form = s.me
        ? `<form class="comment-form" data-form="comment" data-item="${esc(itemId || "")}">
             <textarea name="body" data-draft="c-${esc(key)}" maxlength="2000" rows="1" placeholder="${itemId ? "Comment on this item…" : "Message everyone…"}"></textarea>
             <button class="btn" type="submit">Send</button>
           </form>`
        : "";
      return `<div class="thread">${list}${form}</div>`;
    }

    _renderGeneral() {
      return `<section class="card"><h3 class="section-title">\u{1F4AC} Discussion</h3>${this._renderThread(null)}</section>`;
    }

    // ---- Events ----

    _item(id) { return this._state?.items.find((i) => i.id === id); }

    async _onClick(e) {
      const el = e.target.closest("[data-act]");
      if (!el || el.tagName === "SELECT" || !this._state) return;
      const act = el.dataset.act;
      const id = el.dataset.id;
      const s = this._state;
      switch (act) {
        case "filter": this._filter = el.dataset.filter; this.render(); break;
        case "toggle-panel":
          this._openItem = this._openItem === id ? null : id;
          if (this._openItem !== this._editingItem) this._editingItem = null;
          this.render();
          break;
        case "toggle-done": {
          const item = this._item(id);
          if (!item) return;
          const done = !item.done;
          this._do("PUT", `/items/${encodeURIComponent(id)}`, { done }, { optimistic: () => { item.done = done; } });
          break;
        }
        case "claim": {
          const item = this._item(id);
          if (item) this._do("PUT", `/items/${encodeURIComponent(id)}`, { claimedBy: s.me }, { optimistic: () => { item.claimedBy = s.me; } });
          break;
        }
        case "unclaim": {
          const item = this._item(id);
          if (item) this._do("PUT", `/items/${encodeURIComponent(id)}`, { claimedBy: null }, { optimistic: () => { item.claimedBy = null; } });
          break;
        }
        case "edit-item":
          this._editingItem = id;
          this._clearDrafts(`edit-name-${id}`, `edit-cat-${id}`, `edit-notes-${id}`);
          this.render();
          this.shadowRoot.querySelector(`[data-draft="edit-name-${CSS.escape(id)}"]`)?.focus();
          break;
        case "cancel-edit": this._editingItem = null; this.render(); break;
        case "delete-item": {
          const item = this._item(id);
          if (!item || !confirm(`Remove "${item.name}" from the menu?`)) return;
          if (this._openItem === id) this._openItem = null;
          this._do("DELETE", `/items/${encodeURIComponent(id)}`, undefined, { optimistic: () => { s.items = s.items.filter((i) => i.id !== id); } });
          break;
        }
        case "delete-comment":
          if (!confirm("Delete this comment?")) return;
          this._do("DELETE", `/comments/${encodeURIComponent(id)}`, undefined, { optimistic: () => { s.comments = s.comments.filter((c) => c.id !== id); } });
          break;
        case "add-in":
          this._drafts["add-cat"] = el.dataset.cat;
          this.render();
          this.shadowRoot.querySelector(`[data-draft="add-name"]`)?.focus();
          break;
        case "edit-menu":
          this._editingMenu = true;
          this._clearDrafts("menu-title", "menu-date", "menu-notes");
          this.render();
          break;
        case "cancel-menu": this._editingMenu = false; this.render(); break;
        case "rename": this._renaming = true; this._clearDrafts("rename"); this.render(); break;
        case "cancel-rename": this._renaming = false; this.render(); break;
        case "copy-link": this._copyLink(); break;
        case "native-share":
          navigator.share({ title: s.menu.title, text: `Help plan ${s.menu.title}: claim what you're bringing`, url: this._shareUrl() }).catch(() => {});
          break;
        case "share-off":
          if (!confirm("Turn off the link? Anyone outside the family will lose access until you turn it back on.")) return;
          this._do("POST", "/share", { enabled: false }, { okMessage: "Link turned off" });
          break;
        case "share-on": this._do("POST", "/share", { enabled: true }, { okMessage: "Link is on" }); break;
        case "regen-link":
          if (!confirm("Make a new link? The old one stops working, so you'll need to send the new one to your guests.")) return;
          this._do("POST", "/share", { regenerate: true }, { okMessage: "New link ready. Copy it and send it again" });
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
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const input = this.shadowRoot.querySelector(".share-url");
        input?.select();
        try { document.execCommand("copy"); } catch {}
      }
      this._showToast("Link copied", true);
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
      // Enter sends a comment; Shift+Enter adds a new line.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.matches(".comment-form textarea")) {
        e.preventDefault();
        e.target.form.requestSubmit();
      }
      if (e.key === "Escape" && this._editingItem) { this._editingItem = null; this.render(); }
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
          if (!name) return;
          try {
            this._state = await this._api("POST", "/join", { name });
            this._clearDrafts("join-name");
            this.render();
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
        case "add-item": {
          const name = val("name");
          if (!name) return;
          const category = val("category") || "other";
          const claim = fd.get("claim") === "on";
          this._clearDrafts("add-name", "add-claim");
          this._drafts["add-cat"] = category;
          form.querySelector("[name=name]").value = "";
          form.querySelector("[name=claim]").checked = false;
          await this._do("POST", "/items", { name, category, claimedBy: claim ? s.me : null }, {
            optimistic: () => s.items.push({ id: `tmp-${Date.now()}`, name, category, notes: "", claimedBy: claim ? s.me : null, done: false, addedBy: s.me, createdAt: new Date().toISOString() }),
          });
          this.shadowRoot.querySelector(`[data-draft="add-name"]`)?.focus();
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
