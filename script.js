/* =============================================
   CoLab — Collaborative Workspace
   script.js — Full collaboration logic
   ============================================= */

// ─────────────────────────────────────────────
// CONSTANTS & UTILS
// ─────────────────────────────────────────────
const STORAGE_KEY    = "collabData_v2";
const HEARTBEAT_MS   = 4000;
const USER_TIMEOUT   = 12000; // clean up users inactive > 12s
const TYPING_FADE_MS = 1500;
const HIGHLIGHT_MS   = 2200;

const NAMES = ["Alex","Blake","Casey","Dana","Eden","Finn","Gray","Haven","Iris","Jordan"];
const COLORS = ["av-0","av-1","av-2","av-3","av-4","av-5","av-6","av-7"];

let myUserId  = "";
let myName    = "";
let myColor   = "";

let typingTimer        = null;
let typingBarTimer     = null;
let heartbeatInterval  = null;
let editorPendingValue = null; // for conflict detection
let isHandlingStorage  = false;

// ─────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────
function defaultData() {
  return {
    document:    "",
    todos:       [],
    notes:       [],
    users:       {},
    activityLog: []
  };
}

function readData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : defaultData();
  } catch (e) {
    return defaultData();
  }
}

function writeData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function nowTime() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function addLog(data, user, action) {
  if (!data.activityLog) data.activityLog = [];
  data.activityLog.unshift({ user, action, timestamp: nowTime() });
  if (data.activityLog.length > 60) data.activityLog.length = 60;
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
function init() {
  // Generate persistent user identity for this tab session
  myUserId = sessionStorage.getItem("myUserId") || uid();
  sessionStorage.setItem("myUserId", myUserId);

  const nameIdx  = parseInt(myUserId, 36) % NAMES.length;
  myName  = NAMES[nameIdx];
  myColor = COLORS[parseInt(myUserId, 36) % COLORS.length];

  // Register user
  const data = readData();
  if (!data.users) data.users = {};
  data.users[myUserId] = { name: myName, color: myColor, lastActive: Date.now() };
  writeData(data);

  // Render UI from storage
  renderAll(data);
  renderPresence(data);
  renderActivityLog(data);

  // Apply theme
  const savedTheme = localStorage.getItem("colabTheme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);
  updateThemeIcon(savedTheme);

  // Show own user badge
  document.getElementById("userLabel").textContent = myName;

  // Setup event listeners
  setupEditor();
  setupTodos();
  setupNotes();
  setupTabs();
  setupThemeToggle();
  setupClearLog();

  // Listen for cross-tab changes
  window.addEventListener("storage", handleStorageChange);

  // Heartbeat to stay "online"
  heartbeatInterval = setInterval(heartbeat, HEARTBEAT_MS);

  // Cleanup on tab close
  window.addEventListener("beforeunload", cleanup);

  setSyncStatus("synced");
}

// ─────────────────────────────────────────────
// HEARTBEAT & PRESENCE
// ─────────────────────────────────────────────
function heartbeat() {
  const data = readData();
  if (!data.users) data.users = {};
  if (data.users[myUserId]) {
    data.users[myUserId].lastActive = Date.now();
  } else {
    data.users[myUserId] = { name: myName, color: myColor, lastActive: Date.now() };
  }
  // Clean stale users
  const now = Date.now();
  for (const id in data.users) {
    if (id !== myUserId && (now - (data.users[id].lastActive || 0)) > USER_TIMEOUT) {
      delete data.users[id];
    }
  }
  writeData(data);
  renderPresence(data);
}

function cleanup() {
  clearInterval(heartbeatInterval);
  const data = readData();
  if (data.users) delete data.users[myUserId];
  writeData(data);
}

function renderPresence(data) {
  const users  = data.users || {};
  const ids    = Object.keys(users);
  const count  = ids.length;
  document.getElementById("onlineCount").textContent =
    `${count} user${count !== 1 ? "s" : ""} online`;

  const avatarRow = document.getElementById("avatarRow");
  avatarRow.innerHTML = "";
  ids.slice(0, 6).forEach(id => {
    const u   = users[id];
    const chip = document.createElement("div");
    chip.className = "avatar-chip " + (u.color || "av-0");
    chip.textContent = (u.name || "?")[0];
    chip.title = u.name + (id === myUserId ? " (you)" : "");
    avatarRow.appendChild(chip);
  });
}

// ─────────────────────────────────────────────
// STORAGE LISTENER (cross-tab sync)
// ─────────────────────────────────────────────
function handleStorageChange(event) {
  if (event.storageArea !== localStorage) return;
  if (event.key !== STORAGE_KEY) return;

  setSyncStatus("updating");
  isHandlingStorage = true;

  let newData;
  try {
    newData = event.newValue ? JSON.parse(event.newValue) : defaultData();
  } catch (e) {
    setSyncStatus("synced");
    isHandlingStorage = false;
    return;
  }

  // Find what changed (section-level diffing)
  let oldData;
  try { oldData = event.oldValue ? JSON.parse(event.oldValue) : defaultData(); }
  catch (e) { oldData = defaultData(); }

  const docChanged   = newData.document !== oldData.document;
  const todosChanged = JSON.stringify(newData.todos) !== JSON.stringify(oldData.todos);
  const notesChanged = JSON.stringify(newData.notes) !== JSON.stringify(oldData.notes);
  const usersChanged = JSON.stringify(newData.users) !== JSON.stringify(oldData.users);

  // Detect who changed
  const changer = findChanger(newData, oldData);

  if (docChanged)   {
    handleEditorSync(newData, changer);
    showTypingBar(changer);
  }
  if (todosChanged) renderTodoList(newData, true);
  if (notesChanged) renderNotesList(newData, true);
  if (usersChanged) renderPresence(newData);

  renderActivityLog(newData);

  if (changer && (docChanged || todosChanged || notesChanged)) {
    const action = docChanged ? "edited the document" :
                   todosChanged ? "updated the to-do list" : "updated notes";
    pushNotification(changer.name, action);
    showTypingBar(changer, `${changer.name} ${action}`);
  }

  setSyncStatus("synced");
  isHandlingStorage = false;
}

function findChanger(newData, oldData) {
  // Check activity log for most recent entry
  const log = newData.activityLog || [];
  if (log.length > 0) {
    const recent = log[0];
    // Find user from users object
    const users = newData.users || {};
    for (const id in users) {
      if (users[id].name === recent.user && id !== myUserId) {
        return users[id];
      }
    }
    // Return user by name if found
    if (recent.user !== myName) {
      return { name: recent.user };
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// RENDER ALL (initial load & full refresh)
// ─────────────────────────────────────────────
function renderAll(data) {
  renderEditorContent(data);
  renderTodoList(data, false);
  renderNotesList(data, false);
}

// ─────────────────────────────────────────────
// EDITOR
// ─────────────────────────────────────────────
function setupEditor() {
  const ta = document.getElementById("sharedEditor");

  ta.addEventListener("input", () => {
    // Save cursor position
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;

    const data = readData();

    // Conflict detection: if data changed by someone else since last read
    if (editorPendingValue !== null && data.document !== editorPendingValue) {
      showEditorConflict(data.document, ta.value);
      return;
    }

    data.document = ta.value;
    addLog(data, myName, "edited document");
    writeData(data);

    editorPendingValue = ta.value;

    // Typing indicator (local)
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      editorPendingValue = null;
    }, 800);

    setSyncStatus("synced");

    // Restore cursor after programmatic changes
    ta.setSelectionRange(start, end);
  });

  document.getElementById("editorOverwrite").addEventListener("click", () => {
    const ta = document.getElementById("sharedEditor");
    const data = readData();
    data.document = ta.value;
    addLog(data, myName, "overwrote conflict in document");
    writeData(data);
    hideEditorConflict();
    setSyncStatus("synced");
    showToast("✅", "Your version kept");
  });

  document.getElementById("editorMerge").addEventListener("click", () => {
    const ta = document.getElementById("sharedEditor");
    const data = readData();
    // Simple merge: append other version below separator
    const merged = ta.value + "\n\n--- Merged version ---\n\n" + data.document;
    ta.value = merged;
    data.document = merged;
    addLog(data, myName, "merged conflict in document");
    writeData(data);
    hideEditorConflict();
    setSyncStatus("synced");
    showToast("🔀", "Versions merged");
  });
}

function renderEditorContent(data) {
  const ta = document.getElementById("sharedEditor");
  if (document.activeElement !== ta) {
    ta.value = data.document || "";
  }
}

function handleEditorSync(newData, changer) {
  const ta = document.getElementById("sharedEditor");
  if (document.activeElement === ta) {
    // User is actively typing — show conflict if content differs
    if (ta.value !== newData.document && ta.value.trim() !== "") {
      showEditorConflict(newData.document, ta.value);
      return;
    }
  }
  // Safe to update
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  ta.value = newData.document || "";
  ta.setSelectionRange(start, end);
  highlightEl(document.getElementById("editorWrap"));
}

function showEditorConflict(remoteText, localText) {
  document.getElementById("editorConflict").classList.remove("hidden");
}
function hideEditorConflict() {
  document.getElementById("editorConflict").classList.add("hidden");
}

// ─────────────────────────────────────────────
// TODOS
// ─────────────────────────────────────────────
function setupTodos() {
  document.getElementById("addTodoBtn").addEventListener("click", addTodo);
  document.getElementById("todoInput").addEventListener("keydown", e => {
    if (e.key === "Enter") addTodo();
  });
}

function addTodo() {
  const input = document.getElementById("todoInput");
  const text  = input.value.trim();
  if (!text) return;

  const data = readData();
  const newTodo = { id: uid(), text, completed: false };
  data.todos.push(newTodo);
  addLog(data, myName, `added todo: "${text}"`);
  writeData(data);

  input.value = "";
  renderTodoList(data, false);
  setSyncStatus("synced");
  showToast("☑", `Added: "${text}"`);
}

function toggleTodo(id) {
  const data = readData();
  const todo = data.todos.find(t => t.id === id);
  if (!todo) return;
  todo.completed = !todo.completed;
  addLog(data, myName, `${todo.completed ? "completed" : "uncompleted"} task: "${todo.text}"`);
  writeData(data);
  renderTodoList(data, false);
  setSyncStatus("synced");
}

function deleteTodo(id) {
  const data = readData();
  const todo = data.todos.find(t => t.id === id);
  const text = todo ? todo.text : "";
  data.todos = data.todos.filter(t => t.id !== id);
  addLog(data, myName, `deleted todo: "${text}"`);
  writeData(data);
  renderTodoList(data, false);
  setSyncStatus("synced");
  showToast("🗑", `Deleted task`);
}

function renderTodoList(data, highlight) {
  const list  = document.getElementById("todoList");
  const todos = data.todos || [];

  document.getElementById("todoMeta").textContent =
    `${todos.length} task${todos.length !== 1 ? "s" : ""}`;

  list.innerHTML = "";
  if (todos.length === 0) {
    list.innerHTML = '<li class="log-empty">No tasks yet. Add one above.</li>';
    return;
  }
  todos.forEach(todo => {
    const li = document.createElement("li");
    li.className = "todo-item" + (todo.completed ? " completed" : "");
    if (highlight) li.classList.add("highlight-change");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = todo.completed;
    cb.addEventListener("change", () => toggleTodo(todo.id));

    const span = document.createElement("span");
    span.className = "todo-text";
    span.textContent = todo.text;

    const del = document.createElement("button");
    del.className = "todo-delete";
    del.textContent = "✕";
    del.addEventListener("click", () => deleteTodo(todo.id));

    li.append(cb, span, del);
    list.appendChild(li);
  });
}

// ─────────────────────────────────────────────
// NOTES
// ─────────────────────────────────────────────
function setupNotes() {
  document.getElementById("addNoteBtn").addEventListener("click", addNote);
  document.getElementById("noteTitle").addEventListener("keydown", e => {
    if (e.key === "Enter") addNote();
  });
}

function addNote() {
  const titleInput = document.getElementById("noteTitle");
  const title = titleInput.value.trim() || "Untitled Note";

  const data = readData();
  const newNote = { id: uid(), title, content: "" };
  data.notes.push(newNote);
  addLog(data, myName, `added note: "${title}"`);
  writeData(data);

  titleInput.value = "";
  renderNotesList(data, false);
  setSyncStatus("synced");
  showToast("◈", `Note added: "${title}"`);
}

function saveNote(id) {
  const card = document.querySelector(`.note-card[data-id="${id}"]`);
  if (!card) return;
  const title   = card.querySelector(".note-title").value;
  const content = card.querySelector(".note-content").value;

  const data = readData();
  const note = data.notes.find(n => n.id === id);
  if (!note) return;
  note.title   = title;
  note.content = content;
  addLog(data, myName, `edited note: "${title}"`);
  writeData(data);
  setSyncStatus("synced");
  highlightEl(card);
  showToast("💾", `Note saved: "${title}"`);
}

function deleteNote(id) {
  const data = readData();
  const note = data.notes.find(n => n.id === id);
  const title = note ? note.title : "";
  data.notes = data.notes.filter(n => n.id !== id);
  addLog(data, myName, `deleted note: "${title}"`);
  writeData(data);
  renderNotesList(data, false);
  setSyncStatus("synced");
  showToast("🗑", `Deleted note`);
}

function renderNotesList(data, highlight) {
  const grid  = document.getElementById("notesList");
  const notes = data.notes || [];

  document.getElementById("notesMeta").textContent =
    `${notes.length} note${notes.length !== 1 ? "s" : ""}`;

  grid.innerHTML = "";
  if (notes.length === 0) {
    grid.innerHTML = '<p class="log-empty">No notes yet. Add one above.</p>';
    return;
  }
  notes.forEach(note => {
    const card = document.createElement("div");
    card.className = "note-card" + (highlight ? " highlight-change" : "");
    card.dataset.id = note.id;

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "note-title";
    titleInput.value = note.title || "";
    titleInput.placeholder = "Title…";

    const contentArea = document.createElement("textarea");
    contentArea.className = "note-content";
    contentArea.value = note.content || "";
    contentArea.placeholder = "Write something…";
    contentArea.rows = 4;

    const footer = document.createElement("div");
    footer.className = "note-footer";

    const saveBtn = document.createElement("button");
    saveBtn.className = "note-save";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => saveNote(note.id));

    const delBtn = document.createElement("button");
    delBtn.className = "note-delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteNote(note.id));

    footer.append(saveBtn, delBtn);
    card.append(titleInput, contentArea, footer);
    grid.appendChild(card);
  });
}

// ─────────────────────────────────────────────
// ACTIVITY LOG
// ─────────────────────────────────────────────
function renderActivityLog(data) {
  const ul  = document.getElementById("activityLog");
  const log = data.activityLog || [];

  if (log.length === 0) {
    ul.innerHTML = '<li class="log-empty">No activity yet</li>';
    return;
  }
  ul.innerHTML = "";
  log.slice(0, 30).forEach(entry => {
    const li = document.createElement("li");
    li.className = "log-item";
    li.innerHTML = `
      <span class="log-who">${escHtml(entry.user)}</span>
      <span class="log-what">${escHtml(entry.action)}</span>
      <span class="log-when">${escHtml(entry.timestamp)}</span>
    `;
    ul.appendChild(li);
  });
}

function setupClearLog() {
  document.getElementById("clearLogBtn").addEventListener("click", () => {
    const data = readData();
    data.activityLog = [];
    writeData(data);
    renderActivityLog(data);
  });
}

// ─────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────
function pushNotification(userName, action) {
  const area = document.getElementById("notificationsArea");

  // Remove placeholder
  const placeholder = area.querySelector(".log-empty");
  if (placeholder) placeholder.remove();

  const item = document.createElement("div");
  item.className = "notif-item";
  item.innerHTML = `<span class="notif-user">${escHtml(userName)}</span> ${escHtml(action)}`;
  area.insertBefore(item, area.firstChild);

  // Keep max 10
  while (area.children.length > 10) area.removeChild(area.lastChild);
}

// ─────────────────────────────────────────────
// TOASTS
// ─────────────────────────────────────────────
function showToast(icon, message) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ─────────────────────────────────────────────
// TYPING INDICATOR BAR
// ─────────────────────────────────────────────
function showTypingBar(user, text) {
  const bar = document.getElementById("typingBar");
  const label = document.getElementById("typingText");
  const msg = text || (user ? `${user.name} is editing…` : "");
  if (!msg) return;
  label.textContent = msg;
  bar.classList.add("visible");

  clearTimeout(typingBarTimer);
  typingBarTimer = setTimeout(() => {
    bar.classList.remove("visible");
  }, TYPING_FADE_MS);
}

// ─────────────────────────────────────────────
// SYNC STATUS
// ─────────────────────────────────────────────
function setSyncStatus(status) {
  const dot   = document.querySelector(".sync-dot");
  const label = document.getElementById("syncLabel");
  if (status === "synced") {
    dot.className = "sync-dot synced";
    label.textContent = "Synced";
  } else {
    dot.className = "sync-dot updating";
    label.textContent = "Updating…";
  }
}

// ─────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.getElementById("tab-" + btn.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });
}

// ─────────────────────────────────────────────
// THEME TOGGLE
// ─────────────────────────────────────────────
function setupThemeToggle() {
  document.getElementById("themeToggle").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next    = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("colabTheme", next);
    updateThemeIcon(next);
  });
}

function updateThemeIcon(theme) {
  document.getElementById("themeIcon").textContent = theme === "dark" ? "☀" : "☾";
}

// ─────────────────────────────────────────────
// HIGHLIGHT ELEMENT
// ─────────────────────────────────────────────
function highlightEl(el) {
  if (!el) return;
  el.classList.remove("highlight-change");
  void el.offsetWidth; // force reflow
  el.classList.add("highlight-change");
  setTimeout(() => el.classList.remove("highlight-change"), HIGHLIGHT_MS);
}

// ─────────────────────────────────────────────
// HTML ESCAPE
// ─────────────────────────────────────────────
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
