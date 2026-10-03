# Task Tracker (+ MCP)

A local-first Kanban board with a calm, themeable UI, an SQLite backend that needs no setup, and an MCP server so AI agents can read and update your tasks.

## Quick start

Requires **Node 22.13+**. SQLite is built into Node, so there's nothing native to compile.

```bash
npm install     # also builds the UI
npm start       # → http://localhost:1717
```

On first run the board is seeded with four columns (**Open · In Progress · Follow-up · Done**) and a few welcome cards.

| Env var          | Default                         |
| ---------------- | ------------------------------- |
| `PORT`           | `1717`                          |
| `HOST`           | `127.0.0.1` (local only)        |
| `TASKTRACKER_DB` | `~/.tasktracker/tasktracker.db` |

Development with hot reload: `npm run dev`, then open http://localhost:5173.

## Using the board

- **Add a task**: press `N` or click **+ Add task** in any column. Quick-add understands:
  - `@today` `@tomorrow` `@fri` `@nextweek` `@3d` `@2w` `@2026-10-12` `@10/12` → deadline
  - `!low` `!med` `!high` `!urgent` → priority
  - e.g. `Send invoice @fri !high`
- **Edit**: click a card. Title, description, subtasks, note, priority, deadline and timer all **autosave**.
- **Deadlines**: pick a date (plus an optional time) or use the presets. Cards show friendly labels such as *Due today*, *Due tomorrow*, *Due in 3h*, *Due next week* and *Overdue by 2d*, colour-coded by urgency. Use **Due this week** / **Overdue** in the top bar to focus.
- **Time spent**: start and pause a timer per task. It stops automatically when the task reaches the done column.
- **Complete**: tick the circle on a card (moves it to the done column, with an undo option) or drag it there.
- **Archive**: the archive icon on a card (on hover) or in the task panel. Restore or delete permanently from the 🗄 archive panel.
- **Columns**: double-click a name to rename. The `⋯` menu lets you change the colour, mark the column as "done", move it left/right, hide it, or remove it. Removing a column that has tasks asks you to **move the tasks** to another column or **hide the column** instead. Hidden columns come back from **Hidden** in the top bar.
- **Themes**: the brush icon offers Paper, Old Money, Nordic Frost, Sakura, Sage Garden, Midnight Ink, Espresso Library and Graphite.
- `/` focuses search · `Esc` closes panels.

## MCP server (for AI agents)

The MCP server talks to the same SQLite file. Changes made by an agent appear in open browser tabs within about half a second. The web server doesn't need to be running for the agent to work.

**Claude Code**

```bash
claude mcp add tasktracker -- node /ABSOLUTE/PATH/TO/tasktracker_MCP/mcp/index.js
```

**Claude Desktop / Cursor / other clients** (`mcpServers` config):

```json
{
  "mcpServers": {
    "tasktracker": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/tasktracker_MCP/mcp/index.js"]
    }
  }
}
```

| Tool | What it does |
| --- | --- |
| `get_board` | Overview of every column and task. A good first call |
| `list_tasks` | Filter by column, text, `due_within_days`, `overdue`, archived |
| `get_task` | Full details, including subtask ids |
| `create_task` | Title, description, note, column, priority, due, subtasks |
| `update_task` | Change any field (`due: ""` clears the deadline) |
| `move_task` | Move to a column by name (fuzzy: `"in prog"` works) or id |
| `complete_task` | Move to the done column, optionally appending a summary note |
| `archive_task` | Archive, or restore with `archived: false` |
| `append_note` | Add a timestamped line to the note (progress log) |
| `add_subtasks` / `update_subtask` / `delete_subtask` | Manage the checklist |
| `track_time` | Start or stop the time-spent timer |
| `list_columns` | Columns with ids, hidden flags and the done column |

Try asking your agent: *"What's overdue on my board?"* or *"Break task #3 into subtasks and move it to In Progress."*

## Architecture

```
server/db.js     data layer: schema, migrations, all business rules (shared)
server/index.js  Fastify REST API + SSE live updates + serves the built UI
mcp/index.js     MCP stdio server, using the same data layer
shared/due.js    deadline labels, used by the UI and MCP
web/             React 19 + Vite + Tailwind v4 + Radix UI + dnd-kit
```

- `GET /api/board` returns the whole board in one query (~1 ms locally). The UI updates optimistically, so interactions never wait on the network.
- Writes from other processes (the MCP server) are detected with SQLite's `PRAGMA data_version` and pushed to browsers over Server-Sent Events.
- SQLite runs in WAL mode, so the web app and an agent can work at the same time.

## Tests

```bash
npm test
```

## Note for macOS iCloud users

If this folder lives in an iCloud-synced location (such as `~/Documents` with "Desktop & Documents" sync and *Optimize Mac Storage*), macOS can evict `node_modules` files to the cloud. When that happens, `npm start` hangs with no output. To exclude the folder from sync, run this after installing:

```bash
xattr -w 'com.apple.fileprovider.ignore#P' 1 node_modules web/dist
```

This is also why the database defaults to `~/.tasktracker/` and not the project folder.
