// ps-reward-shop: Browse + buy shop items
class PsRewardShop extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("shop:changed", () => this.render()),
      eventBus.on("balances:changed", () => this.render()),
      eventBus.on("redemption:added", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  _canAfford(item, userId) {
    for (const [cid, cost] of Object.entries(item.costs || {})) {
      if (tracker.getBalance(userId, cid) < cost) return false;
    }
    return true;
  }

  _costText(item) {
    if (!item.costs || Object.keys(item.costs).length === 0) return "Free";
    return Object.entries(item.costs)
      .map(([cid, amt]) => tracker.formatAmount(amt, cid))
      .join(" + ");
  }

  render() {
    const user = tracker.getCurrentUser();
    if (!user) return;

    const items = trackerStore.shop.data.filter((s) => !s.archived);

    // Recent purchases by this user
    const myRedemptions = trackerStore.redemptions.data
      .filter((r) => r.userId === user.id)
      .sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt))
      .slice(0, 5);

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .shop-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 10px;
        }
        .shop-card {
          border-radius: var(--radius-lg);
          padding: 14px;
          background: linear-gradient(145deg, #181926, #10111b);
          border: 1px solid rgba(255, 255, 255, 0.03);
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .shop-card.cant-afford {
          opacity: 0.5;
        }
        .shop-name {
          font-size: 0.95rem;
          font-weight: 600;
        }
        .shop-desc {
          font-size: 0.78rem;
          color: var(--muted);
        }
        .shop-cost {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--accent);
        }
        .buy-btn {
          appearance: none;
          border: none;
          background: rgba(80, 250, 123, 0.12);
          color: var(--success);
          border: 1px solid rgba(80, 250, 123, 0.2);
          border-radius: 999px;
          padding: 8px 16px;
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          min-height: 44px;
          transition: background 160ms ease-out;
          align-self: flex-start;
        }
        .buy-btn:hover { background: rgba(80, 250, 123, 0.22); }
        .buy-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .progress-rows {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .progress-row-label {
          display: flex;
          justify-content: space-between;
          font-size: 0.72rem;
          color: var(--muted);
        }
        .progress-row-label .have {
          color: var(--text);
          font-weight: 600;
        }
        .progress-row-label .have.enough {
          color: var(--success);
        }
        .progress-bar {
          height: 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.06);
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          border-radius: 999px;
          background: var(--accent);
          transition: width 400ms ease-out;
        }
        .progress-fill.full {
          background: var(--success);
        }
        .recent-title {
          font-size: 0.78rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin: 18px 0 8px;
        }
        .recent-item {
          font-size: 0.8rem;
          color: var(--muted);
          padding: 6px 0;
          border-bottom: 1px solid rgba(255,255,255,0.03);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .recent-item:last-child { border-bottom: none; }
        .fulfilled-badge {
          font-size: 0.68rem;
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(80,250,123,0.1);
          color: #50fa7b;
          border: 1px solid rgba(80,250,123,0.15);
        }
        .pending-badge {
          font-size: 0.68rem;
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(241,250,140,0.1);
          color: #f1fa8c;
          border: 1px solid rgba(241,250,140,0.15);
        }
      </style>
      <div class="panel">
        <div class="panel-title">Reward Shop</div>
        <div class="panel-subtitle mb-3">Spend your earnings on rewards</div>

        ${items.length === 0 ? `
          <div class="empty-state">
            <strong>Shop is empty.</strong><br>
            An admin needs to add reward items.
          </div>
        ` : `
          <div class="shop-grid">
            ${items.map((item) => {
              const canAfford = this._canAfford(item, user.id);
              const costs = Object.entries(item.costs || {});
              const progressHtml = costs.length > 0 ? `
                <div class="progress-rows">
                  ${costs.map(([cid, cost]) => {
                    const bal = tracker.getBalance(user.id, cid);
                    const pct = Math.min(100, cost > 0 ? (bal / cost) * 100 : 100);
                    const isFull = bal >= cost;
                    return `
                      <div>
                        <div class="progress-row-label">
                          <span class="have ${isFull ? "enough" : ""}">${tracker.formatAmount(bal, cid)}</span>
                          <span>${tracker.formatAmount(cost, cid)}</span>
                        </div>
                        <div class="progress-bar">
                          <div class="progress-fill ${isFull ? "full" : ""}" style="width: ${pct}%"></div>
                        </div>
                      </div>
                    `;
                  }).join("")}
                </div>
              ` : "";
              return `
                <div class="shop-card">
                  <div class="shop-name">${item.name}</div>
                  ${item.description ? `<div class="shop-desc">${item.description}</div>` : ""}
                  ${progressHtml}
                  <button class="buy-btn" data-item-id="${item.id}" ${canAfford ? "" : "disabled"}>
                    ${canAfford ? "Buy" : "Can't afford"}
                  </button>
                </div>
              `;
            }).join("")}
          </div>
        `}

        ${myRedemptions.length > 0 ? `
          <div class="recent-title">Recent Purchases</div>
          ${myRedemptions.map((r) => {
            const item = trackerStore.shop.data.find((s) => s.id === r.shopItemId);
            const name = item ? item.name : "Unknown";
            const date = new Date(r.purchasedAt).toLocaleDateString();
            return `
              <div class="recent-item">
                <span>${name} · ${date}</span>
                ${r.fulfilled
                  ? `<span class="fulfilled-badge">Fulfilled</span>`
                  : `<span class="pending-badge">Pending</span>`}
              </div>
            `;
          }).join("")}
        ` : ""}
      </div>
    `;

    this.shadowRoot.querySelectorAll(".buy-btn:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => {
        const itemId = btn.dataset.itemId;
        const item = trackerStore.shop.data.find((s) => s.id === itemId);
        if (!item) return;

        if (!confirm(`Buy "${item.name}" for ${this._costText(item)}?`)) return;

        const result = tracker.purchaseItem(itemId, user.id);
        if (result.ok) {
          eventBus.emit("toast:show", { message: `Purchased ${item.name}!`, type: "success" });
        } else {
          eventBus.emit("toast:show", { message: result.reason, type: "danger" });
        }
        this.render();
      });
    });
  }
}

customElements.define("ps-reward-shop", PsRewardShop);
