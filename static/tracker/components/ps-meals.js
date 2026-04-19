// ps-meals: Meal planning & tracking with Today / Week / Menu sub-views
class PsMeals extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "today"; // today | week | menu
    this._weekOffset = 0; // 0 = current week
    this._showAddForm = false;
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("meals:changed", () => this.render()),
      eventBus.on("user:changed", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach(u => u());
  }

  _getWeekDates(offset) {
    const now = new Date();
    const day = now.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + offset * 7);
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  _tomorrowStr() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  _formatDate(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  _dayLabel(dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }

  _getOption(id) {
    return trackerStore.mealOptions.data.find(o => o.id === id);
  }

  _getMealTypeLabel(type) {
    return { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" }[type] || type;
  }

  _getMealTypeIcon(type) {
    return { breakfast: "\u2600", lunch: "\u2601", dinner: "\uD83C\uDF19" }[type] || "";
  }

  // --- Today view ---
  _renderToday() {
    const today = this._todayStr();
    const tomorrow = this._tomorrowStr();
    const plan = tracker.getMealPlanForDate(today);
    const log = tracker.getMealLogForDate(today);
    const users = trackerStore.users.data;
    const currentUser = tracker.getCurrentUser();
    const isAdmin = tracker.isCurrentUserAdmin();

    const tomorrowPlan = tracker.getMealPlanForDate(tomorrow);

    const MEAL_TYPES = ["breakfast", "lunch", "dinner"];

    const renderSlot = (date, type, planItems, logItems, editable) => {
      const planned = planItems.find(p => p.mealType === type);
      const option = planned ? this._getOption(planned.mealOptionId) : null;

      let logHTML = "";
      if (planned) {
        logHTML = users.map(u => {
          const logged = logItems.find(l => l.mealType === type && l.userId === u.id && l.mealOptionId === planned.mealOptionId);
          const checked = !!logged;
          return `<label class="log-check ${checked ? "checked" : ""}" data-action="toggle-log"
                    data-date="${date}" data-meal-type="${type}" data-user-id="${u.id}"
                    data-meal-option-id="${planned.mealOptionId}" data-log-id="${logged?.id || ""}">
                    <span class="check-box">${checked ? "\u2713" : ""}</span>
                    <span class="check-name">${u.name}</span>
                  </label>`;
        }).join("");
      }

      return `
        <div class="meal-slot">
          <div class="slot-header">
            <span class="slot-icon">${this._getMealTypeIcon(type)}</span>
            <span class="slot-label">${this._getMealTypeLabel(type)}</span>
          </div>
          <div class="slot-body">
            ${option
              ? `<div class="planned-meal">${option.name}</div>
                 ${planned.notes ? `<div class="meal-notes">${planned.notes}</div>` : ""}
                 <div class="log-checks">${logHTML}</div>`
              : `<div class="no-plan">No plan</div>`}
          </div>
        </div>
      `;
    };

    const todayLog = tracker.getMealLogForDate(today);

    return `
      <div class="today-view">
        <div class="date-header">${this._formatDate(today)}</div>
        <div class="meal-slots">
          ${MEAL_TYPES.map(t => renderSlot(today, t, plan, todayLog, true)).join("")}
        </div>
        ${tomorrowPlan.length > 0 ? `
          <div class="tomorrow-preview">
            <div class="date-header tomorrow-label">Tomorrow \u2014 ${this._formatDate(tomorrow)}</div>
            <div class="meal-slots tomorrow-slots">
              ${MEAL_TYPES.map(t => {
                const p = tomorrowPlan.find(p => p.mealType === t);
                const opt = p ? this._getOption(p.mealOptionId) : null;
                return `<div class="meal-slot mini">
                  <span class="slot-icon-mini">${this._getMealTypeIcon(t)}</span>
                  <span>${opt ? opt.name : "\u2014"}</span>
                </div>`;
              }).join("")}
            </div>
          </div>
        ` : ""}
      </div>
    `;
  }

  // --- Week view ---
  _renderWeek() {
    const dates = this._getWeekDates(this._weekOffset);
    const isAdmin = tracker.isCurrentUserAdmin();
    const allPlan = trackerStore.mealPlan.data;
    const MEAL_TYPES = ["breakfast", "lunch", "dinner"];
    const today = this._todayStr();

    const weekLabel = `${this._formatDate(dates[0])} \u2013 ${this._formatDate(dates[6])}`;

    return `
      <div class="week-view">
        <div class="week-nav">
          <button class="week-btn" data-action="prev-week">\u2190</button>
          <span class="week-label">${weekLabel}</span>
          <button class="week-btn" data-action="next-week">\u2192</button>
        </div>
        <div class="week-grid">
          <div class="week-header-row">
            <div class="week-corner"></div>
            ${dates.map(d => `<div class="week-day-header ${d === today ? "today" : ""}">${this._dayLabel(d)}<br><span class="day-num">${d.slice(8)}</span></div>`).join("")}
          </div>
          ${MEAL_TYPES.map(type => `
            <div class="week-row">
              <div class="week-type-label">${this._getMealTypeIcon(type)}</div>
              ${dates.map(date => {
                const entry = allPlan.find(p => p.date === date && p.mealType === type);
                const opt = entry ? this._getOption(entry.mealOptionId) : null;
                return `<div class="week-cell ${date === today ? "today" : ""} ${isAdmin ? "clickable" : ""}"
                         data-action="${isAdmin ? "pick-meal" : ""}" data-date="${date}" data-meal-type="${type}"
                         data-plan-id="${entry?.id || ""}"
                         title="${opt ? opt.name : ""}">
                  ${opt ? `<span class="cell-name">${opt.name}</span>` : ""}
                </div>`;
              }).join("")}
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  // --- Menu view ---
  _renderMenu() {
    const options = trackerStore.mealOptions.data.filter(o => !o.archived);
    const currentUser = tracker.getCurrentUser();
    const isAdmin = tracker.isCurrentUserAdmin();

    const optionsHTML = options.map(o => {
      const votes = tracker.getMealVoteSummary(o.id);
      const userVote = currentUser ? tracker.getUserMealVote(o.id, currentUser.id) : 0;
      const suggestor = trackerStore.users.data.find(u => u.id === o.suggestedBy);
      return `
        <div class="menu-item">
          <div class="menu-main">
            <div class="menu-name">${o.name}</div>
            ${o.description ? `<div class="menu-desc">${o.description}</div>` : ""}
            <div class="menu-tags">
              ${(o.mealTypes || []).map(t => `<span class="meal-tag">${this._getMealTypeLabel(t)}</span>`).join("")}
              ${suggestor ? `<span class="suggested-by">by ${suggestor.name}</span>` : ""}
            </div>
          </div>
          <div class="menu-votes">
            <button class="vote-btn ${userVote === 1 ? "active up" : ""}" data-action="vote" data-option-id="${o.id}" data-vote="1">
              \u25B2 <span class="vote-count">${votes.up || ""}</span>
            </button>
            <button class="vote-btn ${userVote === -1 ? "active down" : ""}" data-action="vote" data-option-id="${o.id}" data-vote="-1">
              \u25BC <span class="vote-count">${votes.down || ""}</span>
            </button>
            ${isAdmin ? `<button class="archive-btn" data-action="archive" data-option-id="${o.id}" title="Archive">\u2715</button>` : ""}
          </div>
        </div>
      `;
    }).join("");

    const addFormHTML = this._showAddForm ? `
      <div class="add-form">
        <input type="text" class="input" id="meal-name" placeholder="Meal name" />
        <input type="text" class="input" id="meal-desc" placeholder="Description (optional)" />
        <div class="meal-type-checks">
          <label><input type="checkbox" value="breakfast" /> Breakfast</label>
          <label><input type="checkbox" value="lunch" /> Lunch</label>
          <label><input type="checkbox" value="dinner" /> Dinner</label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" data-action="save-option">Add</button>
          <button class="btn" data-action="cancel-add">Cancel</button>
        </div>
      </div>
    ` : `<button class="btn btn-add" data-action="show-add">+ Suggest a meal</button>`;

    return `
      <div class="menu-view">
        ${addFormHTML}
        <div class="menu-list">${optionsHTML || '<div class="empty">No meals yet. Add one to get started!</div>'}</div>
      </div>
    `;
  }

  // --- Picker dialog for week view ---
  _renderPicker(date, mealType, planId) {
    const options = trackerStore.mealOptions.data.filter(o => !o.archived);
    const filtered = options.filter(o => o.mealTypes.length === 0 || o.mealTypes.includes(mealType));
    // Sort by votes
    const sorted = filtered.sort((a, b) => {
      const va = tracker.getMealVoteSummary(a.id);
      const vb = tracker.getMealVoteSummary(b.id);
      return (vb.up - vb.down) - (va.up - va.down);
    });

    return `
      <div class="picker-overlay" data-action="close-picker">
        <div class="picker-dialog" onclick="event.stopPropagation()">
          <div class="picker-title">${this._getMealTypeLabel(mealType)} \u2014 ${this._formatDate(date)}</div>
          <div class="picker-list">
            ${sorted.map(o => {
              const v = tracker.getMealVoteSummary(o.id);
              return `<button class="picker-item" data-action="select-meal" data-option-id="${o.id}"
                        data-date="${date}" data-meal-type="${mealType}" data-plan-id="${planId}">
                <span class="picker-name">${o.name}</span>
                <span class="picker-votes">\u25B2${v.up} \u25BC${v.down}</span>
              </button>`;
            }).join("")}
            ${planId ? `<button class="picker-item remove" data-action="remove-plan" data-plan-id="${planId}">Remove</button>` : ""}
          </div>
          <button class="btn picker-close" data-action="close-picker">Cancel</button>
        </div>
      </div>
    `;
  }

  render() {
    const STYLES = `
      ${tracker.TRACKER_CSS}
      :host { display: block; font-family: system-ui, -apple-system, sans-serif; }

      .tabs { display: flex; gap: 2px; background: #0d0e16; border-radius: 12px; padding: 3px; margin-bottom: 16px; }
      .tab { flex: 1; padding: 8px; border: none; border-radius: 10px; background: transparent;
             color: #a0a4be; font-size: 0.85rem; font-weight: 600; cursor: pointer; text-align: center; }
      .tab.active { background: #1a1c2a; color: #e2e4f0; }

      /* Today view */
      .date-header { font-size: 0.95rem; font-weight: 700; color: #e2e4f0; margin-bottom: 12px; }
      .meal-slots { display: flex; flex-direction: column; gap: 10px; }
      .meal-slot { background: #12131f; border: 1px solid #25273a; border-radius: 14px; padding: 14px; }
      .slot-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .slot-icon { font-size: 1.1rem; }
      .slot-label { font-size: 0.85rem; font-weight: 700; color: #a0a4be; text-transform: uppercase; letter-spacing: 0.04em; }
      .planned-meal { font-size: 1rem; font-weight: 600; color: #e2e4f0; }
      .meal-notes { font-size: 0.78rem; color: #a0a4be; margin-top: 2px; }
      .no-plan { font-size: 0.85rem; color: #555; font-style: italic; }
      .log-checks { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .log-check { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 4px 10px;
                   border-radius: 8px; background: #1a1c2a; border: 1px solid #25273a; font-size: 0.82rem; color: #a0a4be; }
      .log-check.checked { background: #1a3a2a; border-color: #2d6b45; color: #4ade80; }
      .check-box { width: 18px; height: 18px; border: 2px solid #444; border-radius: 4px; display: flex;
                   align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; }
      .log-check.checked .check-box { border-color: #4ade80; background: #4ade80; color: #000; }
      .tomorrow-preview { margin-top: 20px; opacity: 0.7; }
      .tomorrow-label { font-size: 0.82rem; }
      .tomorrow-slots { gap: 6px; }
      .meal-slot.mini { padding: 8px 12px; display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #a0a4be; }
      .slot-icon-mini { font-size: 0.9rem; }

      /* Week view */
      .week-nav { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 14px; }
      .week-btn { background: #1a1c2a; border: 1px solid #25273a; color: #e2e4f0; padding: 6px 12px;
                  border-radius: 8px; cursor: pointer; font-size: 1rem; }
      .week-label { font-size: 0.85rem; font-weight: 600; color: #e2e4f0; min-width: 200px; text-align: center; }
      .week-grid { display: grid; grid-template-columns: 30px repeat(7, 1fr); gap: 2px; }
      .week-header-row, .week-row { display: contents; }
      .week-corner { }
      .week-day-header { text-align: center; font-size: 0.72rem; color: #a0a4be; padding: 4px 0; font-weight: 600; }
      .week-day-header.today { color: #4ade80; }
      .day-num { font-size: 0.68rem; opacity: 0.7; }
      .week-type-label { font-size: 0.8rem; display: flex; align-items: center; justify-content: center; }
      .week-cell { background: #12131f; border: 1px solid #1a1c2a; border-radius: 6px; min-height: 40px;
                   padding: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .week-cell.clickable { cursor: pointer; }
      .week-cell.clickable:hover { border-color: #4ade80; }
      .cell-name { font-size: 0.68rem; color: #e2e4f0; text-align: center; word-break: break-word; line-height: 1.2; }

      /* Menu view */
      .menu-list { display: flex; flex-direction: column; gap: 8px; }
      .menu-item { display: flex; align-items: center; gap: 12px; background: #12131f; border: 1px solid #25273a;
                   border-radius: 14px; padding: 12px 14px; }
      .menu-main { flex: 1; min-width: 0; }
      .menu-name { font-size: 0.95rem; font-weight: 600; color: #e2e4f0; }
      .menu-desc { font-size: 0.78rem; color: #a0a4be; margin-top: 2px; }
      .menu-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
      .meal-tag { font-size: 0.68rem; padding: 2px 8px; border-radius: 6px; background: #1a1c2a; color: #a0a4be; }
      .suggested-by { font-size: 0.68rem; color: #666; }
      .menu-votes { display: flex; flex-direction: column; gap: 4px; align-items: center; }
      .vote-btn { background: #1a1c2a; border: 1px solid #25273a; border-radius: 8px; padding: 4px 10px;
                  color: #a0a4be; cursor: pointer; font-size: 0.78rem; display: flex; align-items: center; gap: 4px; }
      .vote-btn.active.up { background: #1a3a2a; border-color: #2d6b45; color: #4ade80; }
      .vote-btn.active.down { background: #3a1a1a; border-color: #6b2d2d; color: #f87171; }
      .vote-count { font-size: 0.72rem; }
      .archive-btn { background: none; border: none; color: #666; cursor: pointer; font-size: 0.85rem; padding: 4px; }
      .archive-btn:hover { color: #f87171; }

      .btn-add { width: 100%; padding: 10px; margin-bottom: 12px; background: #1a1c2a; border: 1px dashed #25273a;
                 border-radius: 12px; color: #a0a4be; cursor: pointer; font-size: 0.85rem; }
      .btn-add:hover { border-color: #4ade80; color: #4ade80; }

      .add-form { background: #12131f; border: 1px solid #25273a; border-radius: 14px; padding: 14px; margin-bottom: 12px; }
      .input { width: 100%; padding: 8px 12px; background: #0d0e16; border: 1px solid #25273a; border-radius: 8px;
               color: #e2e4f0; font-size: 0.85rem; margin-bottom: 8px; box-sizing: border-box; }
      .meal-type-checks { display: flex; gap: 14px; margin-bottom: 10px; }
      .meal-type-checks label { font-size: 0.82rem; color: #a0a4be; display: flex; align-items: center; gap: 4px; cursor: pointer; }
      .form-actions { display: flex; gap: 8px; }
      .btn { padding: 6px 16px; border-radius: 8px; border: 1px solid #25273a; background: #1a1c2a;
             color: #e2e4f0; cursor: pointer; font-size: 0.82rem; }
      .btn-primary { background: #4ade80; color: #000; border: none; font-weight: 600; }

      .empty { font-size: 0.85rem; color: #555; text-align: center; padding: 30px; font-style: italic; }

      /* Picker */
      .picker-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000;
                        display: flex; align-items: center; justify-content: center; padding: 20px; }
      .picker-dialog { background: #12131f; border: 1px solid #25273a; border-radius: 16px; padding: 18px;
                       max-width: 340px; width: 100%; max-height: 70vh; display: flex; flex-direction: column; }
      .picker-title { font-size: 0.92rem; font-weight: 700; color: #e2e4f0; margin-bottom: 12px; }
      .picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
      .picker-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px;
                     background: #1a1c2a; border: 1px solid #25273a; border-radius: 10px; cursor: pointer;
                     color: #e2e4f0; font-size: 0.85rem; }
      .picker-item:hover { border-color: #4ade80; }
      .picker-item.remove { color: #f87171; justify-content: center; }
      .picker-name { font-weight: 500; }
      .picker-votes { font-size: 0.72rem; color: #a0a4be; }
      .picker-close { width: 100%; }
    `;

    let contentHTML;
    if (this._view === "today") contentHTML = this._renderToday();
    else if (this._view === "week") contentHTML = this._renderWeek();
    else contentHTML = this._renderMenu();

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="panel" style="border-radius:24px; padding:18px; background:radial-gradient(circle at top left,#1a1c2a,#090a13); border:1px solid #25273a; box-shadow:0 14px 30px rgba(0,0,0,0.55);">
        <div class="tabs">
          <button class="tab ${this._view === "today" ? "active" : ""}" data-tab="today">Today</button>
          <button class="tab ${this._view === "week" ? "active" : ""}" data-tab="week">Week</button>
          <button class="tab ${this._view === "menu" ? "active" : ""}" data-tab="menu">Menu</button>
        </div>
        ${contentHTML}
      </div>
      ${this._pickerState ? this._renderPicker(this._pickerState.date, this._pickerState.mealType, this._pickerState.planId) : ""}
    `;

    this._attachEvents();
  }

  _attachEvents() {
    const sr = this.shadowRoot;

    // Tab switching
    sr.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        this._view = btn.dataset.tab;
        this._showAddForm = false;
        this.render();
      });
    });

    // Week navigation
    sr.querySelectorAll("[data-action='prev-week']").forEach(b => b.addEventListener("click", () => { this._weekOffset--; this.render(); }));
    sr.querySelectorAll("[data-action='next-week']").forEach(b => b.addEventListener("click", () => { this._weekOffset++; this.render(); }));

    // Toggle meal log
    sr.querySelectorAll("[data-action='toggle-log']").forEach(el => {
      el.addEventListener("click", async () => {
        const { date, mealType, userId, mealOptionId, logId } = el.dataset;
        if (logId) {
          await tracker.unlogMeal(logId);
        } else {
          await tracker.logMeal({ date, mealType, mealOptionId });
        }
      });
    });

    // Vote
    sr.querySelectorAll("[data-action='vote']").forEach(btn => {
      btn.addEventListener("click", async () => {
        await tracker.voteMeal(btn.dataset.optionId, parseInt(btn.dataset.vote));
      });
    });

    // Archive
    sr.querySelectorAll("[data-action='archive']").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (confirm("Archive this meal option?")) {
          await tracker.archiveMealOption(btn.dataset.optionId);
        }
      });
    });

    // Add form
    sr.querySelectorAll("[data-action='show-add']").forEach(b => {
      b.addEventListener("click", () => { this._showAddForm = true; this.render(); });
    });
    sr.querySelectorAll("[data-action='cancel-add']").forEach(b => {
      b.addEventListener("click", () => { this._showAddForm = false; this.render(); });
    });
    sr.querySelectorAll("[data-action='save-option']").forEach(b => {
      b.addEventListener("click", async () => {
        const name = sr.getElementById("meal-name")?.value?.trim();
        if (!name) return;
        const desc = sr.getElementById("meal-desc")?.value?.trim() || "";
        const types = [...sr.querySelectorAll(".meal-type-checks input:checked")].map(c => c.value);
        await tracker.createMealOption({ name, description: desc, mealTypes: types });
        this._showAddForm = false;
      });
    });

    // Week cell click (picker)
    sr.querySelectorAll("[data-action='pick-meal']").forEach(cell => {
      cell.addEventListener("click", () => {
        this._pickerState = { date: cell.dataset.date, mealType: cell.dataset.mealType, planId: cell.dataset.planId };
        this.render();
      });
    });

    // Picker events
    sr.querySelectorAll("[data-action='select-meal']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { optionId, date, mealType, planId } = btn.dataset;
        if (planId) {
          await tracker.updateMealPlan(planId, { mealOptionId: optionId });
        } else {
          await tracker.addMealPlan({ date, mealType, mealOptionId: optionId });
        }
        this._pickerState = null;
      });
    });

    sr.querySelectorAll("[data-action='remove-plan']").forEach(btn => {
      btn.addEventListener("click", async () => {
        await tracker.removeMealPlan(btn.dataset.planId);
        this._pickerState = null;
      });
    });

    sr.querySelectorAll("[data-action='close-picker']").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target === el || el.tagName === "BUTTON") {
          this._pickerState = null;
          this.render();
        }
      });
    });
  }
}
customElements.define("ps-meals", PsMeals);
