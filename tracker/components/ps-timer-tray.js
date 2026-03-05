// ps-timer-tray: Non-modal multi-timer system
// Manages concurrent timers as minimized pills + expandable card view
class PsTimerTray extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._timers = new Map(); // key = "taskId:userId"
    this._focusedKey = null;
    this._rafId = null;
    this._wakeLock = null;
    this._unsubs = [];
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("timer:start", (data) => this._begin(data.taskId, data.userId)),
    );
    this._render();

    // Handle visibility change for sound resumption
    this._onVisibility = () => {
      if (!document.hidden && this._timers.size > 0 && !this._rafId) {
        this._rafId = requestAnimationFrame(() => this._tick());
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    if (this._rafId) cancelAnimationFrame(this._rafId);
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._releaseWakeLock();
  }

  // --- Wake Lock ---

  async _acquireWakeLock() {
    if (this._wakeLock) return;
    try {
      if (navigator.wakeLock) {
        this._wakeLock = await navigator.wakeLock.request("screen");
        this._wakeLock.addEventListener("release", () => { this._wakeLock = null; });
      }
    } catch (e) {
      // Graceful no-op (not HTTPS, not supported, etc.)
    }
  }

  _releaseWakeLock() {
    if (this._wakeLock) {
      this._wakeLock.release().catch(() => {});
      this._wakeLock = null;
    }
  }

  // --- Timer lifecycle ---

  _begin(taskId, userId) {
    const task = trackerStore.tasks.data.find((t) => t.id === taskId);
    if (!task || !task.timerBonus) return;

    const key = `${taskId}:${userId}`;

    // If already running, just focus it
    if (this._timers.has(key)) {
      this._focusedKey = key;
      this._render();
      return;
    }

    const user = trackerStore.users.data.find((u) => u.id === userId);

    this._timers.set(key, {
      taskId,
      userId,
      userName: user ? user.name : "?",
      taskName: task.name,
      targetSeconds: task.timerBonus.targetSeconds,
      timerMode: task.timerBonus.mode || "under",
      tickSound: task.timerBonus.tickSound || "click",
      hitSound: task.timerBonus.hitSound || "success",
      startTime: performance.now(),
      elapsed: 0,
      targetHitPlayed: false,
      lastTickKey: -1,
      paused: false,
      pausedAt: null,
      pausedElapsed: 0,
      pauseCount: 0,
      pauseCooldownUntil: 0,
    });

    this._focusedKey = key;
    this._render();
    this._acquireWakeLock();

    // Start rAF loop if not already running
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => this._tick());
    }
  }

  _pause(key) {
    const timer = this._timers.get(key);
    if (!timer || timer.paused) return;

    timer.paused = true;
    timer.pausedAt = performance.now();
    timer.pausedElapsed = timer.elapsed;
    timer.pauseCount++;
    this._render();
  }

  _resume(key) {
    const timer = this._timers.get(key);
    if (!timer || !timer.paused) return;

    // Reset startTime so elapsed picks up from where it froze
    timer.startTime = performance.now() - timer.pausedElapsed * 1000;
    timer.paused = false;
    timer.pausedAt = null;
    timer.pauseCooldownUntil = performance.now() + 30000;
    this._render();
  }

  _cancel(key) {
    this._timers.delete(key);
    if (this._focusedKey === key) this._focusedKey = null;
    this._checkEmpty();
    this._render();
  }

  _complete(key) {
    const timer = this._timers.get(key);
    if (!timer) return;

    // If paused, use the frozen elapsed; otherwise use live
    const elapsed = Math.round(timer.paused ? timer.pausedElapsed : timer.elapsed);
    const result = tracker.completeTask(timer.taskId, timer.userId, elapsed);

    if (result) {
      const bonusApplied = result.timerMultiplier > 1;
      const rewardText = Object.entries(result.rewards || {})
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(", ");

      if (bonusApplied) {
        this._showBurst();
      }

      const sfx = window.slopSFX;
      if (sfx) {
        if (result.status === "pending") {
          sfx.submitted();
        } else {
          sfx.cashJingle();
        }
      }

      eventBus.emit("toast:show", {
        message: `${bonusApplied ? "Timer bonus! " : ""}Earned ${rewardText}${result.status === "pending" ? " (pending approval)" : ""}`,
        type: bonusApplied ? "success" : "warning",
      });
    }

    const delay = result && result.timerMultiplier > 1 ? 600 : 0;
    setTimeout(() => {
      this._timers.delete(key);
      if (this._focusedKey === key) this._focusedKey = null;
      this._checkEmpty();
      this._render();
      eventBus.emit("timer:completed");
    }, delay);
  }

  _checkEmpty() {
    if (this._timers.size === 0) {
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
      this._releaseWakeLock();
    }
  }

  // --- rAF tick loop ---

  _tick() {
    if (this._timers.size === 0) {
      this._rafId = null;
      return;
    }

    const now = performance.now();

    for (const [key, timer] of this._timers) {
      if (timer.paused) continue;
      timer.elapsed = (now - timer.startTime) / 1000;
    }

    // Audio: focused timer gets ticks, or most urgent if none focused
    const tickKey = this._focusedKey && this._timers.has(this._focusedKey)
      ? this._focusedKey
      : this._getMostUrgentKey();

    if (tickKey) {
      this._tickAudio(this._timers.get(tickKey));
    }

    // Hit sounds play independently for each timer
    for (const [key, timer] of this._timers) {
      if (timer.paused) continue;
      this._checkHitSound(timer);
    }

    // Lightweight DOM updates
    this._updateDisplays();

    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _getMostUrgentKey() {
    let bestKey = null;
    let bestRemaining = Infinity;

    for (const [key, timer] of this._timers) {
      if (timer.paused) continue;
      const remaining = timer.targetSeconds - timer.elapsed;
      if (remaining < bestRemaining) {
        bestRemaining = remaining;
        bestKey = key;
      }
    }
    return bestKey;
  }

  _tickAudio(timer) {
    if (!timer || timer.paused || timer.tickSound === "none") return;

    const elapsed = timer.elapsed;
    const remaining = Math.max(0, timer.targetSeconds - elapsed);
    const currentSecond = Math.floor(elapsed);

    let ticksPerSecond = 1;
    if (remaining <= 3 && remaining > 0) {
      ticksPerSecond = 4;
    } else if (remaining <= 10 && remaining > 0) {
      ticksPerSecond = 2;
    }

    const subBeat = Math.floor((elapsed % 1) * ticksPerSecond);
    const tickKey = currentSecond * ticksPerSecond + subBeat;

    if (tickKey === timer.lastTickKey) return;
    timer.lastTickKey = tickKey;

    let pitchMult = 1;
    if (remaining <= 3 && remaining > 0) {
      pitchMult = 1.5;
    } else if (remaining <= 10 && remaining > 0) {
      pitchMult = 1.25;
    }

    const sfx = window.slopSFX;
    if (!sfx) return;

    switch (timer.tickSound) {
      case "click": sfx.tickClick(pitchMult); break;
      case "soft": sfx.tickSoft(pitchMult); break;
      case "digital": sfx.tickDigital(pitchMult); break;
    }
  }

  _checkHitSound(timer) {
    if (timer.targetHitPlayed || timer.hitSound === "none") return;

    const hitCondition = timer.timerMode === "over"
      ? timer.elapsed >= timer.targetSeconds
      : timer.elapsed >= timer.targetSeconds;

    if (hitCondition) {
      timer.targetHitPlayed = true;
      const sfx = window.slopSFX;
      if (!sfx) return;
      switch (timer.hitSound) {
        case "success": sfx.timerSuccess(); break;
        case "warning": sfx.timerWarning(); break;
      }
    }
  }

  // --- Display updates (lightweight, per-frame) ---

  _updateDisplays() {
    // Update pills
    for (const [key, timer] of this._timers) {
      const pillTime = this.shadowRoot.getElementById(`pill-time-${key}`);
      if (pillTime) {
        pillTime.textContent = timer.paused ? this._formatTime(timer.pausedElapsed) : this._formatTime(timer.elapsed);
      }
      const pillEl = this.shadowRoot.getElementById(`pill-${key}`);
      if (pillEl) {
        pillEl.classList.toggle("paused", timer.paused);
      }
    }

    // Update expanded card if focused
    if (this._focusedKey && this._timers.has(this._focusedKey)) {
      const timer = this._timers.get(this._focusedKey);
      const display = this.shadowRoot.getElementById("card-display");
      const ring = this.shadowRoot.getElementById("card-ring-progress");
      const statusEl = this.shadowRoot.getElementById("card-status");
      const glow = this.shadowRoot.getElementById("card-glow");
      const pauseBtn = this.shadowRoot.getElementById("card-pause-btn");

      if (!display) return;

      const elapsed = timer.paused ? timer.pausedElapsed : timer.elapsed;
      const remaining = Math.max(0, timer.targetSeconds - elapsed);
      const pct = Math.min(1, elapsed / timer.targetSeconds);
      const circumference = 490.09;

      const isUrgent = remaining <= 10 && remaining > 0;
      const isCritical = remaining <= 3 && remaining > 0;

      if (timer.timerMode === "over") {
        display.textContent = this._formatTime(elapsed);
        ring.style.strokeDashoffset = circumference * (1 - pct);

        if (elapsed >= timer.targetSeconds) {
          display.className = "card-time target-hit";
          ring.style.stroke = "var(--success)";
          statusEl.textContent = "Target reached! Bonus earned.";
          if (glow) glow.style.background = "radial-gradient(circle, rgba(80,250,123,0.12) 0%, transparent 70%)";
        } else {
          display.className = "card-time" + (isCritical ? " critical" : isUrgent ? " urgent" : "");
          ring.style.stroke = isUrgent ? "var(--warning)" : "var(--accent)";
          statusEl.textContent = `Keep going — ${this._formatTime(remaining)} to bonus`;
          if (glow) glow.style.background = "radial-gradient(circle, rgba(102,217,239,0.06) 0%, transparent 70%)";
        }
      } else {
        ring.style.strokeDashoffset = circumference * pct;

        if (remaining > 0) {
          display.textContent = this._formatTime(remaining);
          display.className = "card-time" + (isCritical ? " critical" : isUrgent ? " urgent" : "");
          ring.style.stroke = isCritical ? "var(--danger)" : isUrgent ? "var(--warning)" : "var(--accent)";
          statusEl.textContent = `Finish before ${this._formatTime(timer.targetSeconds)}`;
          if (glow) {
            const glowColor = isCritical ? "rgba(255,107,129,0.1)" : isUrgent ? "rgba(241,250,140,0.08)" : "rgba(102,217,239,0.06)";
            glow.style.background = `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`;
          }
        } else {
          display.textContent = "+" + this._formatTime(elapsed - timer.targetSeconds);
          display.className = "card-time target-hit over";
          ring.style.stroke = "var(--danger)";
          statusEl.textContent = "Over target! Bonus lost.";
          if (glow) glow.style.background = "radial-gradient(circle, rgba(255,107,129,0.1) 0%, transparent 70%)";
        }
      }

      // Update pause button state
      if (pauseBtn) {
        if (timer.paused) {
          pauseBtn.textContent = "Resume";
          pauseBtn.disabled = false;
          pauseBtn.className = "timer-btn btn-pause resume";
        } else {
          const now = performance.now();
          const cooldownLeft = Math.ceil(Math.max(0, timer.pauseCooldownUntil - now) / 1000);
          if (cooldownLeft > 0) {
            pauseBtn.textContent = `Pause (${cooldownLeft}s)`;
            pauseBtn.disabled = true;
            pauseBtn.className = "timer-btn btn-pause cooldown";
          } else {
            pauseBtn.textContent = "Pause";
            pauseBtn.disabled = false;
            pauseBtn.className = "timer-btn btn-pause";
          }
        }
      }
    }
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // --- Burst animation ---

  _showBurst() {
    const card = this.shadowRoot.getElementById("timer-card");
    if (!card) return;
    card.classList.add("burst");
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

  // --- Full render (structural changes only) ---

  _render() {
    const hasFocused = this._focusedKey && this._timers.has(this._focusedKey);
    const hasTimers = this._timers.size > 0;

    if (!hasTimers) {
      this.shadowRoot.innerHTML = "";
      this.hidden = true;
      return;
    }

    this.hidden = false;

    const radius = 78;
    const circumference = 2 * Math.PI * radius;

    // Build pill HTML
    const pillsHtml = Array.from(this._timers.entries()).map(([key, timer]) => {
      const initial = (timer.userName || "?").trim().charAt(0).toUpperCase();
      const elapsed = timer.paused ? timer.pausedElapsed : timer.elapsed;
      const timeStr = this._formatTime(elapsed);
      const shortName = timer.taskName.length > 14 ? timer.taskName.slice(0, 12) + "..." : timer.taskName;
      return `
        <button class="pill${timer.paused ? " paused" : ""}${key === this._focusedKey ? " focused" : ""}"
                id="pill-${key}" data-key="${key}" type="button">
          <span class="pill-avatar">${initial}</span>
          ${timer.paused ? '<span class="pill-pause-icon">&#x23F8;</span>' : ""}
          <span class="pill-name">${shortName}</span>
          <span class="pill-time" id="pill-time-${key}">${timeStr}</span>
        </button>
      `;
    }).join("");

    // Build expanded card HTML (if focused)
    let cardHtml = "";
    if (hasFocused) {
      const timer = this._timers.get(this._focusedKey);
      const elapsed = timer.paused ? timer.pausedElapsed : timer.elapsed;

      // Determine initial pause button state
      let pauseBtnText = "Pause";
      let pauseBtnDisabled = "";
      let pauseBtnClass = "timer-btn btn-pause";
      if (timer.paused) {
        pauseBtnText = "Resume";
        pauseBtnClass = "timer-btn btn-pause resume";
      } else {
        const now = performance.now();
        const cooldownLeft = Math.ceil(Math.max(0, timer.pauseCooldownUntil - now) / 1000);
        if (cooldownLeft > 0) {
          pauseBtnText = `Pause (${cooldownLeft}s)`;
          pauseBtnDisabled = "disabled";
          pauseBtnClass = "timer-btn btn-pause cooldown";
        }
      }

      cardHtml = `
        <div class="card-backdrop" id="card-backdrop"></div>
        <div class="card-container">
          <div class="timer-card" id="timer-card">
            <div class="card-glow" id="card-glow"></div>
            <div class="card-task-name">${timer.taskName}</div>
            <div class="card-user-label">${timer.userName}</div>

            <div class="ring-container">
              <svg class="ring-svg" viewBox="0 0 180 180">
                <circle class="ring-bg" cx="90" cy="90" r="${radius}" />
                <circle class="ring-progress" id="card-ring-progress" cx="90" cy="90" r="${radius}" />
              </svg>
              <div class="ring-time">
                <div class="card-time" id="card-display">${this._formatTime(elapsed)}</div>
              </div>
            </div>

            <div id="card-status" class="card-status">${timer.timerMode === "over"
              ? `Spend at least ${this._formatTime(timer.targetSeconds)}`
              : `Finish before ${this._formatTime(timer.targetSeconds)}`}</div>

            <div class="card-actions">
              <button class="timer-btn btn-cancel" id="card-cancel">Cancel</button>
              <button class="${pauseBtnClass}" id="card-pause-btn" ${pauseBtnDisabled}>${pauseBtnText}</button>
              <button class="timer-btn btn-minimize" id="card-minimize">Minimize</button>
              <button class="timer-btn btn-complete" id="card-done">Done!</button>
            </div>

            <div class="bonus-hint">${timer.timerMode === "over"
              ? `Keep going for at least ${this._formatTime(timer.targetSeconds)} for a bonus!`
              : `Finish under ${this._formatTime(timer.targetSeconds)} for a bonus!`}</div>
          </div>
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>${this._getStyles(circumference)}</style>
      <div class="tray" id="timer-tray">${pillsHtml}</div>
      ${cardHtml}
    `;

    this._bindEvents();
  }

  _bindEvents() {
    // Pill clicks → expand
    this.shadowRoot.querySelectorAll(".pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const key = pill.dataset.key;
        this._focusedKey = key;
        this._render();
      });
    });

    // Backdrop click → minimize
    const backdrop = this.shadowRoot.getElementById("card-backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", () => {
        this._focusedKey = null;
        this._render();
      });
    }

    // Card buttons
    const minimizeBtn = this.shadowRoot.getElementById("card-minimize");
    if (minimizeBtn) {
      minimizeBtn.addEventListener("click", () => {
        this._focusedKey = null;
        this._render();
      });
    }

    const cancelBtn = this.shadowRoot.getElementById("card-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        const key = this._focusedKey;
        if (key) this._cancel(key);
      });
    }

    const doneBtn = this.shadowRoot.getElementById("card-done");
    if (doneBtn) {
      doneBtn.addEventListener("click", () => {
        const key = this._focusedKey;
        if (key) this._complete(key);
      });
    }

    const pauseBtn = this.shadowRoot.getElementById("card-pause-btn");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => {
        const key = this._focusedKey;
        if (!key) return;
        const timer = this._timers.get(key);
        if (!timer) return;
        if (timer.paused) {
          this._resume(key);
        } else {
          this._pause(key);
        }
      });
    }
  }

  _getStyles(circumference) {
    return `
      :host {
        display: block;
        font-family: system-ui, -apple-system, sans-serif;
      }

      /* --- Pill tray --- */
      .tray {
        position: fixed;
        bottom: 16px;
        left: 16px;
        z-index: 890;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        max-width: calc(100vw - 32px);
      }

      .pill {
        appearance: none;
        border: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px 6px 8px;
        border-radius: 999px;
        background: linear-gradient(135deg, #1a1c2a, #0f101a);
        border: 1px solid rgba(102, 217, 239, 0.25);
        color: #f7f7ff;
        font-size: 0.78rem;
        font-family: inherit;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
        transition: transform 160ms ease-out, border-color 160ms ease-out, box-shadow 160ms ease-out;
        animation: pillIn 300ms cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes pillIn {
        from { transform: translateY(20px) scale(0.8); opacity: 0; }
        to { transform: translateY(0) scale(1); opacity: 1; }
      }

      .pill:hover {
        transform: translateY(-2px);
        border-color: rgba(102, 217, 239, 0.5);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.7);
      }

      .pill.focused {
        border-color: rgba(102, 217, 239, 0.6);
        box-shadow: 0 0 12px rgba(102, 217, 239, 0.2);
      }

      .pill.paused {
        opacity: 0.6;
        border-color: rgba(255, 255, 255, 0.1);
      }

      .pill-avatar {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: radial-gradient(circle at 30% 0%, rgba(255,255,255,0.12), rgba(102,217,239,0.25));
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.7rem;
        font-weight: 700;
        color: var(--accent, #66d9ef);
        flex-shrink: 0;
      }

      .pill-pause-icon {
        font-size: 0.68rem;
        color: var(--muted, #a0a4be);
      }

      .pill-name {
        color: #a0a4be;
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pill-time {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--accent, #66d9ef);
      }

      /* --- Expanded card overlay --- */
      .card-backdrop {
        position: fixed;
        inset: 0;
        z-index: 894;
        background: rgba(5, 6, 10, 0.6);
        backdrop-filter: blur(4px);
        animation: fadeIn 200ms ease-out;
      }

      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .card-container {
        position: fixed;
        inset: 0;
        z-index: 895;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }

      .timer-card {
        position: relative;
        pointer-events: auto;
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

      .card-glow {
        position: absolute;
        inset: -40px;
        pointer-events: none;
        transition: background 1s ease;
        background: radial-gradient(circle, rgba(102,217,239,0.06) 0%, transparent 70%);
      }

      .card-task-name {
        position: relative;
        font-size: 0.92rem;
        font-weight: 600;
        color: #f7f7ff;
        margin-bottom: 2px;
      }

      .card-user-label {
        position: relative;
        font-size: 0.78rem;
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

      .card-time {
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

      .card-time.urgent {
        color: var(--warning, #f1fa8c);
        animation: pulseUrgent 0.8s ease-in-out infinite;
      }

      @keyframes pulseUrgent {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.04); }
      }

      .card-time.critical {
        color: var(--danger, #ff6b81);
        animation: pulseCritical 0.4s ease-in-out infinite;
      }

      @keyframes pulseCritical {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.06); }
      }

      .card-time.target-hit {
        color: var(--success, #50fa7b);
        animation: pulseSuccess 1s ease-in-out infinite;
      }

      .card-time.target-hit.over {
        color: var(--warning, #f1fa8c);
      }

      @keyframes pulseSuccess {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.03); }
      }

      .card-status {
        position: relative;
        font-size: 0.78rem;
        color: #a0a4be;
        margin-bottom: 20px;
      }

      .card-actions {
        position: relative;
        display: flex;
        gap: 8px;
        justify-content: center;
        flex-wrap: wrap;
      }

      .timer-btn {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 10px 18px;
        font-size: 0.84rem;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        min-height: 44px;
        transition: transform 160ms ease-out, box-shadow 160ms ease-out, opacity 160ms ease-out;
      }

      .timer-btn:hover { transform: translateY(-1px); }
      .timer-btn:active { transform: translateY(0); }
      .timer-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        transform: none;
      }

      .btn-complete {
        background: linear-gradient(135deg, #1a3a22, #0f2518);
        color: #50fa7b;
        border: 1px solid rgba(80, 250, 123, 0.3);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5);
      }

      .btn-cancel {
        background: rgba(255, 255, 255, 0.04);
        color: #a0a4be;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }

      .btn-minimize {
        background: rgba(255, 255, 255, 0.04);
        color: #a0a4be;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }

      .btn-pause {
        background: rgba(241, 250, 140, 0.08);
        color: #f1fa8c;
        border: 1px solid rgba(241, 250, 140, 0.2);
      }

      .btn-pause.resume {
        background: rgba(80, 250, 123, 0.08);
        color: #50fa7b;
        border: 1px solid rgba(80, 250, 123, 0.2);
      }

      .btn-pause.cooldown {
        background: rgba(255, 255, 255, 0.03);
        color: #a0a4be;
        border: 1px solid rgba(255, 255, 255, 0.06);
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
        60% { opacity: 0.8; }
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
    `;
  }
}

customElements.define("ps-timer-tray", PsTimerTray);
