// ps-admin-log: Full activity audit trail
class PsAdminLog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._limit = 50;
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("redemption:added", () => this.render()),
      eventBus.on("redemption:fulfilled", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    // Merge completions and redemptions into a single timeline
    const entries = [];

    for (const c of trackerStore.completions.data) {
      const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
      const user = trackerStore.users.data.find((u) => u.id === c.userId);
      entries.push({
        type: c.isPenalty ? "penalty" : "completion",
        date: c.completedAt,
        status: c.status,
        taskName: task?.name || "?",
        userName: user?.name || "?",
        rewards: c.rewards,
        note: c.note || "",
        timerSeconds: c.timerSeconds,
        streakCount: c.streakCount,
      });
    }

    for (const r of trackerStore.redemptions.data) {
      const item = trackerStore.shop.data.find((s) => s.id === r.shopItemId);
      const user = trackerStore.users.data.find((u) => u.id === r.userId);
      entries.push({
        type: "redemption",
        date: r.purchasedAt,
        status: r.fulfilled ? "fulfilled" : "pending",
        itemName: item?.name || "?",
        userName: user?.name || "?",
        costs: item?.costs || {},
      });
    }

    entries.sort((a, b) => b.date.localeCompare(a.date));
    const displayed = entries.slice(0, this._limit);

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .log-entry {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 8px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.03);
          font-size: 0.8rem;
        }
        .log-entry:last-child { border-bottom: none; }
        .log-icon {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.85rem;
          flex-shrink: 0;
        }
        .log-icon.completion { background: rgba(80, 250, 123, 0.1); }
        .log-icon.penalty { background: rgba(255, 107, 129, 0.1); }
        .log-icon.redemption { background: rgba(102, 217, 239, 0.1); }
        .log-text { flex: 1; color: var(--muted); }
        .log-text strong { color: var(--text); font-weight: 500; }
        .log-date { font-size: 0.68rem; color: var(--muted); white-space: nowrap; opacity: 0.7; }
        .log-note { font-size: 0.72rem; color: var(--muted); font-style: italic; margin-top: 2px; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      </style>
      <div class="panel">
        <div class="toolbar">
          <div>
            <div class="panel-title">Activity Log</div>
            <div class="panel-subtitle">${entries.length} total entries</div>
          </div>
        </div>

        <div class="scroll-y">
          ${displayed.length === 0 ? `
            <div class="empty-state"><strong>No activity yet.</strong></div>
          ` : displayed.map((e) => {
            const date = new Date(e.date).toLocaleString();
            if (e.type === "penalty") {
              const rText = Object.entries(e.rewards || {}).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(", ");
              return `
                <div class="log-entry">
                  <div class="log-icon penalty">−</div>
                  <div class="log-text">
                    <strong>${e.userName}</strong> penalized: ${e.taskName} (${rText})
                    ${e.note ? `<div class="log-note">${e.note}</div>` : ""}
                  </div>
                  <div class="log-date">${date}</div>
                </div>
              `;
            }
            if (e.type === "completion") {
              const rText = Object.entries(e.rewards || {}).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(", ");
              return `
                <div class="log-entry">
                  <div class="log-icon completion">✓</div>
                  <div class="log-text">
                    <strong>${e.userName}</strong> completed ${e.taskName}
                    <span class="badge badge-${e.status}">${e.status}</span>
                    ${rText ? ` → ${rText}` : ""}
                    ${e.timerSeconds ? ` · ${Math.round(e.timerSeconds)}s` : ""}
                    ${e.streakCount > 0 ? ` · streak ${e.streakCount}` : ""}
                  </div>
                  <div class="log-date">${date}</div>
                </div>
              `;
            }
            // redemption
            const cText = Object.entries(e.costs || {}).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(" + ");
            return `
              <div class="log-entry">
                <div class="log-icon redemption">★</div>
                <div class="log-text">
                  <strong>${e.userName}</strong> redeemed ${e.itemName} (${cText})
                  <span class="badge badge-${e.status === "fulfilled" ? "approved" : "pending"}">${e.status}</span>
                </div>
                <div class="log-date">${date}</div>
              </div>
            `;
          }).join("")}
        </div>

        ${entries.length > this._limit ? `
          <div class="mt-3" style="text-align:center">
            <button class="btn btn-sm btn-ghost" id="load-more">Show more</button>
          </div>
        ` : ""}
      </div>
    `;

    this.shadowRoot.getElementById("load-more")?.addEventListener("click", () => {
      this._limit += 50;
      this.render();
    });
  }
}

customElements.define("ps-admin-log", PsAdminLog);
