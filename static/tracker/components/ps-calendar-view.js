// ps-calendar-view: Month-grid calendar showing daily event dots
class PsCalendarView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const now = new Date();
    this._year = now.getFullYear();
    this._month = now.getMonth();
    this._selectedDay = null; // "YYYY-MM-DD" or null
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

  _getTimelineByDay() {
    const user = tracker.getCurrentUser();
    if (!user) return {};
    const events = tracker.buildBalanceTimeline(user.id);
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

    const byDay = this._getTimelineByDay();
    const year = this._year;
    const month = this._month;
    const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = new Date(year, month, 1).toLocaleString("default", { month: "long" });
    const todayKey = tracker.dateKey(new Date().toISOString());

    // Build grid cells
    const cells = [];
    // Empty cells for days before the 1st
    for (let i = 0; i < firstDay; i++) {
      cells.push(`<div class="day empty"></div>`);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayEvents = byDay[key] || [];
      const isToday = key === todayKey;
      const isSelected = key === this._selectedDay;
      const types = new Set(dayEvents.map(e => e.type));
      const dots = [];
      if (types.has("earned")) dots.push(`<span class="dot earned"></span>`);
      if (types.has("penalty")) dots.push(`<span class="dot penalty"></span>`);
      if (types.has("purchase")) dots.push(`<span class="dot purchase"></span>`);
      if (types.has("adjustment")) dots.push(`<span class="dot adjustment"></span>`);

      cells.push(`
        <div class="day${isToday ? " today" : ""}${isSelected ? " selected" : ""}${dayEvents.length ? " has-events" : ""}" data-day="${key}">
          <span class="day-num">${d}</span>
          ${dots.length ? `<div class="dots">${dots.join("")}</div>` : ""}
        </div>
      `);
    }

    // Detail panel for selected day
    let detailHTML = "";
    if (this._selectedDay && byDay[this._selectedDay]) {
      const dayEvents = byDay[this._selectedDay];
      const dateObj = new Date(this._selectedDay + "T12:00:00");
      const dateLabel = dateObj.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" });
      detailHTML = `
        <div class="day-detail">
          <div class="detail-header">${dateLabel}</div>
          ${dayEvents.map(ev => {
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
          }).join("")}
        </div>
      `;
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
        <span class="legend-item"><span class="legend-dot" style="background:var(--success)"></span> Earned</span>
        <span class="legend-item"><span class="legend-dot" style="background:var(--danger)"></span> Penalty</span>
        <span class="legend-item"><span class="legend-dot" style="background:var(--accent)"></span> Purchase</span>
        <span class="legend-item"><span class="legend-dot" style="background:#f1c40f"></span> Adjustment</span>
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
        this.render();
      });
    });
  }
}

customElements.define("ps-calendar-view", PsCalendarView);
