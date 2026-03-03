// ps-setup-wizard: First-run wizard - set admin user + first currency
class PsSetupWizard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._step = 1; // 1 = admin, 2 = currency
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const CSS = tracker.TRACKER_CSS;
    if (this._step === 1) {
      this.shadowRoot.innerHTML = `
        <style>${CSS}
          .wizard { max-width: 420px; margin: 0 auto; }
          .step-indicator { font-size: 0.72rem; color: var(--muted); margin-bottom: 12px; }
          h2 { font-size: 1.1rem; margin: 0 0 4px; color: var(--accent); }
          p { font-size: 0.84rem; color: var(--muted); margin: 0 0 16px; }
        </style>
        <div class="panel wizard">
          <div class="step-indicator">Step 1 of 2</div>
          <h2>Welcome to ParentSlop</h2>
          <p>Let's set up an admin (parent) account to manage tasks and rewards.</p>
          <div class="form-group">
            <label>Your name</label>
            <input type="text" id="admin-name" placeholder="e.g. Mom, Dad, Parent" autofocus />
          </div>
          <div class="form-actions">
            <button class="btn" id="next-btn">Next</button>
          </div>
        </div>
      `;
      const input = this.shadowRoot.getElementById("admin-name");
      const btn = this.shadowRoot.getElementById("next-btn");
      const go = () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        this._adminName = name;
        this._step = 2;
        this.render();
      };
      btn.addEventListener("click", go);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    } else {
      this.shadowRoot.innerHTML = `
        <style>${tracker.TRACKER_CSS}
          .wizard { max-width: 420px; margin: 0 auto; }
          .step-indicator { font-size: 0.72rem; color: var(--muted); margin-bottom: 12px; }
          h2 { font-size: 1.1rem; margin: 0 0 4px; color: var(--accent); }
          p { font-size: 0.84rem; color: var(--muted); margin: 0 0 16px; }
          .preview { padding: 10px 14px; border-radius: var(--radius-md); background: #0d0e16; border: 1px solid var(--border-subtle); margin-bottom: 16px; }
          .preview-val { font-size: 1.2rem; font-weight: 600; color: var(--accent); }
        </style>
        <div class="panel wizard">
          <div class="step-indicator">Step 2 of 2</div>
          <h2>Create your first currency</h2>
          <p>Kids earn this for completing tasks. You can add more currencies later.</p>
          <div class="form-row">
            <div class="form-group" style="flex:2">
              <label>Currency name</label>
              <input type="text" id="curr-name" placeholder="e.g. Stars, Coins, Dollars" />
            </div>
            <div class="form-group" style="flex:1">
              <label>Symbol</label>
              <input type="text" id="curr-symbol" placeholder="e.g. ⭐ $" maxlength="4" />
            </div>
          </div>
          <div class="form-group">
            <label>Decimal places (0 for whole numbers, 2 for dollars)</label>
            <select id="curr-decimals">
              <option value="0" selected>0 (Stars, Coins, Points)</option>
              <option value="2">2 (Dollars, Euros)</option>
            </select>
          </div>
          <div class="preview">
            <div class="text-muted" style="font-size:0.72rem;margin-bottom:4px;">Preview</div>
            <div class="preview-val" id="preview">⭐ 100</div>
          </div>
          <div class="form-actions">
            <button class="btn btn-ghost" id="back-btn">Back</button>
            <button class="btn" id="finish-btn">Finish Setup</button>
          </div>
        </div>
      `;
      const nameInput = this.shadowRoot.getElementById("curr-name");
      const symInput = this.shadowRoot.getElementById("curr-symbol");
      const decSelect = this.shadowRoot.getElementById("curr-decimals");
      const preview = this.shadowRoot.getElementById("preview");

      const updatePreview = () => {
        const sym = symInput.value || "⭐";
        const dec = parseInt(decSelect.value) || 0;
        preview.textContent = `${sym}${(100).toFixed(dec)}`;
      };
      nameInput.addEventListener("input", updatePreview);
      symInput.addEventListener("input", updatePreview);
      decSelect.addEventListener("change", updatePreview);

      this.shadowRoot.getElementById("back-btn").addEventListener("click", () => {
        this._step = 1;
        this.render();
      });

      this.shadowRoot.getElementById("finish-btn").addEventListener("click", () => {
        const currName = nameInput.value.trim() || "Stars";
        const currSymbol = symInput.value.trim() || "⭐";
        const currDecimals = parseInt(decSelect.value) || 0;
        this._finishSetup(currName, currSymbol, currDecimals);
      });

      nameInput.focus();
    }
  }

  _finishSetup(currName, currSymbol, currDecimals = 0) {
    // Create admin user
    const users = trackerStore.users.data;
    const admin = {
      id: tracker.uid(),
      name: this._adminName,
      isAdmin: true,
      balances: {},
      createdAt: tracker.now(),
    };
    users.push(admin);
    trackerStore.users.save();

    // Create first currency
    tracker.createCurrency(currName, currSymbol, currDecimals, "#66d9ef");

    // Mark setup complete and set current user
    const app = trackerStore.app.data;
    app.setupComplete = true;
    app.currentUserId = admin.id;
    app.currentView = "dashboard";
    trackerStore.app.save();

    eventBus.emit("setup:complete", { admin });
  }
}

customElements.define("ps-setup-wizard", PsSetupWizard);
