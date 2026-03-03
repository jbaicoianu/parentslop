// ps-balance-bar: Always-visible currency balance strip
class PsBalanceBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("balances:changed", () => this.render()),
      eventBus.on("currencies:changed", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    const user = tracker.getCurrentUser();
    if (!user) { this.shadowRoot.innerHTML = ""; return; }

    const currencies = trackerStore.currencies.data;
    if (currencies.length === 0) { this.shadowRoot.innerHTML = ""; return; }

    const balances = currencies.map((c) => {
      const raw = tracker.getBalance(user.id, c.id);
      return { currency: c, amount: raw, formatted: tracker.formatAmount(raw, c.id) };
    });

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        }

        .bar {
          display: flex;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 14px;
          background: #0d0e16;
          border: 1px solid #25273a;
          overflow-x: auto;
          align-items: center;
        }

        .user-name {
          font-size: 0.78rem;
          font-weight: 600;
          color: #66d9ef;
          white-space: nowrap;
          padding-right: 8px;
          border-right: 1px solid #25273a;
        }

        .balance-chip {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.05);
          white-space: nowrap;
        }

        .balance-symbol {
          font-size: 0.85rem;
        }

        .balance-amount {
          font-size: 0.82rem;
          font-weight: 600;
          color: #f7f7ff;
        }

        .balance-name {
          font-size: 0.68rem;
          color: #a0a4be;
        }

        .switch-btn {
          margin-left: auto;
          appearance: none;
          border: none;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 0.72rem;
          color: #a0a4be;
          cursor: pointer;
          white-space: nowrap;
          font-family: inherit;
          transition: background 160ms ease-out;
        }

        .switch-btn:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #f7f7ff;
        }
      </style>
      <div class="bar">
        <div class="user-name">${user.name}${user.isAdmin ? " ⚙" : ""}</div>
        ${balances
          .map(
            (b) => `
          <div class="balance-chip">
            <span class="balance-symbol">${b.currency.symbol}</span>
            <span class="balance-amount">${b.formatted}</span>
          </div>
        `
          )
          .join("")}
        <button class="switch-btn" id="switch-user">Switch User</button>
      </div>
    `;

    this.shadowRoot.getElementById("switch-user").addEventListener("click", () => {
      eventBus.emit("user:switch-requested");
    });
  }
}

customElements.define("ps-balance-bar", PsBalanceBar);
