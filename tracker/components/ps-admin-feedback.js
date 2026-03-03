// ps-admin-feedback: Admin view for reviewing and completing user feedback
class PsAdminFeedback extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._feedback = [];
    this._loading = true;
    this._showCompleted = false;
    this._completingId = null; // which item is showing the note input
  }

  connectedCallback() {
    this.render();
    this._fetchFeedback();
  }

  async _fetchFeedback() {
    try {
      const res = await fetch("/api/feedback");
      if (!res.ok) throw new Error("Failed to fetch");
      this._feedback = await res.json();
    } catch (e) {
      console.error("Feedback fetch failed:", e);
      this._feedback = [];
    }
    this._loading = false;
    this.render();
  }

  async _completeWithNote(id, note) {
    try {
      const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true, note: note || "" }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const item = this._feedback.find((f) => f.id === id);
      if (item) {
        item.completed_at = new Date().toISOString();
        item.resolution_note = note || null;
      }
      this._completingId = null;
      this.render();
    } catch (e) {
      console.error("Feedback update failed:", e);
      eventBus.emit("toast:show", { message: "Failed to update feedback", type: "danger" });
    }
  }

  async _reopen(id) {
    try {
      const res = await fetch(`/api/feedback/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: false }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const item = this._feedback.find((f) => f.id === id);
      if (item) {
        item.completed_at = null;
        item.resolution_note = null;
      }
      this.render();
    } catch (e) {
      console.error("Feedback update failed:", e);
      eventBus.emit("toast:show", { message: "Failed to update feedback", type: "danger" });
    }
  }

  render() {
    const open = this._feedback.filter((f) => !f.completed_at);
    const completed = this._feedback.filter((f) => f.completed_at);

    const timeAgo = (iso) => {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      return `${days}d ago`;
    };

    const renderItem = (f) => {
      const isCompleted = !!f.completed_at;
      const isCompleting = this._completingId === f.id;
      return `
        <div class="fb-card${isCompleted ? " fb-completed" : ""}">
          <div class="fb-header">
            <div class="fb-meta">
              <span class="fb-user">${f.user_name || "Anonymous"}</span>
              <span class="fb-time">${timeAgo(f.created_at)}</span>
              ${f.current_view ? `<span class="fb-view">${f.current_view}</span>` : ""}
            </div>
            ${isCompleted ? `
              <button class="btn btn-sm btn-ghost" data-reopen-id="${f.id}">Reopen</button>
            ` : isCompleting ? "" : `
              <button class="btn btn-sm btn-success" data-start-complete="${f.id}">Done</button>
            `}
          </div>
          <div class="fb-text">${this._escapeHtml(f.text)}</div>
          ${isCompleting ? `
            <div class="fb-resolve">
              <textarea class="fb-note-input" data-note-id="${f.id}" placeholder="What was done? (required)" rows="2"></textarea>
              <div class="fb-resolve-actions">
                <button class="btn btn-sm btn-ghost" data-cancel-complete="${f.id}">Cancel</button>
                <button class="btn btn-sm btn-success" data-confirm-complete="${f.id}">Complete</button>
              </div>
            </div>
          ` : ""}
          ${isCompleted && f.resolution_note ? `
            <div class="fb-resolution">
              <span class="fb-resolution-label">Resolution:</span> ${this._escapeHtml(f.resolution_note)}
            </div>
          ` : ""}
          ${isCompleted ? `<div class="fb-completed-at">Completed ${timeAgo(f.completed_at)}</div>` : ""}
        </div>
      `;
    };

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        .fb-card {
          border-radius: var(--radius-md);
          padding: 12px 14px;
          background: linear-gradient(145deg, #181926, #10111b);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 8px;
        }
        .fb-card.fb-completed {
          opacity: 0.5;
          border-color: rgba(80, 250, 123, 0.1);
        }
        .fb-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          gap: 8px;
        }
        .fb-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          flex: 1;
          min-width: 0;
        }
        .fb-user {
          font-size: 0.82rem;
          font-weight: 600;
          color: var(--text);
        }
        .fb-time {
          font-size: 0.68rem;
          color: var(--muted);
          opacity: 0.7;
        }
        .fb-view {
          font-size: 0.65rem;
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(102, 217, 239, 0.08);
          color: var(--accent);
          border: 1px solid rgba(102, 217, 239, 0.12);
        }
        .fb-text {
          font-size: 0.85rem;
          color: var(--text);
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .fb-resolve {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border-subtle);
        }
        .fb-note-input {
          width: 100%;
          padding: 8px 10px;
          font-size: 0.82rem;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          color: var(--text);
          font-family: inherit;
          outline: none;
          resize: vertical;
          min-height: 48px;
        }
        .fb-note-input:focus { border-color: var(--accent); }
        .fb-resolve-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
          margin-top: 8px;
        }
        .fb-resolution {
          font-size: 0.78rem;
          color: var(--muted);
          margin-top: 8px;
          padding: 8px 10px;
          background: rgba(80, 250, 123, 0.04);
          border-radius: var(--radius-sm);
          border: 1px solid rgba(80, 250, 123, 0.08);
          line-height: 1.4;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .fb-resolution-label {
          font-weight: 600;
          color: var(--success);
          opacity: 0.8;
        }
        .fb-completed-at {
          font-size: 0.68rem;
          color: var(--success);
          opacity: 0.7;
          margin-top: 6px;
        }
        .completed-toggle {
          appearance: none;
          border: none;
          background: transparent;
          color: var(--muted);
          font-size: 0.78rem;
          cursor: pointer;
          font-family: inherit;
          padding: 4px 0;
          transition: color 160ms;
        }
        .completed-toggle:hover { color: var(--text); }
        .section-divider {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 16px 0 10px;
        }
        .section-divider::before, .section-divider::after {
          content: "";
          flex: 1;
          height: 1px;
          background: var(--border-subtle);
        }
        .count-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 20px;
          height: 20px;
          padding: 0 6px;
          border-radius: 999px;
          font-size: 0.7rem;
          font-weight: 700;
          background: rgba(102, 217, 239, 0.15);
          color: var(--accent);
          border: 1px solid rgba(102, 217, 239, 0.2);
        }
      </style>
      <div class="panel">
        <div class="toolbar">
          <div>
            <div class="panel-title">Feedback</div>
            <div class="panel-subtitle">${open.length} open${completed.length > 0 ? ` · ${completed.length} completed` : ""}</div>
          </div>
          <button class="btn btn-sm btn-ghost" id="refresh-btn">Refresh</button>
        </div>

        ${this._loading ? `
          <div class="empty-state"><strong>Loading...</strong></div>
        ` : open.length === 0 && completed.length === 0 ? `
          <div class="empty-state"><strong>No feedback yet.</strong></div>
        ` : `
          ${open.length === 0 ? `
            <div class="empty-state"><strong>All caught up!</strong> No open feedback.</div>
          ` : open.map(renderItem).join("")}

          ${completed.length > 0 ? `
            <div class="section-divider">
              <button class="completed-toggle" id="toggle-completed">
                ${this._showCompleted ? "Hide" : "Show"} completed <span class="count-badge">${completed.length}</span>
              </button>
            </div>
            ${this._showCompleted ? completed.map(renderItem).join("") : ""}
          ` : ""}
        `}
      </div>
    `;

    // Bind "Done" → expand note input
    this.shadowRoot.querySelectorAll("[data-start-complete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._completingId = btn.dataset.startComplete;
        this.render();
        // Auto-focus the textarea
        const ta = this.shadowRoot.querySelector(`.fb-note-input[data-note-id="${this._completingId}"]`);
        if (ta) ta.focus();
      });
    });

    // Bind "Cancel"
    this.shadowRoot.querySelectorAll("[data-cancel-complete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._completingId = null;
        this.render();
      });
    });

    // Bind "Complete" → send with note
    this.shadowRoot.querySelectorAll("[data-confirm-complete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.confirmComplete;
        const ta = this.shadowRoot.querySelector(`.fb-note-input[data-note-id="${id}"]`);
        const note = ta?.value?.trim() || "";
        if (!note) {
          ta?.focus();
          ta?.classList.add("shake");
          setTimeout(() => ta?.classList.remove("shake"), 400);
          return;
        }
        this._completeWithNote(id, note);
      });
    });

    // Bind "Reopen"
    this.shadowRoot.querySelectorAll("[data-reopen-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._reopen(btn.dataset.reopenId);
      });
    });

    // Bind refresh
    this.shadowRoot.getElementById("refresh-btn")?.addEventListener("click", () => {
      this._loading = true;
      this.render();
      this._fetchFeedback();
    });

    // Bind completed toggle
    this.shadowRoot.getElementById("toggle-completed")?.addEventListener("click", () => {
      this._showCompleted = !this._showCompleted;
      this.render();
    });
  }

  _escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

customElements.define("ps-admin-feedback", PsAdminFeedback);
