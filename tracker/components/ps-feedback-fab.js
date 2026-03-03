// ps-feedback-fab: Floating action button for quick feedback jots
class PsFeedbackFab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
    this._modalOpen = false;
    this._pressTimer = null;
    this._voiceMode = false;
    this._recognition = null;
    this._transcript = "";
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this._updateVisibility()),
      eventBus.on("nav:changed", () => this._updateVisibility()),
    );
    this.render();
    this._updateVisibility();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    this._stopRecognition();
  }

  _updateVisibility() {
    const user = tracker.getCurrentUser();
    const fab = this.shadowRoot.querySelector(".fab");
    if (fab) fab.style.display = user ? "" : "none";
  }

  _hasSpeechAPI() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  _openModal(voice) {
    this._voiceMode = voice && this._hasSpeechAPI();
    this._modalOpen = true;
    this._transcript = "";
    this._renderModal();

    if (this._voiceMode) {
      this._startRecognition();
    } else {
      const ta = this.shadowRoot.querySelector(".fb-textarea");
      if (ta) setTimeout(() => ta.focus(), 50);
    }
  }

  _closeModal() {
    this._modalOpen = false;
    this._stopRecognition();
    this._renderModal();
  }

  _renderModal() {
    const existing = this.shadowRoot.querySelector(".fb-overlay");
    if (existing) existing.remove();

    if (!this._modalOpen) return;

    const overlay = document.createElement("div");
    overlay.className = "fb-overlay";
    overlay.innerHTML = `
      <div class="fb-backdrop"></div>
      <div class="fb-card">
        <div class="fb-title">${this._voiceMode ? "Listening..." : "Jot Feedback"}</div>
        ${this._voiceMode ? `<div class="fb-voice-indicator"><span class="fb-pulse"></span> Speak now</div>` : ""}
        <textarea class="fb-textarea" rows="4" placeholder="What did you notice?">${this._transcript}</textarea>
        <div class="fb-actions">
          <button class="fb-btn fb-cancel" type="button">Cancel</button>
          <button class="fb-btn fb-submit" type="button">Submit</button>
        </div>
      </div>
    `;

    this.shadowRoot.appendChild(overlay);

    overlay.querySelector(".fb-backdrop").addEventListener("click", () => this._closeModal());
    overlay.querySelector(".fb-cancel").addEventListener("click", () => this._closeModal());
    overlay.querySelector(".fb-submit").addEventListener("click", () => this._submit());

    // Submit on Enter (without shift)
    overlay.querySelector(".fb-textarea").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._submit();
      }
    });
  }

  _startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    this._recognition = new SpeechRecognition();
    this._recognition.continuous = true;
    this._recognition.interimResults = true;
    this._recognition.lang = "en-US";

    this._recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      this._transcript = final + interim;
      const ta = this.shadowRoot.querySelector(".fb-textarea");
      if (ta) ta.value = this._transcript;
    };

    this._recognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);
      // Switch to text mode on error
      this._voiceMode = false;
      const indicator = this.shadowRoot.querySelector(".fb-voice-indicator");
      if (indicator) indicator.remove();
      const title = this.shadowRoot.querySelector(".fb-title");
      if (title) title.textContent = "Jot Feedback";
      const ta = this.shadowRoot.querySelector(".fb-textarea");
      if (ta) ta.focus();
    };

    this._recognition.onend = () => {
      // Update voice indicator when recognition stops
      const indicator = this.shadowRoot.querySelector(".fb-voice-indicator");
      if (indicator) indicator.innerHTML = "Done. Edit or submit.";
      const ta = this.shadowRoot.querySelector(".fb-textarea");
      if (ta) ta.focus();
    };

    this._recognition.start();
  }

  _stopRecognition() {
    if (this._recognition) {
      try { this._recognition.stop(); } catch (e) { /* ignore */ }
      this._recognition = null;
    }
  }

  async _submit() {
    const ta = this.shadowRoot.querySelector(".fb-textarea");
    const text = (ta ? ta.value : this._transcript).trim();
    if (!text) return;

    this._stopRecognition();

    const user = tracker.getCurrentUser();
    const payload = {
      text,
      userId: user ? user.id : null,
      userName: user ? user.name : null,
      currentView: trackerStore.app.data.currentView || null,
      userAgent: navigator.userAgent,
    };

    this._closeModal();

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Server error");
      eventBus.emit("toast:show", { message: "Feedback saved!", type: "success" });
    } catch (e) {
      console.error("Feedback submit failed:", e);
      eventBus.emit("toast:show", { message: "Failed to save feedback", type: "danger" });
    }
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        ${tracker.TRACKER_CSS}

        .fab {
          position: fixed;
          bottom: 24px;
          right: 20px;
          z-index: 900;
          width: 52px;
          height: 52px;
          border-radius: 50%;
          border: 1px solid var(--accent-strong);
          background: radial-gradient(circle at top left, #2b344e, #1b1e34);
          color: var(--text);
          font-size: 1.4rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.7);
          transition: transform var(--transition-fast), box-shadow var(--transition-fast);
          -webkit-user-select: none;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
          touch-action: none;
        }

        .fab:hover {
          transform: translateY(-2px);
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.85);
        }

        .fab:active {
          transform: translateY(0) scale(0.95);
        }

        .fb-overlay {
          position: fixed;
          inset: 0;
          z-index: 950;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }

        .fb-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
        }

        .fb-card {
          position: relative;
          width: 100%;
          max-width: 400px;
          border-radius: 20px;
          padding: 20px;
          background: radial-gradient(circle at top left, #1a1c2a, #090a13);
          border: 1px solid var(--border-subtle);
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7);
        }

        .fb-title {
          font-size: 0.95rem;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 12px;
        }

        .fb-voice-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.82rem;
          color: var(--accent);
          margin-bottom: 10px;
        }

        .fb-pulse {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--accent);
          animation: fb-pulse-anim 1s ease-in-out infinite;
        }

        @keyframes fb-pulse-anim {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }

        .fb-textarea {
          width: 100%;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          padding: 10px 12px;
          font-size: 0.88rem;
          color: var(--text);
          font-family: inherit;
          outline: none;
          resize: vertical;
          transition: border-color var(--transition-fast);
        }

        .fb-textarea:focus {
          border-color: var(--accent);
        }

        .fb-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 12px;
        }

        .fb-btn {
          appearance: none;
          border: none;
          border-radius: 999px;
          padding: 8px 16px;
          font-size: 0.82rem;
          font-weight: 500;
          cursor: pointer;
          font-family: inherit;
          transition: transform var(--transition-fast), background var(--transition-fast);
        }

        .fb-cancel {
          background: transparent;
          color: var(--muted);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .fb-cancel:hover {
          background: rgba(255, 255, 255, 0.04);
        }

        .fb-submit {
          background: radial-gradient(circle at top left, #2b344e, #1b1e34);
          color: var(--text);
          border: 1px solid var(--accent-strong);
        }

        .fb-submit:hover {
          background: radial-gradient(circle at top left, #3a4670, #20243b);
        }
      </style>
      <button class="fab" type="button" title="Jot feedback">&#x270E;</button>
    `;

    const fab = this.shadowRoot.querySelector(".fab");

    // Tap vs long-press detection
    let longPressTriggered = false;

    fab.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // keep pointer sequence alive on touch
      longPressTriggered = false;
      this._pressTimer = setTimeout(() => {
        longPressTriggered = true;
        this._openModal(true);
      }, 500);
    });

    fab.addEventListener("pointerup", () => {
      clearTimeout(this._pressTimer);
      if (longPressTriggered) return;
      this._openModal(false);
    });

    fab.addEventListener("pointercancel", () => {
      clearTimeout(this._pressTimer);
    });

    // Prevent context menu on long press (mobile)
    fab.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}

customElements.define("ps-feedback-fab", PsFeedbackFab);
