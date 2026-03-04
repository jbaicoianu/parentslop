// ps-admin-approvals: Approve/reject pending completions
class PsAdminApprovals extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("completion:rejected", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    const pending = trackerStore.completions.data
      .filter((c) => c.status === "pending")
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

    // Also show recent decisions
    const recent = trackerStore.completions.data
      .filter((c) => c.status === "approved" || c.status === "rejected")
      .filter((c) => c.approvedAt || c.rejectedAt)
      .sort((a, b) => (b.approvedAt || b.rejectedAt || "").localeCompare(a.approvedAt || a.rejectedAt || ""))
      .slice(0, 10);

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .pending-card {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #1a1824, #0e0d18);
          border: 1px solid rgba(241, 250, 140, 0.1);
          margin-bottom: 8px;
        }
        .pending-info { flex: 1; min-width: 0; }
        .pending-task { font-size: 0.88rem; font-weight: 500; }
        .pending-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
        .pending-rewards { font-size: 0.78rem; color: var(--success); margin-top: 2px; }
        .invoice-table {
          width: 100%;
          margin: 8px 0 4px;
          border-collapse: collapse;
          font-size: 0.74rem;
        }
        .invoice-table th {
          text-align: left;
          color: var(--muted);
          font-weight: 500;
          padding: 4px 8px;
          border-bottom: 1px solid var(--border-subtle);
          text-transform: uppercase;
          letter-spacing: 0.03em;
          font-size: 0.68rem;
        }
        .invoice-table td {
          padding: 4px 8px;
          color: var(--text);
          border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .invoice-total {
          font-size: 0.78rem;
          color: var(--accent);
          font-weight: 600;
          margin-top: 4px;
        }
        .action-btns { display: flex; gap: 6px; }
        .action-btn {
          appearance: none;
          border: none;
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 0.78rem;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          min-height: 36px;
          transition: background 160ms ease-out;
        }
        .approve-btn {
          background: rgba(80, 250, 123, 0.12);
          color: #50fa7b;
          border: 1px solid rgba(80, 250, 123, 0.2);
        }
        .approve-btn:hover { background: rgba(80, 250, 123, 0.22); }
        .reject-btn {
          background: rgba(255, 107, 129, 0.1);
          color: #ff6b81;
          border: 1px solid rgba(255, 107, 129, 0.15);
        }
        .reject-btn:hover { background: rgba(255, 107, 129, 0.2); }
        .recent-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 0;
          font-size: 0.78rem;
          color: var(--muted);
          border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .recent-row:last-child { border-bottom: none; }
        .section-label {
          font-size: 0.78rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin: 16px 0 8px;
        }
        .criteria-section {
          margin: 8px 0 4px;
          padding: 8px 10px;
          border-radius: var(--radius-sm);
          background: rgba(102, 217, 239, 0.04);
          border: 1px solid rgba(102, 217, 239, 0.1);
        }
        .criteria-section-label {
          font-size: 0.7rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 6px;
        }
        .criterion-check {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 4px;
          font-size: 0.8rem;
          color: var(--text);
        }
        .criterion-check input[type="checkbox"] {
          accent-color: var(--accent);
          width: 16px;
          height: 16px;
        }
        .criterion-check .criterion-mult {
          color: var(--muted);
          font-size: 0.72rem;
        }
        .adjusted-payout {
          font-size: 0.76rem;
          color: var(--accent);
          margin-top: 6px;
          font-weight: 500;
        }
      </style>
      <div class="panel">
        <div class="panel-title">Approvals</div>
        <div class="panel-subtitle mb-3">${pending.length} pending</div>

        ${pending.length === 0 ? `
          <div class="empty-state">
            <strong>No pending approvals.</strong>
          </div>
        ` : pending.map((c) => {
          const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
          const user = trackerStore.users.data.find((u) => u.id === c.userId);
          const rewardText = Object.entries(c.rewards || {})
            .map(([cid, amt]) => tracker.formatAmount(amt, cid))
            .join(", ");
          const date = new Date(c.completedAt).toLocaleString();
          const fmtDur = (secs) => {
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = Math.floor(secs % 60);
            if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m " + String(s).padStart(2, "0") + "s";
            return m + "m " + String(s).padStart(2, "0") + "s";
          };
          const fmtShortTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const fmtShortDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
          const totalHours = c.isHourly && c.totalSeconds ? (c.totalSeconds / 3600) : 0;
          return `
            <div class="pending-card" style="flex-direction: column; align-items: stretch;">
              <div style="display:flex; align-items:center; gap:10px;">
                <div class="pending-info">
                  <div class="pending-task">${task?.name || "Unknown task"}${c.isHourly ? ' <span class="badge badge-pending">hourly</span>' : ""}</div>
                  <div class="pending-meta">
                    by ${user?.name || "?"} · ${date}
                    ${c.timerSeconds !== null && !c.isHourly ? " · " + Math.round(c.timerSeconds) + "s" : ""}
                    ${c.streakCount > 0 ? " · streak " + c.streakCount : ""}
                  </div>
                  <div class="pending-rewards" data-base-rewards='${JSON.stringify(c.rewards || {})}' data-completion-id="${c.id}">Payout: ${rewardText || "none"}</div>
                </div>
                <div class="action-btns">
                  <button class="action-btn approve-btn" data-approve="${c.id}">Approve</button>
                  <button class="action-btn reject-btn" data-reject="${c.id}">Reject</button>
                </div>
              </div>
              ${task?.bonusCriteria?.length > 0 ? `
                <div class="criteria-section" data-criteria-for="${c.id}">
                  <div class="criteria-section-label">Bonus Criteria</div>
                  ${task.bonusCriteria.map((bc) => `
                    <label class="criterion-check">
                      <input type="checkbox" data-criterion-id="${bc.id}" data-multiplier="${bc.multiplier}" />
                      ${bc.label} <span class="criterion-mult">(${bc.multiplier}×)</span>
                    </label>
                  `).join("")}
                  <div class="adjusted-payout" data-adjusted-for="${c.id}"></div>
                </div>
              ` : ""}
              ${c.isHourly && c.worklog && c.worklog.length > 0 ? `
                <table class="invoice-table">
                  <thead>
                    <tr><th>Date</th><th>Clock In</th><th>Clock Out</th><th>Duration</th></tr>
                  </thead>
                  <tbody>
                    ${c.worklog.map((w) => `
                      <tr>
                        <td>${fmtShortDate(w.clockIn)}</td>
                        <td>${fmtShortTime(w.clockIn)}</td>
                        <td>${fmtShortTime(w.clockOut)}</td>
                        <td>${fmtDur(w.seconds)}</td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
                <div class="invoice-total">Total: ${totalHours.toFixed(2)} hrs &rarr; ${rewardText}</div>
              ` : ""}
            </div>
          `;
        }).join("")}

        ${recent.length > 0 ? `
          <div class="section-label">Recent Decisions</div>
          ${recent.map((c) => {
            const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
            const user = trackerStore.users.data.find((u) => u.id === c.userId);
            return `
              <div class="recent-row">
                <span class="badge badge-${c.status}">${c.status}</span>
                <span>${task?.name || "?"} · ${user?.name || "?"}</span>
              </div>
            `;
          }).join("")}
        ` : ""}
      </div>
    `;

    this.shadowRoot.querySelectorAll("[data-approve]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const completionId = btn.dataset.approve;
        const criteriaSection = this.shadowRoot.querySelector(`[data-criteria-for="${completionId}"]`);
        const checkedIds = [];
        if (criteriaSection) {
          criteriaSection.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
            checkedIds.push(cb.dataset.criterionId);
          });
        }
        tracker.approveCompletion(completionId, checkedIds);
        if (typeof slopSFX !== "undefined") slopSFX.cashJingle();
        eventBus.emit("toast:show", { message: "Approved!", type: "success" });
      });
    });

    this.shadowRoot.querySelectorAll("[data-reject]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (confirm("Reject this completion?")) {
          tracker.rejectCompletion(btn.dataset.reject);
          eventBus.emit("toast:show", { message: "Rejected.", type: "danger" });
        }
      });
    });

    // Live payout update when toggling bonus criteria checkboxes
    this.shadowRoot.querySelectorAll(".criteria-section").forEach((section) => {
      const completionId = section.dataset.criteriaFor;
      const payoutEl = section.querySelector(`[data-adjusted-for="${completionId}"]`);
      const rewardsEl = this.shadowRoot.querySelector(`.pending-rewards[data-completion-id="${completionId}"]`);
      if (!payoutEl || !rewardsEl) return;

      const baseRewards = JSON.parse(rewardsEl.dataset.baseRewards);
      const checkboxes = section.querySelectorAll('input[type="checkbox"]');

      const updatePayout = () => {
        let multiplier = 1;
        checkboxes.forEach((cb) => {
          if (cb.checked) multiplier *= parseFloat(cb.dataset.multiplier);
        });
        if (multiplier === 1) {
          payoutEl.textContent = "";
        } else {
          const adjusted = Object.entries(baseRewards)
            .map(([cid, amt]) => {
              const c = tracker.getCurrency(cid);
              const decimals = c ? (c.decimals || 0) : 0;
              const factor = Math.pow(10, decimals);
              return tracker.formatAmount(Math.round(amt * multiplier * factor) / factor, cid);
            })
            .join(", ");
          payoutEl.textContent = `Adjusted payout: ${adjusted}`;
        }
      };

      checkboxes.forEach((cb) => cb.addEventListener("change", updatePayout));
    });
  }
}

customElements.define("ps-admin-approvals", PsAdminApprovals);
