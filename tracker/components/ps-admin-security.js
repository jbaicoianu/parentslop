// ps-admin-security: Auth level config, credential management, family password
class PsAdminSecurity extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._authData = null;
    this._loading = true;
  }

  connectedCallback() {
    this._fetchAuthData();
  }

  async _fetchAuthData() {
    this._loading = true;
    this.render();
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      if (data.authenticated) {
        this._authData = data;
      }
    } catch (e) {
      console.warn("Failed to fetch auth data:", e);
    }
    this._loading = false;
    this.render();
  }

  render() {
    if (this._loading) {
      this.shadowRoot.innerHTML = `
        <style>${tracker.TRACKER_CSS}</style>
        <div class="panel">
          <div class="panel-title">Security</div>
          <div class="text-muted" style="font-size:0.84rem;margin-top:8px;">Loading...</div>
        </div>
      `;
      return;
    }

    const data = this._authData;
    if (!data) {
      this.shadowRoot.innerHTML = `
        <style>${tracker.TRACKER_CSS}</style>
        <div class="panel">
          <div class="panel-title">Security</div>
          <div class="text-muted" style="font-size:0.84rem;margin-top:8px;">Failed to load auth data.</div>
        </div>
      `;
      return;
    }

    const family = data.family;
    const members = data.members || [];
    const authLevel = family.authLevel || "none";

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .section {
          margin-bottom: 20px;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .section:last-child { border-bottom: none; }
        .section-title {
          font-size: 0.82rem;
          color: var(--accent);
          font-weight: 600;
          margin-bottom: 8px;
        }
        .radio-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .radio-option {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: background 120ms;
        }
        .radio-option:hover { background: rgba(255, 255, 255, 0.03); }
        .radio-option input { accent-color: var(--accent); }
        .radio-option label { font-size: 0.84rem; cursor: pointer; }
        .radio-option .radio-desc { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
        .member-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.03);
        }
        .member-row:last-child { border-bottom: none; }
        .member-name { font-size: 0.88rem; flex: 1; }
        .cred-status {
          font-size: 0.72rem;
          padding: 2px 8px;
          border-radius: 999px;
        }
        .cred-set {
          background: rgba(80, 250, 123, 0.1);
          color: var(--success);
          border: 1px solid rgba(80, 250, 123, 0.15);
        }
        .cred-unset {
          background: rgba(255, 255, 255, 0.04);
          color: var(--muted);
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .success-msg {
          padding: 8px 12px;
          border-radius: var(--radius-sm);
          background: rgba(80, 250, 123, 0.1);
          border: 1px solid rgba(80, 250, 123, 0.2);
          color: var(--success);
          font-size: 0.82rem;
          margin-bottom: 12px;
        }
        .error-msg {
          padding: 8px 12px;
          border-radius: var(--radius-sm);
          background: rgba(255, 107, 129, 0.1);
          border: 1px solid rgba(255, 107, 129, 0.2);
          color: var(--danger);
          font-size: 0.82rem;
          margin-bottom: 12px;
        }
      </style>
      <div class="panel">
        <div class="panel-title">Security Settings</div>
        <div class="panel-subtitle">${family.name}</div>

        ${this._successMsg ? `<div class="success-msg mt-3">${this._successMsg}</div>` : ""}
        ${this._errorMsg ? `<div class="error-msg mt-3">${this._errorMsg}</div>` : ""}

        <div class="section mt-3">
          <div class="section-title">User Authentication Level</div>
          <div class="radio-group">
            <div class="radio-option">
              <input type="radio" name="auth-level" id="auth-none" value="none" ${authLevel === "none" ? "checked" : ""} />
              <div>
                <label for="auth-none">None</label>
                <div class="radio-desc">Users tap their name to log in. No credentials needed.</div>
              </div>
            </div>
            <div class="radio-option">
              <input type="radio" name="auth-level" id="auth-pin" value="pin" ${authLevel === "pin" ? "checked" : ""} />
              <div>
                <label for="auth-pin">PIN</label>
                <div class="radio-desc">Users enter a 4-digit PIN after selecting their name.</div>
              </div>
            </div>
            <div class="radio-option">
              <input type="radio" name="auth-level" id="auth-password" value="password" ${authLevel === "password" ? "checked" : ""} />
              <div>
                <label for="auth-password">Password</label>
                <div class="radio-desc">Users enter a password after selecting their name.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Member Credentials</div>
          ${members.map((m) => `
            <div class="member-row">
              <div class="member-name">${m.displayName} ${m.isAdmin ? "(Parent)" : ""}</div>
              ${authLevel === "pin" ? `
                <span class="cred-status ${m.hasPin ? "cred-set" : "cred-unset"}">${m.hasPin ? "PIN set" : "No PIN"}</span>
                <button class="btn btn-sm btn-ghost" data-set-pin="${m.id}">${m.hasPin ? "Change" : "Set"} PIN</button>
              ` : ""}
              ${authLevel === "password" ? `
                <span class="cred-status ${m.hasPassword ? "cred-set" : "cred-unset"}">${m.hasPassword ? "Password set" : "No password"}</span>
                <button class="btn btn-sm btn-ghost" data-set-member-pw="${m.id}">${m.hasPassword ? "Change" : "Set"} Password</button>
              ` : ""}
              ${authLevel === "none" ? `
                <span class="cred-status cred-unset">No auth required</span>
              ` : ""}
            </div>
          `).join("")}
        </div>

        <div class="section">
          <div class="section-title">Family Password</div>
          <p style="font-size:0.8rem;color:var(--muted);margin:0 0 10px;">Change the password used to log in to this family account.</p>
          <div class="form-group">
            <label>New Password</label>
            <input type="password" id="new-family-pw" placeholder="New family password" />
          </div>
          <div class="form-group">
            <label>Confirm Password</label>
            <input type="password" id="confirm-family-pw" placeholder="Confirm password" />
          </div>
          <button class="btn btn-sm" id="change-family-pw-btn">Change Family Password</button>
        </div>
      </div>
    `;

    // Auth level change
    this.shadowRoot.querySelectorAll('input[name="auth-level"]').forEach((radio) => {
      radio.addEventListener("change", async () => {
        try {
          const res = await fetch("/api/auth/set-auth-level", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ authLevel: radio.value }),
          });
          if (res.ok) {
            this._successMsg = `Auth level changed to "${radio.value}"`;
            this._errorMsg = null;
            await this._fetchAuthData();
          } else {
            const data = await res.json();
            this._errorMsg = data.error || "Failed to change auth level";
          }
        } catch (e) {
          this._errorMsg = "Network error";
        }
        this.render();
      });
    });

    // Set PIN
    this.shadowRoot.querySelectorAll("[data-set-pin]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pin = prompt("Enter a 4-digit PIN:");
        if (!pin) return;
        if (!/^\d{4}$/.test(pin)) {
          alert("PIN must be exactly 4 digits.");
          return;
        }
        try {
          const res = await fetch("/api/auth/set-pin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memberId: btn.dataset.setPin, pin }),
          });
          if (res.ok) {
            this._successMsg = "PIN updated";
            this._errorMsg = null;
            await this._fetchAuthData();
          } else {
            const data = await res.json();
            this._errorMsg = data.error || "Failed to set PIN";
            this.render();
          }
        } catch (e) {
          this._errorMsg = "Network error";
          this.render();
        }
      });
    });

    // Set member password
    this.shadowRoot.querySelectorAll("[data-set-member-pw]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const password = prompt("Enter a password for this member:");
        if (!password) return;
        try {
          const res = await fetch("/api/auth/set-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ memberId: btn.dataset.setMemberPw, password }),
          });
          if (res.ok) {
            this._successMsg = "Member password updated";
            this._errorMsg = null;
            await this._fetchAuthData();
          } else {
            const data = await res.json();
            this._errorMsg = data.error || "Failed to set password";
            this.render();
          }
        } catch (e) {
          this._errorMsg = "Network error";
          this.render();
        }
      });
    });

    // Change family password
    this.shadowRoot.getElementById("change-family-pw-btn")?.addEventListener("click", async () => {
      const newPw = this.shadowRoot.getElementById("new-family-pw")?.value;
      const confirmPw = this.shadowRoot.getElementById("confirm-family-pw")?.value;
      if (!newPw) { this._errorMsg = "Password required"; this.render(); return; }
      if (newPw !== confirmPw) { this._errorMsg = "Passwords don't match"; this.render(); return; }

      try {
        const res = await fetch("/api/auth/change-family-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword: newPw }),
        });
        if (res.ok) {
          this._successMsg = "Family password changed";
          this._errorMsg = null;
          this.shadowRoot.getElementById("new-family-pw").value = "";
          this.shadowRoot.getElementById("confirm-family-pw").value = "";
          this.render();
        } else {
          const data = await res.json();
          this._errorMsg = data.error || "Failed to change password";
          this.render();
        }
      } catch (e) {
        this._errorMsg = "Network error";
        this.render();
      }
    });
  }
}

customElements.define("ps-admin-security", PsAdminSecurity);
