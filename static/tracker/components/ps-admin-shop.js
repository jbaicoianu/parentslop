// ps-admin-shop: Admin shop item CRUD
class PsAdminShop extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._editing = null;
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("shop:changed", () => { if (!this._editing) this.render(); }),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    const items = trackerStore.shop.data.filter((s) => !s.archived);
    const currencies = trackerStore.currencies.data;

    if (this._editing !== null) {
      this._renderForm();
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .item-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 6px;
        }
        .item-info { flex: 1; min-width: 0; }
        .item-name { font-size: 0.88rem; font-weight: 500; }
        .item-meta { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
        .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      </style>
      <div class="panel">
        <div class="toolbar">
          <div>
            <div class="panel-title">Shop Items</div>
            <div class="panel-subtitle">${items.length} reward${items.length !== 1 ? "s" : ""} available</div>
          </div>
          <button class="btn btn-sm" id="add-item">+ Reward</button>
        </div>

        ${items.map((item) => `
          <div class="item-row">
            <div class="item-info">
              <div class="item-name">${item.name}</div>
              <div class="item-meta">
                Cost: ${Object.entries(item.costs || {}).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(" + ") || "Free"}
                ${item.description ? ` · ${item.description}` : ""}
              </div>
            </div>
            <button class="btn btn-sm btn-ghost" data-edit="${item.id}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-archive="${item.id}" style="color:var(--danger)">×</button>
          </div>
        `).join("")}

        ${items.length === 0 ? `
          <div class="empty-state">
            <strong>No shop items.</strong> Add rewards that kids can buy with their earnings.
          </div>
        ` : ""}
      </div>
    `;

    this.shadowRoot.getElementById("add-item")?.addEventListener("click", () => {
      this._editing = "new";
      this.render();
    });

    this.shadowRoot.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => { this._editing = btn.dataset.edit; this.render(); });
    });

    this.shadowRoot.querySelectorAll("[data-archive]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm("Remove this shop item?")) {
          await tracker.updateShopItem(btn.dataset.archive, { archived: true });
        }
      });
    });
  }

  _renderForm() {
    const currencies = trackerStore.currencies.data;
    const isNew = this._editing === "new";
    const item = isNew ? null : trackerStore.shop.data.find((s) => s.id === this._editing);

    const name = item?.name || "";
    const description = item?.description || "";
    const costs = item?.costs || {};

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        h3 { font-size: 1rem; margin: 0 0 14px; color: var(--accent); }
        .cost-row {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 6px;
        }
        .cost-row .currency-name {
          font-size: 0.82rem;
          min-width: 80px;
          color: var(--muted);
        }
        .cost-row input {
          width: 100px;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          font-size: 0.84rem;
          color: var(--text);
          font-family: inherit;
        }
        .section-label {
          font-size: 0.75rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin: 14px 0 8px;
        }
      </style>
      <div class="panel">
        <h3>${isNew ? "New Reward" : "Edit Reward"}</h3>

        <div class="form-group">
          <label>Name</label>
          <input type="text" id="f-name" value="${name}" placeholder="e.g. 30 min screen time" />
        </div>

        <div class="form-group">
          <label>Description (optional)</label>
          <input type="text" id="f-desc" value="${description}" />
        </div>

        <div class="section-label">Cost</div>
        ${currencies.map((c) => {
          const val = costs[c.id] != null ? costs[c.id] : "";
          const step = c.decimals > 0 ? (1 / Math.pow(10, c.decimals)) : "1";
          return `
          <div class="cost-row">
            <span class="currency-name">${c.symbol} ${c.name}</span>
            <input type="number" data-currency="${c.id}" value="${val}" placeholder="0" min="0" step="${step}" />
          </div>
        `; }).join("")}

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

      const description = s.getElementById("f-desc").value.trim();
      const costs = {};
      s.querySelectorAll("[data-currency]").forEach((inp) => {
        const val = parseFloat(inp.value);
        if (!isNaN(val) && val > 0) costs[inp.dataset.currency] = val;
      });

      if (this._editing === "new") {
        await tracker.createShopItem({ name, description, costs });
      } else {
        await tracker.updateShopItem(this._editing, { name, description, costs });
      }

      this._editing = null;
      this.render();
    });
  }
}

customElements.define("ps-admin-shop", PsAdminShop);
