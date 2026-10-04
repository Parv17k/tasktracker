#!/usr/bin/env node
// MCP server (stdio) for the task tracker. Reads and writes the same SQLite
// database as the web app; open browser tabs update live via SSE.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as store from '../server/db.js';
import { dueInfo, formatDuration } from '../shared/due.js';

const server = new McpServer({ name: 'tasktracker', version: '1.0.0' });

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
  if (t.timerStartedAt) parts.push('⏱ running');
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
    `due: ${due ? `${t.dueAt} — ${due.label}` : 'none'}`,
    `time spent: ${formatDuration(t.timeSpent + running)}${t.timerStartedAt ? ' (timer running)' : ''}`,
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
const projectRef = z
  .union([z.string(), z.number()])
  .describe('Project name (fuzzy, e.g. "website") or id. Defaults to the first project on the home page.');
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const due = z.string().describe('Deadline as YYYY-MM-DD (whole day) or an ISO datetime, e.g. 2026-10-05T17:00');

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
    description:
      'Search/filter tasks across all projects, or one project. Use due_within_days or overdue to find deadlines (completed tasks are excluded from deadline filters).',
    inputSchema: {
      project: projectRef.optional().describe('Limit to one project (name or id). Omit to search every project.'),
      column: columnRef.optional().describe('Column name or id (needs project when using a name)'),
      query: z.string().optional().describe('Text to match in title, description, note or subtasks'),
      due_within_days: z.number().min(0).optional().describe('Only open tasks due within this many days (includes overdue)'),
      overdue: z.boolean().optional().describe('Only open tasks that are past their deadline'),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  tool(({ project, column, query, due_within_days, overdue, include_archived, limit }) => {
    const projectId = project != null ? store.resolveProject(project).id : undefined;
    const tasks = store.listTasks({
      projectId,
      columnId: column != null ? store.resolveColumn(column, projectId).id : undefined,
      query,
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
    },
  },
  tool(({ title, project, description, note, column, priority, due, subtasks }) => {
    const projectId = store.resolveProject(project).id;
    const t = store.createTask({
      projectId,
      title,
      description,
      note,
      priority,
      dueAt: due,
      subtasks,
      columnId: column != null ? store.resolveColumn(column, projectId).id : undefined,
    });
    return text(`Created in ${projectOf(t.columnId)?.name} / ${columnName(t.columnId)}:\n${taskDetail(t)}`);
  })
);

server.registerTool(
  'update_task',
  {
    title: 'Update task',
    description: 'Edit task fields. Only provided fields change. Pass due: "" to clear the deadline. To add to the note without overwriting, use append_note.',
    inputSchema: {
      id: taskId,
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      note: z.string().optional().describe('Replaces the whole note'),
      priority: priority.optional(),
      due: z.string().optional().describe('YYYY-MM-DD or ISO datetime; empty string clears it'),
    },
  },
  tool(({ id, due, ...rest }) => text(`Updated:\n${taskDetail(store.updateTask(id, { ...rest, ...(due !== undefined ? { dueAt: due } : {}) }))}`))
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
  tool(({ id, column, position }) => {
    const col = store.resolveColumn(column, store.getColumn(store.getTask(id).columnId).projectId);
    const t = store.moveTask(id, { columnId: col.id, index: position === 'top' ? 0 : undefined });
    return text(`Moved #${t.id} "${t.title}" to ${col.name}.`);
  })
);

server.registerTool(
  'complete_task',
  {
    title: 'Complete task',
    description: 'Mark a task done by moving it to the done column. Optionally record a completion note.',
    inputSchema: { id: taskId, note: z.string().optional().describe('Appended to the task note, e.g. a summary of what was done') },
  },
  tool(({ id, note }) => {
    if (note) store.appendNote(id, note);
    const t = store.completeTask(id);
    return text(`Completed #${t.id} "${t.title}" → ${columnName(t.columnId)}.`);
  })
);

server.registerTool(
  'archive_task',
  {
    title: 'Archive or restore task',
    description: 'Archive a task (hides it from the board, recoverable) or restore it with archived: false.',
    inputSchema: { id: taskId, archived: z.boolean().default(true) },
  },
  tool(({ id, archived }) => {
    const t = store.archiveTask(id, archived);
    return text(`${archived ? 'Archived' : 'Restored'} #${t.id} "${t.title}".`);
  })
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
    const t = store.appendNote(id, `[${stamp}] ${line}`);
    return text(`Note on #${t.id} is now:\n${t.note}`);
  })
);

server.registerTool(
  'add_subtasks',
  {
    title: 'Add subtasks',
    description: 'Add one or more checklist subtasks to a task.',
    inputSchema: { task_id: taskId, titles: z.array(z.string().min(1)).min(1) },
  },
  tool(({ task_id, titles }) => {
    for (const title of titles) store.addSubtask(task_id, title);
    return text(taskDetail(store.getTask(task_id)));
  })
);

server.registerTool(
  'update_subtask',
  {
    title: 'Update subtask',
    description: 'Check/uncheck or rename a subtask. Subtask ids are shown in get_task as (id).',
    inputSchema: { id: z.coerce.number().int().positive(), done: z.boolean().optional(), title: z.string().min(1).optional() },
  },
  tool(({ id, done, title }) => {
    const s = store.updateSubtask(id, { done, title });
    return text(`[${s.done ? 'x' : ' '}] (${s.id}) ${s.title} — on task #${s.taskId}`);
  })
);

server.registerTool(
  'delete_subtask',
  {
    title: 'Delete subtask',
    description: 'Remove a subtask from its task.',
    inputSchema: { id: z.coerce.number().int().positive() },
    annotations: { destructiveHint: true },
  },
  tool(({ id }) => {
    const r = store.deleteSubtask(id);
    return text(`Deleted subtask ${r.deleted} from task #${r.taskId}.`);
  })
);

server.registerTool(
  'track_time',
  {
    title: 'Start/stop time tracking',
    description: 'Start or stop the time-spent timer on a task. Moving a task to the done column stops it automatically.',
    inputSchema: { id: taskId, action: z.enum(['start', 'stop']) },
  },
  tool(({ id, action }) => {
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
          const cols = s.columns.filter((c) => !c.hidden).map((c) => `${c.name} ${c.count}`).join(' · ');
          const flags = [s.overdue && `${s.overdue} overdue`, s.dueWeek && `${s.dueWeek} due this week`].filter(Boolean).join(', ');
          return `${p.icon} ${p.name} (id ${p.id})${i === 0 && !p.archived ? ' [default]' : ''}${p.archived ? ' [archived]' : ''} — ${s.total} task(s): ${cols}${flags ? ` — ${flags}` : ''}`;
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
    },
  },
  tool(({ name, icon, description }) => {
    const p = store.createProject({ name, icon, description });
    return text(`Created project ${p.icon} ${p.name} (id ${p.id}).`);
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

await server.connect(new StdioServerTransport());
