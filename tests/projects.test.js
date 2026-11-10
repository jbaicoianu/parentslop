#!/usr/bin/env node
/**
 * Projects module tests: admin-only access, import, tasks, dependencies,
 * GitHub external sync, daily picks, event-log replay and the suggestion scorer.
 */

const { withTestServer } = require("./harness");
const ProjectsScore = require("../static/tracker/projects-score.js");

let BASE;
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

async function req(path, { method = "GET", body, cookie } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

async function register() {
  const name = "ProjTest_" + Date.now() + Math.random().toString(36).slice(2, 6);
  const r = await req("/api/auth/register", { method: "POST", body: { familyName: name, adminName: "Parent", password: "testpass123" } });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { name, cookie };
}

async function memberSession(fam, displayName, isAdmin) {
  const add = await req("/api/auth/add-member", { method: "POST", cookie: fam.cookie, body: { displayName, isAdmin } });
  const login = await req("/api/auth/login", { method: "POST", body: { familyName: fam.name, password: "testpass123" } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  await req("/api/auth/select-member", { method: "POST", cookie, body: { memberId: add.json.id } });
  return { id: add.json.id, cookie };
}

async function kidSession(fam) {
  const add = await req("/api/auth/add-member", { method: "POST", cookie: fam.cookie, body: { displayName: "Kid", isAdmin: false } });
  const login = await req("/api/auth/login", { method: "POST", body: { familyName: fam.name, password: "testpass123" } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  await req("/api/auth/select-member", { method: "POST", cookie, body: { memberId: add.json.id } });
  return cookie;
}

const INVENTORY = [
  { id: "alpha", name: "Alpha", machine: "cybercube", path: "~/src/alpha", category: "Games", kind: "Code", status: "Active",
    backup: "No backup", last: "2026-11-01", note: "A game", action: "git init and push to a private repo; write up the design",
    rank: 3, tier: "Top", pitch: "Neat", tags: "Games; Retro computing", related: "beta",
    links: [{ type: "github", repo: "someone/alpha" }] },
  { id: "beta", name: "Beta", machine: "junkyard", path: "/data/beta", category: "Websites", kind: "Code", status: "Dormant",
    backup: "Backed up", last: "2020-01-01", note: "A site", action: "Nothing", rank: null, tier: "", pitch: "", tags: "Web", related: "" },
];

async function run(base) {
  BASE = base;
  const fam = await register();
  const kid = await kidSession(fam);
  const A = { cookie: fam.cookie };

  console.log("\n-- access control --");
  assert((await req("/api/projects/state")).status === 401, "state requires login");
  assert((await req("/api/projects/state", { cookie: kid })).status === 403, "state is admin-only");
  assert((await req("/api/projects", { method: "POST", cookie: kid, body: { name: "x" } })).status === 403, "kids can't create projects");
  assert((await req("/api/store/github_token", { cookie: kid })).status === 403, "kids can't read the GitHub token via the store API");

  console.log("\n-- import --");
  const imp = await req("/api/projects/import", { method: "POST", ...A, body: { projects: INVENTORY } });
  assert(imp.status === 200 && imp.json.created === 2, "import creates projects");
  assert(imp.json.tasksCreated === 3, "import splits next steps into starter tasks");
  let st = (await req("/api/projects/state", A)).json;
  const alpha = st.projects.find((p) => p.slug === "alpha");
  assert(alpha && alpha.tags.includes("Retro computing") && alpha.related[0] === "beta", "tags and related parsed");
  assert(alpha.links.length === 1 && alpha.links[0].repo === "someone/alpha", "links imported");
  assert(alpha.priority === 2, "active projects start at Next priority");

  await req(`/api/projects/${alpha.id}`, { method: "PUT", ...A, body: { status: "Done", goal: "Shipped", priority: 3 } });
  const reimp = await req("/api/projects/import", { method: "POST", ...A, body: { projects: [{ ...INVENTORY[0], note: "Updated note" }, INVENTORY[1]] } });
  st = (await req("/api/projects/state", A)).json;
  const alpha2 = st.projects.find((p) => p.slug === "alpha");
  assert(reimp.json.created === 0 && alpha2.note === "Updated note", "re-import refreshes inventory facts");
  assert(alpha2.status === "Done" && alpha2.goal === "Shipped" && alpha2.priority === 3, "re-import keeps hand-set status, goal and priority");
  assert(st.tasks.filter((t) => t.projectId === alpha.id).length === 2, "re-import doesn't duplicate tasks");
  await req(`/api/projects/${alpha.id}`, { method: "PUT", ...A, body: { status: "Active" } });

  console.log("\n-- tasks and dependencies --");
  const t1 = (await req(`/api/projects/${alpha.id}/tasks`, { method: "POST", ...A, body: { title: "First", size: "xs" } })).json;
  const t2 = (await req(`/api/projects/${alpha.id}/tasks`, { method: "POST", ...A, body: { title: "Second", dependsOn: [t1.id] } })).json;
  assert(t2.dependsOn[0] === t1.id, "task created with dependency");
  const cyc = await req(`/api/project-tasks/${t1.id}`, { method: "PUT", ...A, body: { dependsOn: [t2.id] } });
  assert(cyc.status === 400, "dependency cycles are rejected");
  const bogus = await req(`/api/project-tasks/${t1.id}`, { method: "PUT", ...A, body: { dependsOn: ["not-a-task"] } });
  assert(bogus.json.dependsOn.length === 0, "unknown dependency ids are dropped");
  const bad = await req(`/api/project-tasks/${t1.id}`, { method: "PUT", ...A, body: { status: "weird", size: "huge" } });
  assert(bad.json.status === "todo" && bad.json.size === "s", "invalid enums fall back to defaults");
  const done = await req(`/api/project-tasks/${t1.id}`, { method: "PUT", ...A, body: { status: "done" } });
  assert(done.json.completedAt, "completing a task stamps completedAt");
  const reopen = await req(`/api/project-tasks/${t1.id}`, { method: "PUT", ...A, body: { status: "todo" } });
  assert(reopen.json.completedAt === "", "reopening clears completedAt");
  await req(`/api/project-tasks/${t1.id}`, { method: "DELETE", ...A });
  st = (await req("/api/projects/state", A)).json;
  assert(st.tasks.find((t) => t.id === t2.id).dependsOn.length === 0, "deleting a task removes it from dependency lists");

  console.log("\n-- GitHub external sync --");
  const items = [
    { number: 1, title: "Bug one", state: "OPEN", url: "https://github.com/someone/alpha/issues/1", labels: [{ name: "bug" }], updatedAt: "2026-11-01T00:00:00Z" },
    { number: 2, title: "Old closed", state: "CLOSED", url: "https://github.com/someone/alpha/issues/2", labels: [], updatedAt: "2026-10-01T00:00:00Z" },
    { number: 3, title: "Blocked thing", state: "OPEN", url: "https://github.com/someone/alpha/issues/3", labels: [], blockedBy: [1], parentTitle: "Sub-epic" },
  ];
  let sync = await req(`/api/projects/${alpha.id}/external-sync`, { method: "POST", ...A, body: { source: "github", repo: "someone/alpha", items } });
  assert(sync.json.created === 2, "open issues become tasks, closed history is skipped");
  st = (await req("/api/projects/state", A)).json;
  const gh1 = st.tasks.find((t) => t.externalKey === "someone/alpha#1");
  const gh3 = st.tasks.find((t) => t.externalKey === "someone/alpha#3");
  assert(gh1 && gh1.labels[0] === "bug" && gh1.externalUrl.endsWith("/1"), "issue fields mapped");
  assert(gh3.dependsOn[0] === gh1.id, "blocked-by edges become dependencies");
  assert(gh3.labels[0] === "Sub-epic", "parent epic title kept as a label");
  items[0].state = "CLOSED";
  sync = await req(`/api/projects/${alpha.id}/external-sync`, { method: "POST", ...A, body: { source: "github", repo: "someone/alpha", items } });
  st = (await req("/api/projects/state", A)).json;
  assert(sync.json.closed === 1 && st.tasks.find((t) => t.id === gh1.id).status === "done", "closing an issue closes its task");
  const beta = st.projects.find((p) => p.slug === "beta");
  const steal = await req(`/api/projects/${beta.id}/external-sync`, { method: "POST", ...A, body: { source: "github", repo: "someone/alpha", items, claim: false } });
  assert(steal.json.skipped >= 1, "whole-repo sync leaves issues owned by another project alone");
  const badRepo = await req(`/api/projects/${alpha.id}/external-sync`, { method: "POST", ...A, body: { source: "github", repo: "../etc", items: [] } });
  assert(badRepo.status === 400, "external sync validates the repo name");
  const linkBad = await req(`/api/projects/${alpha.id}`, { method: "PUT", ...A, body: { links: [{ type: "github", repo: "a/b", issue: 7 }, { type: "url", url: "javascript:alert(1)" }] } });
  assert(linkBad.json.links.length === 1 && linkBad.json.links[0].issue === 7, "links are validated (epic issue kept, javascript: url dropped)");

  console.log("\n-- GitHub token --");
  assert((await req("/api/projects/github-token", A)).json.configured === false, "token starts unset");
  await req("/api/projects/github-token", { method: "PUT", ...A, body: { value: "ghp_test" } });
  const tok = await req("/api/projects/github-token", A);
  assert(tok.json.configured === true && !JSON.stringify(tok.json).includes("ghp_"), "token status never echoes the token");

  console.log("\n-- daily picks --");
  const day = "2026-11-09";
  const pick = (await req("/api/project-picks", { method: "POST", ...A, body: { date: day, taskId: t2.id } })).json;
  const dupe = (await req("/api/project-picks", { method: "POST", ...A, body: { date: day, taskId: t2.id } })).json;
  assert(pick.id && dupe.id === pick.id, "picking the same task twice on a day is idempotent");
  assert((await req("/api/project-picks", { method: "POST", ...A, body: { date: "nov 9", taskId: t2.id } })).status === 400, "pick date is validated");
  await req(`/api/project-picks/${pick.id}`, { method: "PUT", ...A, body: { outcome: "done" } });
  st = (await req("/api/projects/state", A)).json;
  assert(st.tasks.find((t) => t.id === t2.id).status === "done", "a pick marked done closes its task");

  console.log("\n-- tracks --");
  const TRACKS = [{ id: "fun", name: "Hobbies", icon: "🎮", color: "#4ade80", intention: "For fun", sort: 1 },
    { id: "work", name: "Work", icon: "💼", color: "javascript:x", sort: 0 }];
  const timp = await req("/api/projects/import", { method: "POST", ...A, body: {
    tracks: TRACKS, projects: [{ ...INVENTORY[0], track: "fun" }, { ...INVENTORY[1], track: "work" }] } });
  assert(timp.json.tracksCreated === 2, "import creates tracks");
  st = (await req("/api/projects/state", A)).json;
  const fun = st.tracks.find((t) => t.slug === "fun");
  const work = st.tracks.find((t) => t.slug === "work");
  assert(st.tracks[0].slug === "work" && fun.intention === "For fun", "tracks come back in sort order with their fields");
  assert(work.color === "#8b8fa8", "invalid track colours are ignored");
  assert(st.projects.find((p) => p.slug === "alpha").trackId === fun.id, "import puts projects in their track");
  await req(`/api/projects/${beta.id}`, { method: "PUT", ...A, body: { trackId: fun.id } });
  await req("/api/projects/import", { method: "POST", ...A, body: { tracks: TRACKS, projects: [{ ...INVENTORY[1], track: "work" }] } });
  st = (await req("/api/projects/state", A)).json;
  assert(st.projects.find((p) => p.id === beta.id).trackId === fun.id && st.tracks.length === 2, "re-import keeps hand-moved projects and doesn't duplicate tracks");
  const badTrack = await req(`/api/projects/${beta.id}`, { method: "PUT", ...A, body: { trackId: "nope" } });
  assert(badTrack.json.trackId === fun.id, "unknown track ids are ignored");
  const nt = await req("/api/project-tracks", { method: "POST", ...A, body: { name: "Side", color: "#123456", focusLimit: 99 } });
  assert(nt.status === 200 && nt.json.focusLimit === 10 && nt.json.sortOrder === 2, "tracks can be created (focus limit clamped, sorted last)");
  assert((await req("/api/project-tracks", { method: "POST", cookie: kid, body: { name: "x" } })).status === 403, "kids can't create tracks");
  await req(`/api/projects/${beta.id}`, { method: "PUT", ...A, body: { trackId: nt.json.id } });
  await req(`/api/project-tracks/${nt.json.id}`, { method: "DELETE", ...A });
  st = (await req("/api/projects/state", A)).json;
  assert(!st.tracks.some((t) => t.id === nt.json.id) && st.projects.find((p) => p.id === beta.id).trackId === "", "deleting a track unassigns its projects");

  console.log("\n-- ownership and sharing --");
  const B = await memberSession(fam, "Kim", true);
  const kidM = await memberSession(fam, "Junior", false);
  const meA = (await req("/api/projects/state", A)).json.me;
  const priv = (await req("/api/projects", { method: "POST", ...A, body: { name: "Secret", trackId: fun.id, priority: 3 } })).json;
  const ptask = (await req(`/api/projects/${priv.id}/tasks`, { method: "POST", ...A, body: { title: "Hidden task" } })).json;
  assert(priv.role === "owner" && priv.members.length === 1 && priv.priority === 3 && priv.trackId === fun.id, "creator owns a new project, placed in their track and lane");
  let stB = (await req("/api/projects/state", { cookie: B.cookie })).json;
  assert(stB.projects.length === 0 && stB.tasks.length === 0 && stB.tracks.length === 0, "another parent sees none of my projects, tasks or tracks");
  const BB = { cookie: B.cookie };
  assert((await req(`/api/projects/${priv.id}`, { method: "PUT", ...BB, body: { name: "pwned" } })).status === 404, "can't edit a project you're not on");
  assert((await req(`/api/projects/${priv.id}/tasks`, { method: "POST", ...BB, body: { title: "x" } })).status === 404, "can't add tasks to it");
  assert((await req(`/api/project-tasks/${ptask.id}`, { method: "PUT", ...BB, body: { title: "x" } })).status === 404, "can't edit its tasks");
  assert((await req("/api/project-picks", { method: "POST", ...BB, body: { date: day, taskId: ptask.id } })).status === 404, "can't pick its tasks");
  assert((await req(`/api/projects/${priv.id}`, { method: "DELETE", ...BB })).status === 404, "can't delete it");
  assert((await req(`/api/project-tracks/${fun.id}`, { method: "PUT", ...BB, body: { name: "x" } })).status === 404, "can't edit someone else's track");
  const bProj = (await req("/api/projects", { method: "POST", ...BB, body: { name: "Kim's" } })).json;
  const bTask = (await req(`/api/projects/${bProj.id}/tasks`, { method: "POST", ...BB, body: { title: "Kim task" } })).json;
  const sneaky = await req(`/api/project-tasks/${bTask.id}`, { method: "PUT", ...BB, body: { dependsOn: [ptask.id] } });
  assert(sneaky.json.dependsOn.length === 0, "dependencies on tasks you can't see are dropped");
  const mv = await req(`/api/project-tasks/${bTask.id}`, { method: "PUT", ...BB, body: { projectId: priv.id } });
  assert(mv.status === 400, "can't move a task into someone else's project");
  assert((await req("/api/store/github_token:" + meA, { cookie: B.cookie })).status === 403
    && (await req("/api/store/github_token:" + meA, { method: "PUT", cookie: B.cookie, body: { value: "x" } })).status === 403, "per-person GitHub tokens are closed to the store API");
  assert((await req("/api/projects/github-token", BB)).json.configured === false, "GitHub tokens are per person");

  const notOwner = await req(`/api/projects/${bProj.id}/members`, { method: "PUT", ...A, body: { memberIds: [meA] } });
  assert(notOwner.status === 404, "can't add yourself to someone else's project");
  const shared = await req(`/api/projects/${priv.id}/members`, { method: "PUT", ...A, body: { memberIds: [B.id, kidM.id, "not-a-member"] } });
  assert(shared.json.members.length === 3 && shared.json.members.find((m) => m.memberId === meA).role === "owner", "owner shares with a parent and a kid (unknown ids ignored)");
  stB = (await req("/api/projects/state", BB)).json;
  const seen = stB.projects.find((p) => p.id === priv.id);
  assert(seen && seen.role === "collaborator" && seen.trackId === "" && seen.priority === 2 && stB.tasks.some((t) => t.id === ptask.id), "shared project appears for them, unsorted, with its tasks");
  await req(`/api/projects/${priv.id}`, { method: "PUT", ...BB, body: { priority: 0, goal: "Shared goal" } });
  const stA = (await req("/api/projects/state", A)).json;
  const forA = stA.projects.find((p) => p.id === priv.id);
  assert(forA.priority === 3 && forA.trackId === fun.id && forA.goal === "Shared goal", "lane and track are per person; goal is shared");
  assert((await req(`/api/projects/${priv.id}/members`, { method: "PUT", ...BB, body: { memberIds: [B.id] } })).status === 403, "only the owner changes who's on it");
  assert((await req(`/api/projects/${priv.id}`, { method: "DELETE", ...BB })).status === 403, "only the owner can delete it");

  const asg = await req(`/api/project-tasks/${ptask.id}`, { method: "PUT", ...A, body: { assigneeId: B.id } });
  assert(asg.json.assigneeId === B.id, "tasks can be assigned to a project member");
  const asgBad = await req(`/api/project-tasks/${ptask.id}`, { method: "PUT", ...A, body: { assigneeId: "stranger" } });
  assert(asgBad.json.assigneeId === B.id, "assignee must be on the project");
  const sugA = ProjectsScore.suggest((await req("/api/projects/state", A)).json, { today: day, limit: 999 });
  const sugB = ProjectsScore.suggest((await req("/api/projects/state", BB)).json, { today: day, limit: 999 });
  assert(!sugA.some((x) => x.task.id === ptask.id) && sugB.some((x) => x.task.id === ptask.id && x.reasons.includes("Assigned to you")), "assigned tasks are only suggested to their assignee");

  const pkB = (await req("/api/project-picks", { method: "POST", ...BB, body: { date: day, taskId: ptask.id } })).json;
  assert(!(await req("/api/projects/state", A)).json.picks.some((p) => p.id === pkB.id), "daily picks are per person");
  assert((await req(`/api/project-picks/${pkB.id}`, { method: "PUT", ...A, body: { outcome: "skipped" } })).status === 404, "can't change someone else's pick");
  assert((await req("/api/projects/state", { cookie: kidM.cookie })).status === 403, "kids on a project still can't open the module yet");

  await req(`/api/projects/${priv.id}/members`, { method: "PUT", ...A, body: { memberIds: [kidM.id] } });
  stB = (await req("/api/projects/state", BB)).json;
  const tAfter = (await req("/api/projects/state", A)).json.tasks.find((t) => t.id === ptask.id);
  assert(!stB.projects.some((p) => p.id === priv.id) && !stB.picks.some((p) => p.id === pkB.id) && tAfter.assigneeId === "", "removing someone hides it from them and clears their assignments and picks");
  assert((await req(`/api/projects/${priv.id}/members/me`, { method: "DELETE", ...A })).status === 400, "the owner can't leave their own project");
  await req(`/api/projects/${bProj.id}/members`, { method: "PUT", ...BB, body: { memberIds: [meA] } });
  assert((await req(`/api/projects/${bProj.id}/members/me`, { method: "DELETE", ...A })).status === 200
    && !(await req("/api/projects/state", A)).json.projects.some((p) => p.id === bProj.id), "a collaborator can leave");

  console.log("\n-- project delete --");
  const tmp = (await req("/api/projects", { method: "POST", ...A, body: { name: "Temp" } })).json;
  const tt = (await req(`/api/projects/${tmp.id}/tasks`, { method: "POST", ...A, body: { title: "x" } })).json;
  await req("/api/project-picks", { method: "POST", ...A, body: { date: day, taskId: tt.id } });
  await req(`/api/projects/${tmp.id}`, { method: "DELETE", ...A });
  st = (await req("/api/projects/state", A)).json;
  assert(!st.projects.some((p) => p.id === tmp.id) && !st.tasks.some((t) => t.id === tt.id) && !st.picks.some((p) => p.taskId === tt.id), "deleting a project removes its tasks and picks");
}

function scorerTests() {
  console.log("\n-- suggestion scorer --");
  const today = "2026-11-09";
  const projects = [
    { id: "p1", name: "Risky", status: "Active", priority: 2, backup: "No backup", showcaseRank: 4, archived: false },
    { id: "p2", name: "Calm", status: "Active", priority: 1, backup: "Backed up", showcaseRank: null, archived: false },
    { id: "p3", name: "Finished", status: "Done", priority: 3, backup: "", showcaseRank: null, archived: false },
  ];
  const tasks = [
    { id: "a", projectId: "p1", title: "git init and push to a private repo", status: "todo", priority: 1, size: "s", energy: "low", dependsOn: [] },
    { id: "b", projectId: "p1", title: "Write the post", status: "todo", priority: 1, size: "l", energy: "high", dependsOn: ["a"] },
    { id: "c", projectId: "p2", title: "Tidy", status: "todo", priority: 1, size: "xl", energy: "medium", dependsOn: [] },
    { id: "d", projectId: "p3", title: "Ignored", status: "todo", priority: 3, size: "xs", energy: "low", dependsOn: [] },
    { id: "e", projectId: "p2", title: "Blocked", status: "blocked", priority: 3, size: "xs", energy: "low", dependsOn: [] },
  ];
  const s = ProjectsScore.suggest({ projects, tasks, picks: [] }, { today, minutes: 60, energy: "low" });
  assert(s[0].task.id === "a", "backup task on a risky project ranks first");
  assert(s[0].reasons.some((r) => r.startsWith("Protects unsaved work")) && s[0].reasons.some((r) => r.startsWith("Unblocks 1")), "reasons explain the ranking");
  assert(!s.some((x) => x.task.id === "b"), "tasks with open dependencies are excluded");
  assert(!s.some((x) => x.task.id === "d"), "tasks in done projects are excluded");
  assert(!s.some((x) => x.task.id === "e"), "blocked tasks are excluded");
  assert(s.find((x) => x.task.id === "c").warnings.length > 0, "oversized tasks carry a warning");
  const sum = ProjectsScore.trackSummary({
    tracks: [{ id: "t1", name: "One", sortOrder: 0, focusLimit: 1 }],
    projects: [{ ...projects[0], trackId: "t1", priority: 3 }, { ...projects[1], trackId: "t1", priority: 3 }, { ...projects[2], trackId: "gone" }],
    tasks: tasks.map((t) => (t.id === "c" ? { ...t, status: "done", completedAt: "2026-11-08T10:00:00Z" } : t)),
    picks: [],
  }, { today });
  assert(sum.length === 2 && sum[1].track.name === "Unsorted", "projects without a known track land in Unsorted");
  assert(sum[0].projects.focus.length === 2 && sum[0].overFocus, "focus lane and focus-limit overflow");
  assert(sum[0].next[0].task.id === "a" && sum[0].doneThisWeek === 1, "per-track next moves and weekly count");
  assert(sum[0].days.length === 7 && sum[0].days[5].worked && !sum[0].days[6].worked && sum[0].idleDays === 1, "7-day activity strip");
  assert(sum[1].projects.finished.length === 1, "finished projects grouped separately");
  const picked = ProjectsScore.suggest({ projects, tasks, picks: [{ date: today, taskId: "a", outcome: "" }] }, { today });
  assert(!picked.some((x) => x.task.id === "a"), "already-picked tasks drop out of suggestions");
}

(async () => {
  console.log("Projects module tests");
  scorerTests();
  try {
    await withTestServer(run);
  } catch (e) {
    failed++;
    failures.push(`crashed: ${e.stack}`);
    console.log(e);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:\n  " + failures.join("\n  ")); process.exit(1); }
})();
