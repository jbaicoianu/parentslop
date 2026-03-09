// ============================================================================
// ParentSlop Tracker – Foundation
// EventBus, TrackerStore, all stores, business logic, shared CSS
// ============================================================================

// --- EventBus ----------------------------------------------------------------

class EventBus {
  constructor() {
    this._listeners = {};
  }

  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this._listeners[event];
    if (!list) return;
    this._listeners[event] = list.filter((f) => f !== fn);
  }

  emit(event, data) {
    const list = this._listeners[event];
    if (!list) return;
    for (const fn of list) {
      try { fn(data); } catch (e) { console.error(`EventBus error [${event}]:`, e); }
    }
  }
}

const bus = new EventBus();

// --- TrackerStore ------------------------------------------------------------

class TrackerStore {
  constructor(key, defaultValue, { localOnly = false } = {}) {
    this._key = key;
    this._default = defaultValue;
    this._data = undefined;
    this._localOnly = localOnly;
  }

  load() {
    try {
      const raw = localStorage.getItem(this._key);
      if (raw === null) {
        this._data = structuredClone(this._default);
        return this._data;
      }
      this._data = JSON.parse(raw);
      return this._data;
    } catch (e) {
      console.warn(`TrackerStore: failed to parse ${this._key}`, e);
      this._data = structuredClone(this._default);
      return this._data;
    }
  }

  save(data) {
    if (data !== undefined) this._data = data;
    localStorage.setItem(this._key, JSON.stringify(this._data));
    bus.emit(`store:${this._key}`, this._data);
    if (!this._localOnly) this._persistToServer();
  }

  async fetchFromServer() {
    if (this._localOnly) {
      this.load();
      return true;
    }
    try {
      const res = await fetch(`/api/store/${encodeURIComponent(this._key)}`);
      if (res.status === 401) {
        bus.emit("auth:required");
        this.load();
        return false;
      }
      if (!res.ok) {
        this.load();
        return false;
      }
      const row = await res.json();
      this._data = JSON.parse(row.value);
      localStorage.setItem(this._key, row.value);
      return true;
    } catch (e) {
      console.warn(`TrackerStore: server fetch failed for ${this._key}, using localStorage`, e);
      this.load();
      return false;
    }
  }

  async _persistToServer() {
    try {
      const res = await fetch(`/api/store/${encodeURIComponent(this._key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(this._data) }),
      });
      if (res.status === 401) {
        bus.emit("auth:required");
      }
    } catch (e) {
      console.warn(`TrackerStore: server persist failed for ${this._key}`, e);
    }
  }

  get data() {
    if (this._data === undefined) this.load();
    return this._data;
  }

  set data(v) {
    this._data = v;
  }
}

// --- Store instances ---------------------------------------------------------

const usersStore = new TrackerStore("parentslop.users.v1", []);
const currencyStore = new TrackerStore("parentslop.currencies.v1", []);
const taskStore = new TrackerStore("parentslop.tasks.v1", []);
const completionStore = new TrackerStore("parentslop.completions.v1", []);
const shopStore = new TrackerStore("parentslop.shop.v1", []);
const redemptionStore = new TrackerStore("parentslop.redemptions.v1", []);
const appStore = new TrackerStore("parentslop.app.v1", {
  setupComplete: false,
  currentUserId: null,
  currentView: "dashboard",
}, { localOnly: true });
const jobClaimStore = new TrackerStore("parentslop.jobclaims.v1", []);
const worklogStore = new TrackerStore("parentslop.worklog.v1", []);

// --- User model migration ----------------------------------------------------
// Existing users may lack isAdmin / balances. Patch on load.

function migrateUsers() {
  const users = usersStore.load();
  let changed = false;
  for (const u of users) {
    if (u.isAdmin === undefined) { u.isAdmin = false; changed = true; }
    if (!u.balances) { u.balances = {}; changed = true; }
    if (!u.tags) { u.tags = []; changed = true; }
  }
  if (changed) usersStore.save(users);
  return users;
}

// --- ID helpers --------------------------------------------------------------

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function now() {
  return new Date().toISOString();
}

// --- Currency helpers --------------------------------------------------------

function getCurrency(id) {
  return currencyStore.data.find((c) => c.id === id);
}

function formatAmount(amount, currencyId) {
  const c = getCurrency(currencyId);
  if (!c) return String(amount);
  const decimals = c.decimals || 0;
  const val = Number(amount).toFixed(decimals);
  return `${c.symbol || ""}${val}`;
}

function createCurrency(name, symbol, decimals = 0, color = "#66d9ef") {
  const c = { id: uid(), name, symbol, decimals: Math.max(0, Math.min(decimals, 4)), color, createdAt: now() };
  currencyStore.data.push(c);
  currencyStore.save();
  bus.emit("currencies:changed");
  return c;
}

// --- Balance management ------------------------------------------------------

function getBalance(userId, currencyId) {
  const user = usersStore.data.find((u) => u.id === userId);
  if (!user) return 0;
  if (!user.balances) user.balances = {};
  return user.balances[currencyId] || 0;
}

function adjustBalance(userId, currencyId, delta) {
  const user = usersStore.data.find((u) => u.id === userId);
  if (!user) return;
  if (!user.balances) user.balances = {};
  user.balances[currencyId] = (user.balances[currencyId] || 0) + delta;
  usersStore.save();
  bus.emit("balances:changed", { userId });
}

function setBalance(userId, currencyId, amount) {
  const user = usersStore.data.find((u) => u.id === userId);
  if (!user) return;
  if (!user.balances) user.balances = {};
  user.balances[currencyId] = amount;
  usersStore.save();
  bus.emit("balances:changed", { userId });
}

// --- Streak calculation ------------------------------------------------------

function dateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekKey(iso) {
  const d = new Date(iso);
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const jan1 = new Date(local.getFullYear(), 0, 1);
  const week = Math.ceil(((local - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${local.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function calcStreak(taskId, userId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return 0;
  if (task.recurrence === "transient") return 0;

  const completions = completionStore.data
    .filter((c) => c.taskId === taskId && c.userId === userId && c.status === "approved")
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  if (completions.length === 0) return 0;

  const keyFn = task.recurrence === "weekly" ? weekKey : dateKey;
  const keys = [...new Set(completions.map((c) => keyFn(c.completedAt)))].sort().reverse();

  // Count consecutive keys from today backwards
  const todayKey = keyFn(new Date().toISOString());
  let streak = 0;
  let expected = todayKey;
  const activeDays = task.activeDays && task.activeDays.length > 0 ? task.activeDays : null;
  const isDaily = task.recurrence !== "weekly";

  // Skip today if it's not a scheduled day
  if (isDaily && activeDays) {
    let skipped = 0;
    while (skipped < 6) {
      const [ey, em, ed] = expected.split("-").map(Number);
      const dow = new Date(ey, em - 1, ed).getDay();
      if (activeDays.includes(dow)) break;
      expected = prevKey(expected, "day");
      skipped++;
    }
  }

  for (const k of keys) {
    if (k === expected) {
      streak++;
      expected = prevKey(expected, isDaily ? "day" : "week");
      // Skip non-scheduled days when walking backwards
      if (isDaily && activeDays) {
        let skipped = 0;
        while (skipped < 6) {
          const [ey, em, ed] = expected.split("-").map(Number);
          const dow = new Date(ey, em - 1, ed).getDay();
          if (activeDays.includes(dow)) break;
          expected = prevKey(expected, "day");
          skipped++;
        }
      }
    } else if (k < expected) {
      // Gap found
      break;
    }
  }

  return streak;
}

function prevKey(key, unit) {
  if (unit === "day") {
    const [y, m, d] = key.split("-").map(Number);
    const prev = new Date(y, m - 1, d - 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
  }
  // week
  const parts = key.split("-W");
  let year = parseInt(parts[0]);
  let week = parseInt(parts[1]) - 1;
  if (week < 1) { year--; week = 52; }
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// --- Task completion logic ---------------------------------------------------

function completeTask(taskId, userId, timerSeconds = null) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;

  const streak = calcStreak(taskId, userId);
  const newStreak = streak + 1;

  // Determine bonuses
  let streakMultiplier = 1;
  if (task.streakBonus && newStreak >= task.streakBonus.threshold) {
    streakMultiplier = task.streakBonus.multiplier || 1;
  }

  let timerMultiplier = 1;
  if (task.timerBonus && timerSeconds !== null) {
    const mode = task.timerBonus.mode || "under"; // "under" = finish before target, "over" = spend at least target
    const hit = mode === "over"
      ? timerSeconds >= task.timerBonus.targetSeconds
      : timerSeconds <= task.timerBonus.targetSeconds;
    if (hit) timerMultiplier = task.timerBonus.multiplier || 1;
  }

  const totalMultiplier = streakMultiplier * timerMultiplier;

  // Calculate granted rewards
  const rewards = {};
  if (task.rewards) {
    for (const [currId, baseAmount] of Object.entries(task.rewards)) {
      const c = getCurrency(currId);
      const decimals = c ? (c.decimals || 0) : 0;
      const factor = Math.pow(10, decimals);
      rewards[currId] = Math.round(baseAmount * totalMultiplier * factor) / factor;
    }
  }

  const status = task.requiresApproval ? "pending" : "approved";

  const completion = {
    id: uid(),
    taskId,
    userId,
    status,
    completedAt: now(),
    timerSeconds,
    streakCount: newStreak,
    streakMultiplier,
    timerMultiplier,
    rewards,
    note: "",
  };

  completionStore.data.push(completion);
  completionStore.save();

  // If auto-approved, credit immediately
  if (status === "approved") {
    creditRewards(userId, rewards);
  }

  bus.emit("completion:added", completion);
  return completion;
}

function approveCompletion(completionId, checkedCriteria = []) {
  const c = completionStore.data.find((x) => x.id === completionId);
  if (!c || c.status !== "pending") return;

  // Apply bonus criteria multipliers if any were checked
  const task = taskStore.data.find((t) => t.id === c.taskId);
  let criteriaMultiplier = 1;
  if (task?.bonusCriteria?.length > 0 && checkedCriteria.length > 0) {
    for (const criterion of task.bonusCriteria) {
      if (checkedCriteria.includes(criterion.id)) {
        criteriaMultiplier *= criterion.multiplier;
      }
    }
    // Adjust rewards by criteria multiplier
    if (criteriaMultiplier !== 1 && c.rewards) {
      for (const [currId, baseAmount] of Object.entries(c.rewards)) {
        const curr = getCurrency(currId);
        const decimals = curr ? (curr.decimals || 0) : 0;
        const factor = Math.pow(10, decimals);
        c.rewards[currId] = Math.round(baseAmount * criteriaMultiplier * factor) / factor;
      }
    }
  }

  c.bonusCriteriaChecked = checkedCriteria.length > 0 ? checkedCriteria : null;
  c.bonusCriteriaMultiplier = criteriaMultiplier !== 1 ? criteriaMultiplier : null;
  c.status = "approved";
  c.approvedAt = now();
  completionStore.save();
  creditRewards(c.userId, c.rewards);
  bus.emit("completion:approved", c);
}

function rejectCompletion(completionId, note = "") {
  const c = completionStore.data.find((x) => x.id === completionId);
  if (!c || c.status !== "pending") return;
  c.status = "rejected";
  c.rejectedAt = now();
  if (note) c.rejectionNote = note;
  completionStore.save();
  bus.emit("completion:rejected", c);
}

function creditRewards(userId, rewards) {
  if (!rewards) return;
  for (const [currId, amount] of Object.entries(rewards)) {
    adjustBalance(userId, currId, amount);
  }
}

// --- Penalty logging (admin only) -------------------------------------------

function logPenalty(taskId, userId, note = "") {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task || !task.isPenalty) return null;

  const rewards = {};
  if (task.rewards) {
    for (const [currId, amount] of Object.entries(task.rewards)) {
      rewards[currId] = amount; // negative values
    }
  }

  const completion = {
    id: uid(),
    taskId,
    userId,
    status: "approved",
    completedAt: now(),
    timerSeconds: null,
    streakCount: 0,
    streakMultiplier: 1,
    timerMultiplier: 1,
    rewards,
    note,
    isPenalty: true,
  };

  completionStore.data.push(completion);
  completionStore.save();
  creditRewards(userId, rewards);
  bus.emit("completion:added", completion);
  return completion;
}

// --- Shop / redemption -------------------------------------------------------

function purchaseItem(shopItemId, userId) {
  const item = shopStore.data.find((s) => s.id === shopItemId);
  if (!item) return { ok: false, reason: "Item not found" };

  const user = usersStore.data.find((u) => u.id === userId);
  if (!user) return { ok: false, reason: "User not found" };

  // Check sufficient balance for all costs
  for (const [currId, cost] of Object.entries(item.costs || {})) {
    if (getBalance(userId, currId) < cost) {
      const c = getCurrency(currId);
      return { ok: false, reason: `Not enough ${c ? c.name : currId}` };
    }
  }

  // Deduct
  for (const [currId, cost] of Object.entries(item.costs || {})) {
    adjustBalance(userId, currId, -cost);
  }

  const redemption = {
    id: uid(),
    shopItemId,
    userId,
    purchasedAt: now(),
    fulfilled: false,
  };

  redemptionStore.data.push(redemption);
  redemptionStore.save();
  bus.emit("redemption:added", redemption);
  return { ok: true, redemption };
}

function fulfillRedemption(redemptionId) {
  const r = redemptionStore.data.find((x) => x.id === redemptionId);
  if (!r) return;
  r.fulfilled = true;
  r.fulfilledAt = now();
  redemptionStore.save();
  bus.emit("redemption:fulfilled", r);
}

// --- Task CRUD ---------------------------------------------------------------

function createTask(data) {
  const task = {
    id: uid(),
    name: data.name || "New Task",
    description: data.description || "",
    recurrence: data.recurrence || "daily", // daily | weekly | once | transient
    available: data.available ?? (data.recurrence === "transient" ? false : true),
    lastActivatedAt: data.lastActivatedAt || null,
    assignedUsers: data.assignedUsers || [], // empty = all
    requiresApproval: data.requiresApproval ?? false,
    isPenalty: data.isPenalty ?? false,
    rewards: data.rewards || {}, // { currencyId: amount }
    streakBonus: data.streakBonus || null, // { threshold, multiplier }
    timerBonus: data.timerBonus || null, // { targetSeconds, multiplier }
    bonusCriteria: data.bonusCriteria || null, // [{ id, label, multiplier }]
    category: data.category || "routine", // "routine" | "jobboard"
    payType: data.payType || "fixed", // "fixed" | "hourly"
    requiredTags: data.requiredTags || [], // tags required for task visibility
    activeDays: data.activeDays || [], // day numbers (0=Sun..6=Sat); empty = every day
    multiUser: data.multiUser ?? true, // whether multiple kids can accept
    maxPayout: data.maxPayout || null, // optional cap for hourly: { currencyId: amount }
    createdAt: now(),
    archived: false,
  };
  taskStore.data.push(task);
  taskStore.save();
  bus.emit("tasks:changed");
  return task;
}

function updateTask(taskId, updates) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;
  Object.assign(task, updates);
  taskStore.save();
  bus.emit("tasks:changed");
  return task;
}

function archiveTask(taskId) {
  return updateTask(taskId, { archived: true });
}

// --- Shop CRUD ---------------------------------------------------------------

function createShopItem(data) {
  const item = {
    id: uid(),
    name: data.name || "New Reward",
    description: data.description || "",
    costs: data.costs || {}, // { currencyId: amount }
    createdAt: now(),
    archived: false,
  };
  shopStore.data.push(item);
  shopStore.save();
  bus.emit("shop:changed");
  return item;
}

function updateShopItem(itemId, updates) {
  const item = shopStore.data.find((s) => s.id === itemId);
  if (!item) return null;
  Object.assign(item, updates);
  shopStore.save();
  bus.emit("shop:changed");
  return item;
}

// --- Recent penalties helper -------------------------------------------------

function getRecentPenalties(userId, days = 7) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0); // midnight today, local time
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffISO = cutoff.toISOString();

  return completionStore.data.filter(
    (c) => c.userId === userId && c.isPenalty && c.completedAt >= cutoffISO
  ).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

// --- Transient task helpers --------------------------------------------------

function isTaskCompletedSinceActivation(taskId, userId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task || !task.lastActivatedAt) return false;
  return completionStore.data.some(
    (c) => c.taskId === taskId && c.userId === userId && c.status !== "rejected" && c.completedAt >= task.lastActivatedAt
  );
}

function activateTransientTask(taskId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;
  task.available = true;
  task.lastActivatedAt = now();
  taskStore.save();
  // Clear old job claims so the task appears fresh on the board
  const oldClaims = jobClaimStore.data.filter((c) => c.taskId === taskId);
  if (oldClaims.length > 0) {
    jobClaimStore.data = jobClaimStore.data.filter((c) => c.taskId !== taskId);
    jobClaimStore.save();
    bus.emit("jobclaims:changed");
  }
  bus.emit("tasks:changed");
  return task;
}

function deactivateTransientTask(taskId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;
  task.available = false;
  taskStore.save();
  bus.emit("tasks:changed");
  return task;
}

// --- Current user helper -----------------------------------------------------

function getCurrentUser() {
  const app = appStore.data;
  if (!app.currentUserId) return null;
  return usersStore.data.find((u) => u.id === app.currentUserId) || null;
}

function isCurrentUserAdmin() {
  const u = getCurrentUser();
  return u ? u.isAdmin === true : false;
}

// --- Data export / import ----------------------------------------------------

function exportAllData() {
  const storeList = [usersStore, currencyStore, taskStore, completionStore, shopStore, redemptionStore, appStore, jobClaimStore, worklogStore];
  const data = {};
  for (const s of storeList) {
    if (s._data !== undefined) data[s._key] = s._data;
  }
  return data;
}

function importAllData(data) {
  const storeMap = {
    "parentslop.users.v1": usersStore,
    "parentslop.currencies.v1": currencyStore,
    "parentslop.tasks.v1": taskStore,
    "parentslop.completions.v1": completionStore,
    "parentslop.shop.v1": shopStore,
    "parentslop.redemptions.v1": redemptionStore,
    "parentslop.app.v1": appStore,
    "parentslop.jobclaims.v1": jobClaimStore,
    "parentslop.worklog.v1": worklogStore,
  };
  for (const [k, v] of Object.entries(data)) {
    const store = storeMap[k];
    if (store) {
      store._data = v;
      store.save();
    }
  }
  migrateUsers();
  bus.emit("data:imported");
}

// --- Today helper for dashboard ----------------------------------------------

function getTasksForUser(userId) {
  const tasks = taskStore.data.filter((t) => {
    if (t.archived) return false;
    if (t.isPenalty) return false;
    if (t.recurrence === "transient" && !t.available) return false;
    if (t.assignedUsers.length > 0 && !t.assignedUsers.includes(userId)) return false;
    if (t.requiredTags?.length > 0) {
      const userTags = usersStore.data.find(u => u.id === userId)?.tags || [];
      if (!t.requiredTags.some(tag => userTags.includes(tag))) return false;
    }
    return true;
  });
  return tasks;
}

function isTaskCompletedToday(taskId, userId) {
  const today = dateKey(new Date().toISOString());
  return completionStore.data.some(
    (c) => c.taskId === taskId && c.userId === userId && dateKey(c.completedAt) === today && c.status !== "rejected"
  );
}

function isTaskCompletedThisWeek(taskId, userId) {
  const thisWeek = weekKey(new Date().toISOString());
  return completionStore.data.some(
    (c) => c.taskId === taskId && c.userId === userId && weekKey(c.completedAt) === thisWeek && c.status !== "rejected"
  );
}

function isTaskScheduledToday(task) {
  if (!task.activeDays || task.activeDays.length === 0) return true;
  return task.activeDays.includes(new Date().getDay());
}

// --- Admin: reset a user's daily tasks for today ----------------------------

function resetDailyTasks(userId) {
  const today = dateKey(new Date().toISOString());
  const dailyTaskIds = new Set(
    taskStore.data.filter((t) => !t.archived && !t.isPenalty && t.recurrence === "daily").map((t) => t.id)
  );

  // Find today's completions for daily tasks by this user
  const toRemove = [];
  for (let i = 0; i < completionStore.data.length; i++) {
    const c = completionStore.data[i];
    if (c.userId === userId && dailyTaskIds.has(c.taskId) && dateKey(c.completedAt) === today) {
      // Reverse credited rewards if the completion was approved
      if (c.status === "approved" && c.rewards) {
        for (const [currId, amount] of Object.entries(c.rewards)) {
          adjustBalance(userId, currId, -amount);
        }
      }
      toRemove.push(i);
    }
  }

  if (toRemove.length === 0) return 0;

  // Remove completions in reverse index order to avoid shifting
  for (let i = toRemove.length - 1; i >= 0; i--) {
    completionStore.data.splice(toRemove[i], 1);
  }
  completionStore.save();
  bus.emit("completion:added"); // triggers UI refresh
  return toRemove.length;
}

// --- Job acceptance ----------------------------------------------------------

function acceptJob(taskId, userId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;
  const claims = jobClaimStore.data;
  // No-op if already accepted
  const existing = claims.find((c) => c.taskId === taskId && c.userId === userId);
  if (existing) return existing;
  // Reject if single-user and someone else claimed it
  if (task.multiUser === false) {
    const otherClaim = claims.find((c) => c.taskId === taskId && c.userId !== userId);
    if (otherClaim) return null;
  }
  const claim = {
    id: uid(),
    taskId,
    userId,
    acceptedAt: now(),
    status: "active",
  };
  claims.push(claim);
  jobClaimStore.save();
  bus.emit("jobclaims:changed", claim);
  return claim;
}

function getUserActiveJobs(userId) {
  return jobClaimStore.data.filter((c) => c.userId === userId && c.status === "active");
}

function getJobClaim(taskId, userId) {
  return jobClaimStore.data.find((c) => c.taskId === taskId && c.userId === userId) || null;
}

// --- Clock in/out (hourly) ---------------------------------------------------

function clockIn(taskId, userId) {
  const entries = worklogStore.data;
  const open = entries.find((e) => e.taskId === taskId && e.userId === userId && e.clockOut === null);
  if (open) return open; // already clocked in
  const entry = {
    id: uid(),
    taskId,
    userId,
    clockIn: now(),
    clockOut: null,
  };
  entries.push(entry);
  worklogStore.save();
  bus.emit("worklog:changed", entry);
  return entry;
}

function clockOut(taskId, userId) {
  const entry = worklogStore.data.find((e) => e.taskId === taskId && e.userId === userId && e.clockOut === null);
  if (!entry) return null;
  entry.clockOut = now();
  worklogStore.save();
  bus.emit("worklog:changed", entry);
  return entry;
}

function getActiveClockIn(taskId, userId) {
  return worklogStore.data.find((e) => e.taskId === taskId && e.userId === userId && e.clockOut === null) || null;
}

function getWorklog(taskId, userId) {
  return worklogStore.data
    .filter((e) => e.taskId === taskId && e.userId === userId)
    .sort((a, b) => a.clockIn.localeCompare(b.clockIn));
}

function getTotalSeconds(taskId, userId) {
  const entries = getWorklog(taskId, userId);
  let total = 0;
  for (const e of entries) {
    if (e.clockOut) {
      total += (new Date(e.clockOut) - new Date(e.clockIn)) / 1000;
    }
  }
  return Math.round(total);
}

// --- Job submission ----------------------------------------------------------

function submitHourlyWork(taskId, userId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;
  // Clock out if still clocked in
  clockOut(taskId, userId);
  const totalSecs = getTotalSeconds(taskId, userId);
  const totalHours = totalSecs / 3600;
  // Calculate rewards: rate * hours, capped by maxPayout
  const rewards = {};
  if (task.rewards) {
    for (const [currId, rate] of Object.entries(task.rewards)) {
      const c = getCurrency(currId);
      const decimals = c ? (c.decimals || 0) : 0;
      const factor = Math.pow(10, decimals);
      let amount = Math.round(rate * totalHours * factor) / factor;
      if (task.maxPayout && task.maxPayout[currId] != null) {
        amount = Math.min(amount, task.maxPayout[currId]);
      }
      rewards[currId] = amount;
    }
  }
  // Build worklog snapshot
  const worklog = getWorklog(taskId, userId)
    .filter((e) => e.clockOut)
    .map((e) => ({
      clockIn: e.clockIn,
      clockOut: e.clockOut,
      seconds: Math.round((new Date(e.clockOut) - new Date(e.clockIn)) / 1000),
    }));
  const completion = {
    id: uid(),
    taskId,
    userId,
    status: "pending",
    completedAt: now(),
    timerSeconds: null,
    streakCount: 0,
    streakMultiplier: 1,
    timerMultiplier: 1,
    rewards,
    note: "",
    isHourly: true,
    totalSeconds: totalSecs,
    worklog,
  };
  completionStore.data.push(completion);
  completionStore.save();
  // Set claim status to submitted
  const claim = jobClaimStore.data.find((c) => c.taskId === taskId && c.userId === userId);
  if (claim) {
    claim.status = "submitted";
    jobClaimStore.save();
  }
  // Clear worklog entries for this task+user
  worklogStore.data = worklogStore.data.filter((e) => !(e.taskId === taskId && e.userId === userId));
  worklogStore.save();
  bus.emit("completion:added", completion);
  bus.emit("jobclaims:changed");
  return completion;
}

function submitFixedJob(taskId, userId) {
  const task = taskStore.data.find((t) => t.id === taskId);
  if (!task) return null;
  const result = completeTask(taskId, userId);
  // Set claim status to submitted
  const claim = jobClaimStore.data.find((c) => c.taskId === taskId && c.userId === userId);
  if (claim) {
    claim.status = "submitted";
    jobClaimStore.save();
    bus.emit("jobclaims:changed");
  }
  return result;
}

// --- Shared CSS constant -----------------------------------------------------

const TRACKER_CSS = `
  :host {
    display: block;
    --bg: #05060a;
    --bg-alt: #11121a;
    --card-bg: #181926;
    --accent: #66d9ef;
    --accent-soft: rgba(102, 217, 239, 0.16);
    --accent-strong: rgba(102, 217, 239, 0.44);
    --text: #f7f7ff;
    --muted: #a0a4be;
    --border-subtle: #25273a;
    --danger: #ff6b81;
    --success: #50fa7b;
    --warning: #f1fa8c;
    --radius-lg: 18px;
    --radius-md: 12px;
    --radius-sm: 8px;
    --shadow-soft: 0 18px 45px rgba(0, 0, 0, 0.5);
    --transition-fast: 160ms ease-out;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    color: var(--text);
  }

  * { box-sizing: border-box; }

  .panel {
    border-radius: 24px;
    padding: 18px 18px 20px;
    background: radial-gradient(circle at top left, #1a1c2a, #090a13);
    border: 1px solid var(--border-subtle);
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.55);
  }

  .panel-title {
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 4px;
  }

  .panel-subtitle {
    font-size: 0.8rem;
    color: var(--muted);
    opacity: 0.85;
  }

  .btn {
    appearance: none;
    border: none;
    border-radius: 999px;
    padding: 9px 16px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: radial-gradient(circle at top left, #2b344e, #1b1e34);
    color: var(--text);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.7);
    border: 1px solid var(--accent-strong);
    transition: transform var(--transition-fast), box-shadow var(--transition-fast), background var(--transition-fast);
  }

  .btn:hover {
    transform: translateY(-1px);
    background: radial-gradient(circle at top left, #3a4670, #20243b);
    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.8);
  }

  .btn:active {
    transform: translateY(0);
  }

  .btn-sm {
    padding: 6px 12px;
    font-size: 0.78rem;
  }

  .btn-danger {
    border-color: rgba(255, 107, 129, 0.4);
    background: radial-gradient(circle at top left, #3a1a22, #1b1118);
  }

  .btn-danger:hover {
    background: radial-gradient(circle at top left, #4a2030, #2a1520);
  }

  .btn-success {
    border-color: rgba(80, 250, 123, 0.4);
    background: radial-gradient(circle at top left, #1a3a22, #111b18);
  }

  .btn-success:hover {
    background: radial-gradient(circle at top left, #204a30, #152a20);
  }

  .btn-ghost {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: none;
  }

  .btn-ghost:hover {
    background: rgba(255, 255, 255, 0.04);
    box-shadow: none;
  }

  .card {
    border-radius: var(--radius-lg);
    padding: 14px 13px 13px;
    background: linear-gradient(145deg, #181926, #10111b);
    border: 1px solid rgba(255, 255, 255, 0.03);
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
  }

  .card-interactive {
    cursor: pointer;
    transition: transform var(--transition-fast), box-shadow var(--transition-fast), border-color var(--transition-fast);
  }

  .card-interactive:hover {
    transform: translateY(-2px);
    border-color: var(--accent-soft);
    box-shadow: 0 18px 36px rgba(0, 0, 0, 0.7);
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 0.7rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: radial-gradient(circle at top, #252944, #121421);
    color: var(--muted);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }

  .form-group label {
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .form-group input, .form-group select, .form-group textarea {
    background: #0d0e16;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    font-size: 0.88rem;
    color: var(--text);
    font-family: inherit;
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
    border-color: var(--accent);
  }

  .form-group select {
    cursor: pointer;
  }

  .form-row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }

  .form-row .form-group {
    flex: 1;
  }

  .form-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  .empty-state {
    padding: 20px 16px;
    border-radius: var(--radius-lg);
    border: 1px dashed rgba(255, 255, 255, 0.08);
    background: radial-gradient(circle at top, #191a28, #0b0b14);
    font-size: 0.84rem;
    color: var(--muted);
    text-align: center;
  }

  .empty-state strong {
    color: var(--accent);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 600;
  }

  .badge-streak {
    background: rgba(241, 250, 140, 0.15);
    color: var(--warning);
    border: 1px solid rgba(241, 250, 140, 0.2);
  }

  .badge-pending {
    background: rgba(241, 250, 140, 0.1);
    color: var(--warning);
    border: 1px solid rgba(241, 250, 140, 0.15);
  }

  .badge-approved {
    background: rgba(80, 250, 123, 0.1);
    color: var(--success);
    border: 1px solid rgba(80, 250, 123, 0.15);
  }

  .badge-rejected {
    background: rgba(255, 107, 129, 0.1);
    color: var(--danger);
    border: 1px solid rgba(255, 107, 129, 0.15);
  }

  .text-danger { color: var(--danger); }
  .text-success { color: var(--success); }
  .text-warning { color: var(--warning); }
  .text-muted { color: var(--muted); }
  .text-accent { color: var(--accent); }

  .mt-2 { margin-top: 8px; }
  .mt-3 { margin-top: 12px; }
  .mt-4 { margin-top: 16px; }
  .mb-2 { margin-bottom: 8px; }
  .mb-3 { margin-bottom: 12px; }
  .gap-2 { gap: 8px; }
  .gap-3 { gap: 12px; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .flex-wrap { flex-wrap: wrap; }
  .items-center { align-items: center; }
  .justify-between { justify-content: space-between; }

  .grid-2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
  }

  .divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 16px 0;
  }

  .scroll-y {
    overflow-y: auto;
    max-height: 400px;
  }

  @media (max-width: 520px) {
    .panel {
      padding: 14px 12px 16px;
      border-radius: 20px;
    }
    .form-row {
      flex-direction: column;
    }
  }
`;

// --- Initialize on load ------------------------------------------------------

// Synchronous fallback so .data getters work before initStores resolves
usersStore.load();
appStore.load();
currencyStore.load();
taskStore.load();
completionStore.load();
shopStore.load();
redemptionStore.load();
jobClaimStore.load();
worklogStore.load();
migrateUsers();

const ALL_STORES = [usersStore, currencyStore, taskStore, completionStore, shopStore, redemptionStore, appStore, jobClaimStore, worklogStore];

async function initStores() {
  try {
    const onServer = await Promise.all(ALL_STORES.map((s) => s.fetchFromServer()));
    migrateUsers();

    // If localStorage has real data but any store is missing from server, bulk sync all
    if (appStore.data.setupComplete && onServer.includes(false)) {
      const stores = {};
      for (const s of ALL_STORES) {
        if (s._localOnly) continue;
        stores[s._key] = JSON.stringify(s._data);
      }
      await fetch("/api/store/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stores }),
      });
      console.log("ParentSlop: migrated localStorage data to server");
    }
  } catch (e) {
    console.warn("ParentSlop: initStores failed, using localStorage", e);
  }
}

// --- Expose globals ----------------------------------------------------------

window.eventBus = bus;
window.trackerStore = {
  users: usersStore,
  currencies: currencyStore,
  tasks: taskStore,
  completions: completionStore,
  shop: shopStore,
  redemptions: redemptionStore,
  app: appStore,
  jobClaims: jobClaimStore,
  worklog: worklogStore,
};
window.tracker = {
  initStores,
  uid,
  now,
  dateKey,
  getCurrency,
  formatAmount,
  createCurrency,
  getBalance,
  adjustBalance,
  setBalance,
  calcStreak,
  completeTask,
  approveCompletion,
  rejectCompletion,
  logPenalty,
  purchaseItem,
  fulfillRedemption,
  createTask,
  updateTask,
  archiveTask,
  createShopItem,
  updateShopItem,
  getCurrentUser,
  isCurrentUserAdmin,
  exportAllData,
  importAllData,
  getTasksForUser,
  isTaskCompletedToday,
  isTaskCompletedThisWeek,
  isTaskCompletedSinceActivation,
  isTaskScheduledToday,
  activateTransientTask,
  deactivateTransientTask,
  resetDailyTasks,
  getRecentPenalties,
  migrateUsers,
  acceptJob,
  getUserActiveJobs,
  getJobClaim,
  clockIn,
  clockOut,
  getActiveClockIn,
  getWorklog,
  getTotalSeconds,
  submitHourlyWork,
  submitFixedJob,
  TRACKER_CSS,
};
