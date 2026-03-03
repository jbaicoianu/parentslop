// ps-nav-bar: Tab navigation
class PsNavBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("nav:changed", () => this.render()),
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  _getTabs() {
    const isAdmin = tracker.isCurrentUserAdmin();
    const tabs = [
      { id: "dashboard", label: "Dashboard", icon: "◉" },
      { id: "tasks", label: "Tasks", icon: "✓" },
      { id: "shop", label: "Shop", icon: "★" },
      { id: "history", label: "History", icon: "⌚" },
      { id: "games", label: "Games", icon: "▶" },
    ];
    if (isAdmin) {
      tabs.push({ id: "admin", label: "Admin", icon: "⚙" });
    }
    return tabs;
  }

  _getPendingCount() {
    return trackerStore.completions.data.filter((c) => c.status === "pending").length;
  }

  render() {
    const app = trackerStore.app.data;
    const current = app.currentView || "dashboard";
    const tabs = this._getTabs();
    const pendingCount = this._getPendingCount();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        }

        nav {
          display: flex;
          gap: 2px;
          padding: 4px;
          border-radius: 16px;
          background: #0d0e16;
          border: 1px solid #25273a;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }

        .tab {
          appearance: none;
          border: none;
          background: transparent;
          color: #a0a4be;
          font-size: 0.78rem;
          font-family: inherit;
          padding: 8px 14px;
          border-radius: 12px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 5px;
          white-space: nowrap;
          transition: background 160ms ease-out, color 160ms ease-out;
          position: relative;
        }

        .tab:hover {
          background: rgba(255, 255, 255, 0.04);
          color: #f7f7ff;
        }

        .tab.active {
          background: radial-gradient(circle at top left, #2b344e, #1b1e34);
          color: #66d9ef;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }

        .tab-icon {
          font-size: 0.9rem;
        }

        .tab-badge {
          position: absolute;
          top: 2px;
          right: 4px;
          min-width: 16px;
          height: 16px;
          border-radius: 999px;
          background: #ff6b81;
          color: #fff;
          font-size: 0.6rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 4px;
        }

        @media (max-width: 520px) {
          .tab {
            padding: 10px 10px;
            flex-direction: column;
            gap: 2px;
            font-size: 0.68rem;
            min-width: 52px;
          }
          .tab-icon { font-size: 1rem; }
          .tab-label { font-size: 0.62rem; }
        }
      </style>
      <nav>
        ${tabs
          .map(
            (t) => `
          <button class="tab ${t.id === current ? "active" : ""}" data-tab="${t.id}">
            <span class="tab-icon">${t.icon}</span>
            <span class="tab-label">${t.label}</span>
            ${t.id === "admin" && pendingCount > 0 ? `<span class="tab-badge">${pendingCount}</span>` : ""}
          </button>
        `
          )
          .join("")}
      </nav>
    `;

    this.shadowRoot.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        const app = trackerStore.app.data;
        app.currentView = tab;
        trackerStore.app.save();
        eventBus.emit("nav:changed", { view: tab });
      });
    });
  }
}

customElements.define("ps-nav-bar", PsNavBar);
