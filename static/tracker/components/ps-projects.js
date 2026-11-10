// ps-projects: personal project backlog organised into tracks (Home & Family, Work, Open Source...).
// Views: Today (a card per track plus the day's plan), a track page, the full project list, project detail.
// Admin-only. Data comes from /api/projects/state and refreshes on the "projects:changed" SSE event.
class PsProjects extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "today"; // today | track | projects | detail
    this._trackId = null;
    this._alt = {}; // track id -> which suggestion the "another" button is showing
    this._openLanes = new Set();
    this._projectId = null;
    this._data = null;
    this._loading = false;
    this._error = "";
    this._busy = false;
    this._flash = "";
    this._filters = { q: "", tag: "", track: "", status: "open", priority: "", sort: "priority" };
    this._editingTaskId = null;
    this._tokenConfigured = null;
    this._dayOpts = this._loadDayOpts();
    this._unsubs = [];
    this._listScrollY = 0;
    this._cameFromApp = false;
    this._onHash = () => this._applyHash();
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
    this.shadowRoot.addEventListener("submit", (e) => this._onSubmit(e));
    this.shadowRoot.addEventListener("input", (e) => this._onInput(e));
  }

  connectedCallback() {
    window.addEventListener("hashchange", this._onHash);
    this._unsubs.push(() => window.removeEventListener("hashchange", this._onHash));
    this._applyHash();
    this._unsubs.push(
      eventBus.on("projects:changed", () => this._load()),
      eventBus.on("user:changed", () => this._load()),
      eventBus.on("nav:changed", (d) => { if (d?.view === "projects") this._load(); }),
    );
    this._load();
  }

  disconnectedCallback() { this._unsubs.forEach((u) => u()); }

  // ---- routing ----
  // Sub-views live in the URL hash so the browser's back/forward buttons move between them:
  //   #projects (Today), #projects/t/<track id>, #projects/list, #projects/p/<project id>
  _go(route) {
    this._navigating = true;
    const hash = route ? `projects/${route}` : "projects";
    if (location.hash.replace(/^#/, "") === hash) this._applyHash();
    else location.hash = hash;
  }

  _applyHash() {
    const hash = location.hash.replace(/^#/, "");
    if (hash !== "projects" && !hash.startsWith("projects/")) return;
    const parts = hash.split("/");
    const prevView = this._view;
    // Remember where list-like pages were scrolled so coming back restores the spot.
    if (prevView !== "detail") this._listScrollY = window.scrollY;
    if (parts[1] === "p" && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      // Arrived by clicking inside the module (so "back" can use real history), or straight from a URL.
      this._cameFromApp = this._navigating || (prevView === "detail" && this._cameFromApp);
      if (this._projectId !== id) this._editingTaskId = null;
      this._view = "detail";
      this._projectId = id;
    } else if (parts[1] === "t") {
      this._view = "track";
      this._trackId = decodeURIComponent(parts[2] || "");
      this._projectId = null;
    } else if (parts[1] === "list") {
      this._view = "projects";
      this._projectId = null;
    } else {
      this._view = "today";
      this._projectId = null;
    }
    this._navigating = false;
    this._flash = "";
    this.render();
    // New pages open at the top; going back from a project restores where you were.
    if (prevView === "detail" && this._view !== "detail") requestAnimationFrame(() => window.scrollTo(0, this._listScrollY));
    else if (prevView !== this._view || this._view === "detail") requestAnimationFrame(() => this.scrollIntoView({ block: "start" }));
  }

  // ---- data ----
  async _load() {
    if (!tracker.isCurrentUserAdmin()) { this._data = null; this.render(); return; }
    if (this._loading) { this._reload = true; return; }
    this._loading = true;
    try {
      this._data = await tracker.apiFetch("/api/projects/state");
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
      const out = await tracker.apiFetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      await this._load();
      return out;
    } catch (e) {
      this._flash = `Couldn't save: ${e.message}`;
      this.render();
      throw e;
    } finally {
      this._busy = false;
    }
  }

  _loadDayOpts() {
    try { return JSON.parse(localStorage.getItem("ps.projects.day") || "") || { minutes: 120, energy: "medium" }; }
    catch { return { minutes: 120, energy: "medium" }; }
  }

  _saveDayOpts() {
    try { localStorage.setItem("ps.projects.day", JSON.stringify(this._dayOpts)); } catch {}
  }

  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  _project(id) { return this._data?.projects.find((p) => p.id === id); }
  _track(id) { return this._data?.tracks.find((t) => t.id === id); }
  _trackOf(p) { return (p && this._track(p.trackId)) || { id: "", name: "Unsorted", icon: "📥", color: "#8b8fa8" }; }
  _summary() {
    return ProjectsScore.trackSummary(this._data, { today: this._today(), minutes: this._dayOpts.minutes, energy: this._dayOpts.energy });
  }
  _task(id) { return this._data?.tasks.find((t) => t.id === id); }
  _stats() { return ProjectsScore.projectStats(this._data.projects, this._data.tasks, this._data.picks, this._today()); }

  // ---- events ----
  async _onClick(e) {
    // Form controls inside a clickable row act on their own, not as a click on the row.
    if (e.target.closest("select, input, textarea, label")) return;
    const el = e.target.closest("[data-action]");
    if (!el || this._busy) return;
    const a = el.dataset.action;
    const id = el.dataset.id;
    this._flash = "";
    try {
      if (a === "tab") this._go(el.dataset.view === "projects" ? "list" : "");
      else if (a === "open-project" || a === "related") this._go(`p/${encodeURIComponent(id)}`);
      else if (a === "open-track") this._go(`t/${encodeURIComponent(id || "unsorted")}`);
      else if (a === "back") {
        // Use real history when we got here from inside the module, so back/forward stay in step.
        if (this._cameFromApp) history.back();
        else { const p = this._project(this._projectId); this._go(`t/${encodeURIComponent(p?.trackId || "unsorted")}`); }
      }
      else if (a === "another") { this._alt[id] = (this._alt[id] || 0) + 1; this.render(); }
      else if (a === "set-lane") await this._api(`/api/projects/${id}`, "PUT", { priority: Number(el.dataset.lane) });
      else if (a === "toggle-lane") {
        if (this._openLanes.has(id)) this._openLanes.delete(id); else this._openLanes.add(id);
        this.render();
      }
      else if (a === "track-delete") {
        const t = this._track(id);
        if (t && confirm(`Delete the ${t.name} track? Its projects stay, just without a track.`)) {
          await this._api(`/api/project-tracks/${id}`, "DELETE");
          this._go("");
        }
      }
      else if (a === "pick") await this._api("/api/project-picks", "POST", { date: this._today(), taskId: id });
      else if (a === "outcome") await this._api(`/api/project-picks/${id}`, "PUT", { outcome: el.dataset.outcome });
      else if (a === "unpick") await this._api(`/api/project-picks/${id}`, "DELETE");
      else if (a === "task-toggle") {
        const t = this._task(id);
        await this._api(`/api/project-tasks/${id}`, "PUT", { status: ProjectsScore.CLOSED(t.status) ? "todo" : "done" });
      }
      else if (a === "task-edit") { this._editingTaskId = this._editingTaskId === id ? null : id; this.render(); }
      else if (a === "task-delete") {
        if (confirm("Delete this task?")) await this._api(`/api/project-tasks/${id}`, "DELETE");
      }
      else if (a === "dep-remove") {
        const t = this._task(el.dataset.task);
        await this._api(`/api/project-tasks/${t.id}`, "PUT", { dependsOn: t.dependsOn.filter((d) => d !== id) });
      }
      else if (a === "leave-project") {
        if (confirm("Leave this project? It will disappear from your tracks.")) {
          await this._api(`/api/projects/${id}/members/me`, "DELETE");
          this._go("");
        }
      }
      else if (a === "delete-project") {
        const p = this._project(id);
        if (confirm(`Delete "${p.name}" and all its tasks${p.members.length > 1 ? " for everyone on it" : ""}? This can't be undone.`)) {
          await this._api(`/api/projects/${id}`, "DELETE");
          this._go("");
        }
      }
      else if (a === "project-done") await this._api(`/api/projects/${id}`, "PUT", { status: "Done" });
      else if (a === "link-remove") {
        const p = this._project(id);
        const links = p.links.filter((_, i) => i !== Number(el.dataset.index));
        await this._api(`/api/projects/${id}`, "PUT", { links });
      }
      else if (a === "sync-github") {
        const r = await this._api(`/api/projects/${id}/sync-github`, "POST");
        const errs = (r.repos || []).filter((x) => x.error).map((x) => `${x.repo}: ${x.error}`);
        this._flash = errs.length ? `GitHub sync problems: ${errs.join("; ")}`
          : `Synced: ${r.created} new, ${r.updated} updated, ${r.closed} closed.`;
        this.render();
      }
      else if (a === "set-token") {
        const v = prompt("GitHub token (fine-grained, read-only Issues access). Leave empty to remove.");
        if (v !== null) {
          const r = await this._api("/api/projects/github-token", "PUT", { value: v });
          this._tokenConfigured = r.configured;
          this.render();
        }
      }
    } catch (err) { /* flash already set */ }
  }

  async _onChange(e) {
    const el = e.target;
    const f = el.dataset.field;
    if (!f) return;
    this._flash = "";
    try {
      if (f === "minutes" || f === "energy") {
        this._dayOpts[f] = f === "minutes" ? Number(el.value) : el.value;
        this._saveDayOpts();
        this.render();
      } else if (f.startsWith("filter-")) {
        this._filters[f.slice(7)] = el.value;
        this.render();
      } else if (f === "share") {
        const p = this._project(el.dataset.id);
        const ids = new Set(p.members.map((m) => m.memberId));
        if (el.checked) ids.add(el.dataset.member); else ids.delete(el.dataset.member);
        await this._api(`/api/projects/${p.id}/members`, "PUT", { memberIds: [...ids] });
      } else if (f.startsWith("project-")) {
        const key = f.slice(8);
        const value = key === "priority" ? Number(el.value) : el.value;
        await this._api(`/api/projects/${el.dataset.id}`, "PUT", { [key]: value });
      } else if (f.startsWith("track-")) {
        const key = f.slice(6);
        await this._api(`/api/project-tracks/${el.dataset.id}`, "PUT", { [key]: key === "focusLimit" ? Number(el.value) : el.value });
      } else if (f.startsWith("task-")) {
        const key = f.slice(5);
        const value = key === "priority" ? Number(el.value) : el.value;
        if (key === "add-dep") {
          if (!value) return;
          const t = this._task(el.dataset.id);
          await this._api(`/api/project-tasks/${t.id}`, "PUT", { dependsOn: [...t.dependsOn, value] });
        } else {
          await this._api(`/api/project-tasks/${el.dataset.id}`, "PUT", { [key]: value });
        }
      }
    } catch (err) { /* flash already set */ }
  }

  _onInput(e) {
    if (e.target.dataset.field === "filter-q") {
      this._filters.q = e.target.value;
      clearTimeout(this._qTimer);
      this._qTimer = setTimeout(() => {
        this.render();
        const q = this.shadowRoot.querySelector('[data-field="filter-q"]');
        if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }, 250);
    }
  }

  async _onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const fd = Object.fromEntries(new FormData(form).entries());
    this._flash = "";
    try {
      if (form.dataset.form === "add-task") {
        if (!fd.title.trim()) return;
        await this._api(`/api/projects/${form.dataset.id}/tasks`, "POST", {
          title: fd.title.trim(), size: fd.size, energy: fd.energy, priority: Number(fd.priority), assigneeId: fd.assignee || "",
        });
      } else if (form.dataset.form === "add-link") {
        const v = fd.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "").replace(/\/issues\/(\d+)$/, "#$1");
        const m = v.match(/^([\w.-]+\/[\w.-]+)(?:#(\d+))?$/);
        if (!m) { this._flash = "Use owner/repo, or owner/repo#123 for an epic issue and its sub-issues"; this.render(); return; }
        const p = this._project(form.dataset.id);
        const link = m[2] ? { type: "github", repo: m[1], issue: Number(m[2]) } : { type: "github", repo: m[1] };
        await this._api(`/api/projects/${p.id}`, "PUT", { links: [...p.links, link] });
      } else if (form.dataset.form === "goal") {
        await this._api(`/api/projects/${form.dataset.id}`, "PUT", { goal: fd.goal });
        this._flash = "Saved.";
        this.render();
      } else if (form.dataset.form === "task-notes") {
        await this._api(`/api/project-tasks/${form.dataset.id}`, "PUT", { title: fd.title, notes: fd.notes });
        this._editingTaskId = null;
        this.render();
      } else if (form.dataset.form === "new-project") {
        if (!fd.name.trim()) return;
        const p = await this._api("/api/projects", "POST", {
          name: fd.name.trim(), status: "Active", priority: 2, trackId: form.dataset.track || "",
        });
        this._go(`p/${encodeURIComponent(p.id)}`);
      } else if (form.dataset.form === "track") {
        await this._api(`/api/project-tracks/${form.dataset.id}`, "PUT", {
          name: fd.name.trim(), icon: fd.icon.trim(), color: fd.color, intention: fd.intention.trim(),
        });
        this._flash = "Track saved.";
        this.render();
      } else if (form.dataset.form === "new-track") {
        if (!fd.name.trim()) return;
        const t = await this._api("/api/project-tracks", "POST", { name: fd.name.trim(), icon: "✨", color: "#f472b6" });
        this._go(`t/${encodeURIComponent(t.id)}`);
      }
    } catch (err) { /* flash already set */ }
  }

  // ---- render helpers ----
  _prioLabel(n) { return ProjectsScore.PRIORITY_LABEL[n ?? 1]; }
  _me() { return this._data?.me; }
  _personName(id) { return id === this._me() ? "you" : this._data?.people.find((x) => x.id === id)?.name || "someone"; }

  // "with Kim" for a project shared with others, else "".
  _sharedWith(p) {
    const others = (p.members || []).filter((m) => m.memberId !== this._me()).map((m) => this._personName(m.memberId));
    if (!others.length) return "";
    return `<span class="tag shared" title="Shared project">👥 with ${this._esc(others.length > 2 ? `${others.slice(0, 2).join(", ")} +${others.length - 2}` : others.join(" & "))}</span>`;
  }

  _options(list, current) {
    return list.map(([v, l]) => `<option value="${this._esc(v)}" ${String(v) === String(current) ? "selected" : ""}>${this._esc(l)}</option>`).join("");
  }

  _progressBar(s, wide = false) {
    const pct = Math.round((s.progress || 0) * 100);
    return `<div class="bar ${wide ? "wide" : ""}" title="${s.done} of ${s.total} tasks done"><i style="width:${pct}%"></i></div>`;
  }

  _taskLine(t, { showProject = false, pick = null } = {}) {
    const p = this._project(t.projectId);
    const ext = t.externalUrl ? `<a class="ext" href="${this._esc(t.externalUrl)}" target="_blank" rel="noopener">${this._esc(t.externalKey.split("/").pop())}</a>` : "";
    const labels = (t.labels || []).slice(0, 3).map((l) => `<span class="tag">${this._esc(l)}</span>`).join("");
    return `
      <div class="task-title">
        ${showProject && p ? `<button class="link proj" style="--tc:${this._esc(this._trackOf(p).color)}" data-action="open-project" data-id="${p.id}"><i class="dot"></i>${this._esc(p.name)}</button>` : ""}
        <span>${this._esc(t.title)}</span> ${ext}
      </div>
      <div class="meta">${t.assigneeId ? `<span class="tag who ${t.assigneeId === this._me() ? "mine" : ""}">→ ${this._esc(this._personName(t.assigneeId))}</span> ` : ""}${this._esc(t.size?.toUpperCase())} · ${this._esc(t.energy)} energy${pick || (t.priority ?? 1) === 1 ? "" : ` · ${["Low", "Normal", "High", "Urgent"][t.priority] || ""}`} ${labels}</div>`;
  }

  // ---- views ----
  _trackStyle(t) { return `--tc:${this._esc(t.color || "#8b8fa8")}`; }

  _dayLetters(days) {
    return days.map((d) => "SMTWTFS"[new Date(d.date + "T12:00:00Z").getUTCDay()]);
  }

  _quiet(sum) {
    const open = sum.projects.focus.length + sum.projects.next.length;
    if (!open) return "";
    if (sum.idleDays === null) return `<span class="tag quiet">no progress logged yet</span>`;
    if (sum.idleDays >= 14) return `<span class="tag quiet">quiet for ${sum.idleDays} days</span>`;
    return "";
  }

  _focusBlock(p, stats) {
    const s = stats.get(p.id);
    const left = s.open;
    return `
      <div class="focus-proj" data-action="open-project" data-id="${p.id}">
        <div class="row between">
          <b>${this._esc(p.name)} ${this._sharedWith(p)}</b>
          <span class="muted small">${s.total ? (left ? `${left} to go` : "all tasks done") : "no tasks yet"}</span>
        </div>
        ${this._progressBar(s, true)}
        ${p.goal ? `<div class="meta">Done means: ${this._esc(p.goal)}</div>` : `<div class="meta faint">No finish line yet. Open it and write what "done" means.</div>`}
      </div>`;
  }

  _trackCard(sum) {
    const t = sum.track;
    const { focus, next, later } = sum.projects;
    const stats = sum.stats;
    const moves = sum.next.slice(0, 5);
    const move = moves.length ? moves[(this._alt[t.id] || 0) % moves.length] : null;
    const candidates = [...next, ...later].slice(0, 3);
    const letters = this._dayLetters(sum.days);
    const waiting = next.length + later.length + sum.projects.someday.length;
    return `
      <section class="track" style="${this._trackStyle(t)}">
        <div class="track-head" data-action="open-track" data-id="${t.id}">
          <span class="icon">${this._esc(t.icon || "•")}</span>
          <div class="grow">
            <div class="row between"><h2>${this._esc(t.name)}</h2>
              <span class="week" title="Last 7 days">${sum.days.map((d, i) => `<i class="${d.worked ? "on" : ""}" title="${d.date}">${letters[i]}</i>`).join("")}</span></div>
            ${t.intention ? `<div class="intention">${this._esc(t.intention)}</div>` : ""}
          </div>
        </div>
        ${this._quiet(sum)}
        ${sum.overFocus ? `<span class="tag warn">${focus.length} focus projects; aim for ${t.focusLimit}</span>` : ""}

        <div class="label">Focus</div>
        ${focus.length ? focus.map((p) => this._focusBlock(p, stats)).join("") : `
          <div class="empty">
            <div class="muted small">No focus yet. Pick the one project this track is about right now:</div>
            <div class="reasons">${candidates.map((p) => `<button class="chip" data-action="set-lane" data-lane="3" data-id="${p.id}">★ ${this._esc(p.name)}</button>`).join("") || `<span class="muted small">Nothing waiting. Add a project from the track page.</span>`}</div>
          </div>`}

        ${move ? `
          <div class="label">Next move</div>
          <div class="move">
            <div class="grow">
              <div class="task-title"><span>${this._esc(move.task.title)}</span>
                ${move.task.externalUrl ? `<a class="ext" href="${this._esc(move.task.externalUrl)}" target="_blank" rel="noopener">${this._esc(move.task.externalKey.split("/").pop())}</a>` : ""}</div>
              <div class="meta">${focus.some((p) => p.id === move.project.id) ? "" : `${this._esc(move.project.name)} · `}${this._esc(move.task.size?.toUpperCase())} · ${this._esc(move.task.energy)} energy</div>
              <div class="reasons">${move.reasons.slice(0, 2).map((r) => `<span class="tag good">${this._esc(r)}</span>`).join("")}${move.warnings.map((w) => `<span class="tag warn">${this._esc(w)}</span>`).join("")}</div>
            </div>
            <div class="col">
              <button class="btn btn-sm" data-action="pick" data-id="${move.task.id}">Do today</button>
              ${moves.length > 1 ? `<button class="chip ghost" data-action="another" data-id="${t.id}" title="Show another option">↻ another</button>` : ""}
            </div>
          </div>` : ""}

        <div class="track-foot" data-action="open-track" data-id="${t.id}">
          <span>${sum.doneThisWeek ? `<b>${sum.doneThisWeek}</b> done this week` : "Nothing done this week yet"}</span>
          <span>${waiting} waiting${sum.projects.finished.length ? ` · ${sum.projects.finished.length} finished` : ""} →</span>
        </div>
      </section>`;
  }

  _renderToday() {
    const today = this._today();
    const d = this._data;
    const picks = d.picks.filter((p) => p.date === today);
    const summary = this._summary();
    const stats = this._stats();
    const readyToClose = d.projects.filter((p) => {
      const s = stats.get(p.id);
      return !ProjectsScore.FINISHED(p) && s.total > 0 && s.open === 0 && !d.tasks.some((t) => t.projectId === p.id && t.status === "blocked");
    });
    const doneWeek = summary.reduce((n, s) => n + s.doneThisWeek, 0);
    const tracksMoved = summary.filter((s) => s.days.some((x) => x.worked)).length;
    const finished = d.projects.filter((p) => p.status === "Done").sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
    const date = new Date(today + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

    return `
      <header class="hero">
        <div>
          <div class="date">${this._esc(date)}</div>
          <div class="muted small">${doneWeek ? `${doneWeek} task${doneWeek === 1 ? "" : "s"} done this week, ${tracksMoved} of ${summary.length} tracks moved` : "A fresh week. Pick one move from any track below."}</div>
        </div>
        <div class="row">
          <label class="muted small">Time <select data-field="minutes">${this._options([[30, "30 min"], [60, "1 hour"], [120, "2 hours"], [240, "Half day"], [480, "Full day"]], this._dayOpts.minutes)}</select></label>
          <label class="muted small">Energy <select data-field="energy">${this._options([["low", "Low"], ["medium", "Medium"], ["high", "High"]], this._dayOpts.energy)}</select></label>
        </div>
      </header>

      ${picks.length ? `<section class="card plan">
        <h3>Today's plan</h3>
        <ul class="list">${picks.map((pk) => {
          const t = this._task(pk.taskId);
          if (!t) return "";
          return `<li class="pick ${pk.outcome ? "o-" + pk.outcome : ""}" style="${this._trackStyle(this._trackOf(this._project(t.projectId)))}">
            <div class="grow">${this._taskLine(t, { showProject: true, pick: pk })}</div>
            <div class="btns">
              ${[["done", "Done"], ["partial", "Partly"], ["skipped", "Skip"]].map(([o, l]) =>
                `<button class="chip ${pk.outcome === o ? "on" : ""}" data-action="outcome" data-id="${pk.id}" data-outcome="${pk.outcome === o ? "" : o}">${l}</button>`).join("")}
              <button class="chip ghost" title="Remove from today" data-action="unpick" data-id="${pk.id}">✕</button>
            </div></li>`;
        }).join("")}</ul>
      </section>` : ""}

      <div class="tracks">${summary.map((s) => this._trackCard(s)).join("")}</div>

      ${readyToClose.length ? `<section class="card">
        <h3>Ready to close</h3>
        <p class="muted">Every task in these projects is done. Check the finish line is met, then call it.</p>
        <ul class="list">${readyToClose.map((p) => `<li style="${this._trackStyle(this._trackOf(p))}"><div class="grow"><button class="link" data-action="open-project" data-id="${p.id}">${this._esc(p.name)}</button>
          ${p.goal ? `<div class="meta">Done means: ${this._esc(p.goal)}</div>` : ""}</div>
          <button class="btn btn-sm" data-action="project-done" data-id="${p.id}">Mark done 🎉</button></li>`).join("")}</ul>
      </section>` : ""}

      <section class="card shelf">
        <h3>Finished</h3>
        ${finished.length ? `<div class="reasons">${finished.slice(0, 12).map((p) => `<button class="chip trophy" style="${this._trackStyle(this._trackOf(p))}" data-action="open-project" data-id="${p.id}">🏆 ${this._esc(p.name)}</button>`).join("")}</div>
          <div class="muted small">${finished.length} of ${d.projects.length} projects finished</div>`
          : `<p class="muted small">Nothing finished yet. The first one lands here.</p>`}
      </section>

      <form data-form="new-track" class="row add-track">
        <input name="name" placeholder="New track name">
        <button class="chip">Add track</button>
      </form>`;
  }

  _laneRow(p, stats) {
    const s = stats.get(p.id);
    const lanes = [[3, "★ Focus"], [2, "Next"], [1, "Later"], [0, "Someday"]];
    return `<li data-action="open-project" data-id="${p.id}" class="clickable">
      <div class="grow">
        <div class="task-title"><span>${this._esc(p.name)}</span> ${this._sharedWith(p)}
          ${p.status !== "Active" ? `<span class="tag st">${this._esc(p.status)}</span>` : ""}
          ${["No backup", "Local git only"].includes(p.backup) ? `<span class="tag warn">${this._esc(p.backup)}</span>` : ""}</div>
        <div class="meta">${s.open} open · ${s.done} done${p.goal ? ` · Done means: ${this._esc(p.goal)}` : ""}</div>
      </div>
      ${ProjectsScore.FINISHED(p) ? "" : `<div class="lanes">${lanes.map(([n, l]) => `<button class="seg ${p.priority === n ? "on" : ""}" data-action="set-lane" data-lane="${n}" data-id="${p.id}">${l}</button>`).join("")}</div>`}
      ${this._progressBar(s)}
    </li>`;
  }

  _renderTrack() {
    const id = this._trackId === "unsorted" ? "" : this._trackId;
    const sum = this._summary().find((s) => s.track.id === id);
    if (!sum) return `<button class="link" data-action="tab" data-view="today">← Today</button><p class="muted">Track not found.</p>`;
    const t = sum.track;
    const stats = sum.stats;
    const lane = (key, title, list, { collapsed = false, hint = "" } = {}) => {
      if (!list.length && key !== "focus") return "";
      const laneKey = `${t.id}:${key}`;
      const open = !collapsed || this._openLanes.has(laneKey);
      const shown = open ? list : list.slice(0, 3);
      return `<section class="card">
        <div class="row between"><h3>${title} <span class="count">${list.length}</span></h3>
          ${collapsed && list.length > 3 ? `<button class="link small" data-action="toggle-lane" data-id="${laneKey}">${open ? "Show fewer" : `Show all ${list.length}`}</button>` : ""}</div>
        ${hint ? `<p class="muted small">${hint}</p>` : ""}
        <ul class="list projects">${shown.map((p) => this._laneRow(p, stats)).join("")}</ul>
      </section>`;
    };
    const moves = sum.next.slice(0, 5);
    return `
      <button class="link" data-action="tab" data-view="today">← Today</button>
      <section class="track big" style="${this._trackStyle(t)}">
        <div class="track-head">
          <span class="icon">${this._esc(t.icon || "•")}</span>
          <div class="grow">
            <h2>${this._esc(t.name)}</h2>
            ${t.intention ? `<div class="intention">${this._esc(t.intention)}</div>` : ""}
          </div>
        </div>
        <div class="row wrap small muted">
          <span>${sum.doneThisWeek} done this week</span> ·
          <span>${sum.lastTouched ? `last moved ${sum.idleDays === 0 ? "today" : sum.idleDays === 1 ? "yesterday" : `${sum.idleDays} days ago`}` : "no progress logged yet"}</span> ·
          <span>${sum.projects.finished.length} finished</span>
        </div>
      </section>

      ${lane("focus", "★ Focus", sum.projects.focus, { hint: sum.projects.focus.length
        ? (sum.overFocus ? `More than ${t.focusLimit} focus projects splits your attention. Move one back to Next.` : "")
        : "Nothing in focus. Promote one project from Next below." })}

      ${moves.length ? `<section class="card">
        <h3>Next moves</h3>
        <ul class="list">${moves.map((m) => `<li>
          <div class="grow">${this._taskLine(m.task, { showProject: true })}
            <div class="reasons">${m.reasons.slice(0, 3).map((r) => `<span class="tag good">${this._esc(r)}</span>`).join("")}${m.warnings.map((w) => `<span class="tag warn">${this._esc(w)}</span>`).join("")}</div></div>
          <button class="btn btn-sm" data-action="pick" data-id="${m.task.id}">Do today</button></li>`).join("")}</ul>
      </section>` : ""}

      ${lane("next", "Up next", sum.projects.next, { collapsed: true })}
      ${lane("later", "Later", sum.projects.later, { collapsed: true })}
      ${lane("someday", "Someday", sum.projects.someday, { collapsed: true })}
      ${lane("finished", "🏆 Finished", sum.projects.finished, { collapsed: true })}

      <section class="card">
        <form data-form="new-project" data-track="${this._esc(t.id)}" class="row">
          <input name="name" placeholder="New project in ${this._esc(t.name)}" required>
          <button class="btn btn-sm">Add project</button>
        </form>
      </section>

      ${t.id ? `<details class="card">
        <summary class="muted small">Edit track</summary>
        <form data-form="track" data-id="${t.id}" class="edit">
          <div class="row wrap">
            <input name="icon" value="${this._esc(t.icon)}" maxlength="4" class="icon-in" aria-label="Icon">
            <input name="name" value="${this._esc(t.name)}" aria-label="Name">
            <input type="color" name="color" value="${this._esc(t.color)}" aria-label="Colour">
          </div>
          <textarea name="intention" rows="2" placeholder="What this track is for">${this._esc(t.intention)}</textarea>
          <label class="muted small">Focus limit
            <select data-field="track-focusLimit" data-id="${t.id}">${this._options([1, 2, 3, 4, 5].map((n) => [n, n]), t.focusLimit)}</select></label>
          <div class="row"><button class="btn btn-sm">Save track</button>
            <button type="button" class="chip ghost" data-action="track-delete" data-id="${t.id}">Delete track</button></div>
        </form>
      </details>` : ""}`;
  }

  _filteredProjects() {
    const d = this._data;
    const f = this._filters;
    const stats = this._stats();
    const q = f.q.trim().toLowerCase();
    let list = d.projects.filter((p) => {
      if (f.status === "open" && ProjectsScore.FINISHED(p)) return false;
      if (f.status && f.status !== "open" && p.status !== f.status) return false;
      if (f.tag && !p.tags.includes(f.tag)) return false;
      if (f.track && (f.track === "unsorted" ? this._track(p.trackId) : p.trackId !== f.track)) return false;
      if (f.priority !== "" && String(p.priority) !== f.priority) return false;
      if (q && ![p.name, p.slug, p.note, p.path, p.tags.join(" ")].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const by = {
      priority: (a, b) => (b.priority - a.priority) || ((a.showcaseRank || 999) - (b.showcaseRank || 999)),
      rank: (a, b) => (a.showcaseRank || 999) - (b.showcaseRank || 999),
      progress: (a, b) => stats.get(b.id).progress - stats.get(a.id).progress,
      open: (a, b) => stats.get(b.id).open - stats.get(a.id).open,
      recent: (a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""),
      name: (a, b) => a.name.localeCompare(b.name),
    }[f.sort] || (() => 0);
    return list.sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
  }

  _renderProjects() {
    const d = this._data;
    const stats = this._stats();
    const tags = [...new Set(d.projects.flatMap((p) => p.tags))].sort();
    const list = this._filteredProjects();
    const focusCount = d.projects.filter((p) => p.priority === 3 && !ProjectsScore.FINISHED(p)).length;
    return `
      <section class="card">
        <div class="row wrap">
          <input type="search" placeholder="Search projects" value="${this._esc(this._filters.q)}" data-field="filter-q">
          <select data-field="filter-track">${this._options([["", "All tracks"], ...d.tracks.map((t) => [t.id, `${t.icon} ${t.name}`]), ["unsorted", "Unsorted"]], this._filters.track)}</select>
          <select data-field="filter-status">${this._options([["open", "Not finished"], ["", "All"], ["Active", "Active"], ["Paused", "Paused"], ["Dormant", "Dormant"], ["Archive", "Archive"], ["Done", "Done"], ["Dropped", "Dropped"]], this._filters.status)}</select>
          <select data-field="filter-priority">${this._options([["", "Any lane"], ["3", "Focus"], ["2", "Next"], ["1", "Later"], ["0", "Someday"]], this._filters.priority)}</select>
          <select data-field="filter-tag">${this._options([["", "All tags"], ...tags.map((t) => [t, t])], this._filters.tag)}</select>
          <select data-field="filter-sort">${this._options([["priority", "Sort: lane"], ["rank", "Sort: showcase rank"], ["progress", "Sort: progress"], ["open", "Sort: open tasks"], ["recent", "Sort: recent"], ["name", "Sort: name"]], this._filters.sort)}</select>
        </div>
        <div class="muted small">${list.length} of ${d.projects.length} projects · ${focusCount} in focus across ${d.tracks.length} tracks</div>
        <ul class="list projects">${list.map((p) => {
          const s = stats.get(p.id);
          const tr = this._trackOf(p);
          return `<li data-action="open-project" data-id="${p.id}" class="clickable" style="${this._trackStyle(tr)}">
            <div class="grow">
              <div class="task-title"><span>${this._esc(p.name)}</span> ${this._sharedWith(p)}
                ${p.showcaseRank ? `<span class="tag">#${p.showcaseRank}</span>` : ""}
                <span class="tag p${p.priority}">${this._prioLabel(p.priority)}</span>
                <span class="tag st">${this._esc(p.status)}</span>
                ${["No backup", "Local git only"].includes(p.backup) ? `<span class="tag warn">${this._esc(p.backup)}</span>` : ""}</div>
              <div class="meta">${this._esc(tr.icon)} ${this._esc(tr.name)} · ${s.open} open · ${s.done} done${p.tags.length ? " · " + this._esc(p.tags.slice(0, 4).join(", ")) : ""}</div>
            </div>
            ${this._progressBar(s)}
          </li>`;
        }).join("")}</ul>
      </section>`;
  }

  _renderDetail() {
    const d = this._data;
    const p = this._project(this._projectId);
    if (!p) return `<p class="muted">Project not found.</p>`;
    const tr = this._trackOf(p);
    const stats = this._stats().get(p.id);
    const taskById = new Map(d.tasks.map((t) => [t.id, t]));
    const tasks = d.tasks.filter((t) => t.projectId === p.id)
      .sort((a, b) => (ProjectsScore.CLOSED(a.status) - ProjectsScore.CLOSED(b.status)) || (a.sortOrder - b.sortOrder));
    const relatedProjects = p.related.map((slug) => d.projects.find((x) => x.slug === slug)).filter(Boolean);
    const otherOpenTasks = d.tasks.filter((t) => !ProjectsScore.CLOSED(t.status));
    const gh = p.links.filter((l) => l.type === "github");
    const assignees = [["", "Anyone"], ...p.members.map((m) => [m.memberId, m.memberId === this._me() ? "Me" : this._personName(m.memberId)])];
    const owner = p.role === "owner";
    const roleOf = new Map(p.members.map((m) => [m.memberId, m.role]));

    return `
      <button class="link" data-action="back">← ${this._cameFromApp ? "Back" : this._esc(tr.name)}</button>
      <section class="card project-head" style="${this._trackStyle(tr)}">
        <button class="link small track-link" data-action="open-track" data-id="${tr.id}">${this._esc(tr.icon)} ${this._esc(tr.name)}</button>
        <div class="row between wrap">
          <h2>${this._esc(p.name)}</h2>
          <div class="row wrap">
            <select data-field="project-trackId" data-id="${p.id}" aria-label="Track">${this._options([...d.tracks.map((t) => [t.id, `${t.icon} ${t.name}`]), ["", "No track"]], p.trackId && this._track(p.trackId) ? p.trackId : "")}</select>
            <select data-field="project-priority" data-id="${p.id}" aria-label="Lane">${this._options([[3, "★ Focus"], [2, "Next"], [1, "Later"], [0, "Someday"]], p.priority)}</select>
            <select data-field="project-status" data-id="${p.id}" aria-label="Status">${this._options(["Active", "Paused", "Dormant", "Archive", "Done", "Dropped"].map((s) => [s, s]), p.status)}</select>
          </div>
        </div>
        <div class="meta">${this._esc(p.machine)}${p.path ? ` · <code>${this._esc(p.path)}</code>` : ""}${p.backup ? ` · ${this._esc(p.backup)}` : ""}${p.lastActivity ? ` · last activity ${this._esc(p.lastActivity)}` : ""}</div>
        ${this._progressBar(stats, true)}
        <div class="meta">${stats.done} of ${stats.total} tasks done</div>
        ${p.note ? `<p>${this._esc(p.note)}</p>` : ""}
        ${p.pitch ? `<p class="muted"><b>Why it matters:</b> ${this._esc(p.pitch)}</p>` : ""}
        <form data-form="goal" data-id="${p.id}" class="goal">
          <label class="muted small">Done means…</label>
          <textarea name="goal" rows="2" placeholder="e.g. pushed to a private repo, demo page live, write-up posted">${this._esc(p.goal)}</textarea>
          <button class="btn btn-sm">Save goal</button>
        </form>
        ${p.tags.length ? `<div class="reasons">${p.tags.map((t) => `<span class="tag">${this._esc(t)}</span>`).join("")}</div>` : ""}
        ${relatedProjects.length ? `<div class="reasons"><span class="muted small">Related:</span> ${relatedProjects.map((r) => `<button class="chip" data-action="related" data-id="${r.id}">${this._esc(r.name)}</button>`).join("")}</div>` : ""}
      </section>

      <section class="card">
        <div class="row between wrap">
          <h3>People</h3>
          ${owner ? `<button class="chip ghost danger" data-action="delete-project" data-id="${p.id}">Delete project</button>`
            : `<button class="chip ghost" data-action="leave-project" data-id="${p.id}">Leave project</button>`}
        </div>
        <div class="people">${d.people.map((x) => {
          const on = roleOf.has(x.id);
          const isOwner = roleOf.get(x.id) === "owner";
          return `<label class="person ${on ? "on" : ""}">
            <input type="checkbox" data-field="share" data-id="${p.id}" data-member="${x.id}" ${on ? "checked" : ""} ${!owner || isOwner ? "disabled" : ""}>
            <span>${this._esc(x.id === this._me() ? `${x.name} (you)` : x.name)}</span>
            <span class="muted small">${isOwner ? "owner" : x.isAdmin ? "" : "kid"}</span>
          </label>`;
        }).join("")}</div>
        <p class="muted small">${owner
          ? (p.members.length > 1 ? "Everyone ticked sees this project and its tasks. Each person keeps their own track and lane for it." : "Only you can see this project. Tick someone to share it.")
          : `${this._esc(this._personName(p.members.find((m) => m.role === "owner")?.memberId))} owns this project and decides who's on it.`}</p>
      </section>

      <section class="card">
        <h3>Tasks</h3>
        <ul class="list">${tasks.map((t) => {
          const blocked = ProjectsScore.blockers(t, taskById);
          const closed = ProjectsScore.CLOSED(t.status);
          const editing = this._editingTaskId === t.id;
          return `<li class="${closed ? "closed" : ""}">
            <button class="check ${t.status === "done" ? "on" : ""}" data-action="task-toggle" data-id="${t.id}" aria-label="Toggle done">${t.status === "done" ? "✓" : ""}</button>
            <div class="grow">
              ${this._taskLine(t)}
              ${blocked.length && !closed ? `<div class="reasons"><span class="tag warn">Blocked by: ${this._esc(blocked.join(", "))}</span></div>` : ""}
              ${t.dependsOn.length ? `<div class="reasons">${t.dependsOn.map((dep) => {
                const dt = taskById.get(dep);
                if (!dt) return "";
                const dp = dt.projectId !== p.id ? this._project(dt.projectId) : null;
                return `<span class="tag ${ProjectsScore.CLOSED(dt.status) ? "good" : ""}">after: ${dp ? this._esc(dp.name) + " → " : ""}${this._esc(dt.title)}
                  <button class="x" data-action="dep-remove" data-task="${t.id}" data-id="${dep}" aria-label="Remove dependency">✕</button></span>`;
              }).join("")}</div>` : ""}
              ${t.notes && !editing ? `<div class="meta notes">${this._esc(t.notes)}</div>` : ""}
              ${editing ? `
                <form data-form="task-notes" data-id="${t.id}" class="edit">
                  <input name="title" value="${this._esc(t.title)}">
                  <textarea name="notes" rows="3" placeholder="Notes">${this._esc(t.notes)}</textarea>
                  <div class="row wrap">
                    <select data-field="task-status" data-id="${t.id}">${this._options([["todo", "To do"], ["doing", "Doing"], ["blocked", "Blocked"], ["done", "Done"], ["dropped", "Dropped"]], t.status)}</select>
                    <select data-field="task-priority" data-id="${t.id}">${this._options([[3, "Urgent"], [2, "High"], [1, "Normal"], [0, "Low"]], t.priority)}</select>
                    <select data-field="task-size" data-id="${t.id}">${this._options([["xs", "XS · 15m"], ["s", "S · 45m"], ["m", "M · 2h"], ["l", "L · half day"], ["xl", "XL · day+"]], t.size)}</select>
                    <select data-field="task-energy" data-id="${t.id}">${this._options([["low", "Low energy"], ["medium", "Medium energy"], ["high", "High energy"]], t.energy)}</select>
                    ${p.members.length > 1 ? `<select data-field="task-assigneeId" data-id="${t.id}" aria-label="Assignee">${this._options(assignees, t.assigneeId)}</select>` : ""}
                    <select data-field="task-add-dep" data-id="${t.id}">
                      <option value="">Add dependency…</option>
                      ${otherOpenTasks.filter((o) => o.id !== t.id && !t.dependsOn.includes(o.id)).map((o) => {
                        const op = this._project(o.projectId);
                        return `<option value="${o.id}">${o.projectId === p.id ? "" : this._esc(op?.name || "") + " → "}${this._esc(o.title)}</option>`;
                      }).join("")}
                    </select>
                  </div>
                  <div class="row"><button class="btn btn-sm">Save</button>
                    <button type="button" class="chip ghost" data-action="task-delete" data-id="${t.id}">Delete task</button></div>
                </form>` : ""}
            </div>
            <button class="chip ghost" data-action="task-edit" data-id="${t.id}">${editing ? "Close" : "Edit"}</button>
          </li>`;
        }).join("")}</ul>
        <form data-form="add-task" data-id="${p.id}" class="row wrap add">
          <input name="title" placeholder="Add a task" required>
          <select name="size">${this._options([["xs", "XS"], ["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]], "s")}</select>
          <select name="energy">${this._options([["low", "Low"], ["medium", "Medium"], ["high", "High"]], "medium")}</select>
          <select name="priority">${this._options([[3, "Urgent"], [2, "High"], [1, "Normal"], [0, "Low"]], 1)}</select>
          ${p.members.length > 1 ? `<select name="assignee" aria-label="Assignee">${this._options(assignees, "")}</select>` : ""}
          <button class="btn btn-sm">Add</button>
        </form>
      </section>

      <section class="card">
        <div class="row between wrap">
          <h3>External tracking</h3>
          <div class="row">
            ${gh.length ? `<button class="btn btn-sm" data-action="sync-github" data-id="${p.id}">Sync GitHub issues</button>` : ""}
            <button class="chip ghost" data-action="set-token">${this._tokenConfigured ? "Your GitHub token is set" : "Set your GitHub token"}</button>
          </div>
        </div>
        ${p.links.length ? `<ul class="list">${p.links.map((l, i) => `<li><div class="grow">${l.type === "github"
          ? (l.issue
            ? `GitHub epic · <a href="https://github.com/${this._esc(l.repo)}/issues/${l.issue}" target="_blank" rel="noopener">${this._esc(l.repo)}#${l.issue}</a> <span class="muted small">and its sub-issues</span>`
            : `GitHub · <a href="https://github.com/${this._esc(l.repo)}/issues" target="_blank" rel="noopener">${this._esc(l.repo)}</a> <span class="muted small">all issues</span>`)
          : `<a href="${this._esc(l.url)}" target="_blank" rel="noopener">${this._esc(l.label || l.url)}</a>`}</div>
          <button class="chip ghost" data-action="link-remove" data-id="${p.id}" data-index="${i}">✕</button></li>`).join("")}</ul>` : `<p class="muted small">Link a GitHub repo (owner/repo) to pull in its open issues, or an epic (owner/repo#123) to pull in its sub-issue tree with blocked-by links as dependencies. Closed issues close their tasks.</p>`}
        <form data-form="add-link" data-id="${p.id}" class="row">
          <input name="repo" placeholder="owner/repo or owner/repo#123">
          <button class="btn btn-sm">Link repo</button>
        </form>
      </section>`;
  }

  render() {
    if (this._view === "detail" && this._tokenConfigured === null && this._data) {
      this._tokenConfigured = false;
      tracker.apiFetch("/api/projects/github-token").then((r) => { this._tokenConfigured = r.configured; this.render(); }).catch(() => {});
    }
    // The element can render before boot has resolved the current user; fetch once we know it's a parent.
    if (tracker.isCurrentUserAdmin() && !this._data && !this._loading && !this._error) this._load();
    let body;
    if (!tracker.isCurrentUserAdmin()) body = `<p class="muted">Projects are only available to parents.</p>`;
    else if (this._error && !this._data) body = `<p class="muted">Couldn't load projects: ${this._esc(this._error)}</p>`;
    else if (!this._data) body = `<p class="muted">Loading…</p>`;
    else if (this._view === "detail") body = this._renderDetail();
    else if (this._view === "projects") body = this._renderProjects();
    else if (this._view === "track") body = this._renderTrack();
    else body = this._renderToday();

    const active = this._view === "projects" ? "projects" : this._view === "detail" ? "" : "today";
    const tab = (v, l) => `<button class="tab ${active === v ? "active" : ""}" data-action="tab" data-view="${v}">${l}</button>`;
    this.shadowRoot.innerHTML = `
      <style>
        ${tracker.TRACKER_CSS}
        :host { display: block; }
        .tabs { display: flex; gap: 2px; background: #0d0e16; border-radius: 12px; padding: 3px; margin-bottom: 14px; }
        .tab { flex: 1; padding: 8px; border: none; border-radius: 10px; background: transparent; color: #a0a4be; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
        .tab.active { background: #1a1c2a; color: #e2e4f0; }
        .card { background: #12131f; border: 1px solid #25273a; border-radius: 14px; padding: 14px; margin-bottom: 12px; }
        h2 { margin: 0; font-size: 1.15rem; }
        h3 { margin: 0 0 10px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
        p { font-size: 0.88rem; line-height: 1.45; margin: 8px 0; }
        .muted { color: var(--muted); }
        .small { font-size: 0.78rem; }
        .row { display: flex; gap: 8px; align-items: center; }
        .row.wrap { flex-wrap: wrap; }
        .row.between { justify-content: space-between; }
        .grow { flex: 1; min-width: 0; }
        .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .list li { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: 10px; background: #181926; border: 1px solid #22243a; }
        .list li.clickable { cursor: pointer; align-items: center; }
        .list li.clickable:hover { border-color: var(--accent-strong); }
        .list li.closed { opacity: 0.55; }
        .list li.closed .task-title span { text-decoration: line-through; }
        .pick.o-done { border-color: #2d6b45; background: #13261c; }
        .pick.o-skipped { opacity: 0.6; }
        .task-title { font-size: 0.92rem; font-weight: 600; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
        .meta { font-size: 0.76rem; color: var(--muted); margin-top: 3px; }
        .meta.notes { white-space: pre-wrap; }
        .reasons { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
        .tag { font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; background: #22243a; color: #c8cbe0; white-space: nowrap; display: inline-flex; gap: 4px; align-items: center; }
        .tag.good { background: rgba(80, 250, 123, 0.12); color: #7ee2a0; }
        .tag.warn { background: rgba(241, 250, 140, 0.12); color: #e8ef9a; }
        .tag.p3 { background: rgba(255, 107, 129, 0.18); color: #ff9aab; }
        .tag.p2 { background: var(--accent-soft); color: var(--accent); }
        .tag .x { all: unset; cursor: pointer; opacity: 0.7; }
        .btns { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
        .chip { font: inherit; font-size: 0.75rem; padding: 4px 10px; border-radius: 999px; border: 1px solid #2c2f48; background: #1a1c2a; color: #c8cbe0; cursor: pointer; white-space: nowrap; }
        .chip.on { background: #1a3a2a; border-color: #2d6b45; color: #4ade80; }
        .chip.ghost { background: transparent; }
        .link { all: unset; cursor: pointer; color: var(--accent); font-size: 0.85rem; }
        .link.proj { font-size: 0.75rem; font-weight: 500; }
        .ext { font-size: 0.72rem; color: var(--accent); }
        .check { width: 22px; height: 22px; flex: none; border-radius: 6px; border: 2px solid #444a66; background: transparent; color: #000; font-weight: 700; cursor: pointer; padding: 0; }
        .check.on { background: #4ade80; border-color: #4ade80; }
        .bar { height: 6px; border-radius: 3px; background: #22243a; overflow: hidden; min-width: 80px; flex: none; width: 90px; margin-top: 6px; }
        .bar i { display: block; height: 100%; background: var(--success); }
        .card > .bar { width: 100%; }
        .stats { margin-bottom: 12px; }
        .stat { flex: 1; background: #12131f; border: 1px solid #25273a; border-radius: 14px; padding: 10px 12px; }
        .stat b { display: block; font-size: 1.3rem; }
        .stat span { font-size: 0.72rem; color: var(--muted); }
        input, select, textarea { font: inherit; font-size: 0.85rem; background: #0d0e16; color: var(--text); border: 1px solid #2c2f48; border-radius: 8px; padding: 6px 8px; min-width: 0; }
        input[type=search], .add input[name=title], form.row input { flex: 1 1 12rem; }
        textarea { width: 100%; resize: vertical; }
        .goal, .edit { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; align-items: flex-start; }
        .edit input { width: 100%; }
        .add { margin-top: 10px; }
        code { font-size: 0.75rem; }
        .flash { font-size: 0.82rem; padding: 8px 12px; border-radius: 10px; background: #1a1c2a; border: 1px solid #2c2f48; margin-bottom: 10px; }
        a { color: var(--accent); }
        .list li[style*="--tc"] { border-left: 3px solid var(--tc); }
        .link.proj { display: inline-flex; align-items: center; gap: 5px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tc, var(--accent)); display: inline-block; }
        .hero { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: flex-end; margin: 4px 2px 14px; }
        .hero .date { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.01em; }
        .plan { border-color: #34385a; }
        .tracks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr)); gap: 12px; margin-bottom: 12px; }
        .track { position: relative; overflow: hidden; border-radius: 16px; padding: 14px 14px 10px; border: 1px solid color-mix(in srgb, var(--tc) 35%, #25273a);
          background: linear-gradient(160deg, color-mix(in srgb, var(--tc) 16%, #12131f) 0%, #12131f 55%); display: flex; flex-direction: column; gap: 8px; }
        .track::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--tc); }
        .track.big { margin-bottom: 12px; padding: 18px 16px 14px; }
        .track-head { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
        .track.big .track-head { cursor: default; }
        .track-head .icon { font-size: 1.6rem; line-height: 1; width: 2.2rem; height: 2.2rem; display: grid; place-items: center; border-radius: 12px; background: color-mix(in srgb, var(--tc) 22%, transparent); flex: none; }
        .track-head h2 { font-size: 1.05rem; }
        .track.big h2 { font-size: 1.35rem; }
        .intention { font-size: 0.8rem; color: #b9bcd4; font-style: italic; margin-top: 2px; line-height: 1.35; }
        .week { display: inline-flex; gap: 3px; }
        .week i { font-style: normal; font-size: 0.58rem; width: 15px; height: 15px; border-radius: 4px; display: grid; place-items: center; color: #6c7090; background: #1c1e2e; }
        .week i.on { background: var(--tc); color: #0d0e16; font-weight: 700; }
        .label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in srgb, var(--tc) 70%, #c8cbe0); font-weight: 700; margin-top: 2px; }
        .focus-proj { padding: 10px 12px; border-radius: 12px; background: rgba(13, 14, 22, 0.55); border: 1px solid color-mix(in srgb, var(--tc) 30%, #22243a); cursor: pointer; }
        .focus-proj:hover { border-color: var(--tc); }
        .focus-proj b { font-size: 0.98rem; }
        .faint { opacity: 0.7; font-style: italic; }
        .empty { padding: 10px 12px; border-radius: 12px; border: 1px dashed color-mix(in srgb, var(--tc) 40%, #2c2f48); }
        .move { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; background: #181926; border: 1px solid #22243a; }
        .col { display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
        .track-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 0.74rem; color: var(--muted); border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 8px; margin-top: 2px; cursor: pointer; }
        .track-foot:hover { color: var(--text); }
        .tag.quiet { align-self: flex-start; background: rgba(255, 170, 90, 0.12); color: #f5b97a; }
        .track > .tag { align-self: flex-start; }
        .bar { --fill: var(--tc, var(--success)); }
        .bar i { background: var(--fill); }
        .bar.wide { width: 100%; }
        .tag.p3 { background: rgba(250, 204, 21, 0.16); color: #fcd34d; }
        .count { font-weight: 500; color: #6c7090; margin-left: 4px; }
        .lanes { display: inline-flex; border: 1px solid #2c2f48; border-radius: 999px; overflow: hidden; flex: none; }
        .seg { font: inherit; font-size: 0.68rem; padding: 3px 8px; border: none; background: transparent; color: #8b8fa8; cursor: pointer; }
        .seg + .seg { border-left: 1px solid #2c2f48; }
        .seg.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
        .seg:first-child.on { background: rgba(250, 204, 21, 0.16); color: #fcd34d; }
        .project-head { border-top: 3px solid var(--tc); }
        .track-link { font-size: 0.75rem; color: var(--tc); margin-bottom: 4px; display: inline-block; }
        .chip.trophy { border-color: color-mix(in srgb, var(--tc) 45%, #2c2f48); }
        .shelf { margin-top: 4px; }
        .add-track { opacity: 0.7; margin: 4px 0 20px; }
        .add-track:focus-within { opacity: 1; }
        .icon-in { width: 3.2rem; text-align: center; flex: none !important; }
        input[type=color] { padding: 0; width: 2.4rem; height: 2rem; flex: none !important; }
        details > summary { cursor: pointer; }
        .tag.shared { background: rgba(167, 139, 250, 0.14); color: #c4b5fd; font-weight: 500; }
        .tag.who { background: #22243a; color: #c8cbe0; }
        .tag.who.mine { background: var(--accent-soft); color: var(--accent); }
        .people { display: flex; flex-wrap: wrap; gap: 6px; }
        .person { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid #2c2f48; font-size: 0.82rem; cursor: pointer; }
        .person.on { border-color: var(--accent-strong); background: var(--accent-soft); }
        .person input { margin: 0; }
        .chip.danger { color: #ff9aab; border-color: rgba(255, 107, 129, 0.35); }
        @media (max-width: 560px) {
          .lanes { display: none; }
          .hero .date { font-size: 1.15rem; }
        }
      </style>
      <div class="tabs">${tab("today", "Tracks")}${tab("projects", "All projects")}</div>
      ${this._flash ? `<div class="flash">${this._esc(this._flash)}</div>` : ""}
      ${body}`;
  }
}

customElements.define("ps-projects", PsProjects);
