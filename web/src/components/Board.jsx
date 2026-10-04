import { useMemo, useState } from 'react';
import { closestCenter, closestCorners, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { dueInfo } from '../../../shared/due.js';
import { tasksForColumn, useBoard } from '../store';
import { AddColumn, Column, ColumnOverlay } from './Column';
import { TaskCardOverlay } from './TaskCard';
import { RemoveColumnDialog } from './RemoveColumnDialog';

const colKey = (id) => `col-${id}`;

const PRIORITY_WORDS = { low: 'low priority', medium: 'medium priority', high: 'high priority', urgent: 'urgent priority' };

/** Every piece of information on a task, as one searchable string. */
function searchText(task, column) {
  const due = dueInfo(task.dueAt, task.dueHasTime);
  return [
    `#${task.id}`,
    task.title,
    task.description,
    task.note,
    ...task.subtasks.map((s) => s.title),
    column?.name,
    PRIORITY_WORDS[task.priority],
    due && `${due.label} ${due.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`,
    task.timerStartedAt && 'tracking timer running',
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/** All words must appear somewhere on the task, in any field and any order. */
function matches(task, column, query) {
  if (!query.trim()) return true;
  const text = searchText(task, column);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

function dueMatches(task, filter, isDoneCol) {
  if (filter === 'all') return true;
  if (isDoneCol) return false;
  const info = dueInfo(task.dueAt, task.dueHasTime);
  if (!info) return false;
  return filter === 'overdue' ? info.tone === 'overdue' : info.days <= 7;
}

const isColumnSort = (c) => c.data?.current?.type === 'column-sort';

/**
 * Columns being reordered snap to the nearest column. Cards prefer the card under the pointer,
 * then the column body, then the nearest corners.
 */
function collision(args) {
  if (args.active.data.current?.type === 'column-sort') {
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(isColumnSort) });
  }
  args = { ...args, droppableContainers: args.droppableContainers.filter((c) => !isColumnSort(c)) };
  const hits = pointerWithin(args);
  const cards = hits.filter((h) => typeof h.id === 'number');
  if (cards.length) return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => cards.some((h) => h.id === c.id)) });
  if (hits.length) return hits;
  return closestCorners(args);
}

export function Board() {
  const columns = useBoard((s) => s.columns);
  const tasks = useBoard((s) => s.tasks);
  const query = useBoard((s) => s.query);
  const dueFilter = useBoard((s) => s.dueFilter);
  const { moveTask, setDragging, reorderColumn } = useBoard.getState();
  const [activeColumnId, setActiveColumnId] = useState(null);

  const visible = useMemo(() => columns.filter((c) => !c.hidden), [columns]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const filtered = !!query || dueFilter !== 'all';

  // column key -> ordered task ids, honouring the active filters
  const derived = useMemo(() => {
    const out = {};
    for (const c of visible) out[colKey(c.id)] = tasksForColumn(tasks, c.id).filter((t) => matches(t, c, query) && dueMatches(t, dueFilter, c.isDone)).map((t) => t.id);
    return out;
  }, [visible, tasks, query, dueFilter]);

  // while dragging we work on a local copy so cards can hop between columns smoothly
  const [dragItems, setDragItems] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [removing, setRemoving] = useState(null);
  const items = dragItems || derived;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const findContainer = (id) => (id in items ? id : Object.keys(items).find((k) => items[k].includes(id)));

  function onDragStart({ active }) {
    if (active.data.current?.type === 'column-sort') return setActiveColumnId(active.data.current.columnId);
    setDragging(true);
    setActiveId(active.id);
    setDragItems(derived);
  }

  function onDragOver({ active, over }) {
    if (!over || active.data.current?.type === 'column-sort') return;
    const from = findContainer(active.id);
    const to = findContainer(over.id);
    if (!from || !to || from === to) return;
    setDragItems((prev) => {
      const src = prev[from].filter((id) => id !== active.id);
      const dst = [...prev[to]];
      const overIndex = dst.indexOf(over.id);
      const below = over.rect && active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
      const index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : dst.length;
      dst.splice(index, 0, active.id);
      return { ...prev, [from]: src, [to]: dst };
    });
  }

  function finish() {
    setActiveColumnId(null);
    setDragItems(null);
    setActiveId(null);
    setDragging(false);
  }

  function onDragEnd({ active, over }) {
    if (active.data.current?.type === 'column-sort') {
      const overId = over?.data.current?.columnId;
      finish();
      if (overId != null && overId !== active.data.current.columnId) reorderColumn(active.data.current.columnId, overId);
      return;
    }
    const container = over && findContainer(over.id);
    if (!container) return finish();
    let list = items[container];
    const oldIndex = list.indexOf(active.id);
    const overIndex = list.indexOf(over.id);
    if (overIndex >= 0 && oldIndex !== overIndex) list = arrayMove(list, oldIndex, overIndex);

    const columnId = Number(container.slice(4));
    const task = tasksById.get(active.id);
    // translate the (possibly filtered) visual index into an index among *all* tasks in the column
    const pos = list.indexOf(active.id);
    const nextId = list[pos + 1];
    const all = tasksForColumn(tasks, columnId).filter((t) => t.id !== active.id);
    const index = nextId != null ? all.findIndex((t) => t.id === nextId) : list[pos - 1] != null ? all.findIndex((t) => t.id === list[pos - 1]) + 1 : 0;

    const currentIndex = tasksForColumn(tasks, task.columnId).findIndex((t) => t.id === task.id);
    finish();
    if (task.columnId !== columnId || currentIndex !== index) moveTask(active.id, columnId, index);
  }

  const activeTask = activeId != null ? tasksById.get(activeId) : null;

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={finish}>
        <div className="flex h-full items-start gap-3 overflow-x-auto px-6 pb-6 pt-1">
          <SortableContext items={visible.map((c) => `colsort-${c.id}`)} strategy={horizontalListSortingStrategy}>
          {visible.map((c, i) => (
            <Column
              key={c.id}
              column={c}
              taskIds={items[colKey(c.id)] || []}
              tasksById={tasksById}
              totalCount={tasks.filter((t) => t.columnId === c.id).length}
              filtered={filtered}
              isFirst={i === 0}
              isLast={i === visible.length - 1}
              onRemove={() => setRemoving(c)}
            />
          ))}
          </SortableContext>
          <AddColumn />
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }}>
          {activeColumnId != null && (
            <ColumnOverlay column={columns.find((c) => c.id === activeColumnId)} tasks={tasksForColumn(tasks, activeColumnId)} />
          )}
          {activeTask && <TaskCardOverlay task={activeTask} isDone={visible.find((c) => c.id === activeTask.columnId)?.isDone} />}
        </DragOverlay>
      </DndContext>
      <RemoveColumnDialog column={removing} onClose={() => setRemoving(null)} />
    </>
  );
}
