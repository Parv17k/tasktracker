#!/usr/bin/env node
// MCP server (stdio) for the task tracker. Reads and writes the same SQLite
// database as the web app; open browser tabs update live via SSE.
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as store from '../server/db.js';
import * as actions from '../server/actions.js';
import { dueInfo, formatDuration } from '../shared/due.js';
import { changeTags } from '../shared/tags.js';

const server = new McpServer(
  { name: 'tasktracker', version: '1.0.0' },
  {
    instructions:
      "Task Tracker is the user's local task board. Read freely. By default the user approves changes: write tools then return a request id instead of changing the board, " +
      'and the change appears once the user taps Apply in the app. Batch related changes into as few calls as you can, tell the user what you asked for, ' +
      'and use get_request to see whether it was applied (and the ids of anything created). ' +
      'Before working on a task for a while, call claim_task so the user and other agents see it is in progress; it expires on its own and is released when the task is done.',
  }
);

// ---------- approval ----------
// In "ask me first" mode (the default) every write becomes a request the user approves in the app.

/** A friendly name for the connected agent, e.g. "claude-code" → "Claude Code". */
function agentName() {
  const raw = server.server.getClientVersion()?.name || '';
  if (!raw) return 'An agent';
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bMcp\b/g, 'MCP')
    .slice(0, 60);
}

const asking = () => store.getAgentSettings().approval === 'ask';

// one id per running MCP server (= one agent session); its claims are released when it exits
const SESSION = randomUUID();
let released = false;
const releaseAll = () => {
  if (released) return;
  released = true;
  try {
    store.releaseSession(SESSION);
  } catch {}
};
process.on('exit', releaseAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

const taskIdsIn = (list) => [...new Set(list.map((a) => Number(a.task)).filter((n) => Number.isInteger(n) && n > 0))];

/** Keep this agent's claims alive while it works, and note cards another agent is working on. */
function touch(list) {
  const notes = [];
  for (const id of taskIdsIn(list)) {
    if (store.refreshClaim(id, SESSION)) continue;
    const c = store.getClaim(id);
    if (c && c.session !== SESSION) notes.push(`Heads-up: ${c.agent} is working on #${id}${c.note ? ` (“${c.note}”)` : ''}.`);
  }
  return notes;
}

const withNotes = (result, notes) => (notes.length ? { ...result, content: [...result.content, { type: 'text', text: notes.join('\n') }] } : result);

/** Queue `list` (action objects) for approval and describe what's waiting. */
function request(list) {
  const p = actions.propose({ agent: agentName(), actions: list, session: SESSION });
  const lines = p.items.map((i) => `- ${i.ok ? '' : '(can’t do) '}${i.verb} ${i.summary}`);
  return text(
    `Waiting for the user's approval in Task Tracker (request ${p.id}):\n${lines.join('\n')}\n\nNothing has changed yet. Call get_request with id ${p.id} later to see whether it was applied.`
  );
}

/** Run `direct` now, or ask first with the equivalent `list` of actions. */
const write = (list, direct) => {
  const notes = touch(list);
  return withNotes(asking() ? request(list) : direct(), notes);
};

// ---------- formatting ----------

function columnName(id) {
  try {
    return store.getColumn(id).name;
  } catch {
    return `#${id}`;
  }
}

function projectOf(columnId) {
  try {
    return store.getProject(store.getColumn(columnId).projectId);
  } catch {
    return null;
  }
}

function isDoneColumn(id) {
  try {
    return store.getColumn(id).isDone;
  } catch {
    return false;
  }
}

function taskLine(t) {
  const parts = [`#${t.id} ${t.title}`];
  if (t.priority !== 'none') parts.push(`[${t.priority}]`);
  const due = !isDoneColumn(t.columnId) && dueInfo(t.dueAt, t.dueHasTime);
  if (due) parts.push(`(${due.label})`);
  if (t.subtasks.length) parts.push(`{${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length} subtasks}`);
  if (t.tags?.length) parts.push(t.tags.map((g) => `#${g}`).join(' '));
  if (t.timerStartedAt) parts.push('⏱ running');
  if (t.claim) parts.push(`(🤖 ${t.claim.agent} is working on it)`);
  if (t.archived) parts.push('(archived)');
  return parts.join(' ');
}

function taskDetail(t) {
  const due = dueInfo(t.dueAt, t.dueHasTime);
  const running = t.timerStartedAt ? (Date.now() - Date.parse(t.timerStartedAt)) / 1000 : 0;
  const lines = [
    `#${t.id} ${t.title}`,
    `project: ${projectOf(t.columnId)?.name ?? '?'}`,
    `column: ${columnName(t.columnId)}${t.archived ? ' (archived)' : ''}`,
    `priority: ${t.priority}`,
    `tags: ${t.tags?.length ? t.tags.join(', ') : 'none'}`,
    `start: ${t.startAt || 'none'}`,
    `due: ${due ? `${t.dueAt} — ${due.label}` : 'none'}`,
    `time spent: ${formatDuration(t.timeSpent + running)}${t.timerStartedAt ? ' (timer running)' : ''}`,
    `working on it: ${t.claim ? `${t.claim.agent} since ${t.claim.claimedAt}${t.claim.note ? ` (“${t.claim.note}”)` : ''}` : 'nobody'}`,
  ];
  if (t.description) lines.push('', 'description:', t.description);
  if (t.note) lines.push('', 'note:', t.note);
  if (t.subtasks.length) {
    lines.push('', 'subtasks:');
    for (const s of t.subtasks) lines.push(`  [${s.done ? 'x' : ' '}] (${s.id}) ${s.title}`);
  }
  return lines.join('\n');
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Wrap a handler so domain errors come back as tool errors instead of crashing. */
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
};

const taskId = z.coerce.number().int().positive().describe('Task id (the number after #)');
const columnRef = z.union([z.string(), z.number()]).describe('Column name (e.g. "In Progress") or id');
const projectRef = z.union([z.string(), z.number()]).describe('Project name (fuzzy, e.g. "website") or id. Defaults to the first project on the home page.');
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const due = z.string().describe('Deadline as YYYY-MM-DD (whole day) or an ISO datetime, e.g. 2026-10-05T17:00');
const start = z.string().describe('Start date as YYYY-MM-DD (shows the task as a span on the timeline); empty string clears it');
const tagList = z.array(z.string().min(1)).describe('Tag names, e.g. ["design", "q4"]. New tags are created automatically.');

// ---------- tools ----------

server.registerTool(
  'get_board',
  {
    title: 'Get board overview',
    description: "Overview of one project's board: every visible column and its tasks (id, title, priority, deadline, subtask progress). Call list_projects first if there are several projects.",
    inputSchema: { project: projectRef.optional() },
    annotations: { readOnlyHint: true },
  },
  tool(({ project }) => {
    const { project: p, columns, tasks } = store.getBoard(store.resolveProject(project).id);
    const out = [`# ${p.icon} ${p.name} (project id ${p.id})`, ''];
    for (const c of columns.filter((c) => !c.hidden)) {
      const items = tasks.filter((t) => t.columnId === c.id);
      out.push(`## ${c.name} (id ${c.id}${c.isDone ? ', done column' : ''}) — ${items.length} task(s)`);
      for (const t of items) out.push(`- ${taskLine(t)}`);
      out.push('');
    }
    const hidden = columns.filter((c) => c.hidden);
    if (hidden.length) out.push(`Hidden columns: ${hidden.map((c) => c.name).join(', ')}`);
    return text(out.join('\n').trim());
  })
);

server.registerTool(
  'list_tasks',
  {
    title: 'Find tasks',
    description: 'Search/filter tasks across all projects, or one project. Use due_within_days or overdue to find deadlines (completed tasks are excluded from deadline filters).',
    inputSchema: {
      project: projectRef.optional().describe('Limit to one project (name or id). Omit to search every project.'),
      column: columnRef.optional().describe('Column name or id (needs project when using a name)'),
      query: z.string().optional().describe('Text to match in title, description, note, subtasks or tags'),
      tag: z.string().optional().describe('Only tasks with this tag (case-insensitive)'),
      due_within_days: z.number().min(0).optional().describe('Only open tasks due within this many days (includes overdue)'),
      overdue: z.boolean().optional().describe('Only open tasks that are past their deadline'),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(({ project, column, query, tag, due_within_days, overdue, include_archived, limit }) => {
    const projectId = project != null ? store.resolveProject(project).id : undefined;
    const tasks = store.listTasks({
      projectId,
      columnId: column != null ? store.resolveColumn(column, projectId).id : undefined,
      query,
      tag,
      dueWithinDays: due_within_days,
      overdue,
      archived: include_archived ? 'all' : false,
      limit: limit ?? 100,
    });
    if (!tasks.length) return text('No matching tasks.');
    return text(
      tasks
        .map((t) => {
          const p = projectOf(t.columnId);
          return `- ${taskLine(t)} — ${p ? `${p.name} / ` : ''}${columnName(t.columnId)}`;
        })
        .join('\n')
    );
  })
);

server.registerTool(
  'get_task',
  {
    title: 'Get task details',
    description: 'Full details of one task: description, note, subtasks (with subtask ids), deadline and time spent.',
    inputSchema: { id: taskId },
    annotations: { readOnlyHint: true },
  },
  tool(({ id }) => text(taskDetail(store.getTask(id))))
);

server.registerTool(
  'create_task',
  {
    title: 'Create task',
    description: 'Create a task in a project. Defaults to the first open (non-done) column of the default project.',
    inputSchema: {
      title: z.string().min(1),
      project: projectRef.optional(),
      description: z.string().optional(),
      note: z.string().optional(),
      column: columnRef.optional(),
      priority: priority.optional(),
      due: due.optional(),
      subtasks: z.array(z.string()).optional().describe('Checklist items to create with the task'),
      tags: tagList.optional(),
      start: start.optional(),
    },
  },
  tool(({ title, project, description, note, column, priority, due, start, subtasks, tags }) =>
    write([{ type: 'create_task', title, project, description, note, column, priority, due, start, subtasks, tags }], () => {
      const projectId = store.resolveProject(project).id;
      const t = store.createTask({
        projectId,
        title,
        description,
        note,
        priority,
        dueAt: due,
        startAt: start,
        subtasks,
        tags,
        columnId: column != null ? store.resolveColumn(column, projectId).id : undefined,
      });
      return text(`Created in ${projectOf(t.columnId)?.name} / ${columnName(t.columnId)}:\n${taskDetail(t)}`);
    })
  )
);

server.registerTool(
  'update_task',
  {
    title: 'Update task',
    description:
      'Edit task fields. Only provided fields change. Pass due: "" to clear the deadline. To add to the note without overwriting, use append_note. Use add_tags/remove_tags to change some tags, or tags to replace them all.',
    inputSchema: {
      id: taskId,
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      note: z.string().optional().describe('Replaces the whole note'),
      priority: priority.optional(),
      due: z.string().optional().describe('YYYY-MM-DD or ISO datetime; empty string clears it'),
      start: start.optional(),
      tags: tagList.optional().describe('Replaces all tags ([] removes them)'),
      add_tags: tagList.optional(),
      remove_tags: z.array(z.string()).optional(),
    },
  },
  tool(({ id, due, start, tags, add_tags, remove_tags, ...rest }) =>
    write([{ type: 'update_task', task: id, ...rest, due, start, tags, add_tags, remove_tags }], () => {
      const patch = { ...rest, ...(due !== undefined ? { dueAt: due } : {}), ...(start !== undefined ? { startAt: start } : {}) };
      if (tags !== undefined || add_tags || remove_tags) patch.tags = changeTags(tags ?? store.getTask(id).tags, { add: add_tags, remove: remove_tags });
      return text(`Updated:\n${taskDetail(store.updateTask(id, patch))}`);
    })
  )
);

server.registerTool(
  'move_task',
  {
    title: 'Move task',
    description: 'Move a task to another column of its project (e.g. "In Progress", "Follow-up").',
    inputSchema: {
      id: taskId,
      column: columnRef,
      position: z.enum(['top', 'bottom']).optional().describe('Where in the column (default bottom)'),
    },
  },
  tool(({ id, column, position }) =>
    write([{ type: 'move_task', task: id, column, position }], () => {
      const col = store.resolveColumn(column, store.getColumn(store.getTask(id).columnId).projectId);
      const t = store.moveTask(id, { columnId: col.id, index: position === 'top' ? 0 : undefined });
      return text(`Moved #${t.id} "${t.title}" to ${col.name}.`);
    })
  )
);

server.registerTool(
  'complete_task',
  {
    title: 'Complete task',
    description: 'Mark a task done by moving it to the done column. Optionally record a completion note.',
    inputSchema: { id: taskId, note: z.string().optional().describe('Appended to the task note, e.g. a summary of what was done') },
  },
  tool(({ id, note }) =>
    write([...(note ? [{ type: 'add_note', task: id, text: note }] : []), { type: 'complete_task', task: id }], () => {
      if (note) store.appendNote(id, note);
      const t = store.completeTask(id);
      return text(`Completed #${t.id} "${t.title}" → ${columnName(t.columnId)}.`);
    })
  )
);

server.registerTool(
  'archive_task',
  {
    title: 'Archive or restore task',
    description: 'Archive a task (hides it from the board, recoverable) or restore it with archived: false.',
    inputSchema: { id: taskId, archived: z.boolean().default(true) },
  },
  tool(({ id, archived }) =>
    write([{ type: archived ? 'archive_task' : 'restore_task', task: id }], () => {
      const t = store.archiveTask(id, archived);
      return text(`${archived ? 'Archived' : 'Restored'} #${t.id} "${t.title}".`);
    })
  )
);

server.registerTool(
  'append_note',
  {
    title: 'Append to note',
    description: 'Add a timestamped line to a task note — good for progress logs.',
    inputSchema: { id: taskId, text: z.string().min(1) },
  },
  tool(({ id, text: line }) => {
    const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return write([{ type: 'add_note', task: id, text: `[${stamp}] ${line}` }], () => {
      const t = store.appendNote(id, `[${stamp}] ${line}`);
      return text(`Note on #${t.id} is now:\n${t.note}`);
    });
  })
);

server.registerTool(
  'add_subtasks',
  {
    title: 'Add subtasks',
    description: 'Add one or more checklist subtasks to a task.',
    inputSchema: { task_id: taskId, titles: z.array(z.string().min(1)).min(1) },
  },
  tool(({ task_id, titles }) =>
    write([{ type: 'add_subtasks', task: task_id, subtasks: titles }], () => {
      for (const title of titles) store.addSubtask(task_id, title);
      return text(taskDetail(store.getTask(task_id)));
    })
  )
);

server.registerTool(
  'update_subtask',
  {
    title: 'Update subtask',
    description: 'Check/uncheck or rename a subtask. Subtask ids are shown in get_task as (id).',
    inputSchema: { id: z.coerce.number().int().positive(), done: z.boolean().optional(), title: z.string().min(1).optional() },
  },
  tool(({ id, done, title }) =>
    write([{ type: 'update_subtask', subtask_id: id, done, title }], () => {
      const s = store.updateSubtask(id, { done, title });
      return text(`[${s.done ? 'x' : ' '}] (${s.id}) ${s.title} — on task #${s.taskId}`);
    })
  )
);

server.registerTool(
  'delete_subtask',
  {
    title: 'Delete subtask',
    description: 'Remove a subtask from its task.',
    inputSchema: { id: z.coerce.number().int().positive() },
    annotations: { destructiveHint: true },
  },
  tool(({ id }) =>
    write([{ type: 'delete_subtask', subtask_id: id }], () => {
      const r = store.deleteSubtask(id);
      return text(`Deleted subtask ${r.deleted} from task #${r.taskId}.`);
    })
  )
);

server.registerTool(
  'track_time',
  {
    title: 'Start/stop time tracking',
    description: 'Start or stop the time-spent timer on a task. Moving a task to the done column stops it automatically.',
    inputSchema: { id: taskId, action: z.enum(['start', 'stop']) },
  },
  tool(({ id, action }) => {
    touch([{ task: id }]);
    const t = action === 'start' ? store.startTimer(id) : store.stopTimer(id);
    return text(`Timer ${action === 'start' ? 'running' : 'stopped'} on #${t.id}. Total so far: ${formatDuration(t.timeSpent)}.`);
  })
);

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: 'Every project with task counts per column, overdue and due-this-week numbers. The first active project is the default for other tools.',
    inputSchema: { include_archived: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  tool(({ include_archived }) => {
    const projects = store.listProjects({ includeArchived: !!include_archived });
    return text(
      projects
        .map((p, i) => {
          const s = p.stats;
          const cols = s.columns
            .filter((c) => !c.hidden)
            .map((c) => `${c.name} ${c.count}`)
            .join(' · ');
          const flags = [s.overdue && `${s.overdue} overdue`, s.dueWeek && `${s.dueWeek} due this week`].filter(Boolean).join(', ');
          const tags = p.tags?.length ? ` ${p.tags.map((g) => `#${g}`).join(' ')}` : '';
          const prio = p.priority !== 'none' ? ` [${p.priority} priority]` : '';
          return `${p.icon} ${p.name} (id ${p.id})${i === 0 && !p.archived ? ' [default]' : ''}${p.archived ? ' [archived]' : ''}${prio}${tags} — ${s.total} task(s): ${cols}${flags ? ` — ${flags}` : ''}`;
        })
        .join('\n')
    );
  })
);

server.registerTool(
  'create_project',
  {
    title: 'Create project',
    description: 'Create a new project with its own board (columns: Open, In Progress, Follow-up, Done).',
    inputSchema: {
      name: z.string().min(1),
      icon: z.string().optional().describe('A single emoji, e.g. 🚀'),
      description: z.string().optional(),
      priority: priority.optional(),
      tags: tagList.optional(),
    },
  },
  tool(({ name, icon, description, priority, tags }) =>
    write([{ type: 'create_project', name, icon, description, priority, tags }], () => {
      const p = store.createProject({ name, icon, description, priority, tags });
      return text(`Created project ${p.icon} ${p.name} (id ${p.id})${p.tags.length ? ` tagged ${p.tags.join(', ')}` : ''}.`);
    })
  )
);

server.registerTool(
  'update_project',
  {
    title: 'Update project',
    description: 'Rename a project or change its icon, description, priority or tags. Only provided fields change.',
    inputSchema: {
      project: projectRef,
      name: z.string().min(1).optional(),
      icon: z.string().optional(),
      description: z.string().optional(),
      priority: priority.optional(),
      tags: tagList.optional().describe('Replaces all tags ([] removes them)'),
      add_tags: tagList.optional(),
      remove_tags: z.array(z.string()).optional(),
    },
  },
  tool(({ project, tags, add_tags, remove_tags, ...rest }) =>
    write([{ type: 'update_project', project, ...rest, tags, add_tags, remove_tags }], () => {
      const current = store.resolveProject(project);
      const patch = { ...rest };
      if (tags !== undefined || add_tags || remove_tags) patch.tags = changeTags(tags ?? current.tags, { add: add_tags, remove: remove_tags });
      const p = store.updateProject(current.id, patch);
      return text(`Updated project ${p.icon} ${p.name} (id ${p.id}). Priority: ${p.priority}. Tags: ${p.tags.length ? p.tags.join(', ') : 'none'}.`);
    })
  )
);

server.registerTool(
  'get_request',
  {
    title: 'Check a change request',
    description: 'When the user approves changes in the app, write tools return a request id. Use this to see whether it was applied or dismissed, and the ids of anything it created.',
    inputSchema: { id: z.coerce.number().int().positive().describe('Request id returned by a write tool') },
    annotations: { readOnlyHint: true },
  },
  tool(({ id }) => {
    const p = store.getProposal(id);
    if (p.status === 'pending') return text(`Request ${p.id} is still waiting for the user's approval.`);
    if (p.status === 'dismissed') return text(`The user dismissed request ${p.id}. Nothing was changed.`);
    const lines = p.result.applied.map((a) => `- ${a.verb} ${a.summary}${a.taskId ? ` → task #${a.taskId}` : ''}${a.projectId ? ` → project id ${a.projectId}` : ''}`);
    const skipped = p.items.filter((i) => i.ok).length - p.result.applied.length;
    return text(`The user applied request ${p.id}:\n${lines.join('\n')}${skipped > 0 ? `\n(${skipped} change${skipped === 1 ? ' was' : 's were'} left out by the user)` : ''}`);
  })
);

server.registerTool(
  'list_tags',
  {
    title: 'List tags',
    description: 'Every tag with how many active tasks and projects use it. Filter tasks by tag with list_tasks.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() => {
    const tags = store.listTags();
    if (!tags.length) return text('No tags yet.');
    return text(tags.map((g) => `- #${g.name} — ${g.tasks} task(s), ${g.projects} project(s)`).join('\n'));
  })
);

server.registerTool(
  'list_columns',
  {
    title: 'List columns',
    description: 'Columns of a project with ids, including hidden ones and which one counts as "done".',
    inputSchema: { project: projectRef.optional() },
    annotations: { readOnlyHint: true },
  },
  tool(({ project }) =>
    text(
      store
        .listColumns(store.resolveProject(project).id)
        .map((c) => `- ${c.name} (id ${c.id})${c.isDone ? ' [done]' : ''}${c.hidden ? ' [hidden]' : ''}`)
        .join('\n')
    )
  )
);

server.registerTool(
  'claim_task',
  {
    title: 'Mark a task as being worked on',
    description:
      'Show the user and other agents that you are working on a task. It never blocks anyone and needs no approval. ' +
      `It lasts ${store.CLAIM_MINUTES} minutes and renews whenever you change that task; it is released when the task is done or archived, when you call release_task, or when you disconnect.`,
    inputSchema: { id: taskId, note: z.string().max(200).optional().describe('What you are doing, e.g. "writing the API docs"') },
  },
  tool(({ id, note }) => {
    const r = store.claimTask(id, { agent: agentName(), session: SESSION, note });
    if (r.heldBy) return text(`${r.heldBy.agent} is already working on #${id}${r.heldBy.note ? ` (“${r.heldBy.note}”)` : ''}. Consider another task, or check with the user.`);
    return text(`You're marked as working on #${id} until ${new Date(r.claim.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} (renews as you work).`);
  })
);

server.registerTool(
  'release_task',
  {
    title: 'Stop working on a task',
    description: 'Remove your "working on it" marker from a task, e.g. when you stop without finishing.',
    inputSchema: { id: taskId },
  },
  tool(({ id }) => text(store.releaseClaim(id, { session: SESSION }).released ? `Released #${id}.` : `You weren't marked as working on #${id}.`))
);

await server.connect(new StdioServerTransport());
