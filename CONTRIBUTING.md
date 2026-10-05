# Contributing to Task Tracker

First off: **thank you!** 🎉 Whether it's your first open-source contribution or your thousandth, you're welcome here. Bug reports, docs fixes, new themes, features, and thoughtful questions all make this project better.

## 🧭 Ways to contribute

- 🐛 **Report a bug.** [Open a bug report](https://github.com/Parv17k/tasktracker/issues/new?template=bug_report.yml)
- 💡 **Suggest a feature.** [Open a feature request](https://github.com/Parv17k/tasktracker/issues/new?template=feature_request.yml)
- 📝 **Improve the docs.** Typos, clearer wording and examples all count
- 🎨 **Design a theme.** One of the most fun first contributions (see below)
- 🧑‍💻 **Write code.** Pick up an issue or something from the [ideas list](#-ideas-to-get-you-started)

## 🚀 Getting set up

You need **Node.js 22.13 or newer**. That's the only requirement.

```bash
# 1. Fork the repo on GitHub, then:
git clone https://github.com/<your-username>/tasktracker.git
cd tasktracker
npm install

# 2. Run in dev mode (API + hot-reloading UI)
npm run dev
# → open http://localhost:5173
```

> 💡 **Tip:** to experiment without touching your real tasks, point the app at a throwaway database:
> `TASKTRACKER_DB=/tmp/tt-dev.db npm run dev`

## 🗺️ Project map

```
server/db.js        ← all data & business rules: projects, columns, tasks, settings (start here)
server/index.js     ← REST API, live updates (SSE), serves the UI
server/reminders.js ← deadline reminder engine + Web Push delivery
server/chat.js      ← AI chat: board snapshot, streaming proxy, voice (speech-to-text / text-to-speech)
server/actions.js   ← changes the assistant proposes: preview for approval, then apply in one transaction
mcp/index.js        ← MCP server for AI agents (uses server/db.js)
shared/due.js       ← "Due tomorrow" / "Overdue 2d" labels, shared by UI + MCP
shared/tags.js      ← tag colours and add/remove helpers, shared by UI, chat + MCP
web/public/
  sw.js             ← service worker: notifications, installable app shell
  manifest.webmanifest, icons/
web/src/
  store.js          ← Zustand store with optimistic updates
  router.js         ← "/" home page, "/p/:id" project boards
  pwa.js            ← install prompt, push subscription, notification clicks
  voice.js          ← mic recording, browser speech fallback, reading answers aloud
  themes.js         ← theme list for the picker
  styles.css        ← theme colours (CSS variables) + global styles
  dates.js          ← date presets & quick-add parser (@fri !high)
  components/       ← Home, Board, Timeline, Column, TaskCard, TaskSheet, Tags, Reminders, Chat, TopBar, …
test/               ← node:test suite
```

**Golden rule:** business logic belongs in `server/db.js`, so the web UI and the MCP server always behave the same way. If you add a capability, consider exposing it in **both** the REST API and the MCP server.

## 🎨 Adding a theme (a great first PR)

1. In `web/src/styles.css`, copy an existing `[data-theme='…']` block and give it a new id. Every colour, font and shadow is a CSS variable.
2. Add an entry to `web/src/themes.js` with a name, tagline and four swatch colours.
3. If it's a dark theme, add its id to the `dark` list in `web/src/App.jsx`, and to the `--bar-l: 0.65` block in `styles.css` so the home-page status bars stay readable.
4. Check that text is readable (aim for WCAG AA contrast), and that due-date chips, priority icons, the note pad and the home page's status bars all look good.
5. Include a screenshot in your PR!

## ✅ Before you open a pull request

- [ ] `npm test` passes, and you've added tests for new data-layer behaviour
- [ ] `npm run build` succeeds
- [ ] You tried your change in the browser, ideally in a light theme **and** a dark one
- [ ] UI changes include a screenshot or short GIF
- [ ] The PR is focused on one thing (smaller PRs get merged faster)

### Code style

- Plain modern JavaScript (ES modules) and React function components
- Match the surrounding code: naming, comment density, Tailwind utility style
- Keep the UI **calm**: fewer buttons, sensible defaults, autosave over confirm dialogs
- Use theme variables (`bg-card`, `text-muted`, `border-line`, …), never hard-coded colours

### Commit messages

Short and descriptive, in the imperative mood:

```
Add Catppuccin theme
Fix overdue count ignoring tasks with a due time
```

## 💡 Ideas to get you started

The [roadmap in the README](README.md#-roadmap) has the bigger picture. These are good places to start:

| Idea | Difficulty |
| --- | --- |
| New themes (Catppuccin, Tokyo Night, Everforest, Nord…) | 🟢 Easy |
| Drag to reorder subtasks in the task panel | 🟢 Easy |
| Keyboard shortcuts help dialog (<kbd>?</kbd>) | 🟢 Easy |
| Clickable `#id` task links in chat replies | 🟢 Easy |
| Copy button on chat replies | 🟢 Easy |
| Saved filters (a tag + deadline + search combination) | 🟡 Medium |
| Sort the home page by project priority | 🟢 Easy |
| Timeline: a "jump to today" button and remembering scroll position | 🟢 Easy |
| Timeline: show project start/end milestones you set by hand | 🟡 Medium |
| Snooze a reminder from the notification | 🟡 Medium |
| Export / import the board as JSON or Markdown | 🟡 Medium |
| Recurring tasks (daily, weekly…) | 🟡 Medium |
| Command palette (<kbd>⌘K</kbd>) | 🟡 Medium |
| Natural-language task capture: "renew insurance next Friday, high priority" → a filled-in task | 🟡 Medium |
| Daily briefing notification: what's due and a suggested plan | 🟡 Medium |
| Undo button on applied chat changes | 🟡 Medium |
| Voice: a push-to-talk keyboard shortcut (hold Space) | 🟢 Easy |
| Native tool calling for providers that support it (keep the approval card) | 🟠 Advanced |
| Planning agent: propose deadline, priority and breakdown changes as a diff you approve | 🟠 Advanced |
| Semantic search with local embeddings | 🟠 Advanced |
| Streamable-HTTP transport for the MCP server | 🟠 Advanced |
| Move tasks between projects | 🟠 Advanced |
| HTTPS on the local network, so phones can install the app | 🟠 Advanced |

**Working on AI features?** Business logic still belongs in `server/db.js`; the chat (`server/chat.js`) and MCP server should call it, never write SQL themselves. Test against a local model (Ollama or LM Studio) so you don't need an API key, and never commit keys or provider URLs.

Want to take one? Comment on (or open) an issue so nobody duplicates work, and feel free to ask questions there.

## 🙋 Need help?

Stuck? Unsure if an idea fits? [Open an issue](https://github.com/Parv17k/tasktracker/issues/new/choose). There are no silly questions. We'd rather help you finish a PR than have you give up on it.

## 🤗 Be kind

Be patient, assume good intent, and help newcomers along.

---

Thanks again for helping make Task Tracker better. 💚
