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

export function setupFocus({ mount, detailsMount, miniMount, getUid, getTasks, notify, onExpand, onHistoryChange }) {
  mount.innerHTML = `<div class="focus-home-status">
    <span id="focusStateLabel">FOCUS / 尚未开始</span>
    <strong id="focusClock">25:00</strong>
  </div>
  <div class="focus-actions focus-home-actions">
    <button class="button primary" id="focusStart" type="button">开始</button>
    <button class="button" id="focusPause" type="button" hidden>暂停</button>
    <button class="button" id="focusEnd" type="button" hidden>结束</button>
    <button class="button" id="breakStart" type="button" hidden>休息</button>
  </div>
  <p id="focusMessage" role="status" aria-live="polite"></p>`;
  detailsMount.innerHTML = `<div class="focus-config">
    <label>专注分钟<input id="focusMinutes" type="number" min="1" max="180" step="1" inputmode="numeric"></label>
    <label>休息分钟<input id="breakMinutes" type="number" min="1" max="60" step="1" inputmode="numeric"></label>
  </div>
  <label class="settings-switch"><input id="focusSound" type="checkbox"><span>结束声音</span></label>
  <label class="focus-task-label" for="focusTask">关联任务（可选）</label>
  <select id="focusTask"><option value="">不关联任务</option></select>
  <div class="focus-summary">
    <p><strong id="focusToday">0 分钟</strong><span>今日专注</span></p>
    <p><strong id="focusRounds">0</strong><span>完整轮数</span></p>
  </div>
  <div class="focus-seven" id="focusSeven" aria-label="最近七天专注时长"></div>
  <ol class="focus-history" id="focusHistory"></ol>`;

  const elements = Object.fromEntries([...mount.querySelectorAll("[id]"), ...detailsMount.querySelectorAll("[id]")].map(node => [node.id, node]));
  let active = false;
  let store = { settings: { ...DEFAULTS }, sessions: [] };
  let timer = 0;
  let channel = null;
  let audioContext = null;

  const storageKey = () => `daily-todo.focus.v1:${getUid()}`;
  const activeSession = () => store.sessions.find(session => ["running", "paused"].includes(session.status)) || null;

  function normalize(raw) {
    const settings = { ...DEFAULTS, ...(raw.settings || {}) };
    settings.focusMinutes = Number.isInteger(Number(settings.focusMinutes)) ? Math.min(180, Math.max(1, Number(settings.focusMinutes))) : 25;
    settings.breakMinutes = Number.isInteger(Number(settings.breakMinutes)) ? Math.min(60, Math.max(1, Number(settings.breakMinutes))) : 5;
    settings.sound = settings.sound !== false;
    const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(session => session?.id && session?.owner_id === getUid() && Array.isArray(session.segments)) : [];
    return { settings, sessions };
  }

  function save() {
    if (!writeJSON(storageKey(), store)) {
      notify("专注状态未能写入本机存储，请勿关闭页面。", "error");
      return false;
    }
    channel?.postMessage({ type: "changed" });
    return true;
  }

  function load() {
    store = normalize(readJSON(storageKey(), { settings: DEFAULTS, sessions: [] }));
    const running = activeSession();
    if (running) {
      const settled = settleExpiredSession(running);
      if (settled.status !== running.status) {
        store.sessions = store.sessions.map(session => session.id === settled.id ? settled : session);
        save();
      }
    }
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
    const history = store.sessions.filter(session => session.phase === "focus" && ["completed", "ended"].includes(session.status)).slice(-7).reverse();
    elements.focusHistory.innerHTML = history.length ? history.map(session => `<li><span>${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(session.started_at))}</span><strong>${formatFocusDuration(session.elapsed_seconds)}</strong><small>${session.status === "completed" ? "完整" : "提前结束"}${session.task_title_snapshot ? ` · ${session.task_title_snapshot}` : ""}</small></li>`).join("") : `<li class="focus-history-empty">还没有专注记录。</li>`;
  }

  function renderMini(session) {
    if (!session) { miniMount.hidden = true; miniMount.replaceChildren(); return; }
    miniMount.hidden = false;
    miniMount.innerHTML = `<button type="button" class="focus-mini-expand"><span>${session.phase === "focus" ? "专注" : "休息"}${session.status === "paused" ? "已暂停" : "中"}</span><strong>${clock(remainingSeconds(session))}</strong></button><button type="button" class="focus-mini-toggle">${session.status === "paused" ? "继续" : "暂停"}</button>`;
    miniMount.querySelector(".focus-mini-expand").addEventListener("click", onExpand);
    miniMount.querySelector(".focus-mini-toggle").addEventListener("click", () => togglePause());
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

  function startPhase(phase) {
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
    save();
    enableSound();
    render({ announce: phase === "focus" ? "专注开始。" : "休息开始。" });
  }

  function replaceActive(next) {
    store.sessions = store.sessions.map(session => session.id === next.id ? next : session);
    save();
  }

  function togglePause() {
    const session = activeSession();
    if (!session) return;
    const next = session.status === "running" ? pauseFocusSession(session) : resumeFocusSession(session);
    replaceActive(next);
    if (next.status === "completed") {
      render({ announce: session.phase === "focus" ? "本轮专注完成。" : "休息结束。" });
      playSound();
      onHistoryChange();
      return;
    }
    render({ announce: next.status === "paused" ? "计时已暂停。" : "计时已继续。" });
  }

  function finish(completed = false) {
    const session = activeSession();
    if (!session) return;
    const next = finishFocusSession(session, Date.now(), completed);
    replaceActive(next);
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

  function tick() {
    if (!active) return;
    const session = activeSession();
    if (!session) return;
    const settled = settleExpiredSession(session);
    if (settled.status !== session.status) {
      replaceActive(settled);
      render({ announce: settled.phase === "focus" ? "本轮专注完成。" : "休息结束。" });
      playSound();
      onHistoryChange();
      return;
    }
    elements.focusClock.textContent = clock(remainingSeconds(session));
    const miniClock = miniMount.querySelector("strong");
    if (miniClock) miniClock.textContent = clock(remainingSeconds(session));
  }

  elements.focusStart.addEventListener("click", () => startPhase("focus"));
  elements.breakStart.addEventListener("click", () => startPhase("break"));
  elements.focusPause.addEventListener("click", togglePause);
  elements.focusEnd.addEventListener("click", () => finish(false));
  elements.focusSound.addEventListener("change", () => { store.settings.sound = elements.focusSound.checked; if (store.settings.sound) enableSound(); save(); });
  for (const input of [elements.focusMinutes, elements.breakMinutes]) input.addEventListener("change", () => {
    store.settings.focusMinutes = Number(elements.focusMinutes.value) || DEFAULTS.focusMinutes;
    store.settings.breakMinutes = Number(elements.breakMinutes.value) || DEFAULTS.breakMinutes;
    save(); render();
  });
  timer = window.setInterval(tick, 250);

  return {
    setActive(value) {
      active = Boolean(value);
      channel?.close(); channel = null;
      if (!active) {
        miniMount.hidden = true;
        store = { settings: { ...DEFAULTS }, sessions: [] };
        render();
        return;
      }
      load(); refreshTasks(); render();
      if ("BroadcastChannel" in window) {
        channel = new BroadcastChannel(`daily-todo-focus-${getUid()}`);
        channel.addEventListener("message", () => { load(); render(); onHistoryChange(); });
      }
    },
    refreshTasks,
    getTaskSeconds(taskId, date) { return taskFocusSeconds(store.sessions, taskId, date); },
    pauseForLogout() {
      const session = activeSession();
      if (session?.status === "running") replaceActive(pauseFocusSession(session));
    },
    reset() { this.setActive(false); audioContext?.close?.(); audioContext = null; },
    destroy() { window.clearInterval(timer); channel?.close(); }
  };
}
