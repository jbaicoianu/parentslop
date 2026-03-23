// ps-timer-tray: Non-modal multi-timer system
// Manages concurrent timers as minimized pills + expandable card view

const ANIMATION_SCRIPTS = {
  "toothbrush-guided": {
    baseAnimation: "toothbrush",
    stages: [
      { label: "Upper left",  fraction: 1/6, visualClass: "stage-upper-left",  sound: "stageChime" },
      { label: "Upper front", fraction: 1/6, visualClass: "stage-upper-front", sound: "stageChime" },
      { label: "Upper right", fraction: 1/6, visualClass: "stage-upper-right", sound: "stageChime" },
      { label: "Lower left",  fraction: 1/6, visualClass: "stage-lower-left",  sound: "stageChime" },
      { label: "Lower front", fraction: 1/6, visualClass: "stage-lower-front", sound: "stageChime" },
      { label: "Lower right", fraction: 1/6, visualClass: "stage-lower-right", sound: "stageChime" },
    ],
  },
  "exercise-guided": {
    baseAnimation: "exercise",
    encouragement: { intervalSeconds: 30, sound: "encourage" },
    stages: [
      { label: "Warm up",     fraction: 1/5, visualClass: "stage-warmup",   sound: "stageChime" },
      { label: "Jumping jacks", fraction: 1/5, visualClass: "stage-jumping", sound: "stageChime" },
      { label: "Stretches",   fraction: 1/5, visualClass: "stage-stretch",   sound: "stageChime" },
      { label: "Squats",      fraction: 1/5, visualClass: "stage-squats",    sound: "stageChime" },
      { label: "Cool down",   fraction: 1/5, visualClass: "stage-cooldown",  sound: "stageChime" },
    ],
  },
  "reading-guided": {
    baseAnimation: "reading",
    encouragement: { intervalSeconds: 30, sound: "encourage" },
    stages: [
      { label: "Start reading", fraction: 1/3, visualClass: "stage-read-start", sound: "stageChime" },
      { label: "Keep going",    fraction: 1/3, visualClass: "stage-read-mid",   sound: "stageChime" },
      { label: "Almost done",   fraction: 1/3, visualClass: "stage-read-end",   sound: "stageChime" },
    ],
  },
  "cleaning-guided": {
    baseAnimation: "cleaning",
    encouragement: { intervalSeconds: 30, sound: "encourage" },
    stages: [
      { label: "Pick up items",  fraction: 1/4, visualClass: "stage-pickup",  sound: "stageChime" },
      { label: "Wipe surfaces",  fraction: 1/4, visualClass: "stage-wipe",    sound: "stageChime" },
      { label: "Sweep / vacuum", fraction: 1/4, visualClass: "stage-sweep",   sound: "stageChime" },
      { label: "Final check",    fraction: 1/4, visualClass: "stage-check",   sound: "stageChime" },
    ],
  },
};

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
      eventBus.on("worklog:changed", () => this._syncRemoteTimers()),
    );
    this._render();

    // Handle visibility change for sound resumption
    this._onVisibility = () => {
      if (!document.hidden && this._timers.size > 0 && !this._rafId) {
        this._rafId = requestAnimationFrame(() => this._tick());
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);

    // Stale cleanup: clock out orphaned entries for current user
    this._cleanupStaleTimers();
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

  async _begin(taskId, userId) {
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
      animation: task.timerBonus.animationOverrides?.[userId] ?? (task.timerBonus.animation || "none"),
      startTime: performance.now(),
      elapsed: 0,
      targetHitPlayed: false,
      lastTickKey: -1,
      paused: false,
      pausedAt: null,
      pausedElapsed: 0,
      pauseCount: 0,
      pauseCooldownUntil: 0,
      remote: false,
      worklogId: null,
      _stageIndex: 0,
      _lastEncourageKey: -1,
    });

    this._focusedKey = key;
    this._render();
    this._acquireWakeLock();

    // Start rAF loop if not already running
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => this._tick());
    }

    // Clock in to worklog for cross-device sync
    try {
      const entry = await tracker.clockIn(taskId, userId);
      const timer = this._timers.get(key);
      if (timer && entry) timer.worklogId = entry.id;
    } catch (e) {
      // Non-fatal — timer still works locally
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

    // Sync pause to server
    tracker.pauseTimer(timer.taskId, timer.userId).catch(() => {});
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

    // Sync resume to server
    tracker.resumeTimer(timer.taskId, timer.userId).catch(() => {});
  }

  _cancel(key) {
    const timer = this._timers.get(key);
    this._timers.delete(key);
    if (this._focusedKey === key) this._focusedKey = null;
    this._checkEmpty();
    this._render();

    // Clock out on server (fire-and-forget)
    if (timer) tracker.clockOut(timer.taskId, timer.userId).catch(() => {});
  }

  async _complete(key) {
    const timer = this._timers.get(key);
    if (!timer) return;

    // If paused, use the frozen elapsed; otherwise use live
    const elapsed = Math.round(timer.paused ? timer.pausedElapsed : timer.elapsed);
    const result = await tracker.completeTask(timer.taskId, timer.userId, elapsed);

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

    // Clock out on server
    tracker.clockOut(timer.taskId, timer.userId).catch(() => {});

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

  // --- Animation script helpers ---

  _getScript(animation) {
    return ANIMATION_SCRIPTS[animation] || null;
  }

  _getStageIndex(elapsed, targetSeconds, script) {
    if (!script) return 0;
    const fraction = Math.min(elapsed / targetSeconds, 1);
    let cumulative = 0;
    for (let i = 0; i < script.stages.length; i++) {
      cumulative += script.stages[i].fraction;
      if (fraction < cumulative) return i;
    }
    return script.stages.length - 1;
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

      // Stage transitions and encouragement for guided animations
      const script = this._getScript(timer.animation);
      if (script) {
        const newStage = this._getStageIndex(timer.elapsed, timer.targetSeconds, script);
        if (newStage !== timer._stageIndex) {
          const prevStage = timer._stageIndex;
          timer._stageIndex = newStage;
          const sfx = window.slopSFX;
          if (sfx && script.stages[newStage].sound) {
            sfx[script.stages[newStage].sound](newStage);
          }
          // Flash completed segment
          const prevSeg = this.shadowRoot?.getElementById(`ring-seg-${prevStage}`);
          if (prevSeg) {
            prevSeg.classList.add("seg-flash");
            setTimeout(() => prevSeg.classList.remove("seg-flash"), 600);
          }
        }

        if (script.encouragement) {
          const encourageKey = Math.floor(timer.elapsed / script.encouragement.intervalSeconds);
          if (encourageKey > 0 && encourageKey !== timer._lastEncourageKey) {
            timer._lastEncourageKey = encourageKey;
            const sfx = window.slopSFX;
            if (sfx && sfx[script.encouragement.sound]) {
              sfx[script.encouragement.sound]();
            }
          }
        }
      }
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

    // Stop ticking once count-up timers reach their target
    if (timer.timerMode === "over" && timer.elapsed >= timer.targetSeconds) return;

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
        case "celebrate": sfx.celebrate(); break;
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
        if (ring) ring.style.strokeDashoffset = circumference * (1 - pct);

        if (elapsed >= timer.targetSeconds) {
          display.className = "card-time target-hit";
          if (ring) ring.style.stroke = "var(--success)";
          statusEl.textContent = "Target reached! Bonus earned.";
          if (glow) glow.style.background = "radial-gradient(circle, rgba(80,250,123,0.12) 0%, transparent 70%)";
        } else {
          display.className = "card-time" + (isCritical ? " critical" : isUrgent ? " urgent" : "");
          if (ring) ring.style.stroke = isUrgent ? "var(--warning)" : "var(--accent)";
          statusEl.textContent = `Keep going — ${this._formatTime(remaining)} to bonus`;
          if (glow) glow.style.background = "radial-gradient(circle, rgba(102,217,239,0.06) 0%, transparent 70%)";
        }
      } else {
        if (ring) ring.style.strokeDashoffset = circumference * pct;

        if (remaining > 0) {
          display.textContent = this._formatTime(remaining);
          display.className = "card-time" + (isCritical ? " critical" : isUrgent ? " urgent" : "");
          if (ring) ring.style.stroke = isCritical ? "var(--danger)" : isUrgent ? "var(--warning)" : "var(--accent)";
          statusEl.textContent = `Finish before ${this._formatTime(timer.targetSeconds)}`;
          if (glow) {
            const glowColor = isCritical ? "rgba(255,107,129,0.1)" : isUrgent ? "rgba(241,250,140,0.08)" : "rgba(102,217,239,0.06)";
            glow.style.background = `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`;
          }
        } else {
          display.textContent = "+" + this._formatTime(elapsed - timer.targetSeconds);
          display.className = "card-time target-hit over";
          if (ring) ring.style.stroke = "var(--danger)";
          statusEl.textContent = "Over target! Bonus lost.";
          if (glow) glow.style.background = "radial-gradient(circle, rgba(255,107,129,0.1) 0%, transparent 70%)";
        }
      }

      // Update segmented ring (guided animations)
      const ringScript = this._getScript(timer.animation);
      if (ringScript && !ring) {
        const gap = 4;
        const allSegsDone = elapsed >= timer.targetSeconds;
        for (let i = 0; i < ringScript.stages.length; i++) {
          const seg = this.shadowRoot.getElementById(`ring-seg-${i}`);
          if (!seg) continue;
          const fraction = ringScript.stages[i].fraction;
          const fullArc = Math.max(0, fraction * circumference - gap);

          if (allSegsDone || i < timer._stageIndex) {
            // Completed segment
            seg.style.strokeDasharray = `${fullArc} ${circumference - fullArc}`;
            seg.style.stroke = "var(--success, #50fa7b)";
            seg.classList.add("seg-done");
            seg.classList.remove("seg-active");
          } else if (i === timer._stageIndex) {
            // Current segment — partial fill
            let cumBefore = 0;
            for (let j = 0; j < i; j++) cumBefore += ringScript.stages[j].fraction;
            const stageStart = cumBefore * timer.targetSeconds;
            const stageDuration = fraction * timer.targetSeconds;
            const stageProgress = Math.min(1, Math.max(0, (elapsed - stageStart) / stageDuration));
            const currentArc = stageProgress * fullArc;
            seg.style.strokeDasharray = `${currentArc} ${circumference - currentArc}`;
            seg.style.stroke = "var(--accent, #66d9ef)";
            seg.classList.add("seg-active");
            seg.classList.remove("seg-done");
          } else {
            // Future segment — hidden
            seg.style.strokeDasharray = `0 ${circumference}`;
            seg.style.stroke = "rgba(255,255,255,0.1)";
            seg.classList.remove("seg-done", "seg-active");
          }
        }
      }

      // Update animation play state and guided stage visuals
      const animEl = this.shadowRoot.getElementById("card-animation");
      if (animEl) {
        animEl.style.animationPlayState = timer.paused ? "paused" : "running";
        const svgEl = animEl.querySelector(".anim-svg");
        if (svgEl) {
          svgEl.style.animationPlayState = timer.paused ? "paused" : "running";
          svgEl.querySelectorAll("*").forEach(el => {
            el.style.animationPlayState = timer.paused ? "paused" : "running";
          });
        }

        // Guided animation: swap visual class on animation container
        const script = this._getScript(timer.animation);
        if (script) {
          const stage = script.stages[timer._stageIndex];
          if (stage) {
            // Remove old stage classes, add current
            for (const s of script.stages) {
              animEl.classList.remove(s.visualClass);
            }
            animEl.classList.add(stage.visualClass);
          }
        }

        // Teeth diagram: zone highlighting + brush positioning
        if (timer.animation === "toothbrush-guided") {
          const allDone = elapsed >= timer.targetSeconds;
          animEl.querySelectorAll(".tooth-zone").forEach((zone) => {
            const zoneIdx = parseInt(zone.dataset.stage);
            zone.classList.toggle("zone-active", !allDone && zoneIdx === timer._stageIndex);
            zone.classList.toggle("zone-done", allDone || zoneIdx < timer._stageIndex);
          });
          const brush = animEl.querySelector("#teeth-brush");
          if (brush) {
            if (allDone) {
              brush.style.opacity = "0";
            } else {
              brush.style.opacity = "1";
              const pos = PsTimerTray.BRUSH_POSITIONS[timer._stageIndex] || [90, 50, 1];
              brush.setAttribute("transform", `translate(${pos[0]}, ${pos[1]}) scale(${pos[2]}, 1)`);
              // Alternate scrub direction every ~8s (20 strokes)
              const useH = Math.floor(elapsed / 8) % 2 === 1;
              brush.classList.toggle("scrub-h", useH);
            }
          }
        }
      }

      // Update stage label and dots
      const stageLabel = this.shadowRoot.getElementById("card-stage-label");
      const stageDots = this.shadowRoot.getElementById("card-stage-dots");
      const script = this._getScript(timer.animation);
      if (script && stageLabel) {
        stageLabel.textContent = script.stages[timer._stageIndex]?.label || "";
      }
      if (script && stageDots) {
        const dots = stageDots.querySelectorAll(".stage-dot");
        dots.forEach((dot, i) => {
          dot.classList.toggle("done", i < timer._stageIndex);
          dot.classList.toggle("current", i === timer._stageIndex);
        });
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

  // --- Remote timer sync ---

  _syncRemoteTimers() {
    const worklog = trackerStore.worklog?.data || [];
    const tasks = trackerStore.tasks?.data || [];
    const users = trackerStore.users?.data || [];
    const currentUser = tracker.getCurrentUser();
    const currentUserId = currentUser?.id;

    // Find all open worklog entries on timed tasks
    const openEntries = worklog.filter((e) => {
      if (e.clockOut) return false;
      const task = tasks.find((t) => t.id === e.taskId);
      return task && task.timerBonus;
    });

    const activeKeys = new Set();

    for (const entry of openEntries) {
      const key = `${entry.taskId}:${entry.userId}`;
      activeKeys.add(key);

      const existing = this._timers.get(key);
      const task = tasks.find((t) => t.id === entry.taskId);
      const user = users.find((u) => u.id === entry.userId);

      // Compute elapsed from worklog entry
      let elapsed;
      if (entry.pausedAt) {
        elapsed = entry.elapsedBeforePause || 0;
      } else {
        elapsed = (entry.elapsedBeforePause || 0) + (Date.now() - new Date(entry.clockIn).getTime()) / 1000;
      }

      if (existing && !existing.remote && entry.userId === currentUserId) {
        // Local timer owned by current user — sync pause/resume state from server
        // (another device may have paused/resumed it)
        const serverPaused = !!entry.pausedAt;
        if (serverPaused && !existing.paused) {
          existing.paused = true;
          existing.pausedAt = performance.now();
          existing.pausedElapsed = elapsed;
        } else if (!serverPaused && existing.paused) {
          existing.startTime = performance.now() - elapsed * 1000;
          existing.paused = false;
          existing.pausedAt = null;
        }
        existing.worklogId = entry.id;
      } else if (existing) {
        // Update existing remote timer state from server
        existing.paused = !!entry.pausedAt;
        existing.pausedElapsed = entry.pausedAt ? elapsed : existing.pausedElapsed;
        if (!entry.pausedAt) {
          existing.startTime = performance.now() - elapsed * 1000;
        }
        existing.worklogId = entry.id;
      } else {
        // Create new remote timer
        this._timers.set(key, {
          taskId: entry.taskId,
          userId: entry.userId,
          userName: user ? user.name : "?",
          taskName: task.name,
          targetSeconds: task.timerBonus.targetSeconds,
          timerMode: task.timerBonus.mode || "under",
          tickSound: task.timerBonus.tickSound || "click",
          hitSound: task.timerBonus.hitSound || "success",
          animation: task.timerBonus.animationOverrides?.[entry.userId] ?? (task.timerBonus.animation || "none"),
          startTime: performance.now() - elapsed * 1000,
          elapsed,
          targetHitPlayed: false,
          lastTickKey: -1,
          paused: !!entry.pausedAt,
          pausedAt: entry.pausedAt ? performance.now() : null,
          pausedElapsed: elapsed,
          pauseCount: 0,
          pauseCooldownUntil: 0,
          remote: true,
          worklogId: entry.id,
          _stageIndex: 0,
          _lastEncourageKey: -1,
        });
      }
    }

    // Remove timers whose worklog entry is now closed (completed/cancelled on another device)
    for (const [key, timer] of this._timers) {
      if (!activeKeys.has(key) && timer.worklogId) {
        this._timers.delete(key);
        if (this._focusedKey === key) this._focusedKey = null;
      }
    }

    // Start rAF if we now have timers
    if (this._timers.size > 0 && !this._rafId) {
      this._rafId = requestAnimationFrame(() => this._tick());
      this._acquireWakeLock();
    }

    this._checkEmpty();
    this._render();
  }

  _cleanupStaleTimers() {
    const currentUser = tracker.getCurrentUser();
    if (!currentUser) return;
    const worklog = trackerStore.worklog?.data || [];
    const tasks = trackerStore.tasks?.data || [];

    // Find open worklog entries for current user on timed tasks
    for (const entry of worklog) {
      if (entry.clockOut) continue;
      if (entry.userId !== currentUser.id) continue;
      const task = tasks.find((t) => t.id === entry.taskId);
      if (!task || !task.timerBonus) continue;

      const key = `${entry.taskId}:${entry.userId}`;
      // If we don't have a local timer for this, it's orphaned — clock it out
      if (!this._timers.has(key)) {
        tracker.clockOut(entry.taskId, entry.userId).catch(() => {});
      }
    }
  }

  // --- Segmented ring for guided animations ---

  _getSegmentedRingSvg(script, radius, circumference) {
    const gap = 4;
    let svg = `<circle class="ring-bg" cx="90" cy="90" r="${radius}" />`;

    let cumulative = 0;
    for (let i = 0; i < script.stages.length; i++) {
      const fraction = script.stages[i].fraction;
      const arcLen = Math.max(0, fraction * circumference - gap);
      const remainder = circumference - arcLen;
      const startOffset = -(cumulative * circumference + gap / 2);

      svg += `<circle class="ring-segment" id="ring-seg-${i}" cx="90" cy="90" r="${radius}"
        stroke-dasharray="${arcLen} ${remainder}"
        stroke-dashoffset="${startOffset}" />`;

      cumulative += fraction;
    }

    // Tick marks at stage boundaries
    cumulative = 0;
    for (let i = 0; i < script.stages.length - 1; i++) {
      cumulative += script.stages[i].fraction;
      const angle = cumulative * 2 * Math.PI;
      const innerR = radius - 6;
      const outerR = radius + 6;
      svg += `<line class="ring-tick"
        x1="${90 + innerR * Math.cos(angle)}" y1="${90 + innerR * Math.sin(angle)}"
        x2="${90 + outerR * Math.cos(angle)}" y2="${90 + outerR * Math.sin(angle)}" />`;
    }

    return svg;
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
        <button class="pill${timer.paused ? " paused" : ""}${key === this._focusedKey ? " focused" : ""}${timer.remote ? " remote" : ""}"
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
            <div class="card-user-label">${timer.remote ? `${timer.userName}'s timer` : timer.userName}</div>

            <div class="ring-container">
              <svg class="ring-svg" viewBox="0 0 180 180">
                ${(() => {
                  const script = this._getScript(timer.animation);
                  return script
                    ? this._getSegmentedRingSvg(script, radius, circumference)
                    : `<circle class="ring-bg" cx="90" cy="90" r="${radius}" />
                       <circle class="ring-progress" id="card-ring-progress" cx="90" cy="90" r="${radius}" />`;
                })()}
              </svg>
              <div class="ring-time">
                <div class="card-time" id="card-display">${this._formatTime(elapsed)}</div>
              </div>
            </div>

            ${timer.animation !== "none" ? `<div class="card-animation${timer.animation === "toothbrush-guided" ? " teeth-variant" : ""}" id="card-animation">${this._getAnimationHtml(timer.animation)}</div>` : ""}

            ${this._getScript(timer.animation) ? (() => {
              const script = this._getScript(timer.animation);
              const stage = script.stages[timer._stageIndex];
              return `
                <div class="stage-label" id="card-stage-label">${stage?.label || ""}</div>
                <div class="stage-dots" id="card-stage-dots">
                  ${script.stages.map((s, i) =>
                    `<div class="stage-dot${i < timer._stageIndex ? " done" : ""}${i === timer._stageIndex ? " current" : ""}" title="${s.label}"></div>`
                  ).join("")}
                </div>
              `;
            })() : ""}

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

  _getTeethDiagramHtml() {
    // Zone positions: [x, y, width, height] for each tooth
    // Upper arch: zone 0 (upper-left), zone 1 (upper-front), zone 2 (upper-right)
    // Lower arch: zone 3 (lower-left), zone 4 (lower-front), zone 5 (lower-right)
    const zones = [
      // Zone 0: Upper left (3 teeth, molars to premolars)
      { teeth: [{x:32,y:32,w:10,h:16,rx:3},{x:44,y:30,w:10,h:18,rx:3},{x:56,y:28,w:10,h:20,rx:3}] },
      // Zone 1: Upper front (4 teeth, incisors/canines)
      { teeth: [{x:68,y:24,w:9,h:26,rx:3},{x:79,y:22,w:10,h:28,rx:3},{x:91,y:22,w:10,h:28,rx:3},{x:103,y:24,w:9,h:26,rx:3}] },
      // Zone 2: Upper right (3 teeth)
      { teeth: [{x:114,y:28,w:10,h:20,rx:3},{x:126,y:30,w:10,h:18,rx:3},{x:138,y:32,w:10,h:16,rx:3}] },
      // Zone 3: Lower left (3 teeth)
      { teeth: [{x:32,y:72,w:10,h:16,rx:3},{x:44,y:70,w:10,h:18,rx:3},{x:56,y:68,w:10,h:20,rx:3}] },
      // Zone 4: Lower front (4 teeth)
      { teeth: [{x:68,y:66,w:9,h:26,rx:3},{x:79,y:64,w:10,h:28,rx:3},{x:91,y:64,w:10,h:28,rx:3},{x:103,y:66,w:9,h:26,rx:3}] },
      // Zone 5: Lower right (3 teeth)
      { teeth: [{x:114,y:68,w:10,h:20,rx:3},{x:126,y:70,w:10,h:18,rx:3},{x:138,y:72,w:10,h:16,rx:3}] },
    ];

    let teethSvg = "";

    // Seeded random for consistent grime placement
    const seeded = (s) => () => { s = (s * 16807 + 0) % 2147483647; return s / 2147483647; };

    // Tooth zone groups
    for (let z = 0; z < zones.length; z++) {
      const rng = seeded(z * 1000 + 7);
      teethSvg += `<g class="tooth-zone" data-stage="${z}">`;
      for (const t of zones[z].teeth) {
        teethSvg += `<rect class="tooth" x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="${t.rx}" />`;
        // Grime splotches on each tooth (jagged irregular shapes)
        for (let g = 0; g < 5; g++) {
          const cx = t.x + 2 + rng() * (t.w - 4);
          const cy = t.y + 3 + rng() * (t.h - 6);
          const sz = 1.5 + rng() * 2.5;
          const colors = ["rgba(90,100,30,0.7)", "rgba(50,160,50,0.5)", "rgba(30,30,30,0.6)", "rgba(140,130,40,0.65)", "rgba(70,130,50,0.55)", "rgba(20,20,15,0.5)", "rgba(160,150,60,0.6)", "rgba(40,80,30,0.6)"];
          // Jagged polygon with 5-6 irregular points
          const pts = [];
          const numPts = 5 + Math.floor(rng() * 2);
          for (let p = 0; p < numPts; p++) {
            const a = (p / numPts) * Math.PI * 2;
            const r = sz * (0.5 + rng() * 0.7);
            pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
          }
          teethSvg += `<polygon class="grime" points="${pts.join(" ")}" fill="${colors[g % colors.length]}" />`;
        }
      }
      teethSvg += `</g>`;
    }

    // Gum arcs (drawn on top of teeth — at the roots)
    teethSvg += `<path class="gum-line" d="M24 30 Q90 18 156 30" />`;
    teethSvg += `<path class="gum-line" d="M24 90 Q90 98 156 90" />`;

    // Bubble layer (drawn on top of gums, grouped by zone for class toggling)
    for (let z = 0; z < zones.length; z++) {
      const zoneTeeth = zones[z].teeth;
      const zMinX = Math.min(...zoneTeeth.map(t => t.x));
      const zMaxX = Math.max(...zoneTeeth.map(t => t.x + t.w));
      const zMinY = Math.min(...zoneTeeth.map(t => t.y));
      const zMaxY = Math.max(...zoneTeeth.map(t => t.y + t.h));
      const padX = 12, padY = 10;
      const bRng = seeded(z * 2000 + 13);
      teethSvg += `<g class="tooth-zone" data-stage="${z}">`;
      for (let b = 0; b < 10; b++) {
        const bx = (zMinX - padX) + bRng() * (zMaxX - zMinX + padX * 2);
        const by = (zMinY - padY) + bRng() * (zMaxY - zMinY + padY * 2);
        const br = 1.5 + bRng() * 3;
        const delay = (bRng() * 2.5).toFixed(2);
        const dur = (1.2 + bRng() * 1.2).toFixed(2);
        teethSvg += `<circle class="bubble" cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${br.toFixed(1)}" style="animation-delay:${delay}s;animation-duration:${dur}s" />`;
      }
      teethSvg += `</g>`;
    }

    // Toothbrush overlay (inner scrub group moves the whole brush)
    teethSvg += `<g class="teeth-brush" id="teeth-brush">
      <g class="tb-scrub">
        <rect class="tb-handle" x="-50" y="-5" width="50" height="10" rx="4" fill="#8be9fd"/>
        <rect x="0" y="-8" width="28" height="16" rx="4" fill="#f8f8f2"/>
        <line x1="4" y1="-5" x2="4" y2="5" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="10" y1="-5" x2="10" y2="5" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="16" y1="-5" x2="16" y2="5" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="22" y1="-5" x2="22" y2="5" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
      </g>
    </g>`;

    return `<svg class="anim-svg anim-teeth-diagram" viewBox="0 0 200 120">${teethSvg}</svg>`;
  }

  // Brush position per zone: [x, y, scaleX]
  // Head is 28 wide (center at local x=14). scaleX=-1 mirrors, so offset accordingly.
  static BRUSH_POSITIONS = [
    [63, 38, -1],   // upper-left: teeth center ~49, +14 for mirrored head
    [76, 36, 1],    // upper-front: teeth center ~90, -14 for head center
    [117, 38, 1],   // upper-right: teeth center ~131, -14
    [63, 78, -1],   // lower-left
    [76, 80, 1],    // lower-front
    [117, 78, 1],   // lower-right
  ];

  _getAnimationHtml(key) {
    // Teeth diagram for toothbrush-guided
    if (key === "toothbrush-guided") return this._getTeethDiagramHtml();

    // Other guided animations use the base animation's SVG
    const script = ANIMATION_SCRIPTS[key];
    if (script) key = script.baseAnimation;

    switch (key) {
      case "toothbrush":
        return `<svg class="anim-svg anim-toothbrush" viewBox="0 0 120 80" fill="none">
          <rect class="tb-handle" x="20" y="35" width="50" height="10" rx="3" fill="#8be9fd"/>
          <rect class="tb-head" x="70" y="30" width="30" height="20" rx="4" fill="#f8f8f2"/>
          <line x1="74" y1="33" x2="74" y2="47" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="80" y1="33" x2="80" y2="47" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="86" y1="33" x2="86" y2="47" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="92" y1="33" x2="92" y2="47" stroke="#a0a4be" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`;

      case "exercise":
        return `<svg class="anim-svg anim-exercise" viewBox="0 0 120 80" fill="none">
          <circle cx="60" cy="12" r="7" fill="#f1fa8c"/>
          <line class="ex-body" x1="60" y1="19" x2="60" y2="48" stroke="#f1fa8c" stroke-width="2.5" stroke-linecap="round"/>
          <line class="ex-arm-l" x1="60" y1="28" x2="42" y2="18" stroke="#f1fa8c" stroke-width="2.5" stroke-linecap="round"/>
          <line class="ex-arm-r" x1="60" y1="28" x2="78" y2="18" stroke="#f1fa8c" stroke-width="2.5" stroke-linecap="round"/>
          <line class="ex-leg-l" x1="60" y1="48" x2="44" y2="72" stroke="#f1fa8c" stroke-width="2.5" stroke-linecap="round"/>
          <line class="ex-leg-r" x1="60" y1="48" x2="76" y2="72" stroke="#f1fa8c" stroke-width="2.5" stroke-linecap="round"/>
        </svg>`;

      case "reading":
        return `<svg class="anim-svg anim-reading" viewBox="0 0 120 80" fill="none">
          <path class="book-left" d="M60 20 L60 70 Q40 65 20 70 L20 20 Q40 15 60 20Z" fill="#bd93f9" opacity="0.7"/>
          <path class="book-right" d="M60 20 L60 70 Q80 65 100 70 L100 20 Q80 15 60 20Z" fill="#bd93f9" opacity="0.5"/>
          <path class="book-page" d="M60 22 L60 68 Q75 63 90 67 L90 22 Q75 17 60 22Z" fill="#f8f8f2" opacity="0.15"/>
          <line x1="60" y1="20" x2="60" y2="70" stroke="#f8f8f2" stroke-width="1.5" opacity="0.4"/>
        </svg>`;

      case "cleaning":
        return `<svg class="anim-svg anim-cleaning" viewBox="0 0 120 80" fill="none">
          <line class="broom-handle" x1="60" y1="5" x2="60" y2="50" stroke="#ffb86c" stroke-width="3" stroke-linecap="round"/>
          <path class="broom-head" d="M40 50 Q45 48 50 55 Q55 48 60 55 Q65 48 70 55 Q75 48 80 50 L78 72 Q60 68 42 72Z" fill="#ffb86c" opacity="0.8"/>
        </svg>`;

      default:
        return "";
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

      .pill.remote {
        border-color: rgba(189, 147, 249, 0.3);
      }

      .pill.remote .pill-avatar {
        color: #bd93f9;
        background: radial-gradient(circle at 30% 0%, rgba(255,255,255,0.12), rgba(189,147,249,0.25));
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

      /* Segmented ring (guided animations) */
      .ring-segment {
        fill: none;
        stroke-width: 6;
        stroke-linecap: round;
        stroke: rgba(255, 255, 255, 0.1);
        transition: stroke 0.4s ease;
      }

      .ring-tick {
        stroke: rgba(255, 255, 255, 0.2);
        stroke-width: 1.5;
      }

      .seg-done {
        filter: drop-shadow(0 0 3px rgba(80, 250, 123, 0.4));
      }

      .seg-active {
        filter: drop-shadow(0 0 3px rgba(102, 217, 239, 0.3));
      }

      .seg-flash {
        animation: segFlash 600ms ease-out;
      }

      @keyframes segFlash {
        0% { filter: drop-shadow(0 0 12px rgba(80, 250, 123, 0.8)); stroke-width: 8; }
        100% { filter: drop-shadow(0 0 3px rgba(80, 250, 123, 0.4)); stroke-width: 6; }
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

      /* --- Stage label & dots (guided animations) --- */
      .stage-label {
        position: relative;
        font-size: 0.92rem;
        font-weight: 600;
        color: #f1fa8c;
        text-align: center;
        margin: 0 auto 6px;
        transition: opacity 0.3s ease;
        animation: stageLabelIn 0.3s ease-out;
      }

      @keyframes stageLabelIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .stage-dots {
        display: flex;
        justify-content: center;
        gap: 8px;
        margin: 0 auto 10px;
      }

      .stage-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.12);
        border: 1.5px solid rgba(255, 255, 255, 0.15);
        transition: background 0.3s ease, border-color 0.3s ease, transform 0.3s ease;
      }

      .stage-dot.current {
        background: #f1fa8c;
        border-color: #f1fa8c;
        transform: scale(1.25);
        box-shadow: 0 0 8px rgba(241, 250, 140, 0.4);
      }

      .stage-dot.done {
        background: #50fa7b;
        border-color: #50fa7b;
      }

      /* --- Task animations --- */
      .card-animation {
        position: relative;
        height: 80px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 4px auto 8px;
        overflow: hidden;
        transition: transform 0.3s ease;
      }

      .anim-svg {
        height: 70px;
        width: auto;
      }

      /* Toothbrush — sweeps side to side */
      .anim-toothbrush {
        animation: toothbrushSweep 1.2s ease-in-out infinite;
      }

      @keyframes toothbrushSweep {
        0%, 100% { transform: translateX(-14px) rotate(-5deg); }
        50% { transform: translateX(14px) rotate(5deg); }
      }

      /* Exercise — jumping jacks */
      .anim-exercise .ex-arm-l {
        transform-origin: 60px 28px;
        animation: armL 0.8s ease-in-out infinite;
      }
      .anim-exercise .ex-arm-r {
        transform-origin: 60px 28px;
        animation: armR 0.8s ease-in-out infinite;
      }
      .anim-exercise .ex-leg-l {
        transform-origin: 60px 48px;
        animation: legL 0.8s ease-in-out infinite;
      }
      .anim-exercise .ex-leg-r {
        transform-origin: 60px 48px;
        animation: legR 0.8s ease-in-out infinite;
      }
      .anim-exercise .ex-body {
        animation: bodyBounce 0.8s ease-in-out infinite;
      }

      @keyframes armL {
        0%, 100% { transform: rotate(0deg); }
        50% { transform: rotate(60deg); }
      }
      @keyframes armR {
        0%, 100% { transform: rotate(0deg); }
        50% { transform: rotate(-60deg); }
      }
      @keyframes legL {
        0%, 100% { transform: rotate(0deg); }
        50% { transform: rotate(-20deg); }
      }
      @keyframes legR {
        0%, 100% { transform: rotate(0deg); }
        50% { transform: rotate(20deg); }
      }
      @keyframes bodyBounce {
        0%, 100% { transform: translateY(0); }
        25% { transform: translateY(-4px); }
        75% { transform: translateY(0); }
      }

      /* Reading — page turning */
      .anim-reading .book-page {
        transform-origin: 60px 45px;
        animation: pageTurn 2.5s ease-in-out infinite;
      }

      @keyframes pageTurn {
        0%, 40% { transform: scaleX(1); opacity: 0.15; }
        50% { transform: scaleX(0); opacity: 0.3; }
        60%, 100% { transform: scaleX(1); opacity: 0.15; }
      }

      /* Cleaning — broom sweeping */
      .anim-cleaning {
        animation: broomSweep 1.4s ease-in-out infinite;
      }

      @keyframes broomSweep {
        0%, 100% { transform: translateX(-16px) rotate(-8deg); }
        50% { transform: translateX(16px) rotate(8deg); }
      }

      /* --- Guided animation stage variants --- */

      /* Teeth diagram (toothbrush-guided) */
      .card-animation.teeth-variant {
        height: 120px;
      }

      .anim-teeth-diagram {
        height: 110px;
        width: auto;
      }

      .tooth {
        fill: rgba(230, 240, 180, 0.7);
        transition: fill 0.4s ease, filter 0.4s ease;
      }

      .grime {
        transition: opacity 0.4s ease;
      }

      .zone-active .grime,
      .zone-done .grime {
        opacity: 0;
      }

      .bubble {
        fill: rgba(200, 230, 255, 0.3);
        stroke: rgba(220, 240, 255, 0.8);
        stroke-width: 0.8;
        opacity: 0;
        transform-box: fill-box;
        transform-origin: center;
      }

      .zone-active .bubble {
        animation: bubblePop 1.8s ease-in-out infinite;
      }

      @keyframes bubblePop {
        0%   { opacity: 0; transform: scale(0) translateY(0); }
        20%  { opacity: 0.9; transform: scale(0.8) translateY(-1px); }
        50%  { opacity: 1; transform: scale(1.2) translateY(-3px); }
        80%  { opacity: 0.7; transform: scale(1) translateY(-5px); }
        100% { opacity: 0; transform: scale(0) translateY(-7px); }
      }

      .gum-line {
        stroke: rgb(180, 75, 95);
        stroke-width: 12;
        stroke-linecap: round;
        fill: none;
      }

      .zone-active .tooth {
        fill: rgba(220, 240, 255, 0.75);
        filter: drop-shadow(0 0 8px rgba(180, 220, 255, 0.5));
        animation: foamy 0.6s ease-in-out infinite alternate;
      }

      @keyframes foamy {
        0% { filter: drop-shadow(0 0 6px rgba(180, 220, 255, 0.4)); }
        100% { filter: drop-shadow(0 0 10px rgba(200, 235, 255, 0.7)); }
      }

      .zone-done .tooth {
        fill: rgba(255, 255, 255, 0.92);
        filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.3));
      }

      .teeth-brush {
        transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.5s ease;
      }

      .teeth-brush .tb-scrub {
        animation: scrubV 0.4s ease-in-out infinite;
      }

      .teeth-brush.scrub-h .tb-scrub {
        animation-name: scrubH;
      }

      @keyframes scrubV {
        0%, 100% { transform: translate(0, 0); }
        25%  { transform: translateY(-3px); }
        75%  { transform: translateY(3px); }
      }
      @keyframes scrubH {
        0%, 100% { transform: translate(0, 0); }
        25%  { transform: translateX(-10px); }
        75%  { transform: translateX(10px); }
      }

      /* Exercise guided: speed/style changes */
      .stage-warmup .anim-svg   { animation-duration: 1.2s; }
      .stage-jumping .anim-svg  { animation-duration: 0.5s; }
      .stage-stretch .anim-svg  { animation-duration: 2.0s; }
      .stage-squats .anim-svg   { animation-duration: 0.7s; }
      .stage-cooldown .anim-svg { animation-duration: 2.5s; }

      /* Reading guided: subtle scale/opacity shifts */
      .stage-read-start .anim-svg { opacity: 0.8; }
      .stage-read-mid .anim-svg   { opacity: 1; transform: scale(1.05); }
      .stage-read-end .anim-svg   { opacity: 1; transform: scale(1.1); }

      /* Cleaning guided: sweep style changes */
      .stage-pickup .anim-svg  { animation-duration: 1.0s; }
      .stage-wipe .anim-svg    { animation-duration: 0.6s; }
      .stage-sweep .anim-svg   { animation-duration: 1.4s; }
      .stage-check .anim-svg   { animation-duration: 2.0s; }
    `;
  }
}

customElements.define("ps-timer-tray", PsTimerTray);
