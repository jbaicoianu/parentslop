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
- **Rules:** anyone who joined can add/edit/tick items and comment; guests claim only for themselves and release only their own claims, family can assign anyone; items/comments are deleted by their author or family.
- Server: `lib/shared-menus.js` (tables `shared_menus`, `shared_menu_participants`, `shared_menu_items`, `shared_menu_comments`; all in the event log). One router serves both URL prefixes. Live updates: per-menu SSE at `.../stream` (`menu:changed`), plus family SSE `shared-menus:changed`.
- Client: `static/tracker/components/ps-shared-menu.js` is self-contained (no core.js) so the guest page can use it; guest text is rendered inside the family app, so everything is escaped.
- Tests: `tests/shared-menus.test.js`.
