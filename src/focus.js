import {
  createFocusSession,
  finishFocusSession,
  formatFocusDuration,
  pauseFocusSession,
  remainingSeconds,
  resumeFocusSession,
  settleExpiredSession,
  sevenDayFocusStats,
  shanghaiDateKey,
  taskFocusSeconds
} from "./focus-core.js";
import { createFocusCloudStore } from "./focus-cloud.js";

const DEFAULTS = { focusMinutes: 25, breakMinutes: 5, sound: true };

function readJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === "object" ? value : fallback;
  } catch { return fallback; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clock(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function shortDate(date) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function setupFocus({ mount, miniMount, db, cloudResult, getUid, getTasks, notify, onExpand, onHistoryChange }) {
  mount.innerHTML = `<header class="view-heading focus-page-heading"><div><p class="view-kicker">FOCUS / 专注</p><h1>把这一段时间，留给一件事。</h1><p>计时状态和记录会同步到当前登录账号。</p></div></header>
  <div class="focus-page-grid"><section class="focus-stage" aria-label="专注计时器"><div class="focus-home-status">
    <span id="focusStateLabel">FOCUS / 尚未开始</span>
    <strong id="focusClock">25:00</strong>
  </div>
  <div class="focus-actions focus-page-actions">
    <button class="button primary" id="focusStart" type="button">开始专注</button>
    <button class="button" id="focusPause" type="button" hidden>暂停</button>
    <button class="button" id="focusEnd" type="button" hidden>提前结束</button>
    <button class="button" id="breakStart" type="button" hidden>开始休息</button>
  </div>
  <p id="focusMessage" role="status" aria-live="polite"></p></section>
  <section class="focus-control-panel" aria-labelledby="focusControlTitle"><h2 id="focusControlTitle">本轮设置</h2><div class="focus-config">
    <label>专注分钟<input id="focusMinutes" type="number" min="1" max="180" step="1" inputmode="numeric"></label>
    <label>休息分钟<input id="breakMinutes" type="number" min="1" max="60" step="1" inputmode="numeric"></label>
  </div>
  <label class="settings-switch"><input id="focusSound" type="checkbox"><span>结束声音</span></label>
  <label class="focus-task-label" for="focusTask">关联任务（可选）</label>
  <select id="focusTask"><option value="">不关联任务</option></select>
  </section></div>
  <section class="focus-records" aria-labelledby="focusRecordsTitle"><div class="focus-records-heading"><div><p class="view-kicker">CLOUD HISTORY / 云端记录</p><h2 id="focusRecordsTitle">专注统计</h2></div><div class="focus-summary">
    <p><strong id="focusToday">0 分钟</strong><span>今日专注</span></p>
    <p><strong id="focusRounds">0</strong><span>完整轮数</span></p>
  </div></div>
  <div class="focus-seven" id="focusSeven" aria-label="最近七天专注时长"></div>
  <ol class="focus-history" id="focusHistory"></ol></section>`;

  const elements = Object.fromEntries([...mount.querySelectorAll("[id]")].map(node => [node.id, node]));
  let active = false;
  let store = { settings: { ...DEFAULTS }, sessions: [] };
  let timer = 0;
  let channel = null;
  let audioContext = null;
  let saving = false;
  let settling = false;
  const cloudStore = createFocusCloudStore({ db, cloudResult, getUid });

  const storageKey = () => `daily-todo.focus.v1:${getUid()}`;
  const settingsKey = () => `daily-todo.focus.settings.v2:${getUid()}`;
  const migrationKey = () => `daily-todo.focus.cloudMigrate.v1:${getUid()}`;
  const activeSession = () => store.sessions.find(session => ["running", "paused"].includes(session.status)) || null;

  function normalize(raw) {
    const settings = { ...DEFAULTS, ...(raw.settings || {}) };
    settings.focusMinutes = Number.isInteger(Number(settings.focusMinutes)) ? Math.min(180, Math.max(1, Number(settings.focusMinutes))) : 25;
    settings.breakMinutes = Number.isInteger(Number(settings.breakMinutes)) ? Math.min(60, Math.max(1, Number(settings.breakMinutes))) : 5;
    settings.sound = settings.sound !== false;
    const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(session => session?.id && session?.owner_id === getUid() && Array.isArray(session.segments)) : [];
    return { settings, sessions };
  }

  async function saveSession(next, previous = null) {
    if (saving) throw new Error("上一项专注更改仍在同步，请稍候。");
    saving = true;
    try {
      const saved = await cloudStore.persist(next, previous);
      store.sessions = store.sessions.map((session) => session.id === saved.id ? saved : session);
      writeJSON(settingsKey(), store.settings);
    } catch (error) {
      notify(`专注状态同步失败：${error?.message || "请检查网络后重试"}`, "error");
      throw error;
    } finally {
      saving = false;
    }
    channel?.postMessage({ type: "changed" });
    return store.sessions.find((session) => session.id === next.id);
  }

  async function load() {
    const local = normalize(readJSON(storageKey(), { settings: DEFAULTS, sessions: [] }));
    store.settings = { ...local.settings, ...readJSON(settingsKey(), {}) };
    store.sessions = await cloudStore.load();
    if (local.sessions.length && !readJSON(migrationKey(), null)?.done) {
      const preview = local.sessions.slice(0, 3).map(session => `${session.phase === "focus" ? "专注" : "休息"} ${new Date(session.started_at).toLocaleString("zh-CN")}`).join("；");
      const accepted = confirm(`发现本机 ${local.sessions.length} 条旧专注记录（${preview}${local.sessions.length > 3 ? "等" : ""}）。是否合并到当前账号云端？原本机记录会保留。`);
      if (accepted) {
        const localActive = local.sessions.find(session => ["running", "paused"].includes(session.status));
        const cloudActive = activeSession();
        let migrationItems = local.sessions;
        if (localActive && cloudActive && localActive.id !== cloudActive.id) {
          const chooseLocal = confirm("本机和云端各有一轮正在计时。确定：结束云端这轮并恢复本机这轮；取消：保留云端这轮，仅迁移本机已结束的记录。两种选择都会保留本机原始备份。");
          if (chooseLocal) {
            await saveSession(finishFocusSession(cloudActive, Date.now(), false), cloudActive);
          } else migrationItems = local.sessions.filter(session => session.id !== localActive.id);
        }
        const migrated = await cloudStore.migrateLocal(migrationItems);
        store.sessions = await cloudStore.load();
        if (migrationItems.length === local.sessions.length) writeJSON(migrationKey(), { done: true, migratedAt: new Date().toISOString() });
        notify(`已将 ${migrated} 条本机专注记录合并到云端；原始记录仍在当前浏览器。`, "success");
      }
    }
    const running = activeSession();
    if (running) {
      const settled = settleExpiredSession(running);
      if (settled.status !== running.status) {
        await saveSession(settled, running);
      }
    }
    writeJSON(settingsKey(), store.settings);
  }

  function taskForSelection() {
    const id = elements.focusTask.value;
    return getTasks().find(task => task.id === id) || null;
  }

  function refreshTasks() {
    const selected = elements.focusTask.value;
    elements.focusTask.replaceChildren(new Option("不关联任务", ""), ...getTasks().map(task => new Option(task.title, task.id)));
    if ([...elements.focusTask.options].some(option => option.value === selected)) elements.focusTask.value = selected;
  }

  function statusCopy(session) {
    if (!session) return "尚未开始";
    const phase = session.phase === "focus" ? "专注" : "休息";
    return session.status === "paused" ? `${phase}已暂停` : `${phase}中`;
  }

  function renderStats() {
    const stats = sevenDayFocusStats(store.sessions);
    const today = stats.at(-1);
    elements.focusToday.textContent = formatFocusDuration(today.seconds);
    elements.focusRounds.textContent = String(today.completedRounds);
    const max = Math.max(1, ...stats.map(day => day.seconds));
    elements.focusSeven.innerHTML = stats.map(day => `<div><span style="--focus-height:${Math.max(3, Math.round(day.seconds / max * 44))}px"></span><small>${shortDate(day.date)}</small><b>${day.seconds < 60 ? `${day.seconds}秒` : `${Math.floor(day.seconds / 60)}分`}</b></div>`).join("");
    const history = store.sessions.filter(session => session.phase === "focus" && ["completed", "ended"].includes(session.status)).slice(-20).reverse();
    elements.focusHistory.innerHTML = history.length ? history.map(session => `<li><span>${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(session.started_at))}</span><strong>${formatFocusDuration(session.elapsed_seconds)}</strong><small>${session.status === "completed" ? "完整" : "提前结束"}${session.task_title_snapshot ? ` · ${escapeHTML(session.task_title_snapshot)}` : ""}</small></li>`).join("") : `<li class="focus-history-empty">还没有专注记录。</li>`;
  }

  function renderMini(session) {
    if (!session) { miniMount.hidden = true; miniMount.replaceChildren(); return; }
    miniMount.hidden = false;
    miniMount.innerHTML = `<button type="button" class="focus-mini-expand"><span>${session.phase === "focus" ? "专注" : "休息"}${session.status === "paused" ? "已暂停" : "中"}</span><strong>${clock(remainingSeconds(session))}</strong></button><button type="button" class="focus-mini-toggle">${session.status === "paused" ? "继续" : "暂停"}</button>`;
    miniMount.querySelector(".focus-mini-expand").addEventListener("click", onExpand);
    miniMount.querySelector(".focus-mini-toggle").addEventListener("click", () => { void togglePause(); });
  }

  function render({ announce = "" } = {}) {
    const session = activeSession();
    elements.focusMinutes.value = store.settings.focusMinutes;
    elements.breakMinutes.value = store.settings.breakMinutes;
    elements.focusSound.checked = store.settings.sound;
    elements.focusStateLabel.textContent = session ? `${session.phase === "focus" ? "FOCUS" : "BREAK"} / ${statusCopy(session)}` : "FOCUS / 尚未开始";
    elements.focusClock.textContent = session ? clock(remainingSeconds(session)) : clock(store.settings.focusMinutes * 60);
    if (announce) elements.focusMessage.textContent = announce;
    elements.focusStart.hidden = Boolean(session);
    elements.focusPause.hidden = !session;
    elements.focusPause.textContent = session?.status === "paused" ? "继续" : "暂停";
    elements.focusEnd.hidden = !session;
    elements.focusEnd.textContent = session?.phase === "break" ? "结束休息" : "结束";
    elements.breakStart.hidden = Boolean(session) || !store.sessions.at(-1) || store.sessions.at(-1)?.phase !== "focus" || !["completed", "ended"].includes(store.sessions.at(-1)?.status);
    elements.focusMinutes.disabled = Boolean(session);
    elements.breakMinutes.disabled = Boolean(session);
    elements.focusTask.disabled = Boolean(session);
    renderMini(session);
    renderStats();
  }

  async function startPhase(phase) {
    if (!active || activeSession()) return;
    const minutes = phase === "focus" ? Number(elements.focusMinutes.value) : Number(elements.breakMinutes.value);
    const max = phase === "focus" ? 180 : 60;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > max) {
      elements.focusMessage.textContent = `${phase === "focus" ? "专注" : "休息"}时长需为 1—${max} 分钟的整数。`;
      return;
    }
    store.settings.focusMinutes = Number(elements.focusMinutes.value);
    store.settings.breakMinutes = Number(elements.breakMinutes.value);
    store.settings.sound = elements.focusSound.checked;
    const task = phase === "focus" ? taskForSelection() : null;
    const session = createFocusSession({ id: makeId(), ownerId: getUid(), phase, plannedSeconds: minutes * 60, task });
    store.sessions.push(session);
    try { await saveSession(session); }
    catch { store.sessions = store.sessions.filter((item) => item.id !== session.id); render(); return; }
    enableSound();
    render({ announce: phase === "focus" ? "专注开始。" : "休息开始。" });
  }

  async function replaceActive(next) {
    const previous = store.sessions.find((session) => session.id === next.id);
    await saveSession(next, previous);
  }

  async function togglePause() {
    const session = activeSession();
    if (!session) return;
    const next = session.status === "running" ? pauseFocusSession(session) : resumeFocusSession(session);
    try { await replaceActive(next); }
    catch { await load(); render(); return; }
    if (next.status === "completed") {
      render({ announce: session.phase === "focus" ? "本轮专注完成。" : "休息结束。" });
      playSound();
      onHistoryChange();
      return;
    }
    render({ announce: next.status === "paused" ? "计时已暂停。" : "计时已继续。" });
  }

  async function finish(completed = false) {
    const session = activeSession();
    if (!session) return;
    const next = finishFocusSession(session, Date.now(), completed);
    try { await replaceActive(next); }
    catch { await load(); render(); return; }
    const message = session.phase === "focus"
      ? `${next.status === "completed" ? "本轮专注完成" : "本轮已提前结束"}，记录 ${formatFocusDuration(next.elapsed_seconds)}。`
      : "休息结束，请在准备好后开始下一轮。";
    render({ announce: message });
    if (next.status === "completed") playSound();
    onHistoryChange();
  }

  function enableSound() {
    if (!store.settings.sound || audioContext) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) audioContext = new Context();
  }

  function playSound() {
    if (!store.settings.sound || !audioContext) return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.12, audioContext.currentTime + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .45);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(); oscillator.stop(audioContext.currentTime + .46);
    } catch { elements.focusMessage.textContent = "计时结束，但浏览器阻止了声音播放。"; }
  }

  async function tick() {
    if (!active) return;
    const session = activeSession();
    if (!session) return;
    const settled = settleExpiredSession(session);
    if (settled.status !== session.status) {
      if (settling) return;
      settling = true;
      try { await replaceActive(settled); }
      catch { await load(); render(); return; }
      finally { settling = false; }
      render({ announce: settled.phase === "focus" ? "本轮专注完成。" : "休息结束。" });
      playSound();
      onHistoryChange();
      return;
    }
    elements.focusClock.textContent = clock(remainingSeconds(session));
    const miniClock = miniMount.querySelector("strong");
    if (miniClock) miniClock.textContent = clock(remainingSeconds(session));
  }

  elements.focusStart.addEventListener("click", () => { void startPhase("focus"); });
  elements.breakStart.addEventListener("click", () => { void startPhase("break"); });
  elements.focusPause.addEventListener("click", () => { void togglePause(); });
  elements.focusEnd.addEventListener("click", () => { void finish(false); });
  elements.focusSound.addEventListener("change", () => { store.settings.sound = elements.focusSound.checked; if (store.settings.sound) enableSound(); writeJSON(settingsKey(), store.settings); });
  for (const input of [elements.focusMinutes, elements.breakMinutes]) input.addEventListener("change", () => {
    store.settings.focusMinutes = Number(elements.focusMinutes.value) || DEFAULTS.focusMinutes;
    store.settings.breakMinutes = Number(elements.breakMinutes.value) || DEFAULTS.breakMinutes;
    writeJSON(settingsKey(), store.settings); render();
  });
  timer = window.setInterval(() => { void tick(); }, 250);

  return {
    async setActive(value) {
      active = Boolean(value);
      channel?.close(); channel = null;
      if (!active) {
        miniMount.hidden = true;
        store = { settings: { ...DEFAULTS }, sessions: [] };
        render();
        return;
      }
      try { await load(); }
      catch (error) { notify(`专注记录读取失败：${error?.message || "请稍后重试"}`, "error"); store.sessions = []; }
      refreshTasks(); render();
      if ("BroadcastChannel" in window) {
        channel = new BroadcastChannel(`daily-todo-focus-${getUid()}`);
        channel.addEventListener("message", () => { void load().then(() => { render(); onHistoryChange(); }); });
      }
    },
    refreshTasks,
    selectTask(taskId) {
      refreshTasks();
      if ([...elements.focusTask.options].some(option => option.value === taskId)) elements.focusTask.value = taskId;
    },
    getTaskSeconds(taskId, date) { return taskFocusSeconds(store.sessions, taskId, date); },
    async pauseForLogout() {
      const session = activeSession();
      if (session?.status === "running") await replaceActive(pauseFocusSession(session));
    },
    reset() { void this.setActive(false); audioContext?.close?.(); audioContext = null; },
    destroy() { window.clearInterval(timer); channel?.close(); }
  };
}
