// ps-auth-screen: Login, register, member selection
class PsAuthScreen extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._state = "choose"; // choose | register | login | select-member | set-password
    this._members = [];
    this._family = null;
    this._error = null;
    this._loading = false;
  }

  connectedCallback() {
    this.render();
  }

  setState(state, data = {}) {
    this._state = state;
    Object.assign(this, data);
    this._error = null;
    this.render();
  }

  showMemberSelection(family, members) {
    this._family = family;
    this._members = members;
    if (family.needsPasswordReset) {
      this._state = "set-password";
    } else {
      this._state = "select-member";
    }
    this._error = null;
    this.render();
  }

  render() {
    const CSS = tracker.TRACKER_CSS;
    const state = this._state;

    let content = "";

    if (state === "choose") {
      content = this._renderChoose();
    } else if (state === "register") {
      content = this._renderRegister();
    } else if (state === "login") {
      content = this._renderLogin();
    } else if (state === "select-member") {
      content = this._renderSelectMember();
    } else if (state === "set-password") {
      content = this._renderSetPassword();
    }

    this.shadowRoot.innerHTML = `
      <style>${CSS}
        .auth-panel {
          max-width: 420px;
          margin: 0 auto;
        }
        h2 { font-size: 1.1rem; margin: 0 0 4px; color: var(--accent); }
        p { font-size: 0.84rem; color: var(--muted); margin: 0 0 16px; }
        .error-msg {
          padding: 8px 12px;
          border-radius: var(--radius-sm);
          background: rgba(255, 107, 129, 0.1);
          border: 1px solid rgba(255, 107, 129, 0.2);
          color: var(--danger);
          font-size: 0.82rem;
          margin-bottom: 12px;
        }
        .choose-btns {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .choose-btn {
          appearance: none;
          border: none;
          border-radius: var(--radius-lg);
          padding: 18px 20px;
          background: linear-gradient(145deg, #181926, #10111b);
          border: 1px solid rgba(255, 255, 255, 0.05);
          cursor: pointer;
          text-align: left;
          transition: transform var(--transition-fast), border-color var(--transition-fast);
          font-family: inherit;
        }
        .choose-btn:hover {
          transform: translateY(-2px);
          border-color: var(--accent-soft);
        }
        .choose-btn .choose-title {
          font-size: 1rem;
          font-weight: 600;
          color: var(--text);
          margin-bottom: 4px;
        }
        .choose-btn .choose-desc {
          font-size: 0.8rem;
          color: var(--muted);
        }
        .member-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .member-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 12px;
          background: linear-gradient(145deg, #181926, #10111b);
          border: 1px solid rgba(255, 255, 255, 0.03);
          cursor: pointer;
          transition: background 160ms ease-out, border-color 160ms ease-out;
        }
        .member-row:hover {
          border-color: var(--accent-soft);
          background: linear-gradient(145deg, #1c1e30, #141524);
        }
        .member-avatar {
          width: 28px; height: 28px;
          border-radius: 8px;
          background: radial-gradient(circle at 30% 0%, #ffffff20, #66d9ef40);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--accent);
          flex-shrink: 0;
        }
        .member-name {
          font-size: 0.88rem;
          font-weight: 600;
          flex: 1;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .member-role {
          font-size: 0.68rem;
          color: var(--muted);
          flex-shrink: 0;
        }
        .pin-input {
          display: flex;
          gap: 8px;
          justify-content: center;
          margin: 16px 0;
        }
        .pin-dot {
          width: 14px; height: 14px;
          border-radius: 50%;
          border: 2px solid var(--border-subtle);
          background: transparent;
          transition: background 120ms;
        }
        .pin-dot.filled { background: var(--accent); border-color: var(--accent); }
        .pin-pad {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          max-width: 240px;
          margin: 0 auto;
        }
        .pin-key {
          appearance: none;
          border: none;
          border-radius: var(--radius-md);
          padding: 14px;
          font-size: 1.2rem;
          font-weight: 600;
          cursor: pointer;
          background: linear-gradient(145deg, #1a1c2e, #0e0f18);
          color: var(--text);
          border: 1px solid var(--border-subtle);
          font-family: inherit;
          transition: background 120ms;
        }
        .pin-key:hover { background: rgba(255, 255, 255, 0.06); }
        .pin-key:active { background: var(--accent-soft); }
        .pin-key.empty { visibility: hidden; }
        .back-link {
          font-size: 0.78rem;
          color: var(--muted);
          cursor: pointer;
          background: none;
          border: none;
          padding: 4px 0;
          font-family: inherit;
          margin-bottom: 12px;
        }
        .back-link:hover { color: var(--accent); }
        .loading { opacity: 0.6; pointer-events: none; }
        .logout-link {
          display: block;
          text-align: center;
          margin-top: 16px;
          font-size: 0.78rem;
          color: var(--muted);
          cursor: pointer;
          background: none;
          border: none;
          font-family: inherit;
        }
        .logout-link:hover { color: var(--danger); }
      </style>
      <div class="panel auth-panel ${this._loading ? "loading" : ""}">
        ${this._error ? `<div class="error-msg">${this._error}</div>` : ""}
        ${content}
      </div>
    `;

    this._attachListeners();
  }

  _renderChoose() {
    return `
      <h2>Welcome to ParentSlop</h2>
      <p>Log in to your family account or create a new one.</p>
      <div class="choose-btns">
        <button class="choose-btn" data-action="go-login">
          <div class="choose-title">Log In</div>
          <div class="choose-desc">Sign in with your family name and password</div>
        </button>
        <button class="choose-btn" data-action="go-register">
          <div class="choose-title">Create Family</div>
          <div class="choose-desc">Set up a new family account</div>
        </button>
      </div>
    `;
  }

  _renderRegister() {
    return `
      <button class="back-link" data-action="go-choose">&larr; Back</button>
      <h2>Create Your Family</h2>
      <p>Set up a family account. You'll be the parent.</p>
      <div class="form-group">
        <label>Family Name</label>
        <input type="text" id="reg-family" placeholder="e.g. The Smiths" autofocus />
      </div>
      <div class="form-group">
        <label>Your Name (Parent)</label>
        <input type="text" id="reg-name" placeholder="e.g. Mom, Dad" />
      </div>
      <div class="form-group">
        <label>Family Password</label>
        <input type="password" id="reg-password" placeholder="Choose a password" />
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input type="password" id="reg-confirm" placeholder="Confirm password" />
      </div>
      <div class="form-actions">
        <button class="btn" id="register-btn">Create Family</button>
      </div>
    `;
  }

  _renderLogin() {
    return `
      <button class="back-link" data-action="go-choose">&larr; Back</button>
      <h2>Log In</h2>
      <p>Enter your family name and password.</p>
      <div class="form-group">
        <label>Family Name</label>
        <input type="text" id="login-family" placeholder="e.g. The Smiths" autofocus />
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="login-password" placeholder="Family password" />
      </div>
      <div class="form-actions">
        <button class="btn" id="login-btn">Log In</button>
      </div>
    `;
  }

  _renderSelectMember() {
    const authLevel = this._family?.authLevel || "none";

    if (this._pendingMember) {
      // Show PIN pad or password field
      const member = this._pendingMember;
      if (authLevel === "pin") {
        return this._renderPinEntry(member);
      } else {
        return this._renderPasswordEntry(member);
      }
    }

    return `
      <h2>${this._family?.name || "Family"}</h2>
      <p>Who's using ParentSlop?</p>
      <div class="member-list">
        ${[...this._members].sort((a, b) => {
          const roleOrder = { parent: 0, kid: 1, pet: 2 };
          const rA = a.isAdmin ? "parent" : (trackerStore.users.data.find(u => u.id === a.id)?.role || "kid");
          const rB = b.isAdmin ? "parent" : (trackerStore.users.data.find(u => u.id === b.id)?.role || "kid");
          const orderDiff = (roleOrder[rA] ?? 1) - (roleOrder[rB] ?? 1);
          if (orderDiff !== 0) return orderDiff;
          return (a.displayName || "").localeCompare(b.displayName || "");
        }).map((m) => {
          const role = m.isAdmin ? "Parent" : (trackerStore.users.data.find(u => u.id === m.id)?.role === "pet" ? "Pet" : "Kid");
          const icon = m.isAdmin ? "⚙" : (role === "Pet" ? "🐾" : "");
          return `
          <div class="member-row" data-member-id="${m.id}">
            <div class="member-avatar">${(m.displayName || "?").charAt(0).toUpperCase()}</div>
            <div class="member-name">${m.displayName}${icon ? " " + icon : ""}</div>
            <div class="member-role">${role}</div>
          </div>
        `}).join("")}
      </div>
      <button class="logout-link" data-action="logout">Log out of this family</button>
    `;
  }

  _renderPinEntry(member) {
    const dots = Array.from({ length: 4 }, (_, i) =>
      `<div class="pin-dot ${i < (this._pinDigits?.length || 0) ? "filled" : ""}"></div>`
    ).join("");

    return `
      <button class="back-link" data-action="clear-member">&larr; Back</button>
      <h2 style="text-align:center">${member.displayName}</h2>
      <p style="text-align:center">Enter your 4-digit PIN</p>
      <div class="pin-input">${dots}</div>
      <div class="pin-pad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pin-key" data-pin="${n}">${n}</button>`).join("")}
        <button class="pin-key empty"></button>
        <button class="pin-key" data-pin="0">0</button>
        <button class="pin-key" data-pin="del">&larr;</button>
      </div>
    `;
  }

  _renderPasswordEntry(member) {
    return `
      <button class="back-link" data-action="clear-member">&larr; Back</button>
      <h2>${member.displayName}</h2>
      <p>Enter your password</p>
      <div class="form-group">
        <input type="password" id="member-password" placeholder="Password" autofocus />
      </div>
      <div class="form-actions">
        <button class="btn" id="member-login-btn">Continue</button>
      </div>
    `;
  }

  _renderSetPassword() {
    return `
      <h2>Set Family Password</h2>
      <p>Your data was migrated. Please set a new family password to secure your account.</p>
      <div class="form-group">
        <label>New Password</label>
        <input type="password" id="new-password" placeholder="Choose a password" autofocus />
      </div>
      <div class="form-group">
        <label>Confirm Password</label>
        <input type="password" id="confirm-password" placeholder="Confirm password" />
      </div>
      <div class="form-actions">
        <button class="btn" id="set-password-btn">Set Password</button>
      </div>
    `;
  }

  _attachListeners() {
    const s = this.shadowRoot;

    // Navigation
    s.querySelector('[data-action="go-login"]')?.addEventListener("click", () => this.setState("login"));
    s.querySelector('[data-action="go-register"]')?.addEventListener("click", () => this.setState("register"));
    s.querySelector('[data-action="go-choose"]')?.addEventListener("click", () => this.setState("choose"));
    s.querySelector('[data-action="clear-member"]')?.addEventListener("click", () => {
      this._pendingMember = null;
      this._pinDigits = "";
      this.render();
    });
    s.querySelector('[data-action="logout"]')?.addEventListener("click", () => this._logout());

    // Register
    s.getElementById("register-btn")?.addEventListener("click", () => this._register());
    s.getElementById("reg-confirm")?.addEventListener("keydown", (e) => { if (e.key === "Enter") this._register(); });

    // Login
    s.getElementById("login-btn")?.addEventListener("click", () => this._login());
    s.getElementById("login-password")?.addEventListener("keydown", (e) => { if (e.key === "Enter") this._login(); });

    // Member selection
    s.querySelectorAll("[data-member-id]").forEach((card) => {
      card.addEventListener("click", () => this._selectMember(card.dataset.memberId));
    });

    // PIN pad
    s.querySelectorAll("[data-pin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.pin;
        if (val === "del") {
          this._pinDigits = (this._pinDigits || "").slice(0, -1);
          this.render();
        } else {
          this._pinDigits = (this._pinDigits || "") + val;
          if (this._pinDigits.length >= 4) {
            this._submitMemberAuth(this._pendingMember.id, { pin: this._pinDigits });
          } else {
            this.render();
          }
        }
      });
    });

    // Member password
    s.getElementById("member-login-btn")?.addEventListener("click", () => {
      const pw = s.getElementById("member-password")?.value;
      if (!pw) return;
      this._submitMemberAuth(this._pendingMember.id, { password: pw });
    });
    s.getElementById("member-password")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const pw = s.getElementById("member-password")?.value;
        if (pw) this._submitMemberAuth(this._pendingMember.id, { password: pw });
      }
    });

    // Set password (migration)
    s.getElementById("set-password-btn")?.addEventListener("click", () => this._setFamilyPassword());
    s.getElementById("confirm-password")?.addEventListener("keydown", (e) => { if (e.key === "Enter") this._setFamilyPassword(); });
  }

  async _register() {
    const s = this.shadowRoot;
    const familyName = s.getElementById("reg-family")?.value?.trim();
    const adminName = s.getElementById("reg-name")?.value?.trim();
    const password = s.getElementById("reg-password")?.value;
    const confirm = s.getElementById("reg-confirm")?.value;

    if (!familyName || !adminName || !password) {
      this._error = "All fields are required";
      this.render();
      return;
    }
    if (password !== confirm) {
      this._error = "Passwords don't match";
      this.render();
      return;
    }
    if (password.length < 4) {
      this._error = "Password must be at least 4 characters";
      this.render();
      return;
    }

    this._loading = true;
    this.render();

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ familyName, adminName, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        this._error = data.error || "Registration failed";
        this._loading = false;
        this.render();
        return;
      }
      this._loading = false;
      this._emitComplete();
    } catch (err) {
      this._error = "Network error";
      this._loading = false;
      this.render();
    }
  }

  async _login() {
    const s = this.shadowRoot;
    const familyName = s.getElementById("login-family")?.value?.trim();
    const password = s.getElementById("login-password")?.value;

    if (!familyName || !password) {
      this._error = "Family name and password are required";
      this.render();
      return;
    }

    this._loading = true;
    this.render();

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ familyName, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        this._error = data.error || "Login failed";
        this._loading = false;
        this.render();
        return;
      }
      this._loading = false;

      // Fetch session state to get members
      await this._fetchMe();
    } catch (err) {
      this._error = "Network error";
      this._loading = false;
      this.render();
    }
  }

  async _fetchMe() {
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      if (!data.authenticated) {
        this.setState("choose");
        return null;
      }

      this._family = data.family;
      this._members = data.members;

      if (data.currentMember) {
        // Already has a member selected
        this._emitComplete();
        return data;
      }

      if (data.family.needsPasswordReset) {
        this._state = "set-password";
      } else {
        this._state = "select-member";
      }
      this.render();
      return data;
    } catch (err) {
      console.error("Failed to fetch auth state:", err);
      return null;
    }
  }

  async _selectMember(memberId) {
    const member = this._members.find((m) => m.id === memberId);
    if (!member) return;

    const authLevel = this._family?.authLevel || "none";

    if (authLevel === "none" || (authLevel === "pin" && !member.hasPin) || (authLevel === "password" && !member.hasPassword)) {
      // No credential check needed
      await this._submitMemberAuth(memberId, {});
    } else {
      // Show credential entry
      this._pendingMember = member;
      this._pinDigits = "";
      this.render();
    }
  }

  async _submitMemberAuth(memberId, credentials) {
    this._loading = true;
    this.render();

    try {
      const res = await fetch("/api/auth/select-member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId, ...credentials }),
      });
      const data = await res.json();
      if (!res.ok) {
        this._error = data.error || "Authentication failed";
        this._pinDigits = "";
        this._loading = false;
        this.render();
        return;
      }
      this._loading = false;
      this._pendingMember = null;
      this._pinDigits = "";
      this._emitComplete();
    } catch (err) {
      this._error = "Network error";
      this._pinDigits = "";
      this._loading = false;
      this.render();
    }
  }

  async _setFamilyPassword() {
    const s = this.shadowRoot;
    const newPassword = s.getElementById("new-password")?.value;
    const confirm = s.getElementById("confirm-password")?.value;

    if (!newPassword) {
      this._error = "Password is required";
      this.render();
      return;
    }
    if (newPassword !== confirm) {
      this._error = "Passwords don't match";
      this.render();
      return;
    }

    this._loading = true;
    this.render();

    try {
      const res = await fetch("/api/auth/change-family-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        this._error = data.error || "Failed to set password";
        this._loading = false;
        this.render();
        return;
      }
      this._loading = false;
      this._family.needsPasswordReset = false;
      this._state = "select-member";
      this.render();
    } catch (err) {
      this._error = "Network error";
      this._loading = false;
      this.render();
    }
  }

  async _logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) { /* ignore */ }

    // Clear localStorage
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("parentslop.")) keys.push(key);
    }
    keys.forEach((k) => localStorage.removeItem(k));

    this._family = null;
    this._members = [];
    this._pendingMember = null;
    this.setState("choose");
  }

  _emitComplete() {
    this.dispatchEvent(new CustomEvent("auth:complete", { bubbles: true, composed: true }));
  }
}

customElements.define("ps-auth-screen", PsAuthScreen);
