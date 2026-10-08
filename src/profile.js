import { aggregateCompletionHistory, buildHeatmap, currentCompletionStreak, heatLevel, profileRange } from "./profile-core.js";
import { shanghaiTodayKey } from "./date-display.js";

function formatDate(date) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${date}T12:00:00+08:00`));
}

export function setupProfile({ mount, db, getUsername, cloudResult }) {
  mount.innerHTML = `<header class="view-heading profile-heading">
    <div><p class="view-kicker">PROFILE / 个人</p><h1><span id="profileName"></span>的完成轨迹</h1><p>只统计云端任务完成记录；专注数据仍保存在当前浏览器。</p></div>
    <button class="button" id="profileRetry" type="button">刷新统计</button>
  </header>
  <p class="profile-status" id="profileStatus" role="status"></p>
  <section class="profile-summary" aria-label="完成概览">
    <div><strong id="profileStreak">—</strong><span>连续完成天数</span></div>
    <div><strong id="profileTotal">—</strong><span>近 365 天完成次数</span></div>
  </section>
  <section class="heatmap-section" aria-labelledby="heatmapTitle">
    <div class="heatmap-heading"><div><h2 id="heatmapTitle">每日完成热力图</h2><p id="heatmapRange"></p></div><div class="heatmap-legend" aria-label="颜色越深，完成次数越多"><span>少</span>${[0,1,2,3,4].map(level => `<i data-level="${level}"></i>`).join("")}<span>多</span></div></div>
    <div class="heatmap-scroll"><div class="heatmap-weekdays" aria-hidden="true"><span>一</span><span>三</span><span>五</span><span>日</span></div><div class="heatmap-grid" id="profileHeatmap" role="grid"></div></div>
  </section>
  <section class="profile-detail" aria-labelledby="profileDetailTitle"><h2 id="profileDetailTitle">选择一天查看明细</h2><p id="profileDetailCopy">点击或用键盘聚焦热力图中的日期。</p><ol id="profileDetailList"></ol></section>`;

  const elements = Object.fromEntries([...mount.querySelectorAll("[id]")].map(node => [node.id, node]));
  let rows = [];
  let loaded = false;

  function renderDetail(date, byDate) {
    const bucket = byDate.get(date);
    elements.profileDetailTitle.textContent = formatDate(date);
    elements.profileDetailCopy.textContent = bucket?.count ? `完成 ${bucket.count} 项` : "这一天没有完成记录。";
    elements.profileDetailList.replaceChildren(...(bucket?.items || []).map(item => {
      const li = document.createElement("li");
      li.textContent = item.title;
      return li;
    }));
  }

  function render() {
    const today = shanghaiTodayKey();
    const model = buildHeatmap(rows, today);
    elements.profileName.textContent = getUsername() || "你";
    elements.profileStreak.textContent = `${model.streak} 天`;
    elements.profileTotal.textContent = String(model.total);
    elements.heatmapRange.textContent = `${model.range.start} — ${model.range.end} · 上海时区`;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < model.leading; index += 1) {
      const spacer = document.createElement("span");
      spacer.className = "heatmap-spacer";
      spacer.setAttribute("aria-hidden", "true");
      fragment.append(spacer);
    }
    for (const cell of model.cells) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "heatmap-cell";
      button.dataset.level = String(heatLevel(cell.count, model.max));
      button.dataset.date = cell.date;
      button.title = `${formatDate(cell.date)}：完成 ${cell.count} 项`;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("role", "gridcell");
      button.addEventListener("click", () => renderDetail(cell.date, model.byDate));
      button.addEventListener("focus", () => renderDetail(cell.date, model.byDate));
      button.addEventListener("mouseenter", () => renderDetail(cell.date, model.byDate));
      fragment.append(button);
    }
    elements.profileHeatmap.replaceChildren(fragment);
    renderDetail(today, model.byDate);
  }

  async function queryRange(start, end) {
    const result = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await cloudResult(db.from("todo_completion_history").select("task_id,task_title_snapshot,completion_date,is_active")
        .gte("completion_date", start).lte("completion_date", end).order("completion_date", { ascending: true })
        .range(offset, offset + pageSize - 1));
      const batch = Array.isArray(page) ? page : [];
      result.push(...batch);
      if (batch.length < pageSize) break;
    }
    return result;
  }

  async function load({ force = false } = {}) {
    if (loaded && !force) return render();
    elements.profileStatus.textContent = "正在读取完成记录…";
    elements.profileRetry.disabled = true;
    try {
      const today = shanghaiTodayKey();
      let covered = profileRange(today, 365);
      let coveredDays = 365;
      rows = await queryRange(covered.start, covered.end);
      while (true) {
        const byDate = aggregateCompletionHistory(rows);
        const expected = coveredDays - (byDate.get(today)?.count ? 0 : 1);
        if (currentCompletionStreak(byDate, today) < expected || !byDate.get(covered.start)?.count) break;
        const previousEnd = new Date(`${covered.start}T00:00:00Z`);
        previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
        const older = profileRange(previousEnd.toISOString().slice(0, 10), 365);
        rows.push(...await queryRange(older.start, older.end));
        covered = { start: older.start, end: covered.end };
        coveredDays += 365;
      }
      loaded = true;
      elements.profileStatus.textContent = "";
      render();
    } catch (error) {
      loaded = false;
      elements.profileStatus.textContent = `统计读取失败：${error?.message || "未知错误"}。请确认完成历史迁移已应用后重试。`;
      elements.profileStreak.textContent = "—";
      elements.profileTotal.textContent = "—";
    } finally {
      elements.profileRetry.disabled = false;
    }
  }

  elements.profileRetry.addEventListener("click", () => { void load({ force: true }); });

  return {
    load,
    invalidate() { loaded = false; },
    reset() { rows = []; loaded = false; elements.profileHeatmap.replaceChildren(); elements.profileStatus.textContent = ""; }
  };
}
