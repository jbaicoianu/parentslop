// ps-calendar-view: Month-grid calendar showing daily event dots
// Admin mode: shows all users with per-user colored dots + backfill UI
// Kid mode: shows single user with event-type dots
const USER_COLORS = ["#50fa7b", "#ff6b81", "#66d9ef", "#f1c40f", "#bd93f9", "#ff79c6"];

class PsCalendarView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const now = new Date();
    this._year = now.getFullYear();
    this._month = now.getMonth();
    this._selectedDay = null; // "YYYY-MM-DD" or null
    this._backfillStatus = "";
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("redemption:added", () => this.render()),
      eventBus.on("balances:changed", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach(u => u());
  }

  _getChildUsers() {
    return trackerStore.users.data.filter(u => u.role === "kid");
  }

  _getUserColor(userId, children) {
    const idx = children.findIndex(u => u.id === userId);
    return USER_COLORS[idx % USER_COLORS.length];
  }

  // Admin mode: build completions by day per user
  _getAdminByDay(children) {
    const byDay = {}; // key → { userId → [events] }
    for (const child of children) {
      const events = tracker.buildBalanceTimeline(child.id);
      for (const ev of events) {
        const key = tracker.dateKey(ev.date);
        if (!byDay[key]) byDay[key] = {};
        if (!byDay[key][child.id]) byDay[key][child.id] = [];
        byDay[key][child.id].push(ev);
      }
    }
    return byDay;
  }

  // Single-user mode
  _getSingleUserByDay(userId) {
    const events = tracker.buildBalanceTimeline(userId);
    const byDay = {};
    for (const ev of events) {
      const key = tracker.dateKey(ev.date);
      (byDay[key] ||= []).push(ev);
    }
    return byDay;
  }

  render() {
    const user = tracker.getCurrentUser();
    if (!user) return;

    const isAdmin = tracker.isCurrentUserAdmin();
    const children = isAdmin ? this._getChildUsers() : [];
    const adminByDay = isAdmin ? this._getAdminByDay(children) : null;
    const singleByDay = !isAdmin ? this._getSingleUserByDay(user.id) : null;

    const year = this._year;
    const month = this._month;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = new Date(year, month, 1).toLocaleString("default", { month: "long" });
    const todayKey = tracker.dateKey(new Date().toISOString());

    // Build grid cells
    const cells = [];
    for (let i = 0; i < firstDay; i++) {
      cells.push(`<div class="day empty"></div>`);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isToday = key === todayKey;
      const isSelected = key === this._selectedDay;
      let dots = "";
      let hasEvents = false;

      if (isAdmin) {
        // Per-user dots
        const dayData = adminByDay[key] || {};
        const userDots = [];
        for (const child of children) {
          if (dayData[child.id] && dayData[child.id].length > 0) {
            hasEvents = true;
            const color = this._getUserColor(child.id, children);
            userDots.push(`<span class="dot" style="background:${color}"></span>`);
          }
        }
        dots = userDots.length ? `<div class="dots">${userDots.join("")}</div>` : "";
      } else {
        // Event-type dots
        const dayEvents = singleByDay[key] || [];
        hasEvents = dayEvents.length > 0;
        const types = new Set(dayEvents.map(e => e.type));
        const typeDots = [];
        if (types.has("earned")) typeDots.push(`<span class="dot earned"></span>`);
        if (types.has("penalty")) typeDots.push(`<span class="dot penalty"></span>`);
        if (types.has("purchase")) typeDots.push(`<span class="dot purchase"></span>`);
        if (types.has("adjustment")) typeDots.push(`<span class="dot adjustment"></span>`);
        dots = typeDots.length ? `<div class="dots">${typeDots.join("")}</div>` : "";
      }

      cells.push(`
        <div class="day${isToday ? " today" : ""}${isSelected ? " selected" : ""}${hasEvents ? " has-events" : ""}" data-day="${key}">
          <span class="day-num">${d}</span>
          ${dots}
        </div>
      `);
    }

    // Legend
    let legendHTML;
    if (isAdmin) {
      legendHTML = children.map((child, i) => {
        const color = USER_COLORS[i % USER_COLORS.length];
        return `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span> ${child.name}</span>`;
      }).join("");
    } else {
      legendHTML = `
        <span class="legend-item"><span class="legend-dot" style="background:var(--success)"></span> Earned</span>
        <span class="legend-item"><span class="legend-dot" style="background:var(--danger)"></span> Penalty</span>
        <span class="legend-item"><span class="legend-dot" style="background:var(--accent)"></span> Purchase</span>
        <span class="legend-item"><span class="legend-dot" style="background:#f1c40f"></span> Adjustment</span>
      `;
    }

    // Detail panel for selected day
    let detailHTML = "";
    if (this._selectedDay) {
      const dateObj = new Date(this._selectedDay + "T12:00:00");
      const dateLabel = dateObj.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" });

      if (isAdmin) {
        detailHTML = this._renderAdminDetail(dateLabel, children, adminByDay);
      } else {
        const dayEvents = singleByDay[this._selectedDay] || [];
        detailHTML = this._renderSingleDetail(dateLabel, dayEvents);
      }
    }

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        :host { display: block; }
        .cal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .cal-header .month-label {
          font-size: 1rem;
          font-weight: 600;
        }
        .cal-nav {
          appearance: none;
          border: 1px solid var(--border-subtle);
          background: transparent;
          color: var(--text);
          width: 32px;
          height: 32px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cal-nav:hover { background: rgba(255,255,255,0.06); }
        .cal-today-btn {
          appearance: none;
          border: 1px solid var(--border-subtle);
          background: transparent;
          color: var(--muted);
          font-size: 0.7rem;
          font-family: inherit;
          padding: 4px 10px;
          border-radius: 6px;
          cursor: pointer;
        }
        .cal-today-btn:hover { background: rgba(255,255,255,0.06); color: var(--text); }

        .weekdays {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          text-align: center;
          font-size: 0.65rem;
          color: var(--muted);
          margin-bottom: 4px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 2px;
        }
        .day {
          aspect-ratio: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          cursor: pointer;
          position: relative;
          min-height: 36px;
        }
        .day.empty { cursor: default; }
        .day:not(.empty):hover { background: rgba(255,255,255,0.06); }
        .day.today .day-num {
          background: var(--accent);
          color: #000;
          border-radius: 50%;
          width: 22px;
          height: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .day.selected { background: rgba(102, 217, 239, 0.12); }
        .day-num { font-size: 0.75rem; }
        .dots {
          display: flex;
          gap: 2px;
          margin-top: 2px;
        }
        .dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
        }
        .dot.earned { background: var(--success); }
        .dot.penalty { background: var(--danger); }
        .dot.purchase { background: var(--accent); }
        .dot.adjustment { background: #f1c40f; }

        .legend {
          display: flex;
          gap: 12px;
          margin-top: 10px;
          font-size: 0.65rem;
          color: var(--muted);
          justify-content: center;
          flex-wrap: wrap;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .legend-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
        }

        .day-detail {
          margin-top: 12px;
          border-top: 1px solid var(--border-subtle);
          padding-top: 10px;
        }
        .detail-header {
          font-size: 0.85rem;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .detail-entry {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 8px 0;
          border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .detail-entry:last-child { border-bottom: none; }
        .entry-icon {
          width: 24px;
          height: 24px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          flex-shrink: 0;
        }
        .entry-icon.earned { background: rgba(80, 250, 123, 0.1); color: var(--success); }
        .entry-icon.penalty { background: rgba(255, 107, 129, 0.1); color: var(--danger); }
        .entry-icon.purchase { background: rgba(102, 217, 239, 0.1); color: var(--accent); }
        .entry-icon.adjustment { background: rgba(241, 196, 15, 0.1); color: #f1c40f; }
        .entry-info { flex: 1; }
        .entry-title { font-size: 0.8rem; font-weight: 500; }
        .entry-meta { font-size: 0.68rem; color: var(--muted); margin-top: 2px; }
        .entry-reward { font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
        .entry-reward.positive { color: var(--success); }
        .entry-reward.negative { color: var(--danger); }

        .empty-day {
          font-size: 0.78rem;
          color: var(--muted);
          padding: 8px 0;
        }

        /* Admin: per-user sections */
        .user-section {
          margin-bottom: 12px;
        }
        .user-section-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.78rem;
          font-weight: 600;
          margin-bottom: 4px;
          padding-bottom: 4px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .user-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .user-no-activity {
          font-size: 0.72rem;
          color: var(--muted);
          padding: 4px 0;
          font-style: italic;
        }

        /* Backfill */
        .backfill-section {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--border-subtle);
        }
        .backfill-header {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--muted);
          margin-bottom: 8px;
        }
        .backfill-user-group {
          margin-bottom: 10px;
        }
        .backfill-user-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.75rem;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .backfill-tasks {
          display: flex;
          flex-direction: column;
          gap: 3px;
          margin-left: 14px;
        }
        .backfill-task {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 5px 8px;
          border-radius: 6px;
          font-size: 0.75rem;
          cursor: pointer;
          transition: background 120ms;
        }
        .backfill-task:hover { background: rgba(255,255,255,0.04); }
        .backfill-task.done {
          opacity: 0.5;
          cursor: default;
        }
        .backfill-task input[type="checkbox"] {
          accent-color: var(--accent);
          margin: 0;
        }
        .bf-name { flex: 1; }
        .bf-reward { color: var(--success); font-size: 0.68rem; }
        .bf-done-badge {
          font-size: 0.6rem;
          background: rgba(80, 250, 123, 0.15);
          color: var(--success);
          padding: 1px 5px;
          border-radius: 4px;
        }
        .backfill-btn {
          appearance: none;
          border: 1px solid var(--accent);
          background: rgba(102, 217, 239, 0.08);
          color: var(--accent);
          font-size: 0.78rem;
          font-family: inherit;
          padding: 8px 16px;
          border-radius: 8px;
          cursor: pointer;
          width: 100%;
          transition: background 120ms;
          margin-top: 8px;
        }
        .backfill-btn:hover { background: rgba(102, 217, 239, 0.16); }
        .backfill-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .backfill-status {
          font-size: 0.72rem;
          padding: 6px 0;
          color: var(--success);
        }
        .backfill-status .error { color: var(--danger); }
      </style>

      <div class="cal-header">
        <button class="cal-nav" data-dir="prev">\u2039</button>
        <span class="month-label">${monthName} ${year}</span>
        <button class="cal-today-btn" data-dir="today">Today</button>
        <button class="cal-nav" data-dir="next">\u203A</button>
      </div>

      <div class="weekdays">
        <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span>
        <span>Thu</span><span>Fri</span><span>Sat</span>
      </div>

      <div class="grid">
        ${cells.join("")}
      </div>

      <div class="legend">
        ${legendHTML}
      </div>

      ${detailHTML}
    `;

    // Navigation
    this.shadowRoot.querySelectorAll(".cal-nav, .cal-today-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const dir = btn.dataset.dir;
        if (dir === "prev") {
          this._month--;
          if (this._month < 0) { this._month = 11; this._year--; }
        } else if (dir === "next") {
          this._month++;
          if (this._month > 11) { this._month = 0; this._year++; }
        } else {
          const now = new Date();
          this._year = now.getFullYear();
          this._month = now.getMonth();
        }
        this._selectedDay = null;
        this.render();
      });
    });

    // Day clicks
    this.shadowRoot.querySelectorAll(".day:not(.empty)").forEach(cell => {
      cell.addEventListener("click", () => {
        const key = cell.dataset.day;
        this._selectedDay = this._selectedDay === key ? null : key;
        this._backfillStatus = "";
        this.render();
      });
    });

    // Backfill submit (admin only)
    const backfillBtn = this.shadowRoot.getElementById("backfill-submit");
    if (backfillBtn) {
      backfillBtn.addEventListener("click", async () => {
        const checked = Array.from(this.shadowRoot.querySelectorAll('.backfill-task:not(.done) input[type="checkbox"]:checked'));
        if (checked.length === 0) {
          this._backfillStatus = '<span class="error">Select at least one task</span>';
          this.render();
          return;
        }

        backfillBtn.disabled = true;
        backfillBtn.textContent = "Submitting...";

        // Group by userId
        const byUser = {};
        for (const input of checked) {
          const userId = input.dataset.user;
          const taskId = input.value;
          (byUser[userId] ||= []).push(taskId);
        }

        for (const [userId, taskIds] of Object.entries(byUser)) {
          for (const taskId of taskIds) {
            try {
              await tracker.apiFetch("/api/completions/backfill", {
                method: "POST",
                body: JSON.stringify({
                  taskId,
                  userId,
                  dates: [this._selectedDay],
                  note: "backfill",
                }),
              });
            } catch (e) {
              this._backfillStatus = `<span class="error">Error: ${e.message}</span>`;
              this.render();
              return;
            }
          }
        }

        this._backfillStatus = `Added ${checked.length} completion${checked.length > 1 ? "s" : ""}`;
        await tracker.refreshState();
        this.render();
      });
    }
  }

  _renderSingleDetail(dateLabel, dayEvents) {
    const eventsHTML = dayEvents.map(ev => {
      const iconClass = ev.type === "penalty" ? "penalty" : ev.type === "purchase" ? "purchase" : ev.type === "adjustment" ? "adjustment" : "earned";
      const icon = ev.type === "penalty" ? "\u2212" : ev.type === "purchase" ? "\u2605" : ev.type === "adjustment" ? "\u2261" : "\u2713";
      const amtText = Object.entries(ev.deltas)
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(", ");
      const time = new Date(ev.date).toLocaleTimeString("default", { hour: "numeric", minute: "2-digit" });
      return `
        <div class="detail-entry">
          <div class="entry-icon ${iconClass}">${icon}</div>
          <div class="entry-info">
            <div class="entry-title">${ev.label}</div>
            <div class="entry-meta">${time} · ${ev.type}</div>
          </div>
          <div class="entry-reward ${Object.values(ev.deltas).reduce((s, v) => s + v, 0) >= 0 ? "positive" : "negative"}">${amtText || "\u2014"}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="day-detail">
        <div class="detail-header">${dateLabel}</div>
        ${eventsHTML}
        ${dayEvents.length === 0 ? `<div class="empty-day">No activity this day</div>` : ""}
      </div>
    `;
  }

  _renderAdminDetail(dateLabel, children, adminByDay) {
    const dayData = adminByDay[this._selectedDay] || {};

    // Per-user activity sections
    const userSections = children.map(child => {
      const color = this._getUserColor(child.id, children);
      const events = dayData[child.id] || [];

      const eventsHTML = events.map(ev => {
        const iconClass = ev.type === "penalty" ? "penalty" : ev.type === "purchase" ? "purchase" : ev.type === "adjustment" ? "adjustment" : "earned";
        const icon = ev.type === "penalty" ? "\u2212" : ev.type === "purchase" ? "\u2605" : ev.type === "adjustment" ? "\u2261" : "\u2713";
        const amtText = Object.entries(ev.deltas)
          .map(([cid, amt]) => tracker.formatAmount(amt, cid))
          .join(", ");
        return `
          <div class="detail-entry">
            <div class="entry-icon ${iconClass}">${icon}</div>
            <div class="entry-info">
              <div class="entry-title">${ev.label}</div>
            </div>
            <div class="entry-reward ${Object.values(ev.deltas).reduce((s, v) => s + v, 0) >= 0 ? "positive" : "negative"}">${amtText || "\u2014"}</div>
          </div>
        `;
      }).join("");

      return `
        <div class="user-section">
          <div class="user-section-header">
            <span class="user-dot" style="background:${color}"></span>
            ${child.name}
          </div>
          ${events.length > 0 ? eventsHTML : `<div class="user-no-activity">No activity</div>`}
        </div>
      `;
    }).join("");

    // Backfill section
    const backfillGroups = children.map(child => {
      const color = this._getUserColor(child.id, children);
      const tasks = tracker.getTasksForUser(child.id);
      const completedTaskIds = new Set(
        trackerStore.completions.data
          .filter(c => c.userId === child.id && c.status === "approved" && tracker.dateKey(c.completedAt) === this._selectedDay)
          .map(c => c.taskId)
      );
      const dailyTasks = tasks.filter(t => !t.isHourly && t.recurrence === "daily");

      return `
        <div class="backfill-user-group">
          <div class="backfill-user-label">
            <span class="user-dot" style="background:${color}"></span>
            ${child.name}
          </div>
          <div class="backfill-tasks">
            ${dailyTasks.map(t => {
              const done = completedTaskIds.has(t.id);
              const rewardText = Object.entries(t.rewards || {})
                .map(([cid, amt]) => tracker.formatAmount(amt, cid))
                .join(", ");
              return `
                <label class="backfill-task${done ? " done" : ""}">
                  <input type="checkbox" value="${t.id}" data-user="${child.id}" ${done ? "checked disabled" : ""} />
                  <span class="bf-name">${t.name}</span>
                  <span class="bf-reward">${rewardText}</span>
                  ${done ? `<span class="bf-done-badge">done</span>` : ""}
                </label>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }).join("");

    const statusMsg = this._backfillStatus || "";

    return `
      <div class="day-detail">
        <div class="detail-header">${dateLabel}</div>
        ${userSections}
        <div class="backfill-section">
          <div class="backfill-header">Backfill completions</div>
          ${backfillGroups}
          ${statusMsg ? `<div class="backfill-status">${statusMsg}</div>` : ""}
          <button class="backfill-btn" id="backfill-submit">Add selected completions</button>
        </div>
      </div>
    `;
  }
}

customElements.define("ps-calendar-view", PsCalendarView);
