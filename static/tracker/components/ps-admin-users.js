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
      eventBus.on("user:changed", () => this.render()),
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
        .tags-row {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          align-items: center;
          margin: 6px 0;
        }
        .tag-pill {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 0.68rem;
          background: rgba(102, 217, 239, 0.1);
          color: var(--accent);
          border: 1px solid rgba(102, 217, 239, 0.2);
        }
        .tag-remove {
          cursor: pointer;
          font-size: 0.8rem;
          opacity: 0.7;
          background: none;
          border: none;
          color: inherit;
          padding: 0 2px;
          line-height: 1;
        }
        .tag-remove:hover { opacity: 1; }
        .tag-add-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px; height: 22px;
          border-radius: 999px;
          border: 1px dashed rgba(102, 217, 239, 0.3);
          background: transparent;
          color: var(--accent);
          font-size: 0.8rem;
          cursor: pointer;
        }
        .tag-add-btn:hover { background: rgba(102, 217, 239, 0.08); }
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
                <span class="user-role">${u.role === "parent" ? "Parent" : u.role === "pet" ? "Pet" : "Kid"}</span>
              </div>
              <div class="balances">
                ${currencies.map((c) => `
                  <div class="balance-item">
                    <span class="balance-val">${tracker.formatAmount(tracker.getBalance(u.id, c.id), c.id)}</span>
                    <span class="balance-label">${c.name}</span>
                  </div>
                `).join("")}
              </div>
              <div class="tags-row">
                ${(u.tags || []).map(tag => `
                  <span class="tag-pill">${tag}<button class="tag-remove" data-tag-user="${u.id}" data-tag="${tag}">×</button></span>
                `).join("")}
                <button class="tag-add-btn" data-add-tag="${u.id}" title="Add tag">+</button>
              </div>
              <div class="user-actions">
                <select class="role-select" data-role-select="${u.id}" style="background:#0d0e16;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:5px 8px;font-size:0.78rem;color:var(--text);font-family:inherit;cursor:pointer;">
                  <option value="parent" ${u.role === "parent" ? "selected" : ""}>Parent</option>
                  <option value="kid" ${u.role === "kid" ? "selected" : ""}>Kid</option>
                  <option value="pet" ${u.role === "pet" ? "selected" : ""}>Pet</option>
                </select>
                <button class="btn btn-sm btn-ghost" data-adjust="${u.id}">Adjust Balance</button>
                <button class="btn btn-sm btn-ghost" data-reset-daily="${u.id}">Reset Daily Tasks</button>
                <button class="btn btn-sm btn-ghost" data-rename="${u.id}">Rename</button>
                ${u.role !== "parent" ? `<button class="btn btn-sm btn-ghost" data-delete="${u.id}" style="color:var(--danger)">Delete</button>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;

    this.shadowRoot.getElementById("add-user")?.addEventListener("click", async () => {
      const name = prompt("Enter user name:");
      if (!name?.trim()) return;

      try {
        // Add to auth system
        const res = await fetch("/api/auth/add-member", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: name.trim(), isAdmin: false }),
        });
        const data = await res.json();
        const memberId = data.id || tracker.uid();

        // Add to users table via API
        await tracker.createUser({
          id: memberId,
          name: name.trim(),
          role: "kid",
          tags: [],
        });
        this.render();
      } catch (e) {
        console.error("Failed to add user:", e);
        alert("Failed to add user. Please try again.");
      }
    });

    this.shadowRoot.querySelectorAll("[data-role-select]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const u = trackerStore.users.data.find((x) => x.id === sel.dataset.roleSelect);
        if (!u) return;
        const newRole = sel.value;
        // Don't let last parent lose parent role
        if (u.role === "parent" && newRole !== "parent") {
          const parentCount = trackerStore.users.data.filter((x) => x.role === "parent").length;
          if (parentCount <= 1) {
            alert("Can't remove the last parent.");
            sel.value = u.role;
            return;
          }
        }
        await tracker.updateUser(u.id, { role: newRole });
        // Sync isAdmin to server auth system
        try {
          await fetch(`/api/auth/member/${encodeURIComponent(u.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isAdmin: newRole === "parent" }),
          });
        } catch (e) { /* best-effort */ }
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-adjust]").forEach((btn) => {
      btn.addEventListener("click", async () => {
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

        await tracker.adjustBalance(userId, curr.id, amount);
        eventBus.emit("toast:show", { message: `Adjusted ${curr.name} by ${amount}`, type: "success" });
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-reset-daily]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const u = trackerStore.users.data.find((x) => x.id === btn.dataset.resetDaily);
        if (!u) return;
        if (!confirm(`Reset all of ${u.name}'s daily tasks for today? This will undo completions and reverse any earned rewards.`)) return;
        const count = await tracker.resetDailyTasks(u.id);
        eventBus.emit("toast:show", {
          message: count > 0 ? `Reset ${count} completion${count !== 1 ? "s" : ""} for ${u.name}.` : `No daily completions to reset for ${u.name} today.`,
          type: count > 0 ? "success" : "warning",
        });
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-rename]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const u = trackerStore.users.data.find((x) => x.id === btn.dataset.rename);
        if (!u) return;
        const name = prompt("New name:", u.name);
        if (!name?.trim()) return;
        await tracker.updateUser(u.id, { name: name.trim() });
        this.render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this user? This cannot be undone.")) return;
        await tracker.deleteUser(btn.dataset.delete);
        this.render();
      });
    });

    // Tag management
    this.shadowRoot.querySelectorAll("[data-add-tag]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.addTag;
        const u = trackerStore.users.data.find((x) => x.id === userId);
        if (!u) return;
        // Collect all existing tags for suggestions
        const allTags = [...new Set(trackerStore.users.data.flatMap((x) => x.tags || []))];
        const unusedTags = allTags.filter((t) => !(u.tags || []).includes(t));
        let hint = "Enter a tag name:";
        if (unusedTags.length > 0) hint += `\n\nExisting tags: ${unusedTags.join(", ")}`;
        const tag = prompt(hint);
        if (!tag?.trim()) return;
        const currentTags = u.tags || [];
        const trimmed = tag.trim().toLowerCase();
        if (!currentTags.includes(trimmed)) {
          await tracker.updateUser(userId, { tags: [...currentTags, trimmed] });
          this.render();
        }
      });
    });

    this.shadowRoot.querySelectorAll("[data-tag-user]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.tagUser;
        const tag = btn.dataset.tag;
        const u = trackerStore.users.data.find((x) => x.id === userId);
        if (!u || !u.tags) return;
        await tracker.updateUser(userId, { tags: u.tags.filter((t) => t !== tag) });
        this.render();
      });
    });
  }
}

customElements.define("ps-admin-users", PsAdminUsers);
