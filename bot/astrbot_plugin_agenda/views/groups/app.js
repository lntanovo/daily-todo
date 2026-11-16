const bridge = window.AstrBotPluginView;
await bridge.ready();

const listEl = document.getElementById("list");
const bannerEl = document.getElementById("banner");
const summaryEl = document.getElementById("summary");
const searchEl = document.getElementById("search");
const saveBtn = document.getElementById("save");
const reloadBtn = document.getElementById("reload");

/** group_id -> "chat" | "watch" | "ignore" */
let modes = new Map();
let groups = [];
let dirty = false;

function setBanner(text, kind) {
  if (!text) {
    bannerEl.className = "banner hidden";
    bannerEl.textContent = "";
    return;
  }
  bannerEl.className = `banner ${kind || "ok"}`;
  bannerEl.textContent = text;
}

function summarize() {
  const counts = { chat: 0, watch: 0, ignore: 0 };
  for (const g of groups) counts[modes.get(g.group_id) || "ignore"] += 1;
  summaryEl.textContent =
    `共 ${groups.length} 个群 · 陪聊 ${counts.chat} · 只听不说 ${counts.watch} · 忽略 ${counts.ignore}` +
    (dirty ? " · 有未保存的修改" : "");
}

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const visible = groups.filter(
    (g) =>
      !q ||
      g.group_name.toLowerCase().includes(q) ||
      g.group_id.includes(q)
  );

  if (groups.length === 0) {
    listEl.innerHTML =
      '<div class="empty">没有拿到群列表。确认小号已登录、OneBot 已连接，并且小号确实在某个群里。</div>';
    summarize();
    return;
  }
  if (visible.length === 0) {
    listEl.innerHTML = '<div class="empty">没有匹配的群。</div>';
    summarize();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of visible) {
    const mode = modes.get(g.group_id) || "ignore";
    const row = document.createElement("div");
    row.className = `row${mode === "ignore" ? " ignored" : ""}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = g.group_name || "(未命名群)";
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = `${g.group_id}${g.member_count ? ` · ${g.member_count} 人` : ""}`;
    meta.append(name, id);

    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [value, label] of [
      ["chat", "陪聊"],
      ["watch", "只听不说"],
      ["ignore", "忽略"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.mode = value;
      b.textContent = label;
      if (value === mode) b.classList.add("on");
      b.addEventListener("click", () => {
        if (value === "ignore") modes.delete(g.group_id);
        else modes.set(g.group_id, value);
        dirty = true;
        render();
      });
      seg.append(b);
    }

    row.append(meta, seg);
    frag.append(row);
  }
  listEl.replaceChildren(frag);
  summarize();
}

async function load() {
  setBanner("");
  try {
    const data = await bridge.apiGet("groups");
    groups = Array.isArray(data.groups) ? data.groups : [];
    modes = new Map();
    for (const id of data.chat || []) modes.set(String(id), "chat");
    for (const id of data.watch || []) {
      if (!modes.has(String(id))) modes.set(String(id), "watch");
    }
    dirty = false;
    render();
  } catch (err) {
    listEl.innerHTML = '<div class="empty">加载失败，见下方提示。</div>';
    setBanner(`加载失败：${err?.message || err}`, "err");
  }
}

async function save() {
  const chat = [];
  const watch = [];
  for (const [id, mode] of modes) {
    if (mode === "chat") chat.push(id);
    else if (mode === "watch") watch.push(id);
  }
  saveBtn.disabled = true;
  try {
    const data = await bridge.apiPost("groups", { chat, watch });
    if (data && data.saved) {
      dirty = false;
      setBanner(`已保存：陪聊 ${chat.length} 个群，只听不说 ${watch.length} 个群。立即生效，无需重启。`, "ok");
      summarize();
    } else {
      setBanner("保存没有返回预期结果，请查看 AstrBot 日志。", "warn");
    }
  } catch (err) {
    setBanner(`保存失败：${err?.message || err}`, "err");
  } finally {
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", save);
reloadBtn.addEventListener("click", load);
searchEl.addEventListener("input", render);

await load();
