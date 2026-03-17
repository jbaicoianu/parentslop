// ============================================================================
// ParentSlop Tracker – Foundation (API-backed)
// EventBus, API-backed state cache, business logic, shared CSS
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

// --- State Cache -------------------------------------------------------------
// In-memory cache populated from GET /api/state. All reads are synchronous
// from this cache. Writes go through typed REST endpoints.

const _state = {
  users: [],
  tasks: [],
  currencies: [],
  completions: [],
  shopItems: [],
  redemptions: [],
  jobClaims: [],
  worklog: [],
  balances: {}, // { userId: { currencyId: amount } }
};

// --- StateProxy (backward compat for trackerStore.*.data) --------------------

class StateProxy {
  constructor(stateKey) {
    this._stateKey = stateKey;
  }

  get data() { return _state[this._stateKey]; }
  set data(v) { _state[this._stateKey] = v; }

  load() { return _state[this._stateKey]; }
  save() { /* no-op for server-backed stores — writes go through API */ }
}

// App store: local-only, persisted to localStorage
class AppStore {
  constructor() {
    this._key = "parentslop.app.v1";
    this._data = undefined;
  }

  get data() {
    if (this._data === undefined) this.load();
    return this._data;
  }

  set data(v) { this._data = v; }

  load() {
    try {
      const raw = localStorage.getItem(this._key);
      if (raw === null) {
        this._data = { setupComplete: false, currentUserId: null, currentView: "dashboard" };
        return this._data;
      }
      this._data = JSON.parse(raw);
      return this._data;
    } catch {
      this._data = { setupComplete: false, currentUserId: null, currentView: "dashboard" };
      return this._data;
    }
  }

  save(data) {
    if (data !== undefined) this._data = data;
    localStorage.setItem(this._key, JSON.stringify(this._data));
    bus.emit(`store:${this._key}`, this._data);
  }
}

// --- Store instances ---------------------------------------------------------

const usersProxy = new StateProxy("users");
const currencyProxy = new StateProxy("currencies");
const taskProxy = new StateProxy("tasks");
const completionProxy = new StateProxy("completions");
const shopProxy = new StateProxy("shopItems");
const redemptionProxy = new StateProxy("redemptions");
const jobClaimProxy = new StateProxy("jobClaims");
const worklogProxy = new StateProxy("worklog");
const appStore = new AppStore();

// --- Local user preferences (persisted to localStorage) ----------------------
// Per-user UI state like lastPenaltySeenAt, lastEarningsSeenAt

function _loadLocalUserPrefs() {
  try { return JSON.parse(localStorage.getItem("parentslop.userprefs.v1") || "{}"); } catch { return {}; }
}

function _saveLocalUserPrefs(prefs) {
  localStorage.setItem("parentslop.userprefs.v1", JSON.stringify(prefs));
}

function getUserPref(userId, key) {
  return _loadLocalUserPrefs()[`${userId}:${key}`] || null;
}

function setUserPref(userId, key, value) {
  const prefs = _loadLocalUserPrefs();
  prefs[`${userId}:${key}`] = value;
  _saveLocalUserPrefs(prefs);
}

// Overlay local prefs onto user objects so components see them
function _attachUserPrefs(users) {
  const prefs = _loadLocalUserPrefs();
  for (const u of users) {
    u.lastPenaltySeenAt = prefs[`${u.id}:lastPenaltySeenAt`] || null;
    u.lastEarningsSeenAt = prefs[`${u.id}:lastEarningsSeenAt`] || null;
  }
}

// --- API helpers -------------------------------------------------------------

async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    if (res.status === 401) {
      bus.emit("auth:required");
      throw new Error("auth required");
    }
    bus.emit("server:reachable");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (e) {
    if (e.message === "auth required") throw e;
    if (e.name === "TypeError" || e.message.includes("Failed to fetch")) {
      bus.emit("server:unreachable");
    }
    throw e;
  }
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
  return _state.currencies.find((c) => c.id === id);
}

function formatAmount(amount, currencyId) {
  const c = getCurrency(currencyId);
  if (!c) return String(amount);
  const decimals = c.decimals || 0;
  const val = Number(amount).toFixed(decimals);
  return `${c.symbol || ""}${val}`;
}

async function createCurrency(name, symbol, decimals = 0, color = "#66d9ef") {
  const c = await apiFetch("/api/currencies", {
    method: "POST",
    body: JSON.stringify({ name, symbol, decimals: Math.max(0, Math.min(decimals, 4)), color }),
  });
  _state.currencies.push(c);
  bus.emit("currencies:changed");
  return c;
}

async function updateCurrency(currencyId, updates) {
  const c = await apiFetch(`/api/currencies/${currencyId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  const idx = _state.currencies.findIndex((x) => x.id === currencyId);
  if (idx >= 0) _state.currencies[idx] = c;
  bus.emit("currencies:changed");
  return c;
}

// --- Balance management ------------------------------------------------------

function getBalance(userId, currencyId) {
  const userBalances = _state.balances[userId];
  if (!userBalances) return 0;
  return userBalances[currencyId] || 0;
}

async function adjustBalance(userId, currencyId, delta) {
  await apiFetch("/api/balance-adjustments", {
    method: "POST",
    body: JSON.stringify({ userId, currencyId, delta }),
  });
  // Update cache
  if (!_state.balances[userId]) _state.balances[userId] = {};
  _state.balances[userId][currencyId] = (getBalance(userId, currencyId) || 0) + delta;
  // Update user object for backward compat
  const user = _state.users.find((u) => u.id === userId);
  if (user) {
    if (!user.balances) user.balances = {};
    user.balances[currencyId] = _state.balances[userId][currencyId];
  }
  bus.emit("balances:changed", { userId });
}

async function setBalance(userId, currencyId, amount) {
  const current = getBalance(userId, currencyId);
  const delta = amount - current;
  if (delta === 0) return;
  await adjustBalance(userId, currencyId, delta);
}

// --- Streak calculation (client-side from cache) -----------------------------

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

function prevKey(key, unit) {
  if (unit === "day") {
    const [y, m, d] = key.split("-").map(Number);
    const prev = new Date(y, m - 1, d - 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
  }
  const parts = key.split("-W");
  let year = parseInt(parts[0]);
  let week = parseInt(parts[1]) - 1;
  if (week < 1) { year--; week = 52; }
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function calcStreak(taskId, userId) {
  const task = _state.tasks.find((t) => t.id === taskId);
  if (!task) return 0;
  if (task.recurrence === "transient") return 0;

  const completions = _state.completions
    .filter((c) => c.taskId === taskId && c.userId === userId && c.status === "approved")
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  if (completions.length === 0) return 0;

  const keyFn = task.recurrence === "weekly" ? weekKey : dateKey;
  const keys = [...new Set(completions.map((c) => keyFn(c.completedAt)))].sort().reverse();

  const todayKey = keyFn(new Date().toISOString());
  let streak = 0;
  let expected = todayKey;
  const activeDays = task.activeDays && task.activeDays.length > 0 ? task.activeDays : null;
  const isDaily = task.recurrence !== "weekly";

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
      break;
    }
  }

  return streak;
}

// --- Task completion logic ---------------------------------------------------

async function completeTask(taskId, userId, timerSeconds = null) {
  const result = await apiFetch("/api/completions", {
    method: "POST",
    body: JSON.stringify({ taskId, userId, timerSeconds }),
  });
  _state.completions.push(result);
  if (result.status === "approved") {
    _updateBalancesFromRewards(userId, result.rewards);
  }
  bus.emit("completion:added", result);
  return result;
}

async function approveCompletion(completionId, checkedCriteria = []) {
  const result = await apiFetch(`/api/completions/${completionId}/approve`, {
    method: "PATCH",
    body: JSON.stringify({ criteria: checkedCriteria }),
  });
  const idx = _state.completions.findIndex((c) => c.id === completionId);
  if (idx >= 0) _state.completions[idx] = result;
  _updateBalancesFromRewards(result.userId, result.rewards);
  bus.emit("completion:approved", result);
  return result;
}

async function rejectCompletion(completionId, note = "") {
  const result = await apiFetch(`/api/completions/${completionId}/reject`, {
    method: "PATCH",
    body: JSON.stringify({ note }),
  });
  const idx = _state.completions.findIndex((c) => c.id === completionId);
  if (idx >= 0) _state.completions[idx] = result;
  bus.emit("completion:rejected", result);
  return result;
}

function _updateBalancesFromRewards(userId, rewards) {
  if (!rewards) return;
  if (!_state.balances[userId]) _state.balances[userId] = {};
  for (const [currId, amount] of Object.entries(rewards)) {
    _state.balances[userId][currId] = (getBalance(userId, currId) || 0) + amount;
  }
  // Also update user.balances for backward compat
  const user = _state.users.find((u) => u.id === userId);
  if (user) user.balances = { ..._state.balances[userId] };
  bus.emit("balances:changed", { userId });
}

// --- Penalty logging (admin only) -------------------------------------------

async function logPenalty(taskId, userId, note = "") {
  const result = await apiFetch("/api/completions/penalty", {
    method: "POST",
    body: JSON.stringify({ taskId, userId, note }),
  });
  _state.completions.push(result);
  _updateBalancesFromRewards(userId, result.rewards);
  bus.emit("completion:added", result);
  return result;
}

// --- Shop / redemption -------------------------------------------------------

async function purchaseItem(shopItemId, userId) {
  try {
    const result = await apiFetch("/api/redemptions", {
      method: "POST",
      body: JSON.stringify({ shopItemId, userId }),
    });
    _state.redemptions.push(result.redemption);
    // Deduct from cached balances
    const item = _state.shopItems.find((s) => s.id === shopItemId);
    if (item && item.costs) {
      if (!_state.balances[userId]) _state.balances[userId] = {};
      for (const [currId, cost] of Object.entries(item.costs)) {
        _state.balances[userId][currId] = (getBalance(userId, currId) || 0) - cost;
      }
      const user = _state.users.find((u) => u.id === userId);
      if (user) user.balances = { ..._state.balances[userId] };
    }
    bus.emit("redemption:added", result.redemption);
    bus.emit("balances:changed", { userId });
    return { ok: true, redemption: result.redemption };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function fulfillRedemption(redemptionId) {
  const result = await apiFetch(`/api/redemptions/${redemptionId}/fulfill`, {
    method: "PATCH",
  });
  const idx = _state.redemptions.findIndex((r) => r.id === redemptionId);
  if (idx >= 0) _state.redemptions[idx] = result;
  bus.emit("redemption:fulfilled", result);
}

// --- Task CRUD ---------------------------------------------------------------

async function createTask(data) {
  const task = await apiFetch("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  });
  _state.tasks.push(task);
  bus.emit("tasks:changed");
  return task;
}

async function updateTask(taskId, updates) {
  const task = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  const idx = _state.tasks.findIndex((t) => t.id === taskId);
  if (idx >= 0) _state.tasks[idx] = task;
  bus.emit("tasks:changed");
  return task;
}

async function archiveTask(taskId) {
  return updateTask(taskId, { archived: true });
}

// --- Shop CRUD ---------------------------------------------------------------

async function createShopItem(data) {
  const item = await apiFetch("/api/shop-items", {
    method: "POST",
    body: JSON.stringify(data),
  });
  _state.shopItems.push(item);
  bus.emit("shop:changed");
  return item;
}

async function updateShopItem(itemId, updates) {
  const item = await apiFetch(`/api/shop-items/${itemId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  const idx = _state.shopItems.findIndex((s) => s.id === itemId);
  if (idx >= 0) _state.shopItems[idx] = item;
  bus.emit("shop:changed");
  return item;
}

// --- User CRUD ---------------------------------------------------------------

async function createUser(data) {
  const user = await apiFetch("/api/users", {
    method: "POST",
    body: JSON.stringify(data),
  });
  _state.users.push(user);
  _attachUserPrefs(_state.users);
  bus.emit("user:changed");
  return user;
}

async function updateUser(userId, updates) {
  const user = await apiFetch(`/api/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  const idx = _state.users.findIndex((u) => u.id === userId);
  if (idx >= 0) {
    // Preserve balances and local prefs
    user.balances = _state.balances[userId] || {};
    _state.users[idx] = user;
    _attachUserPrefs(_state.users);
  }
  bus.emit("user:changed");
  return user;
}

async function deleteUser(userId) {
  await apiFetch(`/api/users/${userId}`, { method: "DELETE" });
  _state.users = _state.users.filter((u) => u.id !== userId);
  bus.emit("user:changed");
}

// --- Recent penalties helper -------------------------------------------------

function getRecentPenalties(userId, days = 7) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffISO = cutoff.toISOString();

  return _state.completions.filter(
    (c) => c.userId === userId && c.isPenalty && c.completedAt >= cutoffISO
  ).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

// --- Transient task helpers --------------------------------------------------

function isTaskCompletedSinceActivation(taskId, userId) {
  const task = _state.tasks.find((t) => t.id === taskId);
  if (!task || !task.lastActivatedAt) return false;
  return _state.completions.some(
    (c) => c.taskId === taskId && c.userId === userId && c.status !== "rejected" && c.completedAt >= task.lastActivatedAt
  );
}

async function activateTransientTask(taskId) {
  const task = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ available: true, lastActivatedAt: now() }),
  });
  const idx = _state.tasks.findIndex((t) => t.id === taskId);
  if (idx >= 0) _state.tasks[idx] = task;

  // Clear old job claims for this task
  const oldClaims = _state.jobClaims.filter((c) => c.taskId === taskId);
  if (oldClaims.length > 0) {
    _state.jobClaims = _state.jobClaims.filter((c) => c.taskId !== taskId);
    bus.emit("jobclaims:changed");
  }

  bus.emit("tasks:changed");
  return task;
}

async function deactivateTransientTask(taskId) {
  const task = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ available: false }),
  });
  const idx = _state.tasks.findIndex((t) => t.id === taskId);
  if (idx >= 0) _state.tasks[idx] = task;
  bus.emit("tasks:changed");
  return task;
}

// --- Current user helper -----------------------------------------------------

function getCurrentUser() {
  const app = appStore.data;
  if (!app.currentUserId) return null;
  return _state.users.find((u) => u.id === app.currentUserId) || null;
}

function isCurrentUserAdmin() {
  const u = getCurrentUser();
  return u ? u.role === "parent" : false;
}

// --- Data export / import ----------------------------------------------------

function exportAllData() {
  return {
    users: _state.users,
    tasks: _state.tasks,
    currencies: _state.currencies,
    completions: _state.completions,
    shopItems: _state.shopItems,
    redemptions: _state.redemptions,
    jobClaims: _state.jobClaims,
    worklog: _state.worklog,
    balances: _state.balances,
  };
}

function importAllData() {
  console.warn("importAllData is not supported in the new API-backed model");
}

// --- Today helpers -----------------------------------------------------------

function getTasksForUser(userId) {
  return _state.tasks.filter((t) => {
    if (t.archived) return false;
    if (t.isPenalty) return false;
    if (t.recurrence === "transient" && !t.available) return false;
    if (t.assignedUsers.length > 0 && !t.assignedUsers.includes(userId)) return false;
    if (t.requiredTags?.length > 0) {
      const userTags = _state.users.find(u => u.id === userId)?.tags || [];
      if (!t.requiredTags.some(tag => userTags.includes(tag))) return false;
    }
    return true;
  });
}

function isTaskCompletedToday(taskId, userId) {
  const today = dateKey(new Date().toISOString());
  return _state.completions.some(
    (c) => c.taskId === taskId && c.userId === userId && dateKey(c.completedAt) === today && c.status !== "rejected"
  );
}

function isTaskCompletedThisWeek(taskId, userId) {
  const thisWeek = weekKey(new Date().toISOString());
  return _state.completions.some(
    (c) => c.taskId === taskId && c.userId === userId && weekKey(c.completedAt) === thisWeek && c.status !== "rejected"
  );
}

function isTaskScheduledToday(task) {
  if (!task.activeDays || task.activeDays.length === 0) return true;
  return task.activeDays.includes(new Date().getDay());
}

// --- Admin: reset a user's daily tasks for today ----------------------------

async function resetDailyTasks(userId) {
  const result = await apiFetch("/api/completions/reset-daily", {
    method: "DELETE",
    body: JSON.stringify({ userId }),
  });
  // Refresh state to pick up changes
  await _refreshState();
  bus.emit("completion:added");
  return result.removed || 0;
}

// --- Job acceptance ----------------------------------------------------------

async function acceptJob(taskId, userId) {
  try {
    const claim = await apiFetch("/api/job-claims", {
      method: "POST",
      body: JSON.stringify({ taskId, userId }),
    });
    // Update cache if not already there
    if (!_state.jobClaims.find((c) => c.id === claim.id)) {
      _state.jobClaims.push(claim);
    }
    bus.emit("jobclaims:changed", claim);
    return claim;
  } catch {
    return null;
  }
}

function getUserActiveJobs(userId) {
  return _state.jobClaims.filter((c) => c.userId === userId && c.status === "active");
}

function getJobClaim(taskId, userId) {
  return _state.jobClaims.find((c) => c.taskId === taskId && c.userId === userId) || null;
}

// --- Clock in/out (hourly) ---------------------------------------------------

async function clockIn(taskId, userId) {
  const entry = await apiFetch("/api/worklog", {
    method: "POST",
    body: JSON.stringify({ taskId, userId }),
  });
  if (!_state.worklog.find((e) => e.id === entry.id)) {
    _state.worklog.push(entry);
  }
  bus.emit("worklog:changed", entry);
  return entry;
}

async function clockOut(taskId, userId) {
  const open = _state.worklog.find((e) => e.taskId === taskId && e.userId === userId && e.clockOut === null);
  if (!open) return null;

  const entry = await apiFetch(`/api/worklog/${open.id}/clock-out`, {
    method: "PATCH",
  });
  const idx = _state.worklog.findIndex((e) => e.id === open.id);
  if (idx >= 0) _state.worklog[idx] = entry;
  bus.emit("worklog:changed", entry);
  return entry;
}

function getActiveClockIn(taskId, userId) {
  return _state.worklog.find((e) => e.taskId === taskId && e.userId === userId && e.clockOut === null) || null;
}

function getWorklog(taskId, userId) {
  return _state.worklog
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

async function submitHourlyWork(taskId, userId) {
  const result = await apiFetch("/api/completions/hourly", {
    method: "POST",
    body: JSON.stringify({ taskId, userId }),
  });
  _state.completions.push(result);
  // Update job claim in cache
  const claim = _state.jobClaims.find((c) => c.taskId === taskId && c.userId === userId);
  if (claim) claim.status = "submitted";
  // Remove worklog entries from cache
  _state.worklog = _state.worklog.filter((e) => !(e.taskId === taskId && e.userId === userId));
  bus.emit("completion:added", result);
  bus.emit("jobclaims:changed");
  return result;
}

async function submitFixedJob(taskId, userId) {
  const result = await completeTask(taskId, userId);
  // Update job claim in cache
  const claim = _state.jobClaims.find((c) => c.taskId === taskId && c.userId === userId);
  if (claim) {
    claim.status = "submitted";
    bus.emit("jobclaims:changed");
  }
  return result;
}

// --- User migration (no-op, kept for backward compat) -----------------------

function migrateUsers() {
  // No-op: user data now comes from server with correct shape
  return _state.users;
}

// --- SSE subscription --------------------------------------------------------

let _sseSource = null;

function _connectSSE() {
  if (_sseSource) return;
  try {
    _sseSource = new EventSource("/api/events/stream");
    _sseSource.onerror = () => {
      _sseSource.close();
      _sseSource = null;
      // Reconnect after delay
      setTimeout(() => _connectSSE(), 5000);
    };

    // SSE event handlers — update cache and emit eventBus events
    _sseSource.addEventListener("completion:added", (e) => {
      const data = JSON.parse(e.data);
      if (!_state.completions.find((c) => c.id === data.id)) {
        _state.completions.push(data);
      }
      bus.emit("completion:added", data);
    });

    _sseSource.addEventListener("completion:approved", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.completions.findIndex((c) => c.id === data.id);
      if (idx >= 0) _state.completions[idx] = data;
      else _state.completions.push(data);
      bus.emit("completion:approved", data);
    });

    _sseSource.addEventListener("completion:rejected", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.completions.findIndex((c) => c.id === data.id);
      if (idx >= 0) _state.completions[idx] = data;
      bus.emit("completion:rejected", data);
    });

    _sseSource.addEventListener("completions:reset", (e) => {
      const data = JSON.parse(e.data);
      _refreshState();
      bus.emit("completion:added", data);
    });

    _sseSource.addEventListener("balances:changed", (e) => {
      const data = JSON.parse(e.data);
      // Refresh balances from server
      _refreshBalances().then(() => bus.emit("balances:changed", data));
    });

    _sseSource.addEventListener("balances:recomputed", (e) => {
      const data = JSON.parse(e.data);
      _state.balances = data;
      // Update user objects
      for (const u of _state.users) {
        u.balances = _state.balances[u.id] || {};
      }
      bus.emit("balances:changed");
    });

    _sseSource.addEventListener("redemption:added", (e) => {
      const data = JSON.parse(e.data);
      if (!_state.redemptions.find((r) => r.id === data.id)) {
        _state.redemptions.push(data);
      }
      bus.emit("redemption:added", data);
    });

    _sseSource.addEventListener("redemption:fulfilled", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.redemptions.findIndex((r) => r.id === data.id);
      if (idx >= 0) _state.redemptions[idx] = data;
      bus.emit("redemption:fulfilled", data);
    });

    _sseSource.addEventListener("task:created", (e) => {
      const data = JSON.parse(e.data);
      if (!_state.tasks.find((t) => t.id === data.id)) _state.tasks.push(data);
      bus.emit("tasks:changed");
    });

    _sseSource.addEventListener("task:updated", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.tasks.findIndex((t) => t.id === data.id);
      if (idx >= 0) Object.assign(_state.tasks[idx], data);
      bus.emit("tasks:changed");
    });

    _sseSource.addEventListener("user:created", (e) => {
      const data = JSON.parse(e.data);
      if (!_state.users.find((u) => u.id === data.id)) _state.users.push(data);
      _attachUserPrefs(_state.users);
      bus.emit("user:changed");
    });

    _sseSource.addEventListener("user:updated", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.users.findIndex((u) => u.id === data.id);
      if (idx >= 0) { data.balances = _state.users[idx].balances; _state.users[idx] = data; }
      _attachUserPrefs(_state.users);
      bus.emit("user:changed");
    });

    _sseSource.addEventListener("user:deleted", (e) => {
      const data = JSON.parse(e.data);
      _state.users = _state.users.filter((u) => u.id !== data.id);
      bus.emit("user:changed");
    });

    _sseSource.addEventListener("currency:created", (e) => {
      const data = JSON.parse(e.data);
      if (!_state.currencies.find((c) => c.id === data.id)) _state.currencies.push(data);
      bus.emit("currencies:changed");
    });

    _sseSource.addEventListener("currency:updated", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.currencies.findIndex((c) => c.id === data.id);
      if (idx >= 0) _state.currencies[idx] = data;
      bus.emit("currencies:changed");
    });

    _sseSource.addEventListener("currency:deleted", (e) => {
      const data = JSON.parse(e.data);
      _state.currencies = _state.currencies.filter((c) => c.id !== data.id);
      bus.emit("currencies:changed");
    });

    _sseSource.addEventListener("shop:created", (e) => {
      const data = JSON.parse(e.data);
      if (!_state.shopItems.find((s) => s.id === data.id)) _state.shopItems.push(data);
      bus.emit("shop:changed");
    });

    _sseSource.addEventListener("shop:updated", (e) => {
      const data = JSON.parse(e.data);
      const idx = _state.shopItems.findIndex((s) => s.id === data.id);
      if (idx >= 0) Object.assign(_state.shopItems[idx], data);
      bus.emit("shop:changed");
    });

    _sseSource.addEventListener("jobclaims:changed", () => {
      _refreshJobClaims();
    });

    _sseSource.addEventListener("worklog:changed", () => {
      _refreshWorklog();
    });
  } catch (e) {
    console.warn("SSE connection failed:", e);
    setTimeout(() => _connectSSE(), 5000);
  }
}

// --- Refresh helpers (fetch fresh data from server) --------------------------

async function _refreshState() {
  try {
    const data = await apiFetch("/api/state");
    _applyState(data);
  } catch (e) {
    console.warn("Failed to refresh state:", e);
  }
}

async function _refreshBalances() {
  try {
    const data = await apiFetch("/api/state");
    _state.balances = data.balances;
    for (const u of _state.users) {
      u.balances = _state.balances[u.id] || {};
    }
  } catch (e) {
    console.warn("Failed to refresh balances:", e);
  }
}

async function _refreshJobClaims() {
  try {
    const data = await apiFetch("/api/job-claims");
    _state.jobClaims = data;
    bus.emit("jobclaims:changed");
  } catch (e) {
    console.warn("Failed to refresh job claims:", e);
  }
}

async function _refreshWorklog() {
  try {
    const data = await apiFetch("/api/worklog");
    _state.worklog = data;
    bus.emit("worklog:changed");
  } catch (e) {
    console.warn("Failed to refresh worklog:", e);
  }
}

function _applyState(data) {
  _state.users = data.users || [];
  _state.tasks = data.tasks || [];
  _state.currencies = data.currencies || [];
  _state.completions = data.completions || [];
  _state.shopItems = data.shopItems || [];
  _state.redemptions = data.redemptions || [];
  _state.jobClaims = data.jobClaims || [];
  _state.worklog = data.worklog || [];
  _state.balances = data.balances || {};

  // Attach balances to user objects for backward compat
  for (const u of _state.users) {
    u.balances = _state.balances[u.id] || {};
  }
  _attachUserPrefs(_state.users);

  // Notify all components so they re-render with the new data
  bus.emit("user:changed");
  bus.emit("tasks:changed");
  bus.emit("currencies:changed");
  bus.emit("completions:changed");
  bus.emit("shop:changed");
  bus.emit("balances:changed");
  bus.emit("completion:added");
  bus.emit("redemption:added");
  bus.emit("jobclaims:changed");
  bus.emit("worklog:changed");
}

// --- Initialize on load ------------------------------------------------------

// Load app store from localStorage synchronously
appStore.load();

async function initStores() {
  try {
    const data = await apiFetch("/api/state");
    _applyState(data);
    appStore.data.setupComplete = _state.users.length > 0;
    appStore.save();
    bus.emit("server:reachable");

    // Connect SSE for real-time updates
    _connectSSE();

    bus.emit("stores:synced");
  } catch (e) {
    console.warn("ParentSlop: initStores failed", e);
  }
}

// --- Auto-reconnect ----------------------------------------------------------

let _wasOffline = false;
bus.on("server:unreachable", () => {
  _wasOffline = true;
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
});
bus.on("server:reachable", () => {
  if (!_wasOffline) return;
  _wasOffline = false;
  console.log("ParentSlop: connection restored, refreshing state...");
  _refreshState().then(() => {
    _connectSSE();
    bus.emit("stores:synced");
    console.log("ParentSlop: sync complete");
  });
});

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

// --- Expose globals ----------------------------------------------------------

window.eventBus = bus;
window.trackerStore = {
  users: usersProxy,
  currencies: currencyProxy,
  tasks: taskProxy,
  completions: completionProxy,
  shop: shopProxy,
  redemptions: redemptionProxy,
  app: appStore,
  jobClaims: jobClaimProxy,
  worklog: worklogProxy,
};
window.tracker = {
  initStores,
  uid,
  now,
  dateKey,
  weekKey,
  getCurrency,
  formatAmount,
  createCurrency,
  updateCurrency,
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
  createUser,
  updateUser,
  deleteUser,
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
  getUserPref,
  setUserPref,
  TRACKER_CSS,
};
