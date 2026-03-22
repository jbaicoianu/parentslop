// ps-nav-bar: Tab navigation
class PsNavBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
    this._offline = false;
    this._queueCount = 0;
    this._banner = null; // body-level offline banner element
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("nav:changed", () => this.render()),
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("server:unreachable", () => { this._offline = true; this._updateQueueCount(); }),
      eventBus.on("server:reachable", () => { this._offline = false; this._updateBanner(); }),
      eventBus.on("offlineQueue:changed", () => this._updateQueueCount()),
    );
    if (!navigator.onLine) this._offline = true;
    this._ensureBanner();
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    if (this._banner && this._banner.parentNode) {
      this._banner.parentNode.removeChild(this._banner);
    }
    this._banner = null;
  }

  _ensureBanner() {
    if (this._banner) return;
    const el = document.createElement("div");
    el.id = "offline-banner";
    el.style.cssText = `
      display: none;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 14px;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 10000;
      border-radius: 0 0 12px 12px;
      background: rgba(241, 196, 15, 0.15);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(241, 196, 15, 0.3);
      border-top: none;
      color: #f1c40f;
      font-size: 0.8rem;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      animation: offline-pulse 2s ease-in-out infinite;
    `;
    el.innerHTML = `
      <span style="font-size:1rem; flex-shrink:0;">\u26A1</span>
      <span>
        <span style="font-weight:500;">Offline</span>
        <span class="queue-count" style="font-size:0.7rem; opacity:0.75; font-weight:400;"> \u2014 changes saved locally, will sync when reconnected</span>
      </span>
    `;

    // Add the pulse keyframes if not already present
    if (!document.getElementById("offline-pulse-style")) {
      const style = document.createElement("style");
      style.id = "offline-pulse-style";
      style.textContent = `
        @keyframes offline-pulse {
          0%, 100% { border-color: rgba(241, 196, 15, 0.3); }
          50% { border-color: rgba(241, 196, 15, 0.6); }
        }
        @media (max-width: 520px) {
          #offline-banner { font-size: 0.72rem !important; padding: 6px 10px !important; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(el);
    this._banner = el;
  }

  _updateBanner() {
    this._ensureBanner();
    this._banner.style.display = this._offline ? "flex" : "none";
    const countEl = this._banner.querySelector(".queue-count");
    if (countEl) {
      countEl.textContent = this._queueCount > 0
        ? ` \u2014 ${this._queueCount} change${this._queueCount !== 1 ? "s" : ""} queued, will sync when reconnected`
        : " \u2014 changes saved locally, will sync when reconnected";
    }
  }

  async _updateQueueCount() {
    if (typeof offlineDB !== "undefined") {
      try {
        this._queueCount = await offlineDB.getPendingCount();
      } catch { this._queueCount = 0; }
    }
    this._updateBanner();
  }

  _getTabs() {
    const isAdmin = tracker.isCurrentUserAdmin();
    const tabs = [
      { id: "dashboard", label: "Dashboard", icon: "\u25C9" },
      { id: "tasks", label: "Tasks", icon: "\u2713" },
      { id: "shop", label: "Shop", icon: "\u2605" },
      { id: "history", label: "History", icon: "\u231A" },
      { id: "games", label: "Games", icon: "\u25B6" },
    ];
    if (isAdmin) {
      tabs.push({ id: "admin", label: "Admin", icon: "\u2699" });
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

    // Update body-level banner
    this._updateBanner();

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
        location.hash = btn.dataset.tab;
      });
    });
  }
}

customElements.define("ps-nav-bar", PsNavBar);
