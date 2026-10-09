# Changelog

## Unreleased

- 🤝 **When two agents touch the same card:** agents can mark a card as being worked on (`claim_task` / `release_task`). Claims are leases, not locks: they expire after 30 minutes without activity, clear when the agent disconnects or the card is done, and you can release one anytime.
- ⚠️ **No stale overwrites:** requests remember the values they'd replace; changes made since the agent asked are flagged and start unticked.
- Side panels now close with a single Esc (the close button's tooltip no longer pops up on open).

## v1.0.0 · 2026-10-04

The first stable release: a local-first task board for you and your AI agents.

### 🤖 Work with AI agents
- **MCP server with 19 tools** so Claude Code, Cursor and other agents can plan, update and complete tasks.
- **Agents ask first** (default): their changes wait in the 🤖 Agent requests inbox, in plain words, until you approve. Switch to *Apply right away* when you trust an agent. Agents can check the outcome with `get_request`.

### ✨ Built-in assistant
- Chat with any OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Ollama, LM Studio), grounded in a snapshot of your board.
- **Proposes, you approve**: changes appear on an approval card, are checked against the board's rules, and apply all-or-nothing. It can't delete anything.
- **Voice**: speak your question, hear the answer, hands-free. Uses your provider's speech models or the browser's.
- Plain-language errors when the provider is down, the key is wrong or the URL is off.

### 🗓️ Planning
- **Timeline (Gantt)** per project and across all projects, with drag to reschedule and optional start dates.
- Projects with a home page, **priorities** and **tags**; colour tags on tasks; deadlines that read like a person wrote them.
- Quick add: `Send invoice @fri !high #finance`.

### 🧘 Everyday
- Installable app (PWA) with deadline reminders that work while it's closed.
- Twenty-four focus-friendly themes.
- One SQLite file on your machine. No account, no cloud, no telemetry.
