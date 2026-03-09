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
    this._showAllEarnings = false;
    this._showAllPenalties = false;
    this._earningsCutoffForSession = null;
    this._penaltyCutoffForSession = null;
    this._expandedApprovalId = null;
  }

  connectedCallback() {
    this._unsubs.push(
      eventBus.on("user:changed", () => this.render()),
      eventBus.on("balances:changed", () => this.render()),
      eventBus.on("tasks:changed", () => this.render()),
      eventBus.on("completion:added", () => this.render()),
      eventBus.on("completion:approved", () => this.render()),
      eventBus.on("completion:rejected", () => this.render()),
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

    // --- Pending rewards by user ---
    const pendingByUser = {};
    for (const c of trackerStore.completions.data) {
      if (c.status !== "pending" || !c.rewards) continue;
      if (!pendingByUser[c.userId]) pendingByUser[c.userId] = {};
      for (const [currId, amt] of Object.entries(c.rewards)) {
        pendingByUser[c.userId][currId] = (pendingByUser[c.userId][currId] || 0) + amt;
      }
    }

    // --- Admin overview data ---
    let adminKids = [];
    let penaltyTasks = [];
    if (user.isAdmin) {
      penaltyTasks = trackerStore.tasks.data.filter((t) => !t.archived && t.isPenalty);
      const allUsers = trackerStore.users.data;
      adminKids = allUsers.map((kid) => {
        const kidTasks = tracker.getTasksForUser(kid.id);
        const dailyTasks = kidTasks.filter((t) => t.recurrence === "daily" && t.category !== "jobboard" && tracker.isTaskScheduledToday(t));
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
        const pendingRewards = pendingByUser[kid.id] || {};
        const pendingText = Object.entries(pendingRewards)
          .filter(([, amt]) => amt > 0)
          .map(([cid, amt]) => "+" + tracker.formatAmount(amt, cid))
          .join(", ");
        const pendingApprovals = trackerStore.completions.data.filter(
          (c) => c.userId === kid.id && c.status === "pending"
        );
        return { ...kid, dailyDone, dailyTotal, activeJobs, balances, recentPenaltyCount, pendingText, pendingApprovals };
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
        // Capture cutoff once per session so re-renders keep showing NEW badges
        if (!this._penaltyCutoffForSession) {
          this._penaltyCutoffForSession = user.lastPenaltySeenAt;
        }
        _penaltySeenCutoff = this._penaltyCutoffForSession;
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

    // --- Unseen earnings notification ---
    let _earningsSeenCutoff = null;
    if (!user.isAdmin) {
      if (!user.lastEarningsSeenAt) {
        user.lastEarningsSeenAt = tracker.now();
        trackerStore.users.save();
      } else {
        // Capture cutoff once per session so re-renders keep showing NEW badges
        if (!this._earningsCutoffForSession) {
          this._earningsCutoffForSession = user.lastEarningsSeenAt;
        }
        _earningsSeenCutoff = this._earningsCutoffForSession;
        const unseenEarnings = trackerStore.completions.data.filter(
          (c) => c.userId === user.id && !c.isPenalty && (c.status === "approved" || c.status === "rejected") && (c.rejectedAt || c.approvedAt || c.completedAt) > _earningsSeenCutoff
        ).length;
        if (unseenEarnings > 0) {
          user.lastEarningsSeenAt = tracker.now();
          trackerStore.users.save();
        }
      }
    }

    // Split into routine vs jobboard
    const routineTasks = [];
    const allJobboardTasks = [];
    const routineDone = [];
    const jobboardDone = [];

    for (const t of allTasks) {
      // Skip daily tasks not scheduled for today
      if (t.recurrence === "daily" && !tracker.isTaskScheduledToday(t)) continue;

      const isDone =
        t.recurrence === "transient"
          ? tracker.isTaskCompletedSinceActivation(t.id, user.id)
          : t.recurrence === "weekly"
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

    // --- Recent activity: min 5, max 10 from last 24h, expand to 7 days ---
    const RECENT_MIN = 5;
    const RECENT_MAX = 10;
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Penalties
    const allPenalties = trackerStore.completions.data
      .filter((c) => c.userId === user.id && c.isPenalty)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    let penalties;
    let hasMorePenalties = false;
    if (this._showAllPenalties) {
      penalties = allPenalties.filter((c) => c.completedAt >= cutoff7d);
    } else {
      const within24h = allPenalties.filter((c) => c.completedAt >= cutoff24h);
      if (within24h.length >= RECENT_MIN) {
        penalties = within24h.slice(0, RECENT_MAX);
        hasMorePenalties = allPenalties.length > penalties.length;
      } else {
        penalties = allPenalties.slice(0, RECENT_MIN);
        hasMorePenalties = allPenalties.length > RECENT_MIN;
      }
    }
    let _unseenIdx = 0;
    const penaltyDetails = penalties.map((p) => {
      const task = trackerStore.tasks.data.find((t) => t.id === p.taskId);
      const isNew = _penaltySeenCutoff && p.completedAt > _penaltySeenCutoff;
      const unseenOrder = isNew ? _unseenIdx++ : 0;
      return { ...p, taskName: task?.name || "Unknown", isNew, unseenOrder };
    });

    // Recent earnings
    const allEarningsSorted = trackerStore.completions.data
      .filter((c) => c.userId === user.id && !c.isPenalty && (c.status === "approved" || c.status === "pending" || c.status === "rejected"))
      .sort((a, b) => (b.rejectedAt || b.approvedAt || b.completedAt).localeCompare(a.rejectedAt || a.approvedAt || a.completedAt));
    let earningsSlice;
    let hasMoreEarnings = false;
    if (this._showAllEarnings) {
      earningsSlice = allEarningsSorted.filter((c) => (c.rejectedAt || c.approvedAt || c.completedAt) >= cutoff7d);
    } else {
      const within24h = allEarningsSorted.filter((c) => (c.rejectedAt || c.approvedAt || c.completedAt) >= cutoff24h);
      if (within24h.length >= RECENT_MIN) {
        earningsSlice = within24h.slice(0, RECENT_MAX);
        hasMoreEarnings = allEarningsSorted.length > earningsSlice.length;
      } else {
        earningsSlice = allEarningsSorted.slice(0, RECENT_MIN);
        hasMoreEarnings = allEarningsSorted.length > RECENT_MIN;
      }
    }
    const recentEarnings = earningsSlice
      .map((c) => {
        const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
        const earningTs = c.rejectedAt || c.approvedAt || c.completedAt;
        const isNew = _earningsSeenCutoff && earningTs > _earningsSeenCutoff;
        const isPending = c.status === "pending";
        const isRejected = c.status === "rejected";
        const rewardText = Object.entries(c.rewards || {})
          .filter(([, amt]) => amt > 0)
          .map(([cid, amt]) => "+" + tracker.formatAmount(amt, cid))
          .join(", ");
        return { ...c, taskName: task?.name || "Unknown", isNew, isPending, isRejected, rewardText, earningTs };
      });

    // Streaks
    const streaks = allTasks
      .map((t) => ({ task: t, streak: tracker.calcStreak(t.id, user.id) }))
      .filter((s) => s.streak > 0)
      .sort((a, b) => b.streak - a.streak);

    // Streak tier helper
    const streakTier = (count) => {
      if (count >= 100) return { color: "#f1fa8c", glow: "rgba(241,250,140,0.4)" };
      if (count >= 60)  return { color: "#ff79c6", glow: "rgba(255,121,198,0.4)" };
      if (count >= 30)  return { color: "#bd93f9", glow: "rgba(189,147,249,0.4)" };
      if (count >= 14)  return { color: "#66d9ef", glow: "rgba(102,217,239,0.4)" };
      if (count >= 7)   return { color: "#ffd700", glow: "rgba(255,215,0,0.4)" };
      if (count >= 3)   return { color: "#c0c0c0", glow: "rgba(192,192,192,0.4)" };
      return { color: "#cd7f32", glow: "rgba(205,127,50,0.4)" };
    };

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
        .stat-pending {
          font-size: 0.7rem;
          color: var(--warning);
          margin-top: 2px;
          opacity: 0.9;
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

        /* Activity columns (penalties + earnings side by side) */
        .activity-columns {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 12px;
          margin-bottom: 18px;
        }
        .activity-columns > .penalty-section,
        .activity-columns > .earnings-section {
          margin-bottom: 0;
        }

        /* Earnings section */
        .earnings-section {
          border-radius: var(--radius-lg);
          padding: 14px 16px;
          background: linear-gradient(145deg, #152a1a, #0e180f);
          border: 1px solid rgba(80, 250, 123, 0.12);
          margin-bottom: 18px;
        }
        .earnings-title {
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--success);
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .earnings-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 0;
          font-size: 0.82rem;
          border-bottom: 1px solid rgba(80, 250, 123, 0.06);
          flex-wrap: wrap;
        }
        .earnings-row:last-child { border-bottom: none; }
        .earnings-name { flex: 1; color: var(--text); }
        .earnings-time { color: var(--muted); font-size: 0.72rem; }
        .earnings-amount { color: var(--success); font-weight: 600; font-size: 0.82rem; }
        .earnings-row.earnings-pending .earnings-amount { color: var(--warning); }
        .earnings-row.earnings-rejected { opacity: 0.7; }
        .earnings-row.earnings-rejected .earnings-name { text-decoration: line-through; color: var(--muted); }
        .earnings-row.earnings-rejected .earnings-amount { color: var(--danger); }
        .earnings-rejected-badge {
          font-size: 0.6rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--danger);
          background: rgba(255, 107, 129, 0.12);
          padding: 2px 6px;
          border-radius: 999px;
          border: 1px solid rgba(255, 107, 129, 0.2);
          flex-shrink: 0;
        }
        .earnings-rejection-note {
          width: 100%;
          font-size: 0.7rem;
          color: var(--muted);
          font-style: italic;
          margin-top: 2px;
        }
        .earnings-pending-badge {
          font-size: 0.6rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--warning);
          background: rgba(241, 250, 140, 0.12);
          padding: 2px 6px;
          border-radius: 999px;
          border: 1px solid rgba(241, 250, 140, 0.2);
          flex-shrink: 0;
        }
        .earnings-row.earnings-unseen {
          animation: earningsGlow 800ms ease-out both;
          background: rgba(80, 250, 123, 0.1);
          border-radius: var(--radius-sm);
          padding: 8px 8px;
          border-left: 3px solid var(--success);
        }
        .earnings-new-badge {
          font-size: 0.6rem;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #fff;
          background: var(--success);
          padding: 2px 6px;
          border-radius: 999px;
          flex-shrink: 0;
          animation: badgePulse 1.5s ease-in-out 0.8s 3;
        }
        .view-more-link {
          display: block;
          text-align: center;
          font-size: 0.74rem;
          color: var(--muted);
          cursor: pointer;
          padding: 6px 0 2px;
          opacity: 0.8;
          transition: opacity 160ms, color 160ms;
        }
        .view-more-link:hover {
          opacity: 1;
          color: var(--accent);
        }
        @keyframes earningsGlow {
          0% { opacity: 0; transform: translateX(-20px); background: rgba(80, 250, 123, 0.25); }
          50% { opacity: 1; transform: translateX(3px); }
          100% { transform: translateX(0); background: rgba(80, 250, 123, 0.1); }
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
        .streak-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
          gap: 10px;
          margin-top: 8px;
        }
        .streak-badge {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 12px 6px 10px;
          border-radius: var(--radius-md);
          background: linear-gradient(145deg, #161724, #0e0f18);
          border: 1px solid rgba(255, 255, 255, 0.05);
          transition: transform 0.2s;
        }
        .streak-badge:hover {
          transform: scale(1.05);
        }
        .streak-badge.bonus-active {
          position: relative;
        }
        .streak-badge.bonus-active::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          box-shadow: 0 0 14px var(--glow-color, rgba(255, 200, 50, 0.35)), 0 0 4px var(--glow-color, rgba(255, 200, 50, 0.2));
          animation: streakGlow 2s ease-in-out infinite;
          pointer-events: none;
        }
        .streak-shield {
          position: relative;
          width: 40px;
          height: 48px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
        }
        .streak-shield svg {
          position: absolute;
          top: 0;
          left: 0;
        }
        .streak-shield-count {
          position: relative;
          z-index: 1;
          font-weight: 800;
          font-size: 0.9rem;
          color: #fff;
          text-shadow: 0 1px 3px rgba(0,0,0,0.5);
        }
        .streak-shield-unit {
          position: relative;
          z-index: 1;
          font-size: 0.5rem;
          font-weight: 600;
          color: rgba(255,255,255,0.7);
          margin-top: -1px;
          letter-spacing: 0.02em;
        }
        .streak-badge-name {
          margin-top: 6px;
          font-size: 0.72rem;
          color: var(--muted);
          text-align: center;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .streak-badge-bonus {
          font-size: 0.65rem;
          font-weight: 700;
          margin-top: 3px;
        }
        .streak-inline {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 1px 6px;
          border-radius: 999px;
          font-size: 0.68rem;
          font-weight: 700;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .streak-inline-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          display: inline-block;
        }
        @keyframes streakGlow {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }

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
        .kid-pending-note {
          font-size: 0.72rem;
          color: var(--warning);
          margin-top: 2px;
        }
        .kid-pending-approvals {
          margin-top: 6px;
          padding: 6px 8px;
          background: rgba(241, 250, 140, 0.06);
          border: 1px solid rgba(241, 250, 140, 0.12);
          border-radius: var(--radius-sm);
        }
        .kid-pending-item {
          font-size: 0.72rem;
          color: var(--warning);
          padding: 4px 6px;
          margin: 2px -6px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: background 120ms;
        }
        .kid-pending-item:hover {
          background: rgba(241, 250, 140, 0.08);
        }
        .kid-pending-item.expanded {
          background: rgba(241, 250, 140, 0.06);
        }
        .kid-pending-amount {
          color: var(--muted);
          font-size: 0.68rem;
        }
        .kid-approval-inline {
          margin-top: 6px;
          padding: 8px 10px;
          border-radius: var(--radius-sm);
          background: rgba(102, 217, 239, 0.04);
          border: 1px solid rgba(102, 217, 239, 0.1);
        }
        .kid-approval-btns {
          display: flex;
          gap: 6px;
          margin-top: 6px;
        }
        .kid-approval-btns button {
          appearance: none;
          border: none;
          border-radius: 999px;
          padding: 5px 12px;
          font-size: 0.72rem;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          min-height: 30px;
          transition: background 160ms ease-out;
        }
        .kid-approve-btn {
          background: rgba(80, 250, 123, 0.12);
          color: #50fa7b;
          border: 1px solid rgba(80, 250, 123, 0.2);
        }
        .kid-approve-btn:hover { background: rgba(80, 250, 123, 0.22); }
        .kid-reject-btn {
          background: rgba(255, 107, 129, 0.1);
          color: #ff6b81;
          border: 1px solid rgba(255, 107, 129, 0.15);
        }
        .kid-reject-btn:hover { background: rgba(255, 107, 129, 0.2); }
        .kid-criteria-section {
          margin: 6px 0 2px;
          padding: 6px 8px;
          border-radius: var(--radius-sm);
          background: rgba(102, 217, 239, 0.04);
          border: 1px solid rgba(102, 217, 239, 0.08);
        }
        .kid-criteria-label {
          font-size: 0.66rem;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 4px;
        }
        .kid-criterion-check {
          display: flex;
          align-items: center;
          gap: 5px;
          margin-bottom: 3px;
          font-size: 0.72rem;
          color: var(--text);
        }
        .kid-criterion-check input[type="checkbox"] {
          accent-color: var(--accent);
          width: 14px;
          height: 14px;
        }
        .kid-criterion-mult {
          color: var(--muted);
          font-size: 0.66rem;
        }
        .kid-adjusted-payout {
          font-size: 0.7rem;
          color: var(--accent);
          margin-top: 4px;
          font-weight: 500;
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
                    ${kid.pendingText ? `<div class="kid-pending-note">${kid.pendingText} pending</div>` : ""}
                    ${kid.pendingApprovals.length > 0 ? `
                      <div class="kid-pending-approvals">
                        ${kid.pendingApprovals.map((c) => {
                          const task = trackerStore.tasks.data.find((t) => t.id === c.taskId);
                          const rText = Object.entries(c.rewards || {}).filter(([, a]) => a > 0).map(([cid, a]) => tracker.formatAmount(a, cid)).join(", ");
                          const isExpanded = this._expandedApprovalId === c.id;
                          return `<div class="kid-pending-item${isExpanded ? " expanded" : ""}" data-completion-id="${c.id}">
                            ${task?.name || "?"} <span class="kid-pending-amount">${rText}</span>
                            ${isExpanded ? `
                              <div class="kid-approval-inline" data-inline-for="${c.id}">
                                ${task?.bonusCriteria?.length > 0 ? `
                                  <div class="kid-criteria-section" data-kid-criteria-for="${c.id}">
                                    <div class="kid-criteria-label">Bonus Criteria</div>
                                    ${task.bonusCriteria.map((bc) => `
                                      <label class="kid-criterion-check">
                                        <input type="checkbox" data-criterion-id="${bc.id}" data-multiplier="${bc.multiplier}" />
                                        ${bc.label} <span class="kid-criterion-mult">(${bc.multiplier}×)</span>
                                      </label>
                                    `).join("")}
                                    <div class="kid-adjusted-payout" data-kid-adjusted-for="${c.id}" data-base-rewards='${JSON.stringify(c.rewards || {})}'></div>
                                  </div>
                                ` : ""}
                                <div class="kid-approval-btns">
                                  <button class="kid-approve-btn" data-kid-approve="${c.id}">Approve</button>
                                  <button class="kid-reject-btn" data-kid-reject="${c.id}">Reject</button>
                                </div>
                              </div>
                            ` : ""}
                          </div>`;
                        }).join("")}
                      </div>
                    ` : ""}
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
          ${currencies.map((c) => {
            const pending = pendingByUser[user.id]?.[c.id] || 0;
            return `
            <div class="stat-card">
              <div class="stat-value">${tracker.formatAmount(tracker.getBalance(user.id, c.id), c.id)}</div>
              <div class="stat-label">${c.name}</div>
              ${pending > 0 ? `<div class="stat-pending">+${tracker.formatAmount(pending, c.id)} pending</div>` : ""}
            </div>
          `; }).join("")}
          <div class="stat-card">
            <div class="stat-value">${routineTasks.length}</div>
            <div class="stat-label">Tasks remaining</div>
          </div>
        </div>

        <!-- B. Earnings & Penalties -->
        ${penaltyDetails.length > 0 || recentEarnings.length > 0 ? `
          <div class="activity-columns">
            ${recentEarnings.length > 0 ? `
              <div class="earnings-section">
                <div class="earnings-title">Recent Earnings</div>
                ${recentEarnings.map((e) => `
                  <div class="earnings-row${e.isNew ? " earnings-unseen" : ""}${e.isPending ? " earnings-pending" : ""}${e.isRejected ? " earnings-rejected" : ""}">
                    ${e.isNew ? '<span class="earnings-new-badge">NEW</span>' : ""}
                    ${e.isRejected ? '<span class="earnings-rejected-badge">rejected</span>' : ""}
                    ${e.isPending ? '<span class="earnings-pending-badge">pending</span>' : ""}
                    <span class="earnings-name">${e.taskName}</span>
                    <span class="earnings-time">${timeAgo(e.earningTs)}</span>
                    <span class="earnings-amount">${e.isRejected ? "—" : e.rewardText}</span>
                    ${e.isRejected && e.rejectionNote ? `<div class="earnings-rejection-note">${e.rejectionNote}</div>` : ""}
                  </div>
                `).join("")}
                ${this._showAllEarnings ? `<a class="view-more-link" id="toggle-earnings">Show less</a>` : hasMoreEarnings ? `<a class="view-more-link" id="toggle-earnings">Show more</a>` : ""}
              </div>
            ` : ""}
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
                ${this._showAllPenalties ? `<a class="view-more-link" id="toggle-penalties">Show less</a>` : hasMorePenalties ? `<a class="view-more-link" id="toggle-penalties">Show more</a>` : ""}
              </div>
            ` : ""}
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
                  ${streak > 0 ? (() => { const st = streakTier(streak); return `<span class="streak-inline"><span class="streak-inline-dot" style="background:${st.color}"></span>${streak} ${t.recurrence === "weekly" ? (streak === 1 ? "week" : "weeks") : (streak === 1 ? "day" : "days")}${t.streakBonus && streak >= t.streakBonus.threshold ? " " + t.streakBonus.multiplier + "x" : ""}</span>`; })() : ""}
                </div>
                <span class="task-reward">${rewardSummary(t)}</span>
                <button class="complete-btn" data-task-id="${t.id}">${t.timerBonus ? "Start" : "Done"}</button>
              </div>
            `;
          }).join("")}
        ` : `
          <div class="empty-state">
            <strong>No tasks yet.</strong> A parent can create tasks in the Admin panel.
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

        <!-- F. Active Streaks -->
        ${streaks.length > 0 ? `
          <div class="section-title section-gap"><span class="section-icon">&#x1F525;</span> Active Streaks</div>
          <div class="streak-grid">
            ${streaks.map((s) => {
              const tier = streakTier(s.streak);
              const unit = s.task.recurrence === "weekly" ? (s.streak === 1 ? "week" : "weeks") : (s.streak === 1 ? "day" : "days");
              const hasBonus = s.task.streakBonus && s.streak >= s.task.streakBonus.threshold;
              return `
              <div class="streak-badge${hasBonus ? " bonus-active" : ""}" style="${hasBonus ? `--glow-color: ${tier.glow}` : ""}">
                <div class="streak-shield">
                  <svg width="40" height="48" viewBox="0 0 40 48">
                    <path d="M20 2 L38 10 L38 28 Q38 40 20 46 Q2 40 2 28 L2 10 Z"
                          fill="${tier.color}" fill-opacity="0.18"
                          stroke="${tier.color}" stroke-width="2" stroke-opacity="0.6"/>
                  </svg>
                  <span class="streak-shield-count" style="color: ${tier.color}">${s.streak}</span>
                  <span class="streak-shield-unit" style="color: ${tier.color}">${unit}</span>
                </div>
                <span class="streak-badge-name">${s.task.name}</span>
                ${hasBonus ? `<span class="streak-badge-bonus" style="color: ${tier.color}">&#x1F525; ${s.task.streakBonus.multiplier}x</span>` : ""}
              </div>`;
            }).join("")}
          </div>
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
            if (typeof slopSFX !== "undefined") slopSFX.submitted();
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
          if (typeof slopSFX !== "undefined") slopSFX.submitted();
          eventBus.emit("toast:show", { message: "Work submitted for approval!", type: "warning" });
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

    // --- View more toggles ---
    this.shadowRoot.getElementById("toggle-earnings")?.addEventListener("click", () => {
      this._showAllEarnings = !this._showAllEarnings;
      this.render();
    });
    this.shadowRoot.getElementById("toggle-penalties")?.addEventListener("click", () => {
      this._showAllPenalties = !this._showAllPenalties;
      this.render();
    });

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

      // --- Inline approval: toggle expand on pending item click ---
      root.querySelectorAll(".kid-pending-item[data-completion-id]").forEach((item) => {
        item.addEventListener("click", (e) => {
          if (e.target.closest("button") || e.target.closest("input") || e.target.closest("label")) return;
          e.stopPropagation();
          const cId = item.dataset.completionId;
          this._expandedApprovalId = this._expandedApprovalId === cId ? null : cId;
          this.render();
        });
      });

      // --- Inline approval: approve button ---
      root.querySelectorAll("[data-kid-approve]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const completionId = btn.dataset.kidApprove;
          const criteriaSection = root.querySelector(`[data-kid-criteria-for="${completionId}"]`);
          const checkedIds = [];
          if (criteriaSection) {
            criteriaSection.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
              checkedIds.push(cb.dataset.criterionId);
            });
          }
          tracker.approveCompletion(completionId, checkedIds);
          if (typeof slopSFX !== "undefined") slopSFX.cashJingle();
          eventBus.emit("toast:show", { message: "Approved!", type: "success" });
          this._expandedApprovalId = null;
          this.render();
        });
      });

      // --- Inline approval: reject button ---
      root.querySelectorAll("[data-kid-reject]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const note = prompt("Rejection reason (optional):");
          if (note === null) return;
          tracker.rejectCompletion(btn.dataset.kidReject, note);
          if (typeof slopSFX !== "undefined") slopSFX.sadTrombone();
          eventBus.emit("toast:show", { message: "Rejected.", type: "danger" });
          this._expandedApprovalId = null;
          this.render();
        });
      });

      // --- Inline approval: live payout update for bonus criteria ---
      root.querySelectorAll("[data-kid-criteria-for]").forEach((section) => {
        const completionId = section.dataset.kidCriteriaFor;
        const payoutEl = section.querySelector(`[data-kid-adjusted-for="${completionId}"]`);
        if (!payoutEl) return;
        const baseRewards = JSON.parse(payoutEl.dataset.baseRewards);
        const checkboxes = section.querySelectorAll('input[type="checkbox"]');

        const updatePayout = () => {
          let multiplier = 1;
          checkboxes.forEach((cb) => {
            if (cb.checked) multiplier *= parseFloat(cb.dataset.multiplier);
          });
          if (multiplier === 1) {
            payoutEl.textContent = "";
          } else {
            const adjusted = Object.entries(baseRewards)
              .map(([cid, amt]) => {
                const c = tracker.getCurrency(cid);
                const decimals = c ? (c.decimals || 0) : 0;
                const factor = Math.pow(10, decimals);
                return tracker.formatAmount(Math.round(amt * multiplier * factor) / factor, cid);
              })
              .join(", ");
            payoutEl.textContent = `Adjusted payout: ${adjusted}`;
          }
        };

        checkboxes.forEach((cb) => cb.addEventListener("change", updatePayout));
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

    // Step 3: Play sound (skip for approval-required tasks — submitted() plays later)
    const needsApproval = task && task.requiresApproval;
    if (typeof slopSFX !== "undefined" && !needsApproval) {
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
        if (typeof slopSFX !== "undefined") slopSFX.submitted();
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
        if (t.recurrence === "transient") return tracker.isTaskCompletedSinceActivation(t.id, userId);
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
