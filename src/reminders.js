const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 数据库返回的是 {feishu_set, feishu_hint, ...}；表单只应回填「未配置」或末尾提示，
// 绝不把完整 webhook 送回浏览器。
export function applyReminderSettings(elements, settings) {
  if (!settings || typeof settings !== "object") return;

  elements.feishu.value = "";
  elements.feishu.placeholder = settings.feishu_set
    ? `已保存 ${settings.feishu_hint}（留空不修改，输入“-”可清除）`
    : "https://open.feishu.cn/open-apis/bot/v2/hook/…";
  elements.wecom.value = "";
  elements.wecom.placeholder = settings.wecom_set
    ? `已保存 ${settings.wecom_hint}（留空不修改，输入“-”可清除）`
    : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…";

  elements.digest.checked = settings.digest_enabled !== false;
  elements.digestTime.value = TIME_RE.test(settings.digest_time || "") ? settings.digest_time : "08:00";
  elements.evening.checked = settings.evening_enabled !== false;
  elements.eveningTime.value = TIME_RE.test(settings.evening_time || "") ? settings.evening_time : "20:30";
  elements.leadDays.value = String(Number.isInteger(settings.remind_lead_days) ? settings.remind_lead_days : 3);
  elements.grace.value = String(Number.isInteger(settings.grace_minutes) ? settings.grace_minutes : 60);
  elements.quietStart.value = TIME_RE.test(settings.quiet_start || "") ? settings.quiet_start : "";
  elements.quietEnd.value = TIME_RE.test(settings.quiet_end || "") ? settings.quiet_end : "";
}

// 只提交变化过的字段。webhook 输入框留空表示「保持原值」，
// 输入单个减号表示显式清除，避免用户误把已存的值清空。
export function buildReminderPayload(elements, current) {
  const payload = {};

  for (const [key, channel] of [["feishu_webhook", "feishu"], ["wecom_webhook", "wecom"]]) {
    const raw = String(elements[channel].value || "").trim();
    if (!raw) continue;
    if (raw === "-") {
      payload[key] = "";
      continue;
    }
    if (!/^https:\/\//.test(raw)) throw new Error("Webhook 必须是 https 地址。");
    payload[key] = raw;
  }

  const graceText = String(elements.grace.value || "").trim();
  const grace = Number(graceText);
  if (!/^\d{1,4}$/.test(graceText) || grace > 1440) throw new Error("宽限时间应为 0—1440 分钟。");
  payload.grace_minutes = grace;

  const digestTime = elements.digestTime.value;
  if (!TIME_RE.test(digestTime)) throw new Error("早报时间格式应为 HH:mm。");
  payload.digest_time = digestTime;
  payload.digest_enabled = elements.digest.checked;

  const eveningTime = elements.eveningTime.value;
  if (!TIME_RE.test(eveningTime)) throw new Error("晚间收尾时间格式应为 HH:mm。");
  payload.evening_time = eveningTime;
  payload.evening_enabled = elements.evening.checked;

  // 0 表示只看当天与逾期；上限与数据库的 CHECK 保持一致，避免服务端报错才提示。
  const leadText = String(elements.leadDays.value || "").trim();
  const lead = Number(leadText);
  if (!/^\d{1,2}$/.test(leadText) || lead > 30) throw new Error("提前提醒天数应为 0—30。");
  payload.remind_lead_days = lead;

  const quietStart = elements.quietStart.value;
  const quietEnd = elements.quietEnd.value;
  if (Boolean(quietStart) !== Boolean(quietEnd)) throw new Error("免打扰开始和结束需要同时留空或同时填写。");
  if (quietStart && (!TIME_RE.test(quietStart) || !TIME_RE.test(quietEnd))) {
    throw new Error("免打扰时间格式应为 HH:mm。");
  }
  if (quietStart === quietEnd && quietStart) throw new Error("免打扰开始和结束不能相同。");
  payload.quiet_start = quietStart || "";
  payload.quiet_end = quietEnd || "";

  return payload;
}

// 保存成功后用服务端返回值重绘，并把结果说明给用户。
export function describeSaved(settings) {
  const channels = [];
  if (settings?.feishu_set) channels.push(`飞书 ${settings.feishu_hint}`);
  if (settings?.wecom_set) channels.push(`企业微信 ${settings.wecom_hint}`);
  if (!channels.length) return "已保存，但还没有推送通道；补充 Webhook 后才会收到提醒。";
  return `已保存：${channels.join(" · ")}。`;
}

/* ---------------- 桌面设备配对与管理 ---------------- */

export async function requestPairingCode(db, cloudResult) {
  return await cloudResult(db.rpc("reminder_pairing_create", {}));
}

export async function fetchDevicesList(db, cloudResult) {
  const res = await cloudResult(db.rpc("reminder_devices_list", {}));
  return Array.isArray(res?.devices) ? res.devices : [];
}

export async function revokeDeviceById(db, cloudResult, deviceId) {
  return await cloudResult(db.rpc("reminder_device_revoke", { p_device_id: deviceId }));
}

