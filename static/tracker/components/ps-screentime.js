// ps-screentime: daily screen time allowances, enforced on the family computer by tools/screentime-agent.
// Kids see their own time left and their week. Parents see every kid: time left, who's on which computer,
// quick bonus buttons, settings, and the Computers list (add one to get its install command).
// Data: /api/screentime/state, refreshed on the "screentime:changed" SSE event.
class PsScreentime extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._error = "";
    this._flash = "";
    this._busy = false;
    this._open = new Set(); // person ids with settings expanded
    this._newDevice = null; // { name, token } right after adding a computer (the token is shown once)
    this._unsubs = [];
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("submit", (e) => this._onSubmit(e));
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("screentime:changed", () => this._load()),
      eventBus.on("user:changed", () => { this._newDevice = null; this._open.clear(); this._load(); }),
      eventBus.on("nav:changed", (d) => { if (d?.view === "screentime") this._load(); }),
    );
    // Countdowns (grace period) tick every second; "last seen" text refreshes with it.
    this._timer = setInterval(() => this._tick(), 1000);
    this._load();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    clearInterval(this._timer);
  }

  _today() { return tracker.dateKey(new Date().toISOString()); }

  async _load() {
    if (!tracker.isModuleEnabled("screentime")) return;
    if (this._loading) { this._reload = true; return; }
    this._loading = true;
    try {
      this._data = await tracker.apiFetch(`/api/screentime/state?date=${this._today()}`);
      this._error = "";
    } catch (e) {
      this._error = e.message;
    }
    this._loading = false;
    if (this._reload) { this._reload = false; return this._load(); }
    this.render();
  }

  async _api(url, method, body) {
    this._busy = true;
    try {
      const r = await tracker.apiFetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      this._flash = "";
      return r;
    } catch (e) {
      this._flash = e.message;
      this.render();
      return null;
    } finally {
      this._busy = false;
    }
  }

  // ---- events ----

  async _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || this._busy) return;
    const { act, id } = el.dataset;
    if (act === "adjust") {
      await this._api(`/api/screentime/members/${id}/adjust`, "POST", { date: this._today(), minutes: Number(el.dataset.min) });
      this._load();
    } else if (act === "undo") {
      await this._api(`/api/screentime/adjustments/${id}`, "DELETE");
      this._load();
    } else if (act === "settings") {
      this._open.has(id) ? this._open.delete(id) : this._open.add(id);
      this.render();
    } else if (act === "remove-device") {
      if (!confirm(`Remove ${el.dataset.name}? It will stop enforcing screen time until you add it again.`)) return;
      await this._api(`/api/screentime/devices/${id}`, "DELETE");
      this._load();
    } else if (act === "dismiss-token") {
      this._newDevice = null;
      this.render();
    } else if (act === "copy") {
      const text = this.shadowRoot.getElementById(el.dataset.target)?.textContent || "";
      try { await navigator.clipboard.writeText(text); el.textContent = "Copied"; } catch { el.textContent = "Select and copy"; }
      setTimeout(() => { el.textContent = "Copy"; }, 2000);
    }
  }

  async _onSubmit(e) {
    e.preventDefault();
    if (this._busy) return;
    const f = e.target;
    if (f.dataset.form === "settings") {
      const v = (n) => f.elements[n]?.value ?? "";
      const hm = (n) => Math.round(Number(v(`${n}H`) || 0) * 60 + Number(v(`${n}M`) || 0));
      const body = {
        enabled: f.elements.enabled.checked,
        weekdayMinutes: hm("weekday"),
        weekendMinutes: hm("weekend"),
        loginName: v("loginName").trim(),
        warnMinutes: v("warnMinutes").split(/[ ,]+/).filter(Boolean).map(Number),
        graceMinutes: Math.round(Number(v("graceMinutes") || 0)),
      };
      if (await this._api(`/api/screentime/members/${f.dataset.id}`, "PUT", body)) {
        this._open.delete(f.dataset.id);
        this._load();
      }
    } else if (f.dataset.form === "custom-adjust") {
      const min = Math.round(Number(f.elements.minutes.value));
      if (!min) return;
      if (await this._api(`/api/screentime/members/${f.dataset.id}/adjust`, "POST", { date: this._today(), minutes: min, note: f.elements.note.value })) this._load();
    } else if (f.dataset.form === "add-device") {
      const name = f.elements.name.value.trim();
      if (!name) return;
      const r = await this._api("/api/screentime/devices", "POST", { name });
      if (r) { this._newDevice = r; this._load(); }
    }
  }

  _tick() {
    const root = this.shadowRoot;
    for (const el of root.querySelectorAll("[data-until]")) {
      const s = Math.max(0, Math.round((Date.parse(el.dataset.until) - Date.now()) / 1000));
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
  }

  // ---- formatting ----

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  _dur(seconds) {
    const neg = seconds < 0;
    let m = Math.round(Math.abs(seconds) / 60);
    if (!neg && seconds > 0 && m === 0) return "<1m";
    const h = Math.floor(m / 60);
    m %= 60;
    const s = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    return neg ? `-${s}` : s;
  }

  _ago(iso) {
    if (!iso) return "never";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  _liveBadge(p) {
    const l = p.live;
    if (!l) return "";
    const where = this._esc(l.deviceName);
    if (l.state === "grace" && l.graceEndsAt) return `<span class="badge bad">Logging out of ${where} in <b data-until="${this._esc(l.graceEndsAt)}"></b></span>`;
    if (l.state === "grace" || l.state === "blocked") return `<span class="badge bad">Logging out of ${where}</span>`;
    if (l.state === "warning") return `<span class="badge warn">On ${where} · almost out</span>`;
    return `<span class="badge on">On ${where} now</span>`;
  }

  // ---- render ----

  _meter(t) {
    if (t.allowanceSeconds == null) return "";
    const total = Math.max(1, t.allowanceSeconds + t.bonusSeconds);
    const pct = Math.min(100, (t.usedSeconds / total) * 100);
    const cls = t.remainingSeconds <= 0 ? "bad" : t.remainingSeconds <= 15 * 60 ? "warn" : "";
    return `<div class="meter"><div class="fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>`;
  }

  _summary(t) {
    if (t.allowanceSeconds == null) return `<span class="muted">No limit · used ${this._dur(t.usedSeconds)} today</span>`;
    const bonus = t.bonusSeconds ? ` <span class="${t.bonusSeconds > 0 ? "plus" : "minus"}">${t.bonusSeconds > 0 ? "+" : ""}${this._dur(t.bonusSeconds)}</span>` : "";
    return `Used ${this._dur(t.usedSeconds)} of ${this._dur(t.allowanceSeconds)}${bonus}`;
  }

  _big(t) {
    if (t.allowanceSeconds == null) return `<div class="big muted">No limit</div>`;
    if (t.remainingSeconds <= 0) return `<div class="big bad">Time's up</div>`;
    return `<div class="big ${t.remainingSeconds <= 15 * 60 ? "warn" : ""}">${this._dur(t.remainingSeconds)} <span class="unit">left</span></div>`;
  }

  _week(p) {
    const max = 1.1 * Math.max(60, ...p.week.map((d) => Math.max(d.usedSeconds, d.allowanceSeconds || 0)));
    const days = ["S", "M", "T", "W", "T", "F", "S"];
    return `<div class="week" aria-label="Last 7 days">${p.week.map((d) => {
      const over = d.allowanceSeconds != null && d.usedSeconds > d.allowanceSeconds;
      const h = (d.usedSeconds / max) * 100;
      const cap = d.allowanceSeconds != null ? `<div class="cap" style="bottom:${((d.allowanceSeconds / max) * 100).toFixed(1)}%"></div>` : "";
      const wd = new Date(`${d.date}T12:00:00`).getDay();
      return `<div class="day" title="${this._esc(d.date)}: ${this._dur(d.usedSeconds)}${d.allowanceSeconds != null ? ` of ${this._dur(d.allowanceSeconds)}` : ""}">
        <div class="col">${cap}<div class="bar ${over ? "over" : ""}" style="height:${h.toFixed(1)}%"></div></div>
        <div class="dl">${days[wd]}</div></div>`;
    }).join("")}</div>`;
  }

  _settingsForm(p) {
    const s = p.settings;
    const h = (m) => Math.floor(m / 60);
    const mm = (m) => m % 60;
    return `<form class="settings" data-form="settings" data-id="${this._esc(p.id)}">
      <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> Limit ${this._esc(p.name)}'s screen time</label>
      <div class="grid">
        <label>School days (Mon–Fri)<span class="hm"><input name="weekdayH" type="number" min="0" max="24" value="${h(s.weekdayMinutes)}"> h <input name="weekdayM" type="number" min="0" max="59" value="${mm(s.weekdayMinutes)}"> m</span></label>
        <label>Weekends<span class="hm"><input name="weekendH" type="number" min="0" max="24" value="${h(s.weekendMinutes)}"> h <input name="weekendM" type="number" min="0" max="59" value="${mm(s.weekendMinutes)}"> m</span></label>
        <label>Computer login<input name="loginName" value="${this._esc(s.loginName)}" placeholder="e.g. ${this._esc((p.name || "kid").toLowerCase().replace(/[^a-z0-9]/g, ""))}" autocapitalize="off" spellcheck="false"></label>
        <label>Warn at (minutes left)<input name="warnMinutes" value="${this._esc(s.warnMinutes.join(", "))}" placeholder="15, 5, 1"></label>
        <label>Grace before logout (min)<input name="graceMinutes" type="number" min="0" max="30" value="${s.graceMinutes}"></label>
      </div>
      <p class="small muted">The computer login is their Linux username on the family computer. When time runs out they get the grace period to save their work, then they're logged out and can't log back in until tomorrow (or until you add time).</p>
      <div class="row end"><button type="button" class="ghost" data-act="settings" data-id="${this._esc(p.id)}">Cancel</button><button type="submit" class="primary">Save</button></div>
    </form>`;
  }

  _personCard(p, admin) {
    const t = p.today;
    const id = this._esc(p.id);
    const devices = t.byDevice.length > 1 ? `<div class="small muted">${t.byDevice.map((d) => `${this._esc(d.deviceName)} ${this._dur(d.seconds)}`).join(" · ")}</div>` : "";
    const adj = admin && t.adjustments.length ? `<ul class="adj">${t.adjustments.map((a) => `
        <li><span class="${a.minutes > 0 ? "plus" : "minus"}">${a.minutes > 0 ? "+" : "−"}${this._dur(Math.abs(a.minutes) * 60)}</span>
        ${a.note ? `<span class="muted">${this._esc(a.note)}</span>` : ""}
        <button class="x" data-act="undo" data-id="${this._esc(a.id)}" title="Undo">✕</button></li>`).join("")}</ul>` : "";
    if (!p.settings.enabled && admin) {
      return `<div class="card">
        <div class="row between"><h2>${this._esc(p.name)}</h2><button class="ghost" data-act="settings" data-id="${id}">${this._open.has(p.id) ? "Close" : "Set up"}</button></div>
        ${this._open.has(p.id) ? this._settingsForm(p) : `<p class="muted small">No screen time limit.${t.usedSeconds ? ` Used ${this._dur(t.usedSeconds)} today.` : ""}</p>`}
      </div>`;
    }
    const noLogin = admin && p.settings.enabled && !p.settings.loginName
      ? `<p class="small warn-text">Add their computer login in settings so the computer knows who they are.</p>` : "";
    return `<div class="card">
      <div class="row between top">
        <div class="grow"><h2>${this._esc(p.name)}</h2>${this._liveBadge(p)}</div>
        ${this._big(t)}
      </div>
      ${this._meter(t)}
      <div class="row between small"><span>${this._summary(t)}</span>${admin ? `<button class="link" data-act="settings" data-id="${id}">${this._open.has(p.id) ? "Close settings" : "Settings"}</button>` : ""}</div>
      ${devices}
      ${noLogin}
      ${!admin && t.remainingSeconds != null && t.remainingSeconds <= 0 ? `<p class="small muted">Ask a parent if you need more time.</p>` : ""}
      ${admin ? `<div class="row wrap quick">
        <button data-act="adjust" data-id="${id}" data-min="15">+15m</button>
        <button data-act="adjust" data-id="${id}" data-min="30">+30m</button>
        <button data-act="adjust" data-id="${id}" data-min="60">+1h</button>
        <button data-act="adjust" data-id="${id}" data-min="-15" class="minus-btn">−15m</button>
        <form class="custom" data-form="custom-adjust" data-id="${id}">
          <input name="minutes" type="number" min="-720" max="720" placeholder="± min" aria-label="Minutes">
          <input name="note" placeholder="Why? (optional)" maxlength="200" aria-label="Note">
          <button type="submit">Add</button>
        </form>
      </div>` : ""}
      ${adj}
      ${this._open.has(p.id) ? this._settingsForm(p) : ""}
      ${this._week(p)}
    </div>`;
  }

  _installCommand(token) {
    const origin = location.origin;
    const logins = (this._data?.people || []).filter((p) => p.settings.enabled && p.settings.loginName).map((p) => p.settings.loginName);
    const files = ["parentslop-screentime", "parentslop-screentime.service", "install.sh"];
    return [
      "mkdir -p /tmp/parentslop-screentime && cd /tmp/parentslop-screentime",
      `for f in ${files.join(" ")}; do curl -fsSLO ${origin}/screentime-agent/$f; done`,
      `sudo bash install.sh --server ${origin} --token ${token} ${logins.join(" ") || "KID_LOGIN"}`,
    ].join("\n");
  }

  _devicesCard() {
    const d = this._data;
    const nd = this._newDevice;
    const list = d.devices.length ? `<ul class="list">${d.devices.map((c) => `
      <li><div class="grow"><b>${this._esc(c.name)}</b>${c.hostname && c.hostname !== c.name ? ` <span class="muted small">(${this._esc(c.hostname)})</span>` : ""}
        <div class="small ${c.online ? "on-text" : "muted"}">${c.online ? "● Online" : `Last report: ${this._ago(c.lastSeenAt)}`}</div></div>
        <button class="ghost small-btn" data-act="remove-device" data-id="${this._esc(c.id)}" data-name="${this._esc(c.name)}">Remove</button></li>`).join("")}</ul>`
      : `<p class="muted small">No computers yet. Add the kids' computer to start enforcing.</p>`;
    const token = nd ? `<div class="token">
        <p><b>${this._esc(nd.name)}</b> added. Run this on that computer (Ubuntu/GNOME) in a terminal as an admin. The token is only shown now.</p>
        <pre id="install-cmd">${this._esc(this._installCommand(nd.token))}</pre>
        <div class="row end"><button data-act="copy" data-target="install-cmd">Copy</button><button class="ghost" data-act="dismiss-token">Done</button></div>
        <p class="small muted">It adds the logins at the end to a local "screentime" group: only those accounts are ever limited. To add a kid later: <code>sudo bash install.sh LOGIN</code>. To remove: <code>sudo bash install.sh --uninstall</code>.</p>
      </div>` : "";
    return `<div class="card">
      <h3>Computers</h3>
      ${list}
      ${token}
      <form class="row add" data-form="add-device">
        <input name="name" placeholder="Computer name (e.g. Kidputer)" maxlength="60" aria-label="Computer name">
        <button type="submit" class="primary">Add computer</button>
      </form>
    </div>`;
  }

  render() {
    const d = this._data;
    let body;
    if (!tracker.isModuleEnabled("screentime")) body = `<p class="muted">Screen time is turned off (Admin › Modules).</p>`;
    else if (!d) body = this._error ? `<p class="error">${this._esc(this._error)}</p>` : `<p class="muted">Loading…</p>`;
    else {
      const people = d.people.length ? d.people.map((p) => this._personCard(p, d.isAdmin)).join("")
        : `<div class="card"><p class="muted">${d.isAdmin ? "No kids in the family yet (Admin › Users)." : "No screen time info."}</p></div>`;
      body = `${people}${d.isAdmin ? this._devicesCard() : ""}`;
    }
    this.shadowRoot.innerHTML = `
      <style>
        ${tracker.TRACKER_CSS}
        :host { display: block; }
        .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
        .head h1 { margin: 0; font-size: 1.2rem; }
        .card { background: #12131f; border: 1px solid #25273a; border-radius: 14px; padding: 14px; margin-bottom: 12px; }
        h2 { margin: 0 0 4px; font-size: 1.1rem; }
        h3 { margin: 0 0 10px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
        p { font-size: 0.88rem; line-height: 1.45; margin: 8px 0; }
        .muted { color: var(--muted); }
        .small { font-size: 0.78rem; }
        .row { display: flex; gap: 8px; align-items: center; }
        .row.wrap { flex-wrap: wrap; }
        .row.between { justify-content: space-between; }
        .row.end { justify-content: flex-end; }
        .row.top { align-items: flex-start; }
        .grow { flex: 1; min-width: 0; }
        .big { font-size: 1.7rem; font-weight: 700; white-space: nowrap; color: var(--success); }
        .big .unit { font-size: 0.85rem; font-weight: 500; color: var(--muted); }
        .big.warn { color: #fbbf24; }
        .big.bad { color: var(--danger); }
        .big.muted { color: var(--muted); font-size: 1.1rem; }
        .meter { height: 10px; border-radius: 999px; background: #22243a; overflow: hidden; margin: 10px 0 6px; }
        .fill { height: 100%; background: var(--success); border-radius: 999px; transition: width 300ms ease-out; }
        .fill.warn { background: #fbbf24; }
        .fill.bad { background: var(--danger); }
        .plus { color: #7ee2a0; }
        .minus { color: #ff9aab; }
        .badge { display: inline-block; font-size: 0.74rem; padding: 2px 8px; border-radius: 999px; margin-top: 2px; }
        .badge.on { background: rgba(80, 250, 123, 0.12); color: #7ee2a0; }
        .badge.warn { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
        .badge.bad { background: rgba(255, 107, 129, 0.18); color: #ff9aab; }
        .on-text { color: #7ee2a0; }
        .warn-text { color: #fbbf24; }
        .error { color: var(--danger); }
        .flash { background: rgba(255, 107, 129, 0.15); color: #ff9aab; padding: 8px 12px; border-radius: 10px; font-size: 0.85rem; margin-bottom: 10px; }
        button { font: inherit; font-size: 0.85rem; padding: 7px 12px; border-radius: 10px; border: 1px solid #2b2e45; background: #1a1c2a; color: var(--text); cursor: pointer; }
        button:hover { border-color: var(--accent-strong); }
        button.primary { background: var(--accent-soft); border-color: var(--accent-strong); color: var(--accent); font-weight: 600; }
        button.ghost { background: transparent; }
        button.link { all: unset; cursor: pointer; color: var(--accent); font-size: 0.78rem; }
        button.minus-btn { color: #ff9aab; }
        button.small-btn { padding: 4px 10px; font-size: 0.78rem; }
        button.x { all: unset; cursor: pointer; color: var(--muted); padding: 0 4px; }
        input { font: inherit; font-size: 0.85rem; padding: 7px 9px; border-radius: 9px; border: 1px solid #2b2e45; background: #0d0e16; color: var(--text); min-width: 0; }
        .quick { margin-top: 10px; }
        .custom { display: flex; gap: 6px; flex: 1 1 260px; min-width: 0; }
        .custom input[name=minutes] { width: 78px; flex: none; }
        .custom input[name=note] { flex: 1 1 0; width: 0; }
        .adj { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
        .adj li { font-size: 0.78rem; background: #181926; border: 1px solid #22243a; border-radius: 999px; padding: 3px 6px 3px 10px; display: flex; gap: 6px; align-items: center; }
        .settings { margin-top: 12px; padding-top: 12px; border-top: 1px solid #22243a; }
        .settings .check { display: flex; gap: 8px; align-items: center; font-size: 0.9rem; margin-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
        .grid label { display: flex; flex-direction: column; gap: 4px; font-size: 0.78rem; color: var(--muted); }
        .hm { display: flex; align-items: center; gap: 4px; color: var(--muted); }
        .hm input { width: 60px; }
        .week { display: flex; gap: 6px; margin-top: 14px; height: 70px; }
        .day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
        .col { position: relative; flex: 1; width: 100%; max-width: 28px; background: #181926; border-radius: 6px; overflow: hidden; }
        .bar { position: absolute; bottom: 0; left: 0; right: 0; background: var(--accent-strong); border-radius: 6px 6px 0 0; }
        .bar.over { background: rgba(255, 107, 129, 0.6); }
        .cap { position: absolute; left: 0; right: 0; border-top: 1px dashed #6b6f8e; z-index: 1; }
        .dl { font-size: 0.68rem; color: var(--muted); }
        .list { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .list li { display: flex; gap: 10px; align-items: center; padding: 10px; border-radius: 10px; background: #181926; border: 1px solid #22243a; }
        .add input { flex: 1; }
        .token { background: #0d0e16; border: 1px solid var(--accent-strong); border-radius: 12px; padding: 12px; margin: 10px 0; }
        pre { white-space: pre-wrap; word-break: break-all; font-size: 0.75rem; background: #05060a; padding: 10px; border-radius: 8px; margin: 8px 0; user-select: all; }
        code { font-size: 0.75rem; }
        @media (max-width: 480px) { .big { font-size: 1.35rem; } .custom { flex-basis: 100%; } }
      </style>
      <div class="head"><h1>Screen Time</h1><span class="muted small">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</span></div>
      ${this._flash ? `<div class="flash">${this._esc(this._flash)}</div>` : ""}
      ${body}
    `;
    this._tick();
  }
}

customElements.define("ps-screentime", PsScreentime);
