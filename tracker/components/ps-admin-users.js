// ps-admin-users: Admin user management, permissions, manual balance adjustments
class PsAdminUsers extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("balances:changed", () => this.render()),
      eventBus.on("store:parentslop.users.v1", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
  }

  render() {
    const users = trackerStore.users.data;
    const currencies = trackerStore.currencies.data;

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .user-card {
          border-radius: var(--radius-lg);
          padding: 14px;
          background: linear-gradient(145deg, #181926, #10111b);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 8px;
        }
        .user-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .user-avatar {
          width: 32px; height: 32px;
          border-radius: 10px;
          background: radial-gradient(circle at 30% 0%, #ffffff20, #66d9ef40);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--accent);
        }
        .user-name { font-size: 0.9rem; font-weight: 600; flex: 1; }
        .user-role {
          font-size: 0.68rem;
          padding: 2px 8px;
          border-radius: 999px;
          background: rgba(102, 217, 239, 0.1);
          color: var(--accent);
          border: 1px solid rgba(102, 217, 239, 0.15);
        }
        .balances {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin: 8px 0;
        }
        .balance-item {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.8rem;
        }
        .balance-val { font-weight: 600; color: var(--text); }
        .balance-label { color: var(--muted); font-size: 0.72rem; }
        .user-actions {
          display: flex;
          gap: 6px;
          margin-top: 8px;
          flex-wrap: wrap;
        }
        .toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
      </style>
      <div class="panel">
        <div class="toolbar">
          <div>
            <div class="panel-title">Users</div>
            <div class="panel-subtitle">${users.length} user${users.length !== 1 ? "s" : ""}</div>
          </div>
          <button class="btn btn-sm" id="add-user">+ User</button>
        </div>

        ${users.map((u) => {
          const initial = (u.name || "?").charAt(0).toUpperCase();
          return `
            <div class="user-card">
              <div class="user-header">
                <div class="user-avatar">${initial}</div>
                <div class="user-name">${u.name}</div>
                <span class="user-role">${u.isAdmin ? "Admin" : "Kid"}</span>
              </div>
              <div class="balances">
                ${currencies.map((c) => `
                  <div class="balance-item">
                    <span class="balance-val">${tracker.formatAmount(tracker.getBalance(u.id, c.id), c.id)}</span>
                    <span class="balance-label">${c.name}</span>
                  </div>
                `).join("")}
              </div>
              <div class="user-actions">
                <button class="btn btn-sm btn-ghost" data-toggle-admin="${u.id}">
                  ${u.isAdmin ? "Remove Admin" : "Make Admin"}
                </button>
                <button class="btn btn-sm btn-ghost" data-adjust="${u.id}">Adjust Balance</button>
                <button class="btn btn-sm btn-ghost" data-reset-daily="${u.id}">Reset Daily Tasks</button>
                <button class="btn btn-sm btn-ghost" data-rename="${u.id}">Rename</button>
                ${!u.isAdmin ? `<button class="btn btn-sm btn-ghost" data-delete="${u.id}" style="color:var(--danger)">Delete</button>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;

    this.shadowRoot.getElementById("add-user")?.addEventListener("click", () => {
      const name = prompt("Enter user name:");
      if (!name?.trim()) return;
      const users = trackerStore.users.data;
      users.push({
        id: tracker.uid(),
        name: name.trim(),
        isAdmin: false,
        balances: {},
        createdAt: tracker.now(),
      });
      trackerStore.users.save();
      this.render();
    });

    this.shadowRoot.querySelectorAll("[data-toggle-admin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = trackerStore.users.data.find((x) => x.id === btn.dataset.toggleAdmin);
        if (!u) return;
        // Don't let last admin remove their own admin
        const adminCount = trackerStore.users.data.filter((x) => x.isAdmin).length;
        if (u.isAdmin && adminCount <= 1) {
          alert("Can't remove the last admin.");
          return;
        }
        u.isAdmin = !u.isAdmin;
        trackerStore.users.save();
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-adjust]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const userId = btn.dataset.adjust;
        const currencies = trackerStore.currencies.data;
        if (currencies.length === 0) { alert("No currencies set up."); return; }

        const currNames = currencies.map((c, i) => `${i + 1}. ${c.symbol} ${c.name}`).join("\n");
        const choice = prompt(`Which currency?\n${currNames}\n\nEnter number:`);
        if (!choice) return;
        const idx = parseInt(choice) - 1;
        if (idx < 0 || idx >= currencies.length) { alert("Invalid."); return; }

        const curr = currencies[idx];
        const current = tracker.getBalance(userId, curr.id);
        const amountStr = prompt(`Current ${curr.name}: ${tracker.formatAmount(current, curr.id)}\n\nEnter adjustment (e.g. 5, -2.50):`);
        if (!amountStr) return;
        const amount = parseFloat(amountStr);
        if (isNaN(amount)) { alert("Invalid number."); return; }

        tracker.adjustBalance(userId, curr.id, amount);
        eventBus.emit("toast:show", { message: `Adjusted ${curr.name} by ${amount}`, type: "success" });
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-reset-daily]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = trackerStore.users.data.find((x) => x.id === btn.dataset.resetDaily);
        if (!u) return;
        if (!confirm(`Reset all of ${u.name}'s daily tasks for today? This will undo completions and reverse any earned rewards.`)) return;
        const count = tracker.resetDailyTasks(u.id);
        eventBus.emit("toast:show", {
          message: count > 0 ? `Reset ${count} completion${count !== 1 ? "s" : ""} for ${u.name}.` : `No daily completions to reset for ${u.name} today.`,
          type: count > 0 ? "success" : "warning",
        });
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-rename]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = trackerStore.users.data.find((x) => x.id === btn.dataset.rename);
        if (!u) return;
        const name = prompt("New name:", u.name);
        if (!name?.trim()) return;
        u.name = name.trim();
        trackerStore.users.save();
        eventBus.emit("balances:changed", { userId: u.id }); // triggers re-render elsewhere
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!confirm("Delete this user? This cannot be undone.")) return;
        const users = trackerStore.users.data;
        const idx = users.findIndex((u) => u.id === btn.dataset.delete);
        if (idx >= 0) {
          users.splice(idx, 1);
          trackerStore.users.save();
          this.render();
        }
      });
    });
  }
}

customElements.define("ps-admin-users", PsAdminUsers);
