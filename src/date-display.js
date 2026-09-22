const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function chineseNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 30) return String(value);
  if (number <= 10) return DIGITS[number];
  if (number < 20) return `十${DIGITS[number - 10]}`;
  if (number === 20) return "二十";
  if (number < 30) return `二十${DIGITS[number - 20]}`;
  return "三十";
}

export function shanghaiTodayKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatSolarDate(dateKey) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long"
  }).format(new Date(`${dateKey}T12:00:00+08:00`));
}

export function formatLunarDate(dateKey) {
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      timeZone: "Asia/Shanghai", month: "long", day: "numeric"
    });
    if (formatter.resolvedOptions().calendar !== "chinese") return "";
    const parts = formatter.formatToParts(new Date(`${dateKey}T12:00:00+08:00`));
    const month = parts.find(part => part.type === "month")?.value || "";
    const day = parts.find(part => part.type === "day")?.value || "";
    if (!month || !day) return "";
    const lunarDay = /^\d+$/.test(day) ? chineseNumber(day) : day;
    return `农历${month}${lunarDay}`;
  } catch {
    return "";
  }
}

export function renderDateDisplay({ todayElement, selectedElement, selectedDate, now = Date.now() }) {
  const today = shanghaiTodayKey(now);
  const lunar = formatLunarDate(today);
  todayElement.textContent = [formatSolarDate(today), lunar].filter(Boolean).join(" · ");
  const viewingToday = selectedDate === today;
  selectedElement.hidden = viewingToday;
  selectedElement.textContent = viewingToday ? "" : `正在查看：${formatSolarDate(selectedDate)}`;
  return today;
}

export function scheduleShanghaiMidnight(callback) {
  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    const now = Date.now();
    const shifted = new Date(now + 8 * 60 * 60 * 1000);
    const next = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - 8 * 60 * 60 * 1000;
    timer = window.setTimeout(() => { callback(); schedule(); }, Math.max(1000, next - now + 250));
  };
  schedule();
  const onVisible = () => { if (!document.hidden) callback(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
}
