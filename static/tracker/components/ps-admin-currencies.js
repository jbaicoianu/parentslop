// ps-admin-currencies: Admin currency CRUD
class PsAdminCurrencies extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._editing = null;
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(eventBus.on("currencies:changed", () => { if (!this._editing) this.render(); }));
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    const currencies = trackerStore.currencies.data;

    if (this._editing !== null) {
      this._renderForm();
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .curr-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 6px;
        }
        .curr-symbol {
          font-size: 1.3rem;
          width: 36px;
          height: 36px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255,255,255,0.04);
        }
        .curr-info { flex: 1; }
        .curr-name { font-size: 0.88rem; font-weight: 500; }
        .curr-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      </style>
      <div class="panel">
        <div class="toolbar">
          <div>
            <div class="panel-title">Currencies</div>
            <div class="panel-subtitle">${currencies.length} currenc${currencies.length !== 1 ? "ies" : "y"}</div>
          </div>
          <button class="btn btn-sm" id="add-curr">+ Currency</button>
        </div>

        ${currencies.map((c) => `
          <div class="curr-row">
            <div class="curr-symbol" style="color:${c.color}">${c.symbol}</div>
            <div class="curr-info">
              <div class="curr-name">${c.name}</div>
              <div class="curr-meta">${c.decimals} decimal place${c.decimals !== 1 ? "s" : ""} · ${c.color}</div>
            </div>
            <button class="btn btn-sm btn-ghost" data-edit="${c.id}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-delete="${c.id}" style="color:var(--danger)">Delete</button>
          </div>
        `).join("")}

        ${currencies.length === 0 ? `
          <div class="empty-state">
            <strong>No currencies.</strong> Run setup again or add one.
          </div>
        ` : ""}
      </div>
    `;

    this.shadowRoot.getElementById("add-curr")?.addEventListener("click", () => {
      this._editing = "new";
      this.render();
    });

    this.shadowRoot.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => { this._editing = btn.dataset.edit; this.render(); });
    });

    this.shadowRoot.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const c = trackerStore.currencies.data.find((x) => x.id === btn.dataset.delete);
        if (!c) return;
        if (!confirm(`Delete currency "${c.name}"? Any tasks or shop items using it will lose their price/reward for this currency.`)) return;
        await tracker.deleteCurrency(btn.dataset.delete);
        this.render();
      });
    });
  }

  _renderForm() {
    const isNew = this._editing === "new";
    const curr = isNew ? null : trackerStore.currencies.data.find((c) => c.id === this._editing);

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        h3 { font-size: 1rem; margin: 0 0 14px; color: var(--accent); }
        .color-preview {
          width: 24px; height: 24px; border-radius: 6px;
          display: inline-block; vertical-align: middle;
        }
      </style>
      <div class="panel">
        <h3>${isNew ? "New Currency" : "Edit Currency"}</h3>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Name</label>
            <input type="text" id="f-name" value="${curr?.name || ""}" placeholder="Stars" />
          </div>
          <div class="form-group" style="flex:1">
            <label>Symbol</label>
            <input type="text" id="f-symbol" value="${curr?.symbol || ""}" placeholder="⭐" maxlength="4" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Decimal places</label>
            <select id="f-decimals">
              ${[0, 1, 2].map((d) => `<option value="${d}" ${(curr?.decimals ?? 0) === d ? "selected" : ""}>${d}</option>`).join("")}
            </select>
          </div>
          <div class="form-group">
            <label>Color</label>
            <input type="color" id="f-color" value="${curr?.color || "#66d9ef"}" />
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
          <button class="btn" id="save-btn">${isNew ? "Create" : "Save"}</button>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("cancel-btn").addEventListener("click", () => {
      this._editing = null;
      this.render();
    });

    this.shadowRoot.getElementById("save-btn").addEventListener("click", async () => {
      const s = this.shadowRoot;
      const name = s.getElementById("f-name").value.trim();
      if (!name) { s.getElementById("f-name").focus(); return; }
      const symbol = s.getElementById("f-symbol").value.trim() || "⭐";
      const decimals = parseInt(s.getElementById("f-decimals").value) || 0;
      const color = s.getElementById("f-color").value;

      if (isNew) {
        await tracker.createCurrency(name, symbol, decimals, color);
      } else {
        await tracker.updateCurrency(this._editing, { name, symbol, decimals, color });
      }
      this._editing = null;
      this.render();
    });
  }
}

customElements.define("ps-admin-currencies", PsAdminCurrencies);
