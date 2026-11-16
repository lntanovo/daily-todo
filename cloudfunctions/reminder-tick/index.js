"use strict";

const { tick, createRpc } = require("./core");

function emit(level, event, detail) {
  const record = { level, event, ...detail };
  if (level === "error") console.error(JSON.stringify(record));
  else console.log(JSON.stringify(record));
}

exports.main = async (event = {}, context = {}) => {
  const envId = process.env.APP_ENV_ID;
  const apiKey = process.env.CLOUDBASE_API_KEY;
  if (!envId || !apiKey) {
    emit("error", "missing_configuration", { hasEnvId: Boolean(envId), hasApiKey: Boolean(apiKey) });
    return { ok: false, code: "MISSING_CONFIGURATION" };
  }

  const dryRun = process.env.REMINDER_DRY_RUN === "1";
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    emit("error", "fetch_unavailable", {});
    return { ok: false, code: "FETCH_UNAVAILABLE" };
  }

  const rpc = createRpc({ envId, apiKey, fetchImpl });
  // 定时触发器不携带请求时间；统一使用服务端当前时间，避免慢重试把旧时间当成 now。
  const now = event?.triggerTime || new Date().toISOString();

  if (dryRun) {
    // 只读演练：拉取到期清单但不投递、不记账、不建令牌。
    try {
      const due = await rpc("reminder_due_batch", { p_now: now });
      const am = await rpc("reminder_digest_batch", { p_now: now, p_grace_minutes: 180, p_slot: "am" });
      const pm = await rpc("reminder_digest_batch", { p_now: now, p_grace_minutes: 180, p_slot: "pm" });
      emit("info", "dry_run", {
        at: now,
        due: Array.isArray(due) ? due.length : 0,
        digest_am: Array.isArray(am) ? am.length : 0,
        digest_pm: Array.isArray(pm) ? pm.length : 0
      });
      return { ok: true, dryRun: true };
    } catch (error) {
      emit("error", "dry_run_failed", { message: error.message });
      return { ok: false, code: "DRY_RUN_FAILED" };
    }
  }

  try {
    const summary = await tick({
      rpc,
      fetchImpl,
      baseUrl: process.env.REMINDER_BASE_URL || "",
      format: process.env.REMINDER_FEISHU_FORMAT === "post" ? "post" : "card",
      log: (level, detail) => emit(level === "failed" || level === "purge_failed" ? "warn" : "info", level, detail),
      now,
      graceMinutes: Number(process.env.REMINDER_DIGEST_GRACE_MINUTES || 180),
      purgeDays: Number(process.env.REMINDER_PURGE_DAYS || 60)
    });
    return { ok: true, summary };
  } catch (error) {
    // 单次失败交给下一次定时触发；不向调用方暴露内部错误细节。
    emit("error", "tick_failed", { code: String(error.code || "TICK_FAILED") });
    return { ok: false, code: "TICK_FAILED" };
  }
};
