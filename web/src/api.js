export const CLIENT_ID = Math.random().toString(36).slice(2);

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-client-id': CLIENT_ID, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  home: () => request('GET', '/api/home'),
  board: (projectId) => request('GET', `/api/projects/${projectId}/board`),
  archived: (projectId) => request('GET', `/api/tasks?archived=true&limit=500&project=${projectId}`),

  createProject: (body) => request('POST', '/api/projects', body),
  updateProject: (id, patch) => request('PATCH', `/api/projects/${id}`, patch),
  moveProject: (id, index) => request('POST', `/api/projects/${id}/move`, { index }),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),

  createTask: (body) => request('POST', '/api/tasks', body),
  updateTask: (id, patch) => request('PATCH', `/api/tasks/${id}`, patch),
  moveTask: (id, columnId, index) => request('POST', `/api/tasks/${id}/move`, { columnId, index }),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  startTimer: (id) => request('POST', `/api/tasks/${id}/timer/start`),
  stopTimer: (id) => request('POST', `/api/tasks/${id}/timer/stop`),

  addSubtask: (taskId, title) => request('POST', `/api/tasks/${taskId}/subtasks`, { title }),
  updateSubtask: (id, patch) => request('PATCH', `/api/subtasks/${id}`, patch),
  deleteSubtask: (id) => request('DELETE', `/api/subtasks/${id}`),

  createColumn: (body) => request('POST', '/api/columns', body),
  updateColumn: (id, patch) => request('PATCH', `/api/columns/${id}`, patch),
  moveColumn: (id, index) => request('POST', `/api/columns/${id}/move`, { index }),
  deleteColumn: (id, moveTo) => request('DELETE', `/api/columns/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`),
};

/** Subscribe to server-sent change events. Calls `onChange` for changes made elsewhere. */
export function subscribe(onChange) {
  const es = new EventSource('/api/events');
  es.addEventListener('change', (e) => {
    const { origin } = JSON.parse(e.data || '{}');
    if (origin !== CLIENT_ID) onChange();
  });
  // after a reconnect we may have missed events
  es.addEventListener('open', () => onChange());
  return () => es.close();
}
