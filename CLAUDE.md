# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

ParentSlop is a family task & reward tracker. It runs as a Node/Express server with a SQLite database (`parentslop.db`) and a vanilla JS frontend using Web Components (custom elements with shadow DOM). No build step — all client code is served statically.

## Running

```bash
node server.js        # starts on port 3000
```

## Architecture

- `server.js` — Express server, SQLite via better-sqlite3, serves static files + REST API
- `static/` — All client-facing files (HTML, JS, CSS, games) served via `express.static`
- `static/tracker/core.js` — Client-side business logic, stores (localStorage + server sync), shared CSS
- `static/tracker/components/ps-*.js` — Web Components (shadow DOM, no framework)
- `static/index.html` — Shell, navigation, admin tab system
- All state is in `trackerStore.*` (localStorage-backed stores synced to server)
- Event-driven: `eventBus.emit()`/`eventBus.on()` for cross-component communication

## Feedback Workflow

When working through user feedback from the Admin > Feedback tab:

1. **Review open feedback** by fetching from the API: `GET /api/feedback`
2. **After acting on feedback** (fixing a bug, adding a feature, etc.), mark it as completed with a resolution note explaining what was done:
   ```bash
   curl -X PATCH http://localhost:3000/api/feedback/<id> \
     -H "Content-Type: application/json" \
     -d '{"completed": true, "note": "Description of what was done"}'
   ```
3. The resolution note is required — it should briefly describe the change made (e.g., "Added sorting to the task list" or "Fixed balance display rounding bug")
4. Check for open feedback at the start of sessions when relevant

## Projects module

Parents-only personal project backlog (module id `projects`, nav tab "Projects").

- **Ownership:** a project is visible only to the members on it (`project_members`; the creator is `owner` and alone can share, unshare or delete). Every endpoint checks membership server-side. Shared: name, goal, status, tasks, links. Per person: track and lane (on their `project_members` row), tracks, daily picks, GitHub token (`stores` key `github_token:<member id>`, refused by the generic store API). Tasks can have an `assignee_id`; others don't get them as suggestions. Kids can be members/assignees, but the module and API stay parent-only for now.
- Projects belong to **tracks** (table `project_tracks`: Home & Family, Work, Open Source, Hobbies, Upkeep...). Within a track, a project's lane (sent to the client as `priority`): 3 Focus, 2 Next, 1 Later, 0 Someday; each track has a `focus_limit`. `ProjectsScore.trackSummary` builds the per-track Today cards.
- Server: `lib/projects.js` (tables `project_tracks`, `projects`, `project_members`, `project_tasks`, `project_picks`; all CRRs in the event log). Endpoints under `/api/projects*`, `/api/project-tasks/*`, `/api/project-picks*`, all `requireAdmin`.
- Client: `static/tracker/components/ps-projects.js` (Today / Projects / detail) and `static/tracker/projects-score.js` (daily suggestion scoring, shared with Node).
- CLI: `tools/projects import|sync-github|today` (same PARENTSLOP_* auth env vars as `tools/feedback`). The inventory lives in `~/src/project-backlog/data/projects.json` (with `tracks.json` beside it); GitHub sync uses the local `gh` login.
- GitHub links: `{type:"github", repo}` pulls all issues; `{type:"github", repo, issue}` pulls an epic's sub-issue tree with blocked-by edges as dependencies. Epic links claim their issues before whole-repo links.
- Tests: `tests/projects.test.js`.

## Shared menus

Potluck-style menu checklists (Thanksgiving dinner...) planned with people outside the family. Meals > Shared tab.

- **Access:** a menu belongs to one family. Family members use `/api/shared-menus/:id/*` with their session (any member edits items; parents create menus, control the link, delete). Anyone with the link opens `/m/<token>` (`static/shared-menu.html`) and uses `/api/m/:token/*`; they join with a name, which creates a `shared_menu_participants` row and an httpOnly `psm_<menu id>` cookie (only a hash of the secret is stored). Turning the link off or regenerating it locks guests out. Family members following the link are treated as family.
- **Names:** a family member's name on a menu follows their profile name unless they set their own for that menu (`custom_name` on their participant row; `PUT .../me`, blank resets). Guests rename through the same endpoint.
- **Sign-ups:** `shared_menu_claims` has one row per (item, person) with its own `done`; items have `wanted` (1 default, N people, 0 = anyone). Endpoints `POST/PUT/DELETE .../items/:id/claims[/:pid|me]`. The old one-person `claimedBy`/`done` on `PUT .../items/:id` still works, and old `claimed_by`/`done` item columns are migrated into claims on first request.
- **Rules:** anyone who joined can add/edit items and comment; guests sign up and drop out only for themselves and mark only their own part ready, family can assign/remove anyone (assigning a one-person item replaces whoever had it); items/comments are deleted by their author or family.
- Server: `lib/shared-menus.js` (tables `shared_menus`, `shared_menu_participants`, `shared_menu_items`, `shared_menu_comments`; all in the event log). One router serves both URL prefixes. Live updates: per-menu SSE at `.../stream` (`menu:changed`), plus family SSE `shared-menus:changed`.
- Client: `static/tracker/components/ps-shared-menu.js` is self-contained (no core.js) so the guest page can use it; guest text is rendered inside the family app, so everything is escaped.
- Tests: `tests/shared-menus.test.js`.

## Screen time

Daily computer time per kid, enforced on the family computer ("kidputer", Ubuntu/GNOME). Module id `screentime`, nav tab "Screen Time" (kids see their own time, parents manage everyone).

- **Model:** per person (`screentime_settings`, id = users.id): on/off, weekday/weekend minutes, the Linux login that maps to them, warning thresholds, grace minutes. Usage is one row per (person, day, computer) holding that computer's running total for the day; the server keeps `max(stored, reported)` so reports are idempotent and offline catch-up just works. Parents add/remove time per day (`screentime_adjustments`). remaining = allowance + adjustments - usage over all computers. Days are the computer's local date; Sat/Sun use the weekend allowance.
- **Computers:** `screentime_devices`, bearer token `psd_<id>.<secret>` (only a hash stored), created in the UI (token shown once with an install command). `POST /api/screentime/device/report` is the only device endpoint: it takes `{date, usage:{login:seconds}, active, states, graceEndsAt}` and returns each managed login's remaining time + settings. Who is on which computer right now is kept in memory only.
- **Agent:** `tools/screentime-agent/` (Python 3 stdlib, no build). `parentslop-screentime run` is a root systemd service: polls logind every 5 s (time counts while a session is Active, unlocked and not idle), reports every 60 s, notifies via `notify-send` in the kid's session (always critical so they show over fullscreen games, and closed again by the agent after `banner_seconds`, default 8, so a banner never sits on screen where a mouse-over could give it keyboard focus; GNOME 46 never focuses banners by itself), starts the grace countdown at zero, then `loginctl terminate-user`. `pam-check` (pam_exec, after `@include common-account` in gdm-*/xrdp-sesman/login/sshd, guarded by `pam_succeed_if ... notingroup screentime`) blocks kids with no time left. Only accounts in the local `screentime` group are ever touched. `install.sh` installs/uninstalls; the server serves the three install files at `/screentime-agent/<file>`.
- Server: `lib/screentime.js`. Client: `static/tracker/components/ps-screentime.js`. SSE: `screentime:changed`.
- Tests: `tests/screentime.test.js` (server), `python3 tools/screentime-agent/test_agent.py` (agent logic with fake logind/server).
