// ps-history: Completion + redemption history for the current user
class PsHistory extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "completions"; // completions | purchases
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("completion:rejected", () => this.render()),
      eventBus.on("redemption:added", () => this.render()),
      eventBus.on("redemption:fulfilled", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    const user = tracker.getCurrentUser();
    if (!user) return;

    const completions = trackerStore.completions.data
      .filter((c) => c.userId === user.id)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

    const purchases = trackerStore.redemptions.data
      .filter((r) => r.userId === user.id)
      .sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .tabs {
          display: flex;
          gap: 2px;
          margin-bottom: 12px;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: 10px;
          padding: 3px;
        }
        .tab-btn {
          appearance: none;
          border: none;
          background: transparent;
          color: var(--muted);
          font-size: 0.8rem;
          font-family: inherit;
          padding: 7px 14px;
          border-radius: 8px;
          cursor: pointer;
          flex: 1;
          text-align: center;
          transition: background 160ms ease-out, color 160ms ease-out;
        }
        .tab-btn.active {
          background: radial-gradient(circle at top left, #2b344e, #1b1e34);
          color: var(--accent);
        }
        .tab-btn:not(.active):hover {
          background: rgba(255,255,255,0.04);
        }

        .entry {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 0;
          border-bottom: 1px solid rgba(255,255,255,0.03);
        }
        .entry:last-child { border-bottom: none; }

        .entry-icon {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.8rem;
          flex-shrink: 0;
        }
        .entry-icon.earned { background: rgba(80, 250, 123, 0.1); color: var(--success); }
        .entry-icon.penalty { background: rgba(255, 107, 129, 0.1); color: var(--danger); }
        .entry-icon.purchase { background: rgba(102, 217, 239, 0.1); color: var(--accent); }

        .entry-info { flex: 1; }
        .entry-title { font-size: 0.85rem; font-weight: 500; }
        .entry-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
        .entry-reward {
          font-size: 0.8rem;
          font-weight: 600;
          white-space: nowrap;
        }
        .entry-reward.positive { color: var(--success); }
        .entry-reward.negative { color: var(--danger); }
        .entry-note { font-size: 0.72rem; color: var(--muted); font-style: italic; margin-top: 2px; }
      </style>
      <div class="panel">
        <div class="panel-title">History</div>
        <div class="panel-subtitle mb-3">Your activity log</div>

        <div class="tabs">
          <button class="tab-btn ${this._tab === "completions" ? "active" : ""}" data-tab="completions">
            Tasks (${completions.length})
          </button>
          <button class="tab-btn ${this._tab === "purchases" ? "active" : ""}" data-tab="purchases">
            Purchases (${purchases.length})
          </button>
        </div>

        <div class="scroll-y">
          ${this._tab === "completions" ? this._renderCompletions(completions) : this._renderPurchases(purchases)}
        </div>
      </div>
    `;

    this.shadowRoot.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._tab = btn.dataset.tab;
        this.render();
      });
    });
  }

  _renderCompletions(completions) {
    if (completions.length === 0) {
      return `<div class="empty-state"><strong>No task completions yet.</strong></div>`;
    }

    return completions.map((c) => {
      const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
      const date = new Date(c.completedAt).toLocaleString();
      const isPenalty = c.isPenalty || task?.isPenalty;
      const rewardText = Object.entries(c.rewards || {})
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(", ");

      // Determine total sign
      const totalPositive = Object.values(c.rewards || {}).reduce((s, v) => s + v, 0) >= 0;

      return `
        <div class="entry">
          <div class="entry-icon ${isPenalty ? "penalty" : "earned"}">${isPenalty ? "−" : "✓"}</div>
          <div class="entry-info">
            <div class="entry-title">${task?.name || "Unknown"}</div>
            <div class="entry-meta">
              ${date} · <span class="badge badge-${c.status}">${c.status}</span>
              ${c.timerSeconds !== null ? ` · ${Math.round(c.timerSeconds)}s` : ""}
              ${c.streakCount > 0 ? ` · streak ${c.streakCount}` : ""}
              ${c.streakMultiplier > 1 ? ` · ${c.streakMultiplier}x streak bonus` : ""}
              ${c.timerMultiplier > 1 ? ` · ${c.timerMultiplier}x timer bonus` : ""}
            </div>
            ${c.note ? `<div class="entry-note">${c.note}</div>` : ""}
          </div>
          <div class="entry-reward ${totalPositive ? "positive" : "negative"}">${rewardText || "—"}</div>
        </div>
      `;
    }).join("");
  }

  _renderPurchases(purchases) {
    if (purchases.length === 0) {
      return `<div class="empty-state"><strong>No purchases yet.</strong></div>`;
    }

    return purchases.map((r) => {
      const item = trackerStore.shop.data.find((s) => s.id === r.shopItemId);
      const date = new Date(r.purchasedAt).toLocaleString();
      const costText = Object.entries(item?.costs || {})
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(" + ");

      return `
        <div class="entry">
          <div class="entry-icon purchase">★</div>
          <div class="entry-info">
            <div class="entry-title">${item?.name || "Unknown"}</div>
            <div class="entry-meta">
              ${date} ·
              ${r.fulfilled
                ? `<span class="badge badge-approved">Fulfilled</span>`
                : `<span class="badge badge-pending">Pending</span>`}
            </div>
          </div>
          <div class="entry-reward negative">−${costText || "Free"}</div>
        </div>
      `;
    }).join("");
  }
}

customElements.define("ps-history", PsHistory);
