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
- `tracker/core.js` — Client-side business logic, stores (localStorage + server sync), shared CSS
- `tracker/components/ps-*.js` — Web Components (shadow DOM, no framework)
- `index.html` — Shell, navigation, admin tab system
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
