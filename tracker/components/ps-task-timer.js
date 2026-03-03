// ps-task-timer: Built-in countdown/stopwatch timer for timed tasks
// Circular progress ring, audio ticks, urgency ramping, completion burst
class PsTaskTimer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._active = false;
    this._taskId = null;
    this._userId = null;
    this._startTime = null;
    this._targetSeconds = 0;
    this._elapsed = 0;
    this._rafId = null;
    this._targetHitPlayed = false;
    this._lastTickSecond = -1;
    this._tickSound = "click";
    this._hitSound = "success";
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("timer:start", (data) => this._begin(data.taskId, data.userId)),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  _begin(taskId, userId) {
    const task = trackerStore.tasks.data.find((t) => t.id === taskId);
    if (!task || !task.timerBonus) return;

    this._active = true;
    this._taskId = taskId;
    this._userId = userId;
    this._targetSeconds = task.timerBonus.targetSeconds;
    this._timerMode = task.timerBonus.mode || "under";
    this._tickSound = task.timerBonus.tickSound || "click";
    this._hitSound = task.timerBonus.hitSound || "success";
    this._startTime = performance.now();
    this._elapsed = 0;
    this._targetHitPlayed = false;
    this._lastTickSecond = -1;

    this.render();
    this._tick();
  }

  _tickAudio() {
    if (!this._active || this._tickSound === "none") return;

    const elapsed = this._elapsed;
    const remaining = Math.max(0, this._targetSeconds - elapsed);
    const currentSecond = Math.floor(elapsed);

    // Determine tick rate based on urgency
    let ticksPerSecond = 1;
    if (remaining <= 3 && remaining > 0) {
      ticksPerSecond = 4;
    } else if (remaining <= 10 && remaining > 0) {
      ticksPerSecond = 2;
    }

    // For sub-second ticks, subdivide the second
    const subBeat = Math.floor((elapsed % 1) * ticksPerSecond);
    const tickKey = currentSecond * ticksPerSecond + subBeat;

    if (tickKey === this._lastTickSecond) return;
    this._lastTickSecond = tickKey;

    // Urgency pitch multiplier: normal=1, urgent=1.25, critical=1.5
    let pitchMult = 1;
    if (remaining <= 3 && remaining > 0) {
      pitchMult = 1.5;
    } else if (remaining <= 10 && remaining > 0) {
      pitchMult = 1.25;
    }

    const sfx = window.slopSFX;
    if (!sfx) return;

    switch (this._tickSound) {
      case "click": sfx.tickClick(pitchMult); break;
      case "soft": sfx.tickSoft(pitchMult); break;
      case "digital": sfx.tickDigital(pitchMult); break;
    }
  }

  _playHitSound() {
    if (this._targetHitPlayed || this._hitSound === "none") return;
    this._targetHitPlayed = true;

    const sfx = window.slopSFX;
    if (!sfx) return;

    switch (this._hitSound) {
      case "success": sfx.timerSuccess(); break;
      case "warning": sfx.timerWarning(); break;
    }
  }

  _tick() {
    if (!this._active) return;
    this._elapsed = (performance.now() - this._startTime) / 1000;
    this._tickAudio();
    this._updateDisplay();
    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _updateDisplay() {
    const display = this.shadowRoot.getElementById("timer-display");
    const ring = this.shadowRoot.getElementById("timer-ring-progress");
    const statusEl = this.shadowRoot.getElementById("timer-status");
    const card = this.shadowRoot.getElementById("timer-card");
    const glow = this.shadowRoot.getElementById("timer-glow");
    if (!display) return;

    const remaining = Math.max(0, this._targetSeconds - this._elapsed);
    const pct = Math.min(1, this._elapsed / this._targetSeconds);

    // Ring: circumference = 2 * PI * 78 ≈ 490.09
    const circumference = 490.09;

    // Urgency state
    const isUrgent = remaining <= 10 && remaining > 0;
    const isCritical = remaining <= 3 && remaining > 0;

    if (this._timerMode === "over") {
      // "Spend at least" mode: ring fills up toward target
      display.textContent = this._formatTime(this._elapsed);
      ring.style.strokeDashoffset = circumference * (1 - pct);

      if (this._elapsed >= this._targetSeconds) {
        // Target reached
        display.classList.add("target-hit");
        display.classList.remove("urgent", "critical");
        ring.style.stroke = "var(--success)";
        statusEl.textContent = "Target reached! Bonus earned.";
        if (glow) glow.style.background = "radial-gradient(circle, rgba(80,250,123,0.12) 0%, transparent 70%)";
        this._playHitSound();
      } else {
        display.classList.remove("target-hit");
        display.classList.toggle("urgent", isUrgent);
        display.classList.toggle("critical", isCritical);
        ring.style.stroke = isUrgent ? "var(--warning)" : "var(--accent)";
        statusEl.textContent = `Keep going — ${this._formatTime(remaining)} to bonus`;
        if (glow) glow.style.background = "radial-gradient(circle, rgba(102,217,239,0.06) 0%, transparent 70%)";
      }
    } else {
      // "Finish under" mode: ring drains down
      ring.style.strokeDashoffset = circumference * pct;

      if (remaining > 0) {
        display.textContent = this._formatTime(remaining);
        display.classList.remove("target-hit");
        display.classList.toggle("urgent", isUrgent);
        display.classList.toggle("critical", isCritical);
        ring.style.stroke = isCritical ? "var(--danger)" : isUrgent ? "var(--warning)" : "var(--accent)";
        statusEl.textContent = `Finish before ${this._formatTime(this._targetSeconds)}`;
        if (glow) {
          const glowColor = isCritical ? "rgba(255,107,129,0.1)" : isUrgent ? "rgba(241,250,140,0.08)" : "rgba(102,217,239,0.06)";
          glow.style.background = `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`;
        }
      } else {
        display.textContent = "+" + this._formatTime(this._elapsed - this._targetSeconds);
        display.classList.add("target-hit");
        display.classList.remove("urgent", "critical");
        display.style.color = "var(--warning)";
        ring.style.stroke = "var(--danger)";
        statusEl.textContent = "Over target! Bonus lost.";
        if (glow) glow.style.background = "radial-gradient(circle, rgba(255,107,129,0.1) 0%, transparent 70%)";
        this._playHitSound();
      }
    }
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  _complete() {
    if (!this._active) return;
    cancelAnimationFrame(this._rafId);
    this._active = false;

    const elapsed = Math.round(this._elapsed);
    const result = tracker.completeTask(this._taskId, this._userId, elapsed);

    if (result) {
      const bonusApplied = result.timerMultiplier > 1;
      const rewardText = Object.entries(result.rewards || {})
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(", ");

      // Completion burst animation + cash jingle
      if (bonusApplied) {
        this._showBurst();
      }
      if (result.status !== "pending") {
        const sfx = window.slopSFX;
        if (sfx) sfx.cashJingle();
      }

      eventBus.emit("toast:show", {
        message: `${bonusApplied ? "Timer bonus! " : ""}Earned ${rewardText}${result.status === "pending" ? " (pending approval)" : ""}`,
        type: bonusApplied ? "success" : "warning",
      });
    }

    // Short delay so burst animation is visible before clearing
    setTimeout(() => {
      this._taskId = null;
      this._userId = null;
      this.render();
      eventBus.emit("timer:completed");
    }, result && result.timerMultiplier > 1 ? 600 : 0);
  }

  _showBurst() {
    const card = this.shadowRoot.getElementById("timer-card");
    if (!card) return;
    card.classList.add("burst");
    // Two waves of sparkle particles
    const colors = ["#50fa7b", "#66d9ef", "#f1fa8c", "#ff79c6"];
    for (let wave = 0; wave < 2; wave++) {
      const count = wave === 0 ? 24 : 16;
      for (let i = 0; i < count; i++) {
        const spark = document.createElement("div");
        spark.className = wave === 0 ? "sparkle" : "sparkle sparkle-sm";
        const jitter = (Math.random() - 0.5) * 15;
        spark.style.setProperty("--angle", `${(i * (360 / count)) + jitter}deg`);
        spark.style.setProperty("--delay", `${wave * 0.12 + Math.random() * 0.15}s`);
        spark.style.setProperty("--dist", `${(wave === 0 ? 80 : 50) + Math.random() * 60}px`);
        spark.style.setProperty("--color", colors[Math.floor(Math.random() * colors.length)]);
        card.appendChild(spark);
      }
    }
  }

  _cancel() {
    cancelAnimationFrame(this._rafId);
    this._active = false;
    this._taskId = null;
    this._userId = null;
    this.render();
  }

  render() {
    if (!this._active) {
      this.shadowRoot.innerHTML = "";
      this.hidden = true;
      return;
    }

    this.hidden = false;
    const task = trackerStore.tasks.data.find((t) => t.id === this._taskId);
    const taskName = task ? task.name : "Task";

    // SVG ring dimensions
    const radius = 78;
    const circumference = 2 * Math.PI * radius; // ~490.09

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, sans-serif;
        }

        .timer-overlay {
          position: fixed;
          inset: 0;
          z-index: 998;
          background: rgba(5, 6, 10, 0.92);
          backdrop-filter: blur(12px);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: fadeIn 300ms ease-out;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .timer-card {
          position: relative;
          background: radial-gradient(circle at top left, #1a1c2a, #090a13);
          border: 1px solid #25273a;
          border-radius: 28px;
          padding: 32px 28px;
          text-align: center;
          min-width: 320px;
          max-width: 400px;
          box-shadow: 0 30px 80px rgba(0, 0, 0, 0.8);
          overflow: hidden;
          animation: cardIn 400ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes cardIn {
          from { transform: scale(0.9) translateY(20px); opacity: 0; }
          to { transform: scale(1) translateY(0); opacity: 1; }
        }

        .timer-glow {
          position: absolute;
          inset: -40px;
          pointer-events: none;
          transition: background 1s ease;
          background: radial-gradient(circle, rgba(102,217,239,0.06) 0%, transparent 70%);
        }

        .timer-task-name {
          position: relative;
          font-size: 0.88rem;
          color: #a0a4be;
          margin-bottom: 10px;
        }

        .ring-container {
          position: relative;
          width: 180px;
          height: 180px;
          margin: 0 auto 12px;
        }

        .ring-svg {
          width: 100%;
          height: 100%;
          transform: rotate(-90deg);
        }

        .ring-bg {
          fill: none;
          stroke: rgba(255, 255, 255, 0.06);
          stroke-width: 6;
        }

        .ring-progress {
          fill: none;
          stroke: var(--accent, #66d9ef);
          stroke-width: 6;
          stroke-linecap: round;
          stroke-dasharray: ${circumference};
          stroke-dashoffset: ${circumference};
          transition: stroke 0.6s ease, stroke-dashoffset 0.15s linear;
        }

        .ring-time {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        #timer-display {
          font-size: 2.8rem;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: #66d9ef;
          line-height: 1.1;
          animation: pulse 1.5s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }

        #timer-display.urgent {
          color: var(--warning, #f1fa8c);
          animation: pulseUrgent 0.8s ease-in-out infinite;
        }

        @keyframes pulseUrgent {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }

        #timer-display.critical {
          color: var(--danger, #ff6b81);
          animation: pulseCritical 0.4s ease-in-out infinite;
        }

        @keyframes pulseCritical {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }

        #timer-display.target-hit {
          color: var(--success, #50fa7b);
          animation: pulseSuccess 1s ease-in-out infinite;
        }

        @keyframes pulseSuccess {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.03); }
        }

        #timer-status {
          position: relative;
          font-size: 0.78rem;
          color: #a0a4be;
          margin-bottom: 20px;
        }

        .timer-actions {
          position: relative;
          display: flex;
          gap: 10px;
          justify-content: center;
        }

        .timer-btn {
          appearance: none;
          border: none;
          border-radius: 999px;
          padding: 12px 24px;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          min-height: 48px;
          transition: transform 160ms ease-out, box-shadow 160ms ease-out;
        }

        .timer-btn:hover { transform: translateY(-1px); }
        .timer-btn:active { transform: translateY(0); }

        .btn-complete {
          background: linear-gradient(135deg, #1a3a22, #0f2518);
          color: #50fa7b;
          border: 1px solid rgba(80, 250, 123, 0.3);
          box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5);
        }

        .btn-cancel-timer {
          background: rgba(255, 255, 255, 0.04);
          color: #a0a4be;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .bonus-hint {
          position: relative;
          font-size: 0.72rem;
          color: #50fa7b;
          margin-top: 8px;
          opacity: 0.8;
        }

        /* Completion burst */
        .timer-card.burst {
          animation: burstScale 600ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes burstScale {
          0% { transform: scale(1); }
          20% { transform: scale(1.08); }
          100% { transform: scale(1); }
        }

        .sparkle {
          position: absolute;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--color, #50fa7b);
          box-shadow: 0 0 6px var(--color, #50fa7b);
          top: 50%;
          left: 50%;
          opacity: 0;
          animation: sparkleOut 800ms var(--delay, 0s) cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        .sparkle-sm {
          width: 5px;
          height: 5px;
          animation-name: sparkleOutSm;
          animation-duration: 650ms;
        }

        @keyframes sparkleOut {
          0% {
            transform: translate(-50%, -50%) rotate(var(--angle)) translateX(0) scale(1);
            opacity: 1;
          }
          60% {
            opacity: 0.8;
          }
          100% {
            transform: translate(-50%, -50%) rotate(var(--angle)) translateX(var(--dist, 100px)) scale(0.3);
            opacity: 0;
          }
        }

        @keyframes sparkleOutSm {
          0% {
            transform: translate(-50%, -50%) rotate(var(--angle)) translateX(0) scale(1);
            opacity: 0.9;
          }
          100% {
            transform: translate(-50%, -50%) rotate(var(--angle)) translateX(var(--dist, 60px)) scale(0);
            opacity: 0;
          }
        }
      </style>

      <div class="timer-overlay">
        <div class="timer-card" id="timer-card">
          <div class="timer-glow" id="timer-glow"></div>
          <div class="timer-task-name">${taskName}</div>

          <div class="ring-container">
            <svg class="ring-svg" viewBox="0 0 180 180">
              <circle class="ring-bg" cx="90" cy="90" r="${radius}" />
              <circle class="ring-progress" id="timer-ring-progress" cx="90" cy="90" r="${radius}" />
            </svg>
            <div class="ring-time">
              <div id="timer-display">0:00</div>
            </div>
          </div>

          <div id="timer-status">${this._timerMode === "over"
            ? `Spend at least ${this._formatTime(this._targetSeconds)}`
            : `Finish before ${this._formatTime(this._targetSeconds)}`}</div>

          <div class="timer-actions">
            <button class="timer-btn btn-cancel-timer" id="timer-cancel">Cancel</button>
            <button class="timer-btn btn-complete" id="timer-done">Done!</button>
          </div>

          <div class="bonus-hint">${this._timerMode === "over"
            ? `Keep going for at least ${this._formatTime(this._targetSeconds)} for a bonus!`
            : `Finish under ${this._formatTime(this._targetSeconds)} for a bonus!`}</div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById("timer-done").addEventListener("click", () => this._complete());
    this.shadowRoot.getElementById("timer-cancel").addEventListener("click", () => this._cancel());
  }
}

customElements.define("ps-task-timer", PsTaskTimer);
