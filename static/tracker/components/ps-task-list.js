// ps-task-list: Full task list with completion buttons
class PsTaskList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("tasks:changed", () => this.render()),
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("balances:changed", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  _getStatus(task, userId) {
    if (task.recurrence === "transient") {
      return tracker.isTaskCompletedSinceActivation(task.id, userId) ? "done" : "open";
    }
    if (task.recurrence === "weekly") {
      return tracker.isTaskCompletedThisWeek(task.id, userId) ? "done" : "open";
    }
    if (task.recurrence === "once") {
      const ever = trackerStore.completions.data.some(
        (c) => c.taskId === task.id && c.userId === userId && c.status !== "rejected"
      );
      return ever ? "done" : "open";
    }
    return tracker.isTaskCompletedToday(task.id, userId) ? "done" : "open";
  }

  render() {
    const user = tracker.getCurrentUser();
    if (!user) return;

    const tasks = tracker.getTasksForUser(user.id).filter((t) => t.category !== "jobboard");

    const rewardText = (t) => {
      if (!t.rewards || Object.keys(t.rewards).length === 0) return "—";
      return Object.entries(t.rewards)
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(", ");
    };

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .task-card {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          border-radius: var(--radius-lg);
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 8px;
          transition: border-color var(--transition-fast);
        }
        .task-card:hover {
          border-color: var(--accent-soft);
        }
        .task-card.done {
          opacity: 0.4;
        }
        .task-card.done .task-name {
          text-decoration: line-through;
        }
        .task-info { flex: 1; min-width: 0; }
        .task-name {
          font-size: 0.9rem;
          font-weight: 500;
          margin-bottom: 2px;
        }
        .task-desc {
          font-size: 0.75rem;
          color: var(--muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .task-meta {
          display: flex;
          gap: 6px;
          align-items: center;
          margin-top: 4px;
        }
        .reward-text {
          font-size: 0.78rem;
          color: var(--success);
          font-weight: 500;
          white-space: nowrap;
        }
        .recurrence {
          font-size: 0.65rem;
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(255,255,255,0.04);
          color: var(--muted);
          border: 1px solid rgba(255,255,255,0.06);
        }
        .complete-btn {
          appearance: none;
          border: none;
          background: rgba(80, 250, 123, 0.12);
          color: var(--success);
          border: 1px solid rgba(80, 250, 123, 0.2);
          border-radius: 999px;
          padding: 8px 16px;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          font-family: inherit;
          min-height: 44px;
          transition: background 160ms ease-out;
        }
        .complete-btn:hover {
          background: rgba(80, 250, 123, 0.22);
        }
        .streak-info {
          font-size: 0.72rem;
          color: var(--warning);
        }
        .timer-icon { color: var(--accent); font-size: 0.78rem; }
        .approval-note {
          font-size: 0.65rem;
          color: var(--warning);
          opacity: 0.8;
        }
      </style>
      <div class="panel">
        <div class="panel-title">All Tasks</div>
        <div class="panel-subtitle mb-3">Complete tasks to earn rewards</div>

        ${tasks.length === 0 ? `
          <div class="empty-state">
            <strong>No tasks available.</strong><br>
            An admin needs to create tasks first.
          </div>
        ` : tasks.map((t) => {
          const status = this._getStatus(t, user.id);
          const streak = tracker.calcStreak(t.id, user.id);
          return `
            <div class="task-card ${status === "done" ? "done" : ""}">
              <div class="task-info">
                <div class="task-name">
                  ${t.name}
                  ${t.timerBonus ? `<span class="timer-icon">⏱</span>` : ""}
                </div>
                ${t.description ? `<div class="task-desc">${t.description}</div>` : ""}
                <div class="task-meta">
                  <span class="recurrence">${t.recurrence}</span>
                  <span class="reward-text">${rewardText(t)}</span>
                  ${streak > 0 ? `<span class="streak-info">${streak} streak</span>` : ""}
                  ${t.requiresApproval ? `<span class="approval-note">needs approval</span>` : ""}
                </div>
              </div>
              ${status === "done"
                ? `<span class="badge badge-approved">Done</span>`
                : `<button class="complete-btn" data-task-id="${t.id}">${t.timerBonus ? "⏱ Start" : "✓ Done"}</button>`
              }
            </div>
          `;
        }).join("")}
      </div>
    `;

    this.shadowRoot.querySelectorAll(".complete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const taskId = btn.dataset.taskId;
        const task = trackerStore.tasks.data.find((t) => t.id === taskId);

        if (task && task.timerBonus) {
          eventBus.emit("timer:start", { taskId, userId: user.id });
        } else {
          const result = await tracker.completeTask(taskId, user.id);
          if (result && result.status === "pending") {
            eventBus.emit("toast:show", { message: "Submitted for approval!", type: "warning" });
          } else if (result) {
            const rt = Object.entries(result.rewards || {})
              .map(([cid, amt]) => tracker.formatAmount(amt, cid))
              .join(", ");
            if (typeof slopSFX !== "undefined") slopSFX.cashJingle();
            eventBus.emit("toast:show", { message: `Earned ${rt}!`, type: "success" });
          }
          this.render();
        }
      });
    });
  }
}

customElements.define("ps-task-list", PsTaskList);
