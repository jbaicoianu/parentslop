#!/usr/bin/env node
/**
 * Shared menus: family access, link guests (join, claims, comments, permissions),
 * link controls (off / new link), live updates and the guest page route.
 */

const { withTestServer } = require("./harness");

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

const firstCookie = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

async function register(prefix = "MenuTest") {
  const name = prefix + "_" + Date.now() + Math.random().toString(36).slice(2, 6);
  const r = await req("/api/auth/register", { method: "POST", body: { familyName: name, adminName: "Parent", password: "testpass123" } });
  return { name, cookie: firstCookie(r) };
}

async function memberSession(fam, displayName, isAdmin) {
  const add = await req("/api/auth/add-member", { method: "POST", cookie: fam.cookie, body: { displayName, isAdmin } });
  const login = await req("/api/auth/login", { method: "POST", body: { familyName: fam.name, password: "testpass123" } });
  const cookie = firstCookie(login);
  await req("/api/auth/select-member", { method: "POST", cookie, body: { memberId: add.json.id } });
  return { id: add.json.id, cookie };
}

/** Read an SSE stream until `needle` shows up (or time out). Returns true if seen. */
async function streamSees(path, cookie, trigger, needle = "menu:changed", ms = 3000) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {}, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), ms);
  await reader.read(); // initial comment: the stream is registered
  await trigger();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes(needle)) return true;
    }
  } catch {} finally { clearTimeout(timer); ctrl.abort(); }
  return false;
}

async function run(base) {
  BASE = base;
  const fam = await register();
  const P = { cookie: fam.cookie };
  const kid = await memberSession(fam, "Kiddo", false);
  const other = await register("OtherFam");

  console.log("\n-- family side --");
  assert((await req("/api/shared-menus")).status === 401, "list requires login");
  assert((await req("/api/shared-menus", { method: "POST", cookie: kid.cookie, body: { title: "x" } })).status === 403, "kids can't create menus");
  assert((await req("/api/shared-menus", { method: "POST", ...P, body: { title: "" } })).status === 400, "title required");
  assert((await req("/api/shared-menus", { method: "POST", ...P, body: { title: "x", eventDate: "11/26" } })).status === 400, "date validated");

  const created = await req("/api/shared-menus", { method: "POST", ...P, body: { title: "Thanksgiving dinner", eventDate: "2026-11-26", template: "thanksgiving" } });
  assert(created.status === 200 && created.json.sharePath.startsWith("/m/"), "parent creates a menu with a share link");
  const menuId = created.json.id;
  const token = created.json.sharePath.slice(3);
  assert(token.length >= 20, "share token is long and random");

  let st = (await req(`/api/shared-menus/${menuId}/state`, P)).json;
  assert(st.items.length === 16 && st.items[0].name === "Roast turkey", "Thanksgiving template seeds items in order");
  assert(st.host && st.canManage && st.me, "parent is a managing host with a participant row");
  assert(st.participants.length === 1 && st.participants[0].kind === "member" && st.participants[0].name === "Parent", "family participant named after the member");

  const list = (await req("/api/shared-menus", { cookie: kid.cookie })).json;
  assert(list.length === 1 && list[0].itemCount === 16 && list[0].guestCount === 0, "family list shows counts (kids can see it)");
  assert((await req(`/api/shared-menus/${menuId}/state`, { cookie: other.cookie })).status === 404, "other families can't open it by id");

  const kidState = (await req(`/api/shared-menus/${menuId}/state`, { cookie: kid.cookie })).json;
  assert(kidState.host && !kidState.canManage, "kids are hosts but can't manage the link");
  assert((await req(`/api/shared-menus/${menuId}/share`, { method: "POST", cookie: kid.cookie, body: { enabled: false } })).status === 403, "kids can't turn off the link");
  const kidItem = await req(`/api/shared-menus/${menuId}/items`, { method: "POST", cookie: kid.cookie, body: { name: "Jello salad", category: "sides" } });
  assert(kidItem.status === 200, "kids can add items");

  console.log("\n-- guest page --");
  const page = await fetch(`${BASE}/m/${token}`);
  const html = await page.text();
  assert(page.status === 200 && html.includes("ps-shared-menu"), "guest page served at /m/<token>");
  assert(page.headers.get("referrer-policy") === "no-referrer" && /noindex/.test(page.headers.get("x-robots-tag") || ""), "guest page keeps the token out of referrers and search");

  console.log("\n-- guests --");
  const G = `/api/m/${token}`;
  let g = await req(`${G}/state`);
  assert(g.status === 200 && g.json.me === null && !g.json.host && g.json.items.length === 17, "anyone with the link can read the menu");
  assert(g.json.menu.sharePath === undefined, "guests don't get the share path back");
  assert((await req(`/api/m/not-a-real-token-xxxxxxxx/state`)).status === 404, "unknown token is 404");
  const pre = await req(`${G}/items`, { method: "POST", body: { name: "Pie" } });
  assert(pre.status === 403 && pre.json.needsJoin, "guests must join before editing");
  assert((await req(`${G}/join`, { method: "POST", body: { name: "  " } })).status === 400, "join needs a name");

  const join = await req(`${G}/join`, { method: "POST", body: { name: "Friend" } });
  const guest = firstCookie(join);
  assert(join.status === 200 && guest.startsWith(`psm_${menuId}=`) && join.json.me, "join sets a participant cookie");
  assert(/HttpOnly/i.test(join.headers.get("set-cookie") || ""), "participant cookie is httpOnly");
  const friendId = join.json.me;
  assert(join.json.participants.some((p) => p.id === friendId && p.kind === "guest" && p.name === "Friend"), "guest listed as participant");

  const forged = guest.replace(/\.[^.]+$/, ".wrongsecret");
  assert((await req(`${G}/state`, { cookie: forged })).json.me === null, "a forged participant cookie isn't accepted");
  assert((await req(`/api/shared-menus/${menuId}/state`, { cookie: guest })).status === 401, "guest cookie gives no family access");

  const rename = await req(`${G}/join`, { method: "POST", cookie: guest, body: { name: "Sam" } });
  assert(rename.json.me === friendId && rename.json.participants.find((p) => p.id === friendId).name === "Sam", "joining again renames instead of duplicating");

  console.log("\n-- items & claims --");
  const added = await req(`${G}/items`, { method: "POST", cookie: guest, body: { name: "Pecan pie", category: "desserts", claimedBy: friendId, notes: "Grandma's recipe" } });
  assert(added.status === 200 && added.json.claimedBy === friendId && added.json.addedBy === friendId, "guest adds an item claimed for themself");
  const pieId = added.json.id;
  assert((await req(`${G}/items`, { method: "POST", cookie: guest, body: { name: "x", claimedBy: st.me } })).status === 403, "guests can't add items claimed for someone else");
  assert((await req(`${G}/items`, { method: "POST", cookie: guest, body: { name: "<script>", category: "bogus" } })).json.category === "other", "unknown category falls back to other");

  const turkey = st.items.find((i) => i.name === "Roast turkey");
  const gravy = st.items.find((i) => i.name === "Gravy");
  assert((await req(`/api/shared-menus/${menuId}/items/${turkey.id}`, { method: "PUT", ...P, body: { claimedBy: st.me } })).json.claimedBy === st.me, "host claims the turkey");
  assert((await req(`${G}/items/${turkey.id}`, { method: "PUT", cookie: guest, body: { claimedBy: friendId } })).status === 403, "guest can't take an item someone else claimed");
  assert((await req(`${G}/items/${turkey.id}`, { method: "PUT", cookie: guest, body: { claimedBy: null } })).status === 403, "guest can't release someone else's claim");
  assert((await req(`${G}/items/${gravy.id}`, { method: "PUT", cookie: guest, body: { claimedBy: friendId } })).json.claimedBy === friendId, "guest claims an open item");
  assert((await req(`${G}/items/${gravy.id}`, { method: "PUT", cookie: guest, body: { claimedBy: null } })).json.claimedBy === null, "guest releases their own claim");
  assert((await req(`/api/shared-menus/${menuId}/items/${gravy.id}`, { method: "PUT", ...P, body: { claimedBy: friendId } })).json.claimedBy === friendId, "host can assign an item to a guest");
  assert((await req(`/api/shared-menus/${menuId}/items/${gravy.id}`, { method: "PUT", ...P, body: { claimedBy: "nobody" } })).status === 403, "can't assign to unknown participants");
  const edited = await req(`${G}/items/${turkey.id}`, { method: "PUT", cookie: guest, body: { done: true, notes: "18 lb", name: "Turkey (brined)" } });
  assert(edited.json.done && edited.json.notes === "18 lb" && edited.json.name === "Turkey (brined)", "anyone can tick off and edit items");
  assert((await req(`${G}/items/${turkey.id}`, { method: "PUT", cookie: guest, body: { name: "" } })).status === 400, "item name can't be blanked");

  console.log("\n-- comments --");
  const c1 = await req(`${G}/comments`, { method: "POST", cookie: guest, body: { itemId: pieId, body: "Is anyone allergic to nuts?" } });
  assert(c1.status === 200 && c1.json.itemId === pieId && c1.json.participantId === friendId, "guest comments on an item");
  const c2 = await req(`/api/shared-menus/${menuId}/comments`, { method: "POST", ...P, body: { body: "Dinner at 4pm!" } });
  assert(c2.status === 200 && c2.json.itemId === null, "host posts in the general discussion");
  assert((await req(`${G}/comments`, { method: "POST", cookie: guest, body: { body: "   " } })).status === 400, "empty comments rejected");
  assert((await req(`${G}/comments`, { method: "POST", cookie: guest, body: { body: "hi", itemId: "missing" } })).status === 404, "comments need a real item");
  assert((await req(`${G}/comments/${c2.json.id}`, { method: "DELETE", cookie: guest })).status === 403, "guests can't delete others' comments");

  console.log("\n-- deleting --");
  assert((await req(`${G}/items/${turkey.id}`, { method: "DELETE", cookie: guest })).status === 403, "guests can't remove items they didn't add");
  assert((await req(`${G}/items/${pieId}`, { method: "DELETE", cookie: guest })).status === 200, "guests can remove their own items");
  st = (await req(`/api/shared-menus/${menuId}/state`, P)).json;
  assert(!st.items.some((i) => i.id === pieId) && !st.comments.some((c) => c.id === c1.json.id), "removing an item removes its comments");
  assert((await req(`/api/shared-menus/${menuId}/comments/${c2.json.id}`, { method: "DELETE", cookie: kid.cookie })).status === 200, "family members can delete any comment");

  console.log("\n-- menu details & link controls --");
  assert((await req(`${G}`, { method: "PUT", cookie: guest, body: { title: "Hijacked" } })).status === 403, "guests can't edit menu details");
  assert((await req(`${G}/share`, { method: "POST", cookie: guest, body: { enabled: false } })).status === 403, "guests can't change the link");
  assert((await req(`${G}`, { method: "DELETE", cookie: guest })).status === 403, "guests can't delete the menu");
  const upd = await req(`/api/shared-menus/${menuId}`, { method: "PUT", ...P, body: { notes: "Bring chairs" } });
  assert(upd.json.menu.notes === "Bring chairs", "host edits notes");

  // A logged-in family member who follows the link is a host there too.
  const viaLink = (await req(`${G}/state`, P)).json;
  assert(viaLink.host && viaLink.me === st.me && viaLink.menu.sharePath, "family members following the link act as family");

  const live = await streamSees(`${G}/stream`, guest, () => req(`/api/shared-menus/${menuId}/items`, { method: "POST", ...P, body: { name: "Napkins" } }));
  assert(live, "guests get live updates over the menu stream");

  await req(`/api/shared-menus/${menuId}/share`, { method: "POST", ...P, body: { enabled: false } });
  assert((await req(`${G}/state`, { cookie: guest })).status === 404, "turning the link off locks guests out");
  assert((await req(`/api/shared-menus/${menuId}/state`, P)).status === 200, "family still has access with the link off");
  await req(`/api/shared-menus/${menuId}/share`, { method: "POST", ...P, body: { enabled: true } });
  assert((await req(`${G}/state`, { cookie: guest })).json.me === friendId, "turning it back on restores guests");

  const regen = await req(`/api/shared-menus/${menuId}/share`, { method: "POST", ...P, body: { regenerate: true } });
  const token2 = regen.json.menu.sharePath.slice(3);
  assert(token2 !== token && (await req(`${G}/state`)).status === 404, "a new link retires the old one");
  assert((await req(`/api/m/${token2}/state`, { cookie: guest })).json.me === friendId, "guests who joined keep their identity on the new link");

  const listAfter = (await req("/api/shared-menus", P)).json[0];
  assert(listAfter.guestCount === 1 && listAfter.claimedCount >= 2, "list counts guests and claims");

  console.log("\n-- per-menu names --");
  const M = `/api/shared-menus/${menuId}`;
  const meName = (state) => state.participants.find((p) => p.id === state.me)?.name;
  let named = await req(`${M}/me`, { method: "PUT", ...P, body: { name: "James" } });
  assert(named.status === 200 && meName(named.json) === "James" && named.json.customName && named.json.profileName === "Parent", "family member picks a different name for this menu");
  named = (await req(`${M}/state`, P)).json;
  assert(meName(named) === "James", "the menu name sticks instead of snapping back to the profile name");
  assert(meName((await req(`/api/m/${token2}/state`, P)).json) === "James", "same name when following the link");
  const guestView = (await req(`/api/m/${token2}/state`, { cookie: guest })).json;
  assert(guestView.participants.some((p) => p.name === "James") && !guestView.participants.some((p) => p.name === "Parent"), "guests see the menu name, not the profile name");
  assert(guestView.profileName === undefined && guestView.customName === undefined, "guests don't see family profile names");
  named = await req(`${M}/me`, { method: "PUT", ...P, body: { name: "" } });
  assert(meName(named.json) === "Parent" && !named.json.customName, "clearing it goes back to the profile name");
  assert((await req(`/api/m/${token2}/me`, { method: "PUT", cookie: guest, body: { name: "Sammy" } })).json.participants.some((p) => p.id === friendId && p.name === "Sammy"), "guests rename themselves");
  assert((await req(`/api/m/${token2}/me`, { method: "PUT", cookie: guest, body: { name: " " } })).status === 400, "guests can't blank their name");
  assert((await req(`/api/m/${token2}/me`, { method: "PUT", body: { name: "Nobody" } })).status === 403, "can't rename before joining");
  const other2 = await req("/api/shared-menus", { method: "POST", ...P, body: { title: "Friendsgiving", displayName: "Jim" } });
  const o2 = (await req(`/api/shared-menus/${other2.json.id}/state`, P)).json;
  assert(meName(o2) === "Jim" && o2.customName, "a name can be set when creating a menu");
  assert(meName((await req(`${M}/state`, P)).json) === "Parent", "names are per menu");
  await req(`/api/shared-menus/${other2.json.id}`, { method: "DELETE", ...P });

  console.log("\n-- delete menu --");
  assert((await req(`/api/shared-menus/${menuId}`, { method: "DELETE", cookie: kid.cookie })).status === 403, "kids can't delete menus");
  assert((await req(`/api/shared-menus/${menuId}`, { method: "DELETE", ...P })).status === 200, "parent deletes the menu");
  assert((await req(`/api/m/${token2}/state`)).status === 404 && (await req("/api/shared-menus", P)).json.length === 0, "deleted menu is gone everywhere");
}

(async () => {
  console.log("Shared menus tests");
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
