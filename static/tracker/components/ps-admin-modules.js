// ps-admin-modules: Toggle optional feature modules on/off
class PsAdminModules extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._saving = false;
    this._apiKeyStatus = null; // null = loading, "configured" | "none"
    this._savingKey = false;
  }

  connectedCallback() {
    this.render();
    this._unsub = eventBus.on("meals:changed", () => this.render());
    this._loadApiKeyStatus();
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
  }

  async _loadApiKeyStatus() {
    try {
      const res = await tracker.apiFetch("/api/store/stability_api_key");
      const data = await res.json();
      this._apiKeyStatus = data.value ? "configured" : "none";
    } catch {
      this._apiKeyStatus = "none";
    }
    this.render();
  }

  async _saveApiKey() {
    if (this._savingKey) return;
    const input = this.shadowRoot.getElementById("stability-key-input");
    const value = input?.value?.trim() || "";
    this._savingKey = true;
    this.render();
    try {
      await tracker.apiFetch("/api/store/stability_api_key", {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      this._apiKeyStatus = value ? "configured" : "none";
    } catch (e) {
      console.error("Failed to save API key:", e);
    }
    this._savingKey = false;
    this.render();
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

    const mealsEnabled = tracker.isModuleEnabled("meals");

    const mealsSettingsHTML = mealsEnabled ? `
      <div class="panel" style="margin-top: 16px;">
        <div class="panel-title">Meals Settings</div>
        <div class="settings-row">
          <div class="setting-info">
            <div class="setting-label">Stability AI API Key</div>
            <div class="setting-desc">Enter a key to auto-generate meal images with AI</div>
            <div class="setting-status ${this._apiKeyStatus === "configured" ? "status-ok" : "status-none"}">
              ${this._apiKeyStatus === null ? "Loading..." : this._apiKeyStatus === "configured" ? "Key configured" : "No key set"}
            </div>
          </div>
          <div class="setting-controls">
            <input type="password" class="input key-input" id="stability-key-input"
                   placeholder="${this._apiKeyStatus === "configured" ? "Enter new key to replace" : "sk-..."}" />
            <button class="btn btn-primary btn-small" id="save-key-btn"
                    ${this._savingKey ? "disabled" : ""}>${this._savingKey ? "Saving..." : "Save"}</button>
          </div>
        </div>
      </div>
    ` : "";

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
        .settings-row { margin-top: 10px; }
        .setting-info { margin-bottom: 8px; }
        .setting-label { font-size: 0.9rem; font-weight: 600; color: #e2e4f0; }
        .setting-desc { font-size: 0.78rem; color: #a0a4be; margin-top: 2px; }
        .setting-status { font-size: 0.75rem; margin-top: 4px; }
        .status-ok { color: #4ade80; }
        .status-none { color: #a0a4be; }
        .setting-controls { display: flex; gap: 8px; align-items: center; }
        .key-input { flex: 1; padding: 8px 12px; background: #0d0e16; border: 1px solid #25273a;
                     border-radius: 8px; color: #e2e4f0; font-size: 0.82rem; font-family: monospace; }
        .btn { padding: 6px 16px; border-radius: 8px; border: 1px solid #25273a; background: #1a1c2a;
               color: #e2e4f0; cursor: pointer; font-size: 0.82rem; }
        .btn-primary { background: #4ade80; color: #000; border: none; font-weight: 600; }
        .btn-small { padding: 6px 12px; font-size: 0.78rem; }
        .btn:disabled { opacity: 0.5; cursor: wait; }
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
      ${mealsSettingsHTML}
    `;

    this.shadowRoot.querySelectorAll(".toggle-track").forEach(el => {
      el.addEventListener("click", () => this._toggle(el.dataset.module));
    });

    const saveBtn = this.shadowRoot.getElementById("save-key-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => this._saveApiKey());
    }
  }
}
customElements.define("ps-admin-modules", PsAdminModules);
