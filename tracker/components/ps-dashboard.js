// ps-dashboard: Main kid-friendly view with sections for daily tasks, job board,
// penalties, completions, streaks, and celebration animations + sounds.
class PsDashboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._unsubs = [];
    this._timerInterval = null;
    this._openMenuId = null;
    this._penaltyPickerOpen = false;
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("balances:changed", () => this.render()),
      eventBus.on("tasks:changed", () => this.render()),
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("currencies:changed", () => this.render()),
      eventBus.on("jobclaims:changed", () => this.render()),
      eventBus.on("worklog:changed", () => this.render()),
    );
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((u) => u());
    if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
  }

  render() {
    if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }

    const user = tracker.getCurrentUser();
    if (!user) return;

    const allTasks = tracker.getTasksForUser(user.id);
    const currencies = trackerStore.currencies.data;

    // --- Admin overview data ---
    let adminKids = [];
    let penaltyTasks = [];
    if (user.isAdmin) {
      penaltyTasks = trackerStore.tasks.data.filter((t) => !t.archived && t.isPenalty);
      const allUsers = trackerStore.users.data.filter((u) => !u.isAdmin);
      adminKids = allUsers.map((kid) => {
        const kidTasks = tracker.getTasksForUser(kid.id);
        const dailyTasks = kidTasks.filter((t) => t.recurrence === "daily" && t.category !== "jobboard");
        const dailyDone = dailyTasks.filter((t) => tracker.isTaskCompletedToday(t.id, kid.id)).length;
        const dailyTotal = dailyTasks.length;
        const activeJobClaims = tracker.getUserActiveJobs(kid.id);
        const activeJobs = activeJobClaims.map((c) => {
          const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
          const clockedIn = task ? tracker.getActiveClockIn(task.id, kid.id) !== null : false;
          return { name: task?.name || "Unknown", taskId: c.taskId, clockedIn };
        });
        const balances = currencies.map((c) => ({
          formatted: tracker.formatAmount(tracker.getBalance(kid.id, c.id), c.id),
          currencyName: c.name,
        }));
        const recentPenaltyCount = tracker.getRecentPenalties(kid.id, 7).length;
        return { ...kid, dailyDone, dailyTotal, activeJobs, balances, recentPenaltyCount };
      });
    }

    // --- Unseen penalty notification ---
    let _penaltySeenCutoff = null; // timestamp before update, used to mark rows as new
    if (!user.isAdmin) {
      if (!user.lastPenaltySeenAt) {
        // First run after deploy: initialize silently so old penalties don't trigger
        user.lastPenaltySeenAt = tracker.now();
        trackerStore.users.save();
      } else {
        _penaltySeenCutoff = user.lastPenaltySeenAt;
        const unseenCount = trackerStore.completions.data.filter(
          (c) => c.userId === user.id && c.isPenalty && c.completedAt > _penaltySeenCutoff
        ).length;
        if (unseenCount > 0) {
          user.lastPenaltySeenAt = tracker.now();
          trackerStore.users.save();
          // Staggered sad trombones — overlapping for crescendo
          for (let i = 0; i < unseenCount; i++) {
            setTimeout(() => {
              if (typeof slopSFX !== "undefined") slopSFX.sadTrombone();
            }, i * 900);
          }
        }
      }
    }

    // Split into routine vs jobboard
    const routineTasks = [];
    const allJobboardTasks = [];
    const routineDone = [];
    const jobboardDone = [];

    for (const t of allTasks) {
      const isDone =
        t.recurrence === "weekly"
          ? tracker.isTaskCompletedThisWeek(t.id, user.id)
          : t.recurrence === "daily"
          ? tracker.isTaskCompletedToday(t.id, user.id)
          : tracker.isTaskCompletedToday(t.id, user.id);

      const everDone =
        t.recurrence === "once" &&
        trackerStore.completions.data.some(
          (c) => c.taskId === t.id && c.userId === user.id && c.status !== "rejected"
        );

      const isJobboard = t.category === "jobboard";
      if (isDone || everDone) {
        if (isJobboard) jobboardDone.push(t);
        else routineDone.push(t);
      } else {
        if (isJobboard) allJobboardTasks.push(t);
        else routineTasks.push(t);
      }
    }

    // Job Board: split into available (not accepted) vs My Jobs (accepted)
    const availableJobs = [];
    const myJobs = [];

    for (const t of allJobboardTasks) {
      const claim = tracker.getJobClaim(t.id, user.id);
      if (claim && claim.status === "active") {
        myJobs.push(t);
      } else if (!claim || claim.status !== "submitted") {
        // Filter out single-user jobs already claimed by someone else
        if (t.multiUser === false) {
          const otherClaim = trackerStore.jobClaims.data.find(
            (c) => c.taskId === t.id && c.userId !== user.id
          );
          if (otherClaim) continue;
        }
        availableJobs.push(t);
      }
    }

    const allDone = [...routineDone, ...jobboardDone];
    const todayCompletions = allDone.map((t) => {
      const today = tracker.dateKey(new Date().toISOString());
      const comp = trackerStore.completions.data
        .filter((c) => c.taskId === t.id && c.userId === user.id && tracker.dateKey(c.completedAt) === today && c.status !== "rejected")
        .sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
      return { task: t, completion: comp };
    }).filter((x) => x.completion).sort((a, b) => b.completion.completedAt.localeCompare(a.completion.completedAt));

    // Penalties
    const penalties = tracker.getRecentPenalties(user.id, 7);
    let _unseenIdx = 0;
    const penaltyDetails = penalties.map((p) => {
      const task = trackerStore.tasks.data.find((t) => t.id === p.taskId);
      const isNew = _penaltySeenCutoff && p.completedAt > _penaltySeenCutoff;
      const unseenOrder = isNew ? _unseenIdx++ : 0;
      return { ...p, taskName: task?.name || "Unknown", isNew, unseenOrder };
    });

    // Streaks
    const streaks = allTasks
      .map((t) => ({ task: t, streak: tracker.calcStreak(t.id, user.id) }))
      .filter((s) => s.streak > 0)
      .sort((a, b) => b.streak - a.streak);

    // Reward summary helper
    const rewardSummary = (t) => {
      if (!t.rewards || Object.keys(t.rewards).length === 0) return "";
      return Object.entries(t.rewards)
        .map(([cid, amt]) => tracker.formatAmount(amt, cid))
        .join(", ");
    };

    // Reward pill label: "$10" for fixed, "$10/hr" for hourly
    const rewardPill = (t) => {
      const base = rewardSummary(t);
      if (!base) return "No reward";
      return t.payType === "hourly" ? base + "/hr" : base;
    };

    // Format seconds to human readable
    const fmtTime = (secs) => {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = Math.floor(secs % 60);
      if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
      return `${m}m ${String(s).padStart(2, "0")}s`;
    };

    // Time ago helper
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

    const routineTotal = routineTasks.length + routineDone.length;
    const routineCompleted = routineDone.length;

    // Build My Jobs HTML with state info
    let hasActiveClock = false;
    const myJobsHtml = myJobs.map((t) => {
      const isHourly = t.payType === "hourly";
      const activeClock = isHourly ? tracker.getActiveClockIn(t.id, user.id) : null;
      const totalSecs = isHourly ? tracker.getTotalSeconds(t.id, user.id) : 0;
      const worklog = isHourly ? tracker.getWorklog(t.id, user.id) : [];
      const hasAnySessions = worklog.filter((e) => e.clockOut).length > 0;

      if (activeClock) hasActiveClock = true;

      // Elapsed seconds for active clock
      let elapsedSecs = 0;
      if (activeClock) {
        elapsedSecs = Math.round((Date.now() - new Date(activeClock.clockIn).getTime()) / 1000);
      }

      if (isHourly) {
        const isClockedIn = !!activeClock;
        // Compute earned so far
        const earnedParts = [];
        const totalHoursSoFar = totalSecs / 3600;
        if (t.rewards) {
          for (const [cid, rate] of Object.entries(t.rewards)) {
            const c = tracker.getCurrency(cid);
            const decimals = c ? (c.decimals || 0) : 0;
            const factor = Math.pow(10, decimals);
            let amt = Math.round(rate * totalHoursSoFar * factor) / factor;
            if (t.maxPayout && t.maxPayout[cid] != null) amt = Math.min(amt, t.maxPayout[cid]);
            earnedParts.push(tracker.formatAmount(amt, cid));
          }
        }
        const earnedText = earnedParts.join(", ");
        const maxPayText = t.maxPayout ? Object.entries(t.maxPayout).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(", ") : "";
        return `
          <div class="task-row myjob-row${isClockedIn ? " clocked-in" : ""}" data-task-id="${t.id}">
            <div class="task-name">
              ${t.name}
              <span class="job-reward-pill">${rewardPill(t)}</span>
              ${maxPayText ? `<span class="max-payout-label">max ${maxPayText}</span>` : ""}
            </div>
            <div class="myjob-actions">
              ${totalSecs > 0 ? `<span class="earned-so-far">Earned: ${earnedText}</span>` : ""}
              ${isClockedIn ? `
                <span class="live-timer" data-clock-start="${activeClock.clockIn}">${fmtTime(elapsedSecs)}</span>
                <button class="clockout-btn" data-task-id="${t.id}">Clock Out</button>
              ` : `
                ${totalSecs > 0 || hasAnySessions ? `<span class="logged-time">${fmtTime(totalSecs)}</span>` : ""}
                <button class="clockin-btn" data-task-id="${t.id}">Clock In</button>
                ${hasAnySessions ? `<button class="submit-btn" data-task-id="${t.id}">Submit</button>` : ""}
              `}
            </div>
          </div>
        `;
      } else {
        // Fixed-price job
        return `
          <div class="task-row myjob-row" data-task-id="${t.id}">
            <div class="task-name">
              ${t.name}
              <span class="job-reward-pill">${rewardPill(t)}</span>
            </div>
            <button class="complete-btn myjob-done-btn" data-task-id="${t.id}">Done</button>
          </div>
        `;
      }
    }).join("");

    this.shadowRoot.innerHTML = `
      <style>${tracker.TRACKER_CSS}
        .section-title {
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--muted);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .section-icon {
          font-size: 1rem;
        }

        /* Quick Stats */
        .quick-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 8px;
          margin-bottom: 18px;
        }
        .stat-card {
          border-radius: var(--radius-md);
          padding: 14px;
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.03);
          text-align: center;
        }
        .stat-value {
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--accent);
        }
        .stat-label {
          font-size: 0.72rem;
          color: var(--muted);
          margin-top: 2px;
        }

        /* Penalty card */
        .penalty-section {
          border-radius: var(--radius-lg);
          padding: 14px 16px;
          background: linear-gradient(145deg, #2a1520, #180e14);
          border: 1px solid rgba(255, 107, 129, 0.15);
          margin-bottom: 18px;
        }
        .penalty-title {
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--danger);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .penalty-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 0;
          font-size: 0.82rem;
          border-bottom: 1px solid rgba(255, 107, 129, 0.08);
        }
        .penalty-row:last-child { border-bottom: none; }
        .penalty-name { flex: 1; color: var(--text); }
        .penalty-time { color: var(--muted); font-size: 0.72rem; }
        .penalty-amount { color: var(--danger); font-weight: 600; font-size: 0.82rem; }

        /* Unseen penalty animation */
        .penalty-row.penalty-unseen {
          animation: penaltySlam 800ms ease-out both;
          background: rgba(255, 107, 129, 0.14);
          border-radius: var(--radius-sm);
          padding: 8px 8px;
          border-left: 3px solid var(--danger);
          box-shadow: 0 0 12px rgba(255, 107, 129, 0.2);
        }
        .penalty-new-badge {
          font-size: 0.6rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #fff;
          background: var(--danger);
          padding: 2px 6px;
          border-radius: 999px;
          flex-shrink: 0;
          animation: badgePulse 1.5s ease-in-out 0.8s 3;
        }
        @keyframes penaltySlam {
          0% {
            opacity: 0;
            transform: translateX(-30px) scale(1.06);
            background: rgba(255, 107, 129, 0.4);
            box-shadow: 0 0 24px rgba(255, 107, 129, 0.5);
          }
          25% {
            opacity: 1;
            transform: translateX(6px);
          }
          45% {
            transform: translateX(-4px);
            background: rgba(255, 107, 129, 0.3);
          }
          65% {
            transform: translateX(2px);
          }
          80% {
            transform: translateX(-1px);
            box-shadow: 0 0 16px rgba(255, 107, 129, 0.3);
          }
          100% {
            transform: translateX(0);
            background: rgba(255, 107, 129, 0.14);
            box-shadow: 0 0 12px rgba(255, 107, 129, 0.2);
          }
        }
        @keyframes badgePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.15); }
        }

        /* Task rows */
        .task-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          min-height: 56px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.03);
          margin-bottom: 6px;
          transition: border-color var(--transition-fast), transform 300ms ease, opacity 300ms ease, background 300ms ease;
        }
        .task-row:hover {
          border-color: var(--accent-soft);
        }
        .task-name {
          flex: 1;
          font-size: 0.9rem;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .task-reward {
          font-size: 0.85rem;
          color: var(--success);
          font-weight: 600;
          white-space: nowrap;
        }
        .recurrence-pill {
          font-size: 0.65rem;
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(255,255,255,0.04);
          color: var(--muted);
          border: 1px solid rgba(255,255,255,0.06);
        }
        .has-timer {
          font-size: 0.72rem;
          color: var(--accent);
        }

        /* Chunky "Done" button */
        .complete-btn {
          appearance: none;
          border: none;
          background: rgba(80, 250, 123, 0.14);
          color: var(--success);
          border: 1px solid rgba(80, 250, 123, 0.25);
          border-radius: 999px;
          padding: 12px 20px;
          font-size: 0.82rem;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          font-family: inherit;
          min-width: 48px;
          min-height: 48px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background 160ms ease-out, transform 100ms ease-out;
        }
        .complete-btn:hover {
          background: rgba(80, 250, 123, 0.25);
          transform: scale(1.04);
        }
        .complete-btn:active {
          transform: scale(0.97);
        }

        /* Progress bar */
        .progress-bar-wrap {
          margin: -2px 0 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .progress-bar {
          flex: 1;
          height: 6px;
          border-radius: 999px;
          background: rgba(255,255,255,0.06);
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          border-radius: 999px;
          background: var(--success);
          transition: width 400ms ease-out;
        }
        .progress-label {
          font-size: 0.72rem;
          color: var(--muted);
          white-space: nowrap;
        }

        /* Job Board grid */
        .job-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px;
          margin-bottom: 6px;
        }
        .job-card {
          border-radius: var(--radius-lg);
          padding: 16px 14px;
          background: linear-gradient(145deg, #181a2a, #0f1018);
          border: 1px solid rgba(102, 217, 239, 0.08);
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: transform 160ms ease-out, border-color 160ms ease-out;
        }
        .job-card:hover {
          transform: translateY(-2px);
          border-color: rgba(102, 217, 239, 0.2);
        }
        .job-name {
          font-size: 0.92rem;
          font-weight: 600;
        }
        .job-desc {
          font-size: 0.76rem;
          color: var(--muted);
          flex: 1;
        }
        .job-reward-pill {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 0.78rem;
          font-weight: 700;
          color: var(--success);
          background: rgba(80, 250, 123, 0.12);
          border: 1px solid rgba(80, 250, 123, 0.18);
        }
        .new-badge {
          display: inline-block;
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 0.78rem;
          font-weight: 800;
          color: var(--success);
          background: rgba(80, 250, 123, 0.18);
          border: 1px solid rgba(80, 250, 123, 0.3);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .accept-btn {
          appearance: none;
          border: none;
          background: rgba(102, 217, 239, 0.14);
          color: var(--accent);
          border: 1px solid rgba(102, 217, 239, 0.25);
          border-radius: 999px;
          padding: 12px 16px;
          font-size: 0.82rem;
          font-weight: 700;
          cursor: pointer;
          font-family: inherit;
          min-height: 48px;
          transition: background 160ms ease-out, transform 100ms ease-out;
        }
        .accept-btn:hover {
          background: rgba(102, 217, 239, 0.25);
          transform: scale(1.04);
        }
        .accept-btn:active {
          transform: scale(0.97);
        }

        /* My Jobs */
        .myjob-row.clocked-in {
          border-color: rgba(80, 250, 123, 0.3);
          background: linear-gradient(145deg, #142218, #0e1810);
        }
        .myjob-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .live-timer {
          font-size: 0.9rem;
          font-weight: 700;
          color: var(--success);
          font-variant-numeric: tabular-nums;
        }
        .logged-time {
          font-size: 0.82rem;
          color: var(--muted);
          font-variant-numeric: tabular-nums;
        }
        .earned-so-far {
          font-size: 0.74rem;
          color: var(--success);
          opacity: 0.85;
          white-space: nowrap;
        }
        .max-payout-label {
          font-size: 0.68rem;
          color: var(--muted);
          opacity: 0.7;
        }
        .clockin-btn, .clockout-btn, .submit-btn {
          appearance: none;
          border: none;
          border-radius: 999px;
          padding: 10px 16px;
          font-size: 0.82rem;
          font-weight: 700;
          cursor: pointer;
          font-family: inherit;
          min-height: 44px;
          transition: background 160ms ease-out, transform 100ms ease-out;
          white-space: nowrap;
        }
        .clockin-btn {
          background: rgba(102, 217, 239, 0.14);
          color: var(--accent);
          border: 1px solid rgba(102, 217, 239, 0.25);
        }
        .clockin-btn:hover { background: rgba(102, 217, 239, 0.25); transform: scale(1.04); }
        .clockout-btn {
          background: rgba(241, 250, 140, 0.14);
          color: var(--warning);
          border: 1px solid rgba(241, 250, 140, 0.25);
        }
        .clockout-btn:hover { background: rgba(241, 250, 140, 0.25); transform: scale(1.04); }
        .submit-btn {
          background: rgba(80, 250, 123, 0.14);
          color: var(--success);
          border: 1px solid rgba(80, 250, 123, 0.25);
        }
        .submit-btn:hover { background: rgba(80, 250, 123, 0.25); transform: scale(1.04); }

        /* Completed section */
        .completed-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #121418, #0c0d12);
          border: 1px solid rgba(255, 255, 255, 0.02);
          margin-bottom: 4px;
          opacity: 0.7;
        }
        .completed-check {
          color: var(--success);
          font-size: 0.9rem;
        }
        .completed-name {
          flex: 1;
          font-size: 0.82rem;
          color: var(--muted);
        }
        .completed-reward {
          font-size: 0.76rem;
          color: var(--success);
          opacity: 0.8;
        }

        /* Streaks */
        .streak-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.82rem;
          padding: 6px 0;
        }
        .streak-count {
          font-weight: 700;
          color: var(--warning);
          min-width: 28px;
        }
        .streak-name { color: var(--muted); }

        /* Celebration animation */
        .completing {
          animation: completeFlash 500ms ease-out forwards;
          pointer-events: none;
        }
        @keyframes completeFlash {
          0% { transform: scale(1); background: linear-gradient(145deg, #161724, #0e0f18); }
          30% { transform: scale(1.03); background: linear-gradient(145deg, #1a3a22, #0e1f14); border-color: rgba(80, 250, 123, 0.3); }
          100% { transform: scale(0.97); opacity: 0; }
        }

        .job-completing {
          animation: jobCompleteFlash 500ms ease-out forwards;
          pointer-events: none;
        }
        @keyframes jobCompleteFlash {
          0% { transform: scale(1); }
          30% { transform: scale(1.05); border-color: rgba(80, 250, 123, 0.4); }
          100% { transform: scale(0.95); opacity: 0; }
        }

        /* Floating reward text */
        .float-reward {
          position: absolute;
          pointer-events: none;
          font-size: 1.1rem;
          font-weight: 800;
          color: var(--success);
          text-shadow: 0 0 8px rgba(80, 250, 123, 0.4);
          animation: floatUp 800ms ease-out forwards;
          z-index: 10;
        }
        @keyframes floatUp {
          0% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-40px); }
        }

        /* All done banner */
        .all-done-banner {
          text-align: center;
          padding: 18px;
          border-radius: var(--radius-lg);
          background: linear-gradient(145deg, #1a3a22, #0e1f14);
          border: 1px solid rgba(80, 250, 123, 0.2);
          margin-bottom: 16px;
          animation: bannerBounce 600ms ease-out;
        }
        .all-done-banner .big-text {
          font-size: 1.3rem;
          font-weight: 800;
          color: var(--success);
        }
        .all-done-banner .sub-text {
          font-size: 0.82rem;
          color: var(--muted);
          margin-top: 4px;
        }
        @keyframes bannerBounce {
          0% { transform: scale(0.9); opacity: 0; }
          50% { transform: scale(1.04); }
          100% { transform: scale(1); opacity: 1; }
        }

        .section-gap { margin-top: 20px; }

        /* Admin Overview */
        .admin-overview { margin-bottom: 20px; }
        .admin-overview-title {
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--muted);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .admin-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 10px;
        }
        .kid-card {
          border-radius: var(--radius-lg);
          padding: 14px;
          background: linear-gradient(145deg, #181926, #10111b);
          border: 1px solid rgba(255, 255, 255, 0.03);
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
          position: relative;
        }
        .kid-card-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .kid-avatar {
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
        .kid-name { flex: 1; font-size: 0.9rem; font-weight: 600; }
        .action-menu-btn {
          appearance: none;
          border: none;
          background: transparent;
          color: var(--muted);
          font-size: 1.2rem;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: var(--radius-sm);
          transition: background 160ms;
          line-height: 1;
          font-family: inherit;
        }
        .action-menu-btn:hover { background: rgba(255, 255, 255, 0.06); }
        .kid-progress-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .kid-progress {
          flex: 1;
          height: 4px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.06);
          overflow: hidden;
        }
        .kid-progress-fill {
          height: 100%;
          border-radius: 999px;
          background: var(--success);
          transition: width 400ms ease-out;
        }
        .kid-progress-label {
          font-size: 0.72rem;
          color: var(--muted);
          white-space: nowrap;
        }
        .kid-job {
          font-size: 0.78rem;
          color: var(--muted);
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .kid-job .clocked-in-badge {
          color: var(--success);
          font-weight: 600;
          font-size: 0.72rem;
        }
        .kid-balances {
          font-size: 0.82rem;
          color: var(--text);
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .kid-penalties-note {
          font-size: 0.72rem;
          color: var(--danger);
          margin-top: 4px;
        }
        .action-menu {
          display: none;
          position: absolute;
          top: 44px;
          right: 10px;
          z-index: 100;
          min-width: 200px;
          border-radius: var(--radius-md);
          background: #1a1c2e;
          border: 1px solid var(--border-subtle);
          box-shadow: 0 14px 30px rgba(0, 0, 0, 0.7);
          padding: 6px 0;
        }
        .action-menu.open { display: block; }
        .action-menu-item {
          appearance: none;
          border: none;
          background: transparent;
          color: var(--text);
          font-size: 0.82rem;
          padding: 10px 14px;
          cursor: pointer;
          width: 100%;
          text-align: left;
          font-family: inherit;
          transition: background 120ms;
          display: block;
        }
        .action-menu-item:hover { background: rgba(255, 255, 255, 0.05); }
        .penalty-list {
          display: none;
          padding: 4px 14px 8px;
        }
        .penalty-list.open { display: block; }
        .penalty-option {
          appearance: none;
          border: none;
          background: transparent;
          color: var(--danger);
          font-size: 0.78rem;
          padding: 6px 0;
          cursor: pointer;
          width: 100%;
          text-align: left;
          font-family: inherit;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .penalty-option:hover { opacity: 0.8; }
        .penalty-deduction {
          color: var(--muted);
          font-size: 0.72rem;
        }
        .penalty-note-input {
          width: 100%;
          margin-top: 6px;
          padding: 6px 8px;
          font-size: 0.78rem;
          background: #0d0e16;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          color: var(--text);
          font-family: inherit;
          outline: none;
        }
        .penalty-note-input:focus { border-color: var(--accent); }
      </style>
      <div>
        <!-- Admin Overview (admin only) -->
        ${user.isAdmin && adminKids.length > 0 ? `
          <div class="admin-overview">
            <div class="admin-overview-title"><span class="section-icon">&#x1F4CA;</span> Overview</div>
            <div class="admin-grid">
              ${adminKids.map((kid) => {
                const initial = (kid.name || "?").charAt(0).toUpperCase();
                const pct = kid.dailyTotal > 0 ? (kid.dailyDone / kid.dailyTotal * 100) : 0;
                return `
                  <div class="kid-card" data-kid-id="${kid.id}">
                    <div class="kid-card-header">
                      <div class="kid-avatar">${initial}</div>
                      <div class="kid-name">${kid.name}</div>
                      <button class="action-menu-btn" data-kid-id="${kid.id}">&#x22EE;</button>
                    </div>
                    <div class="kid-progress-wrap">
                      <div class="kid-progress"><div class="kid-progress-fill" style="width: ${pct}%"></div></div>
                      <span class="kid-progress-label">${kid.dailyDone} of ${kid.dailyTotal} tasks</span>
                    </div>
                    ${kid.activeJobs.map((j) => `
                      <div class="kid-job">
                        &#x1F4BC; ${j.name}${j.clockedIn ? ` <span class="clocked-in-badge">(clocked in)</span>` : ""}
                      </div>
                    `).join("")}
                    <div class="kid-balances">
                      ${kid.balances.map((b) => `<span>${b.formatted}</span>`).join(" · ")}
                    </div>
                    ${kid.recentPenaltyCount > 0 ? `
                      <div class="kid-penalties-note">${kid.recentPenaltyCount} penalt${kid.recentPenaltyCount === 1 ? "y" : "ies"} this week</div>
                    ` : ""}
                    <div class="action-menu${this._openMenuId === kid.id ? " open" : ""}" data-menu-kid="${kid.id}">
                      <button class="action-menu-item penalty-trigger" data-kid-id="${kid.id}">Apply Penalty</button>
                      <div class="penalty-list${this._openMenuId === kid.id && this._penaltyPickerOpen ? " open" : ""}" data-penalty-kid="${kid.id}">
                        <input class="penalty-note-input" data-kid-id="${kid.id}" placeholder="Note (optional)">
                        ${penaltyTasks.map((p) => {
                          const deduction = Object.entries(p.rewards || {}).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(", ");
                          return `<button class="penalty-option" data-kid-id="${kid.id}" data-penalty-id="${p.id}">
                            <span>${p.name}</span>
                            <span class="penalty-deduction">${deduction}</span>
                          </button>`;
                        }).join("")}
                        ${penaltyTasks.length === 0 ? `<span class="kid-progress-label">No penalties configured</span>` : ""}
                      </div>
                      <button class="action-menu-item reset-daily-trigger" data-kid-id="${kid.id}">Reset Daily Tasks</button>
                      <button class="action-menu-item adjust-balance-trigger" data-kid-id="${kid.id}">Adjust Balance</button>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        ` : ""}

        <!-- A. Quick Stats -->
        <div class="quick-stats">
          ${currencies.map((c) => `
            <div class="stat-card">
              <div class="stat-value">${tracker.formatAmount(tracker.getBalance(user.id, c.id), c.id)}</div>
              <div class="stat-label">${c.name}</div>
            </div>
          `).join("")}
          <div class="stat-card">
            <div class="stat-value">${routineTasks.length}</div>
            <div class="stat-label">Tasks remaining</div>
          </div>
        </div>

        <!-- B. Penalties — "Watch Out!" -->
        ${penaltyDetails.length > 0 ? `
          <div class="penalty-section">
            <div class="penalty-title">Watch Out!</div>
            ${penaltyDetails.map((p) => {
              const deduction = Object.entries(p.rewards || {})
                .map(([cid, amt]) => tracker.formatAmount(amt, cid))
                .join(", ");
              return `
                <div class="penalty-row${p.isNew ? " penalty-unseen" : ""}"${p.isNew ? ` style="animation-delay: ${p.unseenOrder * 200}ms"` : ""}>
                  ${p.isNew ? `<span class="penalty-new-badge">NEW</span>` : ""}
                  <span class="penalty-name">${p.taskName}</span>
                  <span class="penalty-time">${timeAgo(p.completedAt)}</span>
                  <span class="penalty-amount">${deduction}</span>
                </div>
              `;
            }).join("")}
          </div>
        ` : ""}

        <!-- C. Daily Expectations -->
        ${routineTotal > 0 ? `
          ${routineTasks.length === 0 && routineDone.length > 0 ? `
            <div class="all-done-banner">
              <div class="big-text">All Done!</div>
              <div class="sub-text">You finished all your daily tasks. Amazing!</div>
            </div>
          ` : ""}
          <div class="section-title"><span class="section-icon">*</span> Daily Expectations</div>
          <div class="progress-bar-wrap">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${routineTotal > 0 ? (routineCompleted / routineTotal * 100) : 0}%"></div>
            </div>
            <span class="progress-label">${routineCompleted} of ${routineTotal} done</span>
          </div>
          ${routineTasks.map((t) => {
            const streak = tracker.calcStreak(t.id, user.id);
            return `
              <div class="task-row" data-task-id="${t.id}">
                <div class="task-name">
                  ${t.name}
                  ${t.timerBonus ? `<span class="has-timer">&#x23F1;</span>` : ""}
                  ${streak > 0 ? `<span class="badge badge-streak">${streak}${t.recurrence === "weekly" ? "w" : "d"}${t.streakBonus && streak >= t.streakBonus.threshold ? " " + t.streakBonus.multiplier + "x" : ""}</span>` : ""}
                </div>
                <span class="task-reward">${rewardSummary(t)}</span>
                <button class="complete-btn" data-task-id="${t.id}">${t.timerBonus ? "Start" : "Done"}</button>
              </div>
            `;
          }).join("")}
        ` : `
          <div class="empty-state">
            <strong>No tasks yet.</strong> An admin can create tasks in the Admin panel.
          </div>
        `}

        <!-- D1. Job Board (available) -->
        ${availableJobs.length > 0 ? `
          <div class="section-title section-gap"><span class="section-icon">&#x1F4CB;</span> Job Board</div>
          <div class="job-grid">
            ${availableJobs.map((t) => {
              const isNew = (Date.now() - new Date(t.createdAt).getTime()) < 86400000;
              return `
              <div class="job-card" data-job-id="${t.id}">
                ${isNew ? `<span class="new-badge">New!</span>` : ""}
                <div class="job-name">${t.name}</div>
                ${t.description ? `<div class="job-desc">${t.description}</div>` : ""}
                <div>
                  <span class="job-reward-pill">${rewardPill(t)}</span>
                  ${t.payType === "hourly" && t.maxPayout ? `<span class="max-payout-label"> max ${Object.entries(t.maxPayout).map(([cid, amt]) => tracker.formatAmount(amt, cid)).join(", ")}</span>` : ""}
                </div>
                <button class="accept-btn" data-task-id="${t.id}">Accept</button>
              </div>
            `; }).join("")}
          </div>
        ` : ""}

        <!-- D2. My Jobs (accepted, active) -->
        ${myJobs.length > 0 ? `
          <div class="section-title section-gap"><span class="section-icon">&#x1F4BC;</span> My Jobs</div>
          ${myJobsHtml}
        ` : ""}

        <!-- E. Recently Completed (today) -->
        ${todayCompletions.length > 0 ? `
          <div class="section-title section-gap">Recently Completed</div>
          ${todayCompletions.map((x) => {
            const earnedText = Object.entries(x.completion.rewards || {})
              .map(([cid, amt]) => tracker.formatAmount(amt, cid))
              .join(", ");
            return `
              <div class="completed-row">
                <span class="completed-check">&#x2714;</span>
                <span class="completed-name">${x.task.name}</span>
                <span class="completed-reward">+${earnedText}</span>
              </div>
            `;
          }).join("")}
        ` : ""}

        <!-- F. Active Streaks -->
        ${streaks.length > 0 ? `
          <div class="section-title section-gap">Active Streaks</div>
          ${streaks.map((s) => `
            <div class="streak-row">
              <span class="streak-count">${s.streak}${s.task.recurrence === "weekly" ? "w" : "d"}</span>
              <span class="streak-name">${s.task.name}</span>
              ${s.task.streakBonus && s.streak >= s.task.streakBonus.threshold
                ? `<span class="badge badge-streak">&#x1F525; ${s.task.streakBonus.multiplier}x bonus active</span>`
                : ""}
            </div>
          `).join("")}
        ` : ""}
      </div>
    `;

    // --- Bind routine task complete buttons ---
    this.shadowRoot.querySelectorAll(".task-row:not(.myjob-row) .complete-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const taskId = btn.dataset.taskId;
        const task = trackerStore.tasks.data.find((t) => t.id === taskId);

        if (task && task.timerBonus) {
          eventBus.emit("timer:start", { taskId, userId: user.id });
          return;
        }

        this._celebrateAndComplete(taskId, user.id, btn, "routine");
      });
    });

    // --- Bind Accept buttons ---
    this.shadowRoot.querySelectorAll(".accept-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const taskId = btn.dataset.taskId;
        const card = btn.closest(".job-card");
        if (card) {
          card.classList.add("job-completing");
        }
        if (typeof slopSFX !== "undefined") slopSFX.grab();
        setTimeout(() => {
          tracker.acceptJob(taskId, user.id);
          eventBus.emit("toast:show", { message: "Job accepted!", type: "success" });
          this.render();
        }, 400);
      });
    });

    // --- Bind My Jobs: fixed "Done" buttons ---
    this.shadowRoot.querySelectorAll(".myjob-done-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const taskId = btn.dataset.taskId;
        const row = btn.closest(".myjob-row");
        if (row) row.classList.add("completing");

        if (typeof slopSFX !== "undefined") slopSFX.coin();

        setTimeout(() => {
          const result = tracker.submitFixedJob(taskId, user.id);
          if (result && result.status === "pending") {
            eventBus.emit("toast:show", { message: "Submitted for approval!", type: "warning" });
          } else if (result) {
            const rewardText = Object.entries(result.rewards || {})
              .map(([cid, amt]) => tracker.formatAmount(amt, cid))
              .join(", ");
            if (typeof slopSFX !== "undefined") slopSFX.cashJingle();
            eventBus.emit("toast:show", { message: `Earned ${rewardText}!`, type: "success" });
          }
          this.render();
        }, 500);
      });
    });

    // --- Bind Clock In buttons ---
    this.shadowRoot.querySelectorAll(".clockin-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        tracker.clockIn(btn.dataset.taskId, user.id);
        this.render();
      });
    });

    // --- Bind Clock Out buttons ---
    this.shadowRoot.querySelectorAll(".clockout-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        tracker.clockOut(btn.dataset.taskId, user.id);
        this.render();
      });
    });

    // --- Bind Submit buttons (hourly) ---
    this.shadowRoot.querySelectorAll(".submit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const taskId = btn.dataset.taskId;
        const row = btn.closest(".myjob-row");
        if (row) row.classList.add("completing");

        if (typeof slopSFX !== "undefined") slopSFX.levelUp();

        setTimeout(() => {
          tracker.submitHourlyWork(taskId, user.id);
          eventBus.emit("toast:show", { message: "Work submitted for approval!", type: "success" });
          this.render();
        }, 500);
      });
    });

    // --- Live clock timer (1s interval) ---
    if (hasActiveClock) {
      this._timerInterval = setInterval(() => {
        this.shadowRoot.querySelectorAll(".live-timer").forEach((el) => {
          const start = el.dataset.clockStart;
          if (!start) return;
          const secs = Math.round((Date.now() - new Date(start).getTime()) / 1000);
          el.textContent = fmtTime(secs);
        });
      }, 1000);
    }

    // --- Admin overview event handlers ---
    if (user.isAdmin) {
      const root = this.shadowRoot;

      // Close menu on click outside
      const topDiv = root.querySelector("div");
      topDiv?.addEventListener("click", (e) => {
        if (e.target.closest(".action-menu-btn") || e.target.closest(".action-menu")) return;
        root.querySelectorAll(".action-menu.open").forEach((m) => m.classList.remove("open"));
        root.querySelectorAll(".penalty-list.open").forEach((p) => p.classList.remove("open"));
        this._openMenuId = null;
        this._penaltyPickerOpen = false;
      });

      // Toggle menu on ⋮ click
      root.querySelectorAll(".action-menu-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const kidId = btn.dataset.kidId;
          const menu = root.querySelector(`.action-menu[data-menu-kid="${kidId}"]`);
          const wasOpen = menu?.classList.contains("open");

          root.querySelectorAll(".action-menu.open").forEach((m) => m.classList.remove("open"));
          root.querySelectorAll(".penalty-list.open").forEach((p) => p.classList.remove("open"));
          this._penaltyPickerOpen = false;

          if (!wasOpen && menu) {
            menu.classList.add("open");
            this._openMenuId = kidId;
          } else {
            this._openMenuId = null;
          }
        });
      });

      // Apply Penalty — expand picker
      root.querySelectorAll(".penalty-trigger").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const kidId = btn.dataset.kidId;
          const list = root.querySelector(`.penalty-list[data-penalty-kid="${kidId}"]`);
          if (list) list.classList.toggle("open");
          this._penaltyPickerOpen = list?.classList.contains("open") || false;
        });
      });

      // Penalty option click
      root.querySelectorAll(".penalty-option").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const kidId = btn.dataset.kidId;
          const penaltyId = btn.dataset.penaltyId;
          const noteInput = root.querySelector(`.penalty-note-input[data-kid-id="${kidId}"]`);
          const note = noteInput?.value || "";
          tracker.logPenalty(penaltyId, kidId, note);
          if (typeof slopSFX !== "undefined") slopSFX.sadTrombone();
          const kid = trackerStore.users.data.find((u) => u.id === kidId);
          const task = trackerStore.tasks.data.find((t) => t.id === penaltyId);
          eventBus.emit("toast:show", { message: `Penalty: ${task?.name || "Unknown"} → ${kid?.name || "Unknown"}`, type: "danger" });
          this._openMenuId = null;
          this._penaltyPickerOpen = false;
          this.render();
        });
      });

      // Reset Daily Tasks
      root.querySelectorAll(".reset-daily-trigger").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const kidId = btn.dataset.kidId;
          const kid = trackerStore.users.data.find((u) => u.id === kidId);
          if (!kid) return;
          if (!confirm(`Reset all of ${kid.name}'s daily tasks for today? This will undo completions and reverse any earned rewards.`)) return;
          const count = tracker.resetDailyTasks(kidId);
          eventBus.emit("toast:show", {
            message: count > 0 ? `Reset ${count} completion${count !== 1 ? "s" : ""} for ${kid.name}.` : `No daily completions to reset for ${kid.name} today.`,
            type: count > 0 ? "success" : "warning",
          });
          this._openMenuId = null;
          this.render();
        });
      });

      // Adjust Balance
      root.querySelectorAll(".adjust-balance-trigger").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const kidId = btn.dataset.kidId;
          const allCurrencies = trackerStore.currencies.data;
          if (allCurrencies.length === 0) { alert("No currencies set up."); return; }

          const currNames = allCurrencies.map((c, i) => `${i + 1}. ${c.symbol} ${c.name}`).join("\n");
          const choice = prompt(`Which currency?\n${currNames}\n\nEnter number:`);
          if (!choice) return;
          const idx = parseInt(choice) - 1;
          if (idx < 0 || idx >= allCurrencies.length) { alert("Invalid."); return; }

          const curr = allCurrencies[idx];
          const current = tracker.getBalance(kidId, curr.id);
          const amountStr = prompt(`Current ${curr.name}: ${tracker.formatAmount(current, curr.id)}\n\nEnter adjustment (e.g. 5, -2.50):`);
          if (!amountStr) return;
          const amount = parseFloat(amountStr);
          if (isNaN(amount)) { alert("Invalid number."); return; }

          tracker.adjustBalance(kidId, curr.id, amount);
          eventBus.emit("toast:show", { message: `Adjusted ${curr.name} by ${amount}`, type: "success" });
          this._openMenuId = null;
          this.render();
        });
      });
    }
  }

  _celebrateAndComplete(taskId, userId, btn, type) {
    // Find the row/card element
    const row = type === "jobboard"
      ? btn.closest(".job-card")
      : btn.closest(".task-row");

    if (!row) return;

    // Step 1: Animation class
    row.classList.add(type === "jobboard" ? "job-completing" : "completing");

    // Step 2: Floating reward text
    const task = trackerStore.tasks.data.find((t) => t.id === taskId);
    if (task && task.rewards) {
      const rewardText = Object.entries(task.rewards)
        .map(([cid, amt]) => "+" + tracker.formatAmount(amt, cid))
        .join(" ");
      if (rewardText) {
        const float = document.createElement("span");
        float.className = "float-reward";
        float.textContent = rewardText;
        const btnRect = btn.getBoundingClientRect();
        const hostRect = this.shadowRoot.host.getBoundingClientRect();
        float.style.left = (btnRect.left - hostRect.left) + "px";
        float.style.top = (btnRect.top - hostRect.top) + "px";
        // Need a positioned container
        const container = this.shadowRoot.querySelector("div");
        container.style.position = "relative";
        container.appendChild(float);
      }
    }

    // Step 3: Play sound
    if (typeof slopSFX !== "undefined") {
      if (type === "jobboard") {
        slopSFX.grab();
      } else {
        slopSFX.coin();
      }
    }

    // Step 4: After animation, actually complete the task and rebuild
    setTimeout(() => {
      const result = tracker.completeTask(taskId, userId);

      if (result && result.status === "pending") {
        eventBus.emit("toast:show", { message: "Submitted for approval!", type: "warning" });
      } else if (result) {
        const rewardText = Object.entries(result.rewards || {})
          .map(([cid, amt]) => tracker.formatAmount(amt, cid))
          .join(", ");
        if (typeof slopSFX !== "undefined") slopSFX.cashJingle();
        eventBus.emit("toast:show", { message: `Earned ${rewardText}!`, type: "success" });
      }

      // Step 5: Check if all routine tasks are now done
      const allRoutineTasks = tracker.getTasksForUser(userId).filter((t) => t.category !== "jobboard");
      const allRoutineDone = allRoutineTasks.every((t) => {
        if (t.recurrence === "weekly") return tracker.isTaskCompletedThisWeek(t.id, userId);
        return tracker.isTaskCompletedToday(t.id, userId);
      });

      if (allRoutineDone && allRoutineTasks.length > 0 && type === "routine") {
        if (typeof slopSFX !== "undefined") slopSFX.allDone();
      }

      this.render();
    }, 500);
  }
}

customElements.define("ps-dashboard", PsDashboard);
