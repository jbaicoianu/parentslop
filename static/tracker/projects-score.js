// projects-score: ranks open project tasks into daily suggestions.
// Pure functions, shared by the browser (window.ProjectsScore) and Node (require).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ProjectsScore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SIZE_MINUTES = { xs: 15, s: 45, m: 120, l: 240, xl: 480 };
  const ENERGY_LEVEL = { low: 0, medium: 1, high: 2 };
  const PRIORITY_LABEL = ["Someday", "Later", "Next", "Focus"];
  const OPEN = (s) => s === "todo" || s === "doing";
  const CLOSED = (s) => s === "done" || s === "dropped";
  const BACKUP_RISK = ["No backup", "Local git only", "Partly pushed", "Old snapshot only"];
  const BACKUP_TASK = /\b(git init|push|remote|commit|back ?up|copy (it )?off|snapshot|private repo|keep one verified)\b/i;

  function dayDiff(a, b) {
    return Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5);
  }

  // Per-project progress and activity facts.
  function projectStats(projects, tasks, picks, today) {
    const byId = new Map(projects.map((p) => [p.id, { project: p, open: 0, done: 0, total: 0, lastTouched: "" }]));
    const taskProject = new Map(tasks.map((t) => [t.id, t.projectId]));
    for (const t of tasks) {
      const s = byId.get(t.projectId);
      if (!s || t.status === "dropped") continue;
      s.total++;
      if (CLOSED(t.status)) s.done++; else s.open++;
      const touched = (t.completedAt || "").slice(0, 10);
      if (touched > s.lastTouched) s.lastTouched = touched;
    }
    for (const pk of picks) {
      const s = byId.get(taskProject.get(pk.taskId));
      if (s && pk.outcome && pk.date > s.lastTouched && pk.date <= today) s.lastTouched = pk.date;
    }
    for (const s of byId.values()) {
      s.progress = s.total ? s.done / s.total : 0;
      s.idleDays = s.lastTouched ? dayDiff(today, s.lastTouched) : null;
    }
    return byId;
  }

  // A task is blocked if it is marked blocked or any dependency is still open.
  function blockers(task, taskById) {
    if (task.status === "blocked") return ["marked blocked"];
    return (task.dependsOn || []).map((id) => taskById.get(id)).filter((d) => d && !CLOSED(d.status)).map((d) => d.title);
  }

  /**
   * suggest({projects, tasks, picks, me}, {today, minutes, energy, limit, perProject})
   * Tasks assigned to someone other than `me` are never suggested.
   * Returns [{task, project, score, reasons[], warnings[]}], best first.
   */
  function suggest(data, opts = {}) {
    const { projects = [], tasks = [], picks = [] } = data;
    const today = opts.today;
    const limit = opts.limit || 8;
    const perProject = opts.perProject || 2;
    const minutes = opts.minutes || 0;
    const energy = opts.energy in ENERGY_LEVEL ? opts.energy : "medium";
    const me = opts.me ?? data.me;
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const stats = projectStats(projects, tasks, picks, today);
    const pickedToday = new Set(picks.filter((p) => p.date === today).map((p) => p.taskId));

    // How many open tasks wait on each task (directly).
    const waiting = new Map();
    for (const t of tasks) {
      if (!OPEN(t.status) && t.status !== "blocked") continue;
      for (const d of t.dependsOn || []) waiting.set(d, (waiting.get(d) || 0) + 1);
    }

    const scored = [];
    for (const t of tasks) {
      if (!OPEN(t.status) || pickedToday.has(t.id)) continue;
      if (t.assigneeId && me && t.assigneeId !== me) continue;
      const p = projectById.get(t.projectId);
      if (!p || p.archived || p.status === "Done" || p.status === "Dropped") continue;
      if (blockers(t, taskById).length) continue;
      const s = stats.get(p.id);
      let score = 0;
      const reasons = [];
      const warnings = [];
      const add = (pts, why) => { score += pts; if (why && pts > 0) reasons.push({ pts, why }); };

      add([-10, 5, 20, 40][p.priority ?? 1] ?? 5, p.priority === 3 ? "Focus project" : p.priority === 2 ? "Up next" : "");
      add((t.priority ?? 1) * 8, t.priority >= 2 ? "High-priority task" : "");
      if (t.status === "doing") add(12, "Already in progress");
      if (t.assigneeId && t.assigneeId === me) add(8, "Assigned to you");

      const risky = BACKUP_RISK.includes(p.backup) && (p.status === "Active" || p.status === "Paused" || p.showcaseRank);
      if (risky && BACKUP_TASK.test(t.title)) add(30, `Protects unsaved work (${p.backup.toLowerCase()})`);
      else if (risky) add(6, "");

      if (p.showcaseRank) add(Math.max(0, 22 - p.showcaseRank), p.showcaseRank <= 6 ? `Top-ranked project (#${p.showcaseRank})` : "");

      const unblocks = waiting.get(t.id) || 0;
      if (unblocks) add(10 * unblocks, `Unblocks ${unblocks} task${unblocks > 1 ? "s" : ""}`);

      if (s.open <= 2 && s.done >= 1) add(18, s.open === 1 ? "Last task before the project is done" : "2 tasks from done");
      if (s.idleDays !== null && s.idleDays <= 3) add(8, "Keeps momentum");
      if (s.idleDays !== null && s.idleDays >= 21 && p.priority >= 2) add(6, `Untouched for ${s.idleDays} days`);

      const est = SIZE_MINUTES[t.size] || 60;
      if (minutes) {
        if (est > minutes * 1.5) { score -= 25; warnings.push("Bigger than today's time; consider splitting"); }
        else if (est <= minutes) add(6, "Fits today's time");
      }
      const gap = ENERGY_LEVEL[t.energy || "medium"] - ENERGY_LEVEL[energy];
      if (gap > 0) { score -= 12 * gap; warnings.push("Needs more energy than you have today"); }
      else if (gap === 0 && energy === "low") add(4, "Good low-energy task");

      scored.push({ task: t, project: p, score, est, reasons: reasons.sort((a, b) => b.pts - a.pts).map((r) => r.why), warnings });
    }

    scored.sort((a, b) => b.score - a.score || a.task.title.localeCompare(b.task.title));
    const out = [];
    const perCount = new Map();
    for (const s of scored) {
      const n = perCount.get(s.project.id) || 0;
      if (n >= perProject) continue;
      perCount.set(s.project.id, n + 1);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  const FINISHED = (p) => p.status === "Done" || p.status === "Dropped";

  // Days between 'today' and n days earlier, oldest first: ["2026-11-03", ..., today].
  function lastDays(today, n) {
    const out = [];
    const base = Date.parse(today + "T12:00:00Z");
    for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 864e5).toISOString().slice(0, 10));
    return out;
  }

  /**
   * Per-track view of the backlog. Returns [{track, projects: {focus, next, later, someday, finished},
   *   next: [suggestions], doneThisWeek, days: [{date, worked}], idleDays, overFocus}] in track order,
   * plus an "Unsorted" pseudo-track for projects without one (only when there are any).
   */
  function trackSummary(data, opts = {}) {
    const { tracks = [], projects = [], tasks = [], picks = [] } = data;
    const today = opts.today;
    const stats = projectStats(projects, tasks, picks, today);
    const all = suggest(data, { ...opts, limit: 10000, perProject: opts.perProject || 3 });
    const known = new Set(tracks.map((t) => t.id));
    const list = [...tracks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    if (projects.some((p) => !known.has(p.trackId))) list.push({ id: "", name: "Unsorted", icon: "📥", color: "#8b8fa8", intention: "Projects that haven't been given a track yet.", focusLimit: 2 });
    const projectTrack = new Map(projects.map((p) => [p.id, known.has(p.trackId) ? p.trackId : ""]));
    const taskTrack = new Map(tasks.map((t) => [t.id, projectTrack.get(t.projectId)]));
    const week = lastDays(today, 7);
    const weekStart = week[0];

    return list.map((track) => {
      const mine = projects.filter((p) => projectTrack.get(p.id) === track.id);
      const byRank = (a, b) => ((a.showcaseRank || 999) - (b.showcaseRank || 999))
        || (b.lastActivity || "").localeCompare(a.lastActivity || "") || a.name.localeCompare(b.name);
      const open = mine.filter((p) => !FINISHED(p));
      const lane = (n) => open.filter((p) => (p.priority ?? 1) === n).sort(byRank);
      const worked = new Set();
      let lastTouched = "";
      for (const pk of picks) {
        if (taskTrack.get(pk.taskId) !== track.id || !(pk.outcome === "done" || pk.outcome === "partial")) continue;
        worked.add(pk.date);
        if (pk.date > lastTouched && pk.date <= today) lastTouched = pk.date;
      }
      let doneThisWeek = 0;
      for (const t of tasks) {
        if (taskTrack.get(t.id) !== track.id || t.status !== "done" || !t.completedAt) continue;
        const d = t.completedAt.slice(0, 10);
        worked.add(d);
        if (d >= weekStart) doneThisWeek++;
        if (d > lastTouched && d <= today) lastTouched = d;
      }
      const focus = lane(3);
      return {
        track,
        projects: {
          focus, next: lane(2), later: lane(1), someday: lane(0),
          finished: mine.filter(FINISHED).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
        },
        stats,
        next: all.filter((s) => projectTrack.get(s.project.id) === track.id),
        doneThisWeek,
        days: week.map((date) => ({ date, worked: worked.has(date) })),
        lastTouched,
        idleDays: lastTouched ? dayDiff(today, lastTouched) : null,
        overFocus: focus.length > (track.focusLimit || 2),
      };
    });
  }

  return { suggest, projectStats, trackSummary, lastDays, blockers, SIZE_MINUTES, PRIORITY_LABEL, OPEN, CLOSED, FINISHED };
});
