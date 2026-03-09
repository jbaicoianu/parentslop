// ps-streak-badge: Streak indicator (used inline)
class PsStreakBadge extends HTMLElement {
  static get observedAttributes() {
    return ["task-id", "user-id"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  render() {
    const taskId = this.getAttribute("task-id");
    const userId = this.getAttribute("user-id");
    if (!taskId || !userId) { this.shadowRoot.innerHTML = ""; return; }

    const streak = tracker.calcStreak(taskId, userId);
    if (streak === 0) { this.shadowRoot.innerHTML = ""; return; }

    const task = trackerStore.tasks.data.find((t) => t.id === taskId);
    const unit = task?.recurrence === "weekly" ? "w" : "d";
    const hasBonusActive = task?.streakBonus && streak >= task.streakBonus.threshold;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-flex; }
        .streak {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 0.7rem;
          font-weight: 600;
          font-family: system-ui, sans-serif;
          background: ${hasBonusActive ? "rgba(241, 250, 140, 0.18)" : "rgba(241, 250, 140, 0.08)"};
          color: ${hasBonusActive ? "#f1fa8c" : "#a0a4be"};
          border: 1px solid ${hasBonusActive ? "rgba(241, 250, 140, 0.25)" : "rgba(255, 255, 255, 0.06)"};
        }
        .fire { font-size: 0.8rem; }
      </style>
      <span class="streak">
        ${hasBonusActive ? '<span class="fire">🔥</span>' : ""}
        ${streak}${unit}
        ${hasBonusActive ? ` · ${task.streakBonus.multiplier}x` : ""}
      </span>
    `;
  }
}

customElements.define("ps-streak-badge", PsStreakBadge);
