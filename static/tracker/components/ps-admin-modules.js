// ps-admin-modules: Toggle optional feature modules on/off
class PsAdminModules extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._saving = false;
  }

  connectedCallback() {
    this.render();
    this._unsub = eventBus.on("meals:changed", () => this.render());
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
  }

  async _toggle(moduleId) {
    if (this._saving) return;
    this._saving = true;
    this.render();
    try {
      const current = [...tracker.getEnabledModules()];
      const idx = current.indexOf(moduleId);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(moduleId);
      await tracker.apiFetch("/api/store/enabled_modules", {
        method: "PUT",
        body: JSON.stringify({ value: JSON.stringify(current) }),
      });
      await tracker.refreshState();
    } catch (e) {
      console.error("Failed to toggle module:", e);
    }
    this._saving = false;
    this.render();
  }

  render() {
    const AVAILABLE = [
      { id: "meals", name: "Meals", description: "Plan meals, vote on options, track what's eaten", icon: "\uD83C\uDF7D" },
      { id: "games", name: "Games", description: "Mini-games and activities", icon: "\u25B6" },
    ];

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .module-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 14px 0;
          border-bottom: 1px solid #25273a;
        }
        .module-row:last-child { border-bottom: none; }
        .module-icon { font-size: 1.5rem; width: 36px; text-align: center; }
        .module-info { flex: 1; }
        .module-name { font-size: 0.95rem; font-weight: 600; color: #e2e4f0; }
        .module-desc { font-size: 0.78rem; color: #a0a4be; margin-top: 2px; }
        .toggle-track {
          width: 44px; height: 24px; border-radius: 12px;
          background: #333; cursor: pointer; position: relative;
          transition: background 0.2s; flex-shrink: 0;
        }
        .toggle-track.on { background: #4ade80; }
        .toggle-track.disabled { opacity: 0.5; cursor: wait; }
        .toggle-knob {
          width: 20px; height: 20px; border-radius: 50%;
          background: #fff; position: absolute; top: 2px; left: 2px;
          transition: transform 0.2s;
        }
        .toggle-track.on .toggle-knob { transform: translateX(20px); }
      </style>
      <div class="panel">
        <div class="panel-title">Modules</div>
        <div style="font-size:0.82rem; color:#a0a4be; margin-bottom:14px;">
          Enable or disable optional features for your family.
        </div>
        ${AVAILABLE.map(m => {
          const enabled = tracker.isModuleEnabled(m.id);
          return `
            <div class="module-row">
              <div class="module-icon">${m.icon}</div>
              <div class="module-info">
                <div class="module-name">${m.name}</div>
                <div class="module-desc">${m.description}</div>
              </div>
              <div class="toggle-track ${enabled ? "on" : ""} ${this._saving ? "disabled" : ""}"
                   data-module="${m.id}">
                <div class="toggle-knob"></div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;

    this.shadowRoot.querySelectorAll(".toggle-track").forEach(el => {
      el.addEventListener("click", () => this._toggle(el.dataset.module));
    });
  }
}
customElements.define("ps-admin-modules", PsAdminModules);
