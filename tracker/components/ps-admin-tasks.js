// ps-admin-tasks: Admin task CRUD (rewards, recurrence, bonuses, penalties)
class PsAdminTasks extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._editing = null; // taskId or null
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(eventBus.on("tasks:changed", () => this.render()));
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  _showForm(taskId = null) {
    this._editing = taskId;
    this.render();
  }

  render() {
    const tasks = trackerStore.tasks.data.filter((t) => !t.archived);
    const penalties = trackerStore.tasks.data.filter((t) => !t.archived && t.isPenalty);
    const currencies = trackerStore.currencies.data;
    const users = trackerStore.users.data;

    if (this._editing !== null || this._editing === "new") {
      this._renderForm();
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .task-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 6px;
        }
        .task-item-info { flex: 1; min-width: 0; }
        .task-item-name { font-size: 0.88rem; font-weight: 500; }
        .task-item-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
        .penalty-tag { color: var(--danger); font-weight: 600; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .section-label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 16px 0 8px; }
      </style>
      <div class="panel">
        <div class="toolbar">
          <div>
            <div class="panel-title">Manage Tasks</div>
            <div class="panel-subtitle">${tasks.length} tasks, ${penalties.length} penalties</div>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-sm" id="add-task">+ Task</button>
            <button class="btn btn-sm btn-danger" id="add-penalty">+ Penalty</button>
          </div>
        </div>

        ${tasks.filter(t => !t.isPenalty).length > 0 ? `
          <div class="section-label">Tasks</div>
          ${tasks.filter(t => !t.isPenalty).map((t) => `
            <div class="task-item">
              <div class="task-item-info">
                <div class="task-item-name">${t.name}</div>
                <div class="task-item-meta">
                  ${t.recurrence} · ${t.category === "jobboard" ? "job board" : "routine"} · ${this._rewardText(t)}
                  ${t.payType === "hourly" ? "· hourly" : ""}
                  ${t.maxPayout ? `· max ${this._rewardTextFromHash(t.maxPayout)}` : ""}
                  ${t.multiUser === false ? "· single" : ""}
                  ${t.requiresApproval ? "· approval required" : ""}
                  ${t.streakBonus ? `· streak ${t.streakBonus.threshold}d=${t.streakBonus.multiplier}x` : ""}
                  ${t.timerBonus ? `· timer ${t.timerBonus.mode === "over" ? "≥" : "<"}${t.timerBonus.targetSeconds}s=${t.timerBonus.multiplier}x` : ""}
                  ${t.bonusCriteria?.length ? `· ${t.bonusCriteria.length} bonus criteria` : ""}
                </div>
              </div>
              <button class="btn btn-sm btn-ghost" data-edit="${t.id}">Edit</button>
              <button class="btn btn-sm btn-ghost" data-archive="${t.id}" style="color:var(--danger)">×</button>
            </div>
          `).join("")}
        ` : ""}

        ${penalties.length > 0 ? `
          <div class="section-label">Penalties</div>
          ${penalties.map((t) => `
            <div class="task-item">
              <div class="task-item-info">
                <div class="task-item-name"><span class="penalty-tag">−</span> ${t.name}</div>
                <div class="task-item-meta">${this._rewardText(t)}</div>
              </div>
              <button class="btn btn-sm btn-ghost" data-apply-penalty="${t.id}">Apply</button>
              <button class="btn btn-sm btn-ghost" data-edit="${t.id}">Edit</button>
              <button class="btn btn-sm btn-ghost" data-archive="${t.id}" style="color:var(--danger)">×</button>
            </div>
          `).join("")}
        ` : ""}

        ${tasks.length === 0 ? `
          <div class="empty-state">
            <strong>No tasks yet.</strong> Create a task or penalty to get started.
          </div>
        ` : ""}
      </div>
    `;

    this.shadowRoot.getElementById("add-task")?.addEventListener("click", () => {
      this._editing = "new";
      this._isPenaltyForm = false;
      this.render();
    });

    this.shadowRoot.getElementById("add-penalty")?.addEventListener("click", () => {
      this._editing = "new";
      this._isPenaltyForm = true;
      this.render();
    });

    this.shadowRoot.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => this._showForm(btn.dataset.edit));
    });

    this.shadowRoot.querySelectorAll("[data-archive]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (confirm("Archive this task?")) {
          tracker.archiveTask(btn.dataset.archive);
        }
      });
    });

    this.shadowRoot.querySelectorAll("[data-apply-penalty]").forEach((btn) => {
      btn.addEventListener("click", () => this._applyPenalty(btn.dataset.applyPenalty));
    });
  }

  _rewardText(t) {
    if (!t.rewards || Object.keys(t.rewards).length === 0) return "no reward";
    return Object.entries(t.rewards)
      .map(([cid, amt]) => tracker.formatAmount(amt, cid))
      .join(", ");
  }

  _rewardTextFromHash(hash) {
    if (!hash || Object.keys(hash).length === 0) return "";
    return Object.entries(hash)
      .map(([cid, amt]) => tracker.formatAmount(amt, cid))
      .join(", ");
  }

  _applyPenalty(taskId) {
    const users = trackerStore.users.data;
    if (users.length === 0) { alert("No users."); return; }

    const names = users.map((u, i) => `${i + 1}. ${u.name}`).join("\n");
    const choice = prompt(`Apply penalty to which user?\n${names}\n\nEnter number:`);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= users.length) { alert("Invalid choice."); return; }

    const note = prompt("Optional note (leave blank for none):") || "";
    tracker.logPenalty(taskId, users[idx].id, note);
    if (typeof slopSFX !== "undefined") slopSFX.sadTrombone();
    eventBus.emit("toast:show", { message: "Penalty applied.", type: "danger" });
    this.render();
  }

  _renderForm() {
    const currencies = trackerStore.currencies.data;
    const users = trackerStore.users.data;
    const isNew = this._editing === "new";
    const task = isNew ? null : trackerStore.tasks.data.find((t) => t.id === this._editing);
    const isPenalty = isNew ? this._isPenaltyForm : (task?.isPenalty ?? false);

    const name = task?.name || "";
    const description = task?.description || "";
    const recurrence = task?.recurrence || "daily";
    const requiresApproval = task?.requiresApproval ?? false;
    const rewards = task?.rewards || {};
    const streakThreshold = task?.streakBonus?.threshold || "";
    const streakMultiplier = task?.streakBonus?.multiplier || "";
    const timerTarget = task?.timerBonus?.targetSeconds || "";
    const timerMultiplier = task?.timerBonus?.multiplier || "";
    const timerMode = task?.timerBonus?.mode || "under";
    const timerTickSound = task?.timerBonus?.tickSound || "click";
    const timerHitSound = task?.timerBonus?.hitSound || "success";
    const timerAnimation = task?.timerBonus?.animation || "none";
    const bonusCriteria = task?.bonusCriteria || [];
    const assignedUsers = task?.assignedUsers || [];
    const category = task?.category || "routine";
    const payType = task?.payType || "fixed";
    const multiUser = task?.multiUser ?? true;
    const maxPayout = task?.maxPayout || {};

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        h3 { font-size: 1rem; margin: 0 0 14px; color: var(--accent); }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }
        .checkbox-row label {
          font-size: 0.82rem;
          color: var(--muted);
          cursor: pointer;
        }
        .checkbox-row input[type="checkbox"] {
          accent-color: var(--accent);
          width: 18px;
          height: 18px;
        }
        .section-label {
          font-size: 0.75rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin: 14px 0 8px;
        }
        .reward-row {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 6px;
        }
        .reward-row .currency-name {
          font-size: 0.82rem;
          min-width: 80px;
          color: var(--muted);
        }
        .reward-row input {
          width: 100px;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          font-size: 0.84rem;
          color: var(--text);
          font-family: inherit;
        }
        .user-checkboxes {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .user-check { display: flex; align-items: center; gap: 4px; }
        .user-check label { font-size: 0.8rem; color: var(--muted); cursor: pointer; }
        .user-check input { accent-color: var(--accent); }
        .bonus-criterion-row {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 6px;
        }
        .bonus-criterion-row input[type="text"] {
          flex: 1;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          font-size: 0.84rem;
          color: var(--text);
          font-family: inherit;
        }
        .bonus-criterion-row input[type="number"] {
          width: 80px;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          font-size: 0.84rem;
          color: var(--text);
          font-family: inherit;
        }
        .bonus-criterion-row .remove-criterion {
          appearance: none;
          border: none;
          background: transparent;
          color: var(--danger);
          cursor: pointer;
          font-size: 1.1rem;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .bonus-criterion-row .remove-criterion:hover {
          background: rgba(255, 107, 129, 0.15);
        }
      </style>
      <div class="panel">
        <h3>${isNew ? (isPenalty ? "New Penalty" : "New Task") : "Edit " + (isPenalty ? "Penalty" : "Task")}</h3>

        <div class="form-group">
          <label>Name</label>
          <input type="text" id="f-name" value="${name}" placeholder="${isPenalty ? "e.g. Didn't clean room" : "e.g. Make bed"}" />
        </div>

        <div class="form-group">
          <label>Description (optional)</label>
          <input type="text" id="f-desc" value="${description}" />
        </div>

        ${!isPenalty ? `
          <div class="form-group">
            <label>Recurrence</label>
            <select id="f-recurrence">
              <option value="daily" ${recurrence === "daily" ? "selected" : ""}>Daily</option>
              <option value="weekly" ${recurrence === "weekly" ? "selected" : ""}>Weekly</option>
              <option value="once" ${recurrence === "once" ? "selected" : ""}>One-time</option>
            </select>
          </div>

          <div class="form-group">
            <label>Category</label>
            <select id="f-category">
              <option value="routine" ${category === "routine" ? "selected" : ""}>Daily Expectation (routine)</option>
              <option value="jobboard" ${category === "jobboard" ? "selected" : ""}>Job Board (optional/grab)</option>
            </select>
          </div>

          <div id="jobboard-options" style="${category === "jobboard" ? "" : "display:none"}">
            <div class="form-group">
              <label>Pay Type</label>
              <select id="f-paytype">
                <option value="fixed" ${payType === "fixed" ? "selected" : ""}>Fixed price</option>
                <option value="hourly" ${payType === "hourly" ? "selected" : ""}>Hourly rate</option>
              </select>
            </div>

            <div class="checkbox-row">
              <input type="checkbox" id="f-multiuser" ${multiUser ? "checked" : ""} />
              <label for="f-multiuser">Multiple kids can accept this job</label>
            </div>

            <div id="hourly-options" style="${payType === "hourly" ? "" : "display:none"}">
              <div class="section-label">Max Payout (optional cap per currency)</div>
              ${currencies.map((c) => {
                const val = maxPayout[c.id] != null ? maxPayout[c.id] : "";
                const step = c.decimals > 0 ? (1 / Math.pow(10, c.decimals)) : "1";
                return `
                <div class="reward-row">
                  <span class="currency-name">${c.symbol} ${c.name}</span>
                  <input type="number" data-maxpayout="${c.id}" value="${val}"
                    placeholder="no limit" step="${step}" min="0" />
                </div>
              `; }).join("")}
            </div>
          </div>

          <div class="checkbox-row">
            <input type="checkbox" id="f-approval" ${requiresApproval ? "checked" : ""} />
            <label for="f-approval">Requires admin approval</label>
          </div>
        ` : ""}

        <div class="section-label" id="rewards-label">Rewards ${isPenalty ? "(negative = deduction)" : ""}</div>
        ${currencies.map((c) => {
          const val = rewards[c.id] != null ? rewards[c.id] : "";
          const step = c.decimals > 0 ? (1 / Math.pow(10, c.decimals)) : "1";
          return `
          <div class="reward-row">
            <span class="currency-name">${c.symbol} ${c.name}</span>
            <input type="number" data-currency="${c.id}" value="${val}"
              placeholder="${isPenalty ? "-10" : "10"}" step="${step}" />
          </div>
        `; }).join("")}

        ${!isPenalty ? `
          <div class="section-label">Streak Bonus (optional)</div>
          <div class="form-row">
            <div class="form-group">
              <label>After N days</label>
              <input type="number" id="f-streak-threshold" value="${streakThreshold}" placeholder="e.g. 7" />
            </div>
            <div class="form-group">
              <label>Multiplier</label>
              <input type="number" id="f-streak-multiplier" value="${streakMultiplier}" placeholder="e.g. 1.5" step="0.1" />
            </div>
          </div>

          <div class="section-label">Timer Bonus (optional)</div>
          <div class="form-group">
            <label>Bonus condition</label>
            <select id="f-timer-mode">
              <option value="under" ${timerMode === "under" ? "selected" : ""}>Finish under target (e.g. bath &lt; 10 min)</option>
              <option value="over" ${timerMode === "over" ? "selected" : ""}>Spend at least target (e.g. brush teeth &ge; 2 min)</option>
            </select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Target seconds</label>
              <input type="number" id="f-timer-target" value="${timerTarget}" placeholder="e.g. 120" />
            </div>
            <div class="form-group">
              <label>Multiplier</label>
              <input type="number" id="f-timer-multiplier" value="${timerMultiplier}" placeholder="e.g. 1.25" step="0.1" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Tick sound</label>
              <select id="f-timer-tick">
                <option value="click" ${timerTickSound === "click" ? "selected" : ""}>Click</option>
                <option value="soft" ${timerTickSound === "soft" ? "selected" : ""}>Soft</option>
                <option value="digital" ${timerTickSound === "digital" ? "selected" : ""}>Digital</option>
                <option value="none" ${timerTickSound === "none" ? "selected" : ""}>None</option>
              </select>
            </div>
            <div class="form-group">
              <label>Hit sound</label>
              <select id="f-timer-hit">
                <option value="success" ${timerHitSound === "success" ? "selected" : ""}>Success chime</option>
                <option value="warning" ${timerHitSound === "warning" ? "selected" : ""}>Warning tone</option>
                <option value="none" ${timerHitSound === "none" ? "selected" : ""}>None</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>Timer animation</label>
            <select id="f-timer-animation">
              <option value="none" ${timerAnimation === "none" ? "selected" : ""}>None</option>
              <option value="toothbrush" ${timerAnimation === "toothbrush" ? "selected" : ""}>Toothbrush</option>
              <option value="exercise" ${timerAnimation === "exercise" ? "selected" : ""}>Exercise</option>
              <option value="reading" ${timerAnimation === "reading" ? "selected" : ""}>Reading</option>
              <option value="cleaning" ${timerAnimation === "cleaning" ? "selected" : ""}>Cleaning</option>
            </select>
          </div>

          <div class="section-label">Bonus Criteria (optional)</div>
          <div id="bonus-criteria-list">
            ${bonusCriteria.map((bc) => `
              <div class="bonus-criterion-row" data-criterion-id="${bc.id}">
                <input type="text" class="criterion-label" value="${bc.label}" placeholder="e.g. Without reminding" />
                <input type="number" class="criterion-multiplier" value="${bc.multiplier}" placeholder="1.25" step="0.05" min="1" />
                <span style="font-size:0.72rem;color:var(--muted)">×</span>
                <button class="remove-criterion" type="button">×</button>
              </div>
            `).join("")}
          </div>
          <button class="btn btn-sm btn-ghost mt-2" id="add-criterion" type="button">+ Add criterion</button>

          <div class="section-label">Assign to users (empty = all)</div>
          <div class="user-checkboxes">
            ${users.filter(u => !u.isAdmin).map((u) => `
              <div class="user-check">
                <input type="checkbox" id="u-${u.id}" data-user-id="${u.id}" ${assignedUsers.includes(u.id) ? "checked" : ""} />
                <label for="u-${u.id}">${u.name}</label>
              </div>
            `).join("")}
          </div>
        ` : ""}

        <div class="form-actions">
          <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
          <button class="btn" id="save-btn">${isNew ? "Create" : "Save"}</button>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("cancel-btn").addEventListener("click", () => {
      this._editing = null;
      this.render();
    });

    this.shadowRoot.getElementById("save-btn").addEventListener("click", () => {
      this._saveForm(isPenalty);
    });

    // Toggle jobboard options visibility when category changes
    const categoryEl = this.shadowRoot.getElementById("f-category");
    const jobboardOpts = this.shadowRoot.getElementById("jobboard-options");
    const payTypeEl = this.shadowRoot.getElementById("f-paytype");
    const rewardsLabel = this.shadowRoot.getElementById("rewards-label");

    const updateRewardsLabel = () => {
      if (!rewardsLabel || isPenalty) return;
      const isHourly = payTypeEl && payTypeEl.value === "hourly";
      rewardsLabel.textContent = isHourly ? "Hourly Rate" : "Rewards";
    };

    const hourlyOpts = this.shadowRoot.getElementById("hourly-options");

    if (categoryEl && jobboardOpts) {
      categoryEl.addEventListener("change", () => {
        jobboardOpts.style.display = categoryEl.value === "jobboard" ? "" : "none";
        if (hourlyOpts) hourlyOpts.style.display = (categoryEl.value === "jobboard" && payTypeEl && payTypeEl.value === "hourly") ? "" : "none";
        updateRewardsLabel();
      });
    }
    if (payTypeEl) {
      payTypeEl.addEventListener("change", () => {
        if (hourlyOpts) hourlyOpts.style.display = payTypeEl.value === "hourly" ? "" : "none";
        updateRewardsLabel();
      });
      updateRewardsLabel();
    }

    // Bonus criteria: add / remove
    const criteriaList = this.shadowRoot.getElementById("bonus-criteria-list");
    const addCriterionBtn = this.shadowRoot.getElementById("add-criterion");
    if (addCriterionBtn && criteriaList) {
      addCriterionBtn.addEventListener("click", () => {
        const row = document.createElement("div");
        row.className = "bonus-criterion-row";
        row.innerHTML = `
          <input type="text" class="criterion-label" value="" placeholder="e.g. Without reminding" />
          <input type="number" class="criterion-multiplier" value="1.25" placeholder="1.25" step="0.05" min="1" />
          <span style="font-size:0.72rem;color:var(--muted)">×</span>
          <button class="remove-criterion" type="button">×</button>
        `;
        row.querySelector(".remove-criterion").addEventListener("click", () => row.remove());
        criteriaList.appendChild(row);
      });
    }
    if (criteriaList) {
      criteriaList.querySelectorAll(".remove-criterion").forEach((btn) => {
        btn.addEventListener("click", () => btn.closest(".bonus-criterion-row").remove());
      });
    }
  }

  _saveForm(isPenalty) {
    const s = this.shadowRoot;
    const name = s.getElementById("f-name").value.trim();
    if (!name) { s.getElementById("f-name").focus(); return; }

    const description = s.getElementById("f-desc").value.trim();

    const rewards = {};
    s.querySelectorAll("[data-currency]").forEach((inp) => {
      const val = parseFloat(inp.value);
      if (!isNaN(val) && val !== 0) rewards[inp.dataset.currency] = val;
    });

    const data = { name, description, rewards, isPenalty };

    if (!isPenalty) {
      data.recurrence = s.getElementById("f-recurrence").value;
      data.category = s.getElementById("f-category").value;
      data.requiresApproval = s.getElementById("f-approval").checked;

      if (data.category === "jobboard") {
        data.payType = s.getElementById("f-paytype")?.value || "fixed";
        data.multiUser = s.getElementById("f-multiuser")?.checked ?? true;

        if (data.payType === "hourly") {
          const maxPayout = {};
          s.querySelectorAll("[data-maxpayout]").forEach((inp) => {
            const val = parseFloat(inp.value);
            if (!isNaN(val) && val > 0) maxPayout[inp.dataset.maxpayout] = val;
          });
          data.maxPayout = Object.keys(maxPayout).length > 0 ? maxPayout : null;
        } else {
          data.maxPayout = null;
        }
      } else {
        data.payType = "fixed";
        data.multiUser = true;
        data.maxPayout = null;
      }

      const st = parseInt(s.getElementById("f-streak-threshold")?.value);
      const sm = parseFloat(s.getElementById("f-streak-multiplier")?.value);
      data.streakBonus = (st > 0 && sm > 0) ? { threshold: st, multiplier: sm } : null;

      const tt = parseInt(s.getElementById("f-timer-target")?.value);
      const tm = parseFloat(s.getElementById("f-timer-multiplier")?.value);
      const tmode = s.getElementById("f-timer-mode")?.value || "under";
      const ttick = s.getElementById("f-timer-tick")?.value || "click";
      const thit = s.getElementById("f-timer-hit")?.value || "success";
      const tanim = s.getElementById("f-timer-animation")?.value || "none";
      data.timerBonus = (tt > 0 && tm > 0) ? { targetSeconds: tt, multiplier: tm, mode: tmode, tickSound: ttick, hitSound: thit, animation: tanim !== "none" ? tanim : undefined } : null;

      const bonusCriteria = [];
      s.querySelectorAll(".bonus-criterion-row").forEach((row) => {
        const label = row.querySelector(".criterion-label").value.trim();
        const multiplier = parseFloat(row.querySelector(".criterion-multiplier").value);
        if (label && multiplier > 0) {
          const existingId = row.dataset.criterionId;
          bonusCriteria.push({ id: existingId || tracker.uid(), label, multiplier });
        }
      });
      data.bonusCriteria = bonusCriteria.length > 0 ? bonusCriteria : null;

      const assignedUsers = [];
      s.querySelectorAll("[data-user-id]").forEach((cb) => {
        if (cb.checked) assignedUsers.push(cb.dataset.userId);
      });
      data.assignedUsers = assignedUsers;
    } else {
      data.recurrence = "once";
      data.requiresApproval = false;
      data.assignedUsers = [];
      data.streakBonus = null;
      data.timerBonus = null;
      data.bonusCriteria = null;
    }

    if (this._editing === "new") {
      tracker.createTask(data);
    } else {
      tracker.updateTask(this._editing, data);
    }

    this._editing = null;
    this.render();
  }
}

customElements.define("ps-admin-tasks", PsAdminTasks);
