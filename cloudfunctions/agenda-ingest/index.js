"use strict";

/**
 * Agenda ingest endpoint.
 *
 * The QQ bot understands a sentence and posts one clean task here. This
 * function is the only write path from chat into the schedule database, so it
 * does three things the bot must not be trusted to do itself:
 *
 *   1. authenticate the caller with a shared secret (never a service key);
 *   2. validate every field against the same rules the browser uses;
 *   3. avoid duplicates when the bot retries the same sentence.
 *
 * It talks to PostgREST with the environment service key, exactly like
 * reminder-tick and reminder-done do.
 */

const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KINDS = new Set(["deadline", "event", "task"]);
const DEFAULT_CLOCK = "20:00";

function respondJson(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

function sameSecret(provided) {
  const expected = process.env.BOT_SHARED_SECRET || "";
  if (!expected || typeof provided !== "string" || !provided) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0]) : String(value ?? "");
  }
  return "";
}

function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validate a bot payload into a database row.
 *
 * @returns {{ok: true, row: object, kind: string} | {ok: false, code: string}}
 */
function normalize(payload, ownerId) {
  if (!payload || typeof payload !== "object") return { ok: false, code: "INVALID_BODY" };

  const title = String(payload.title ?? "").replace(/\s+/g, " ").trim();
  if (!title || title.length > 160) return { ok: false, code: "INVALID_TITLE" };

  const date = String(payload.date ?? "").trim();
  if (!isValidDate(date)) return { ok: false, code: "INVALID_DATE" };

  const rawTime = String(payload.time ?? "").trim();
  if (rawTime && !TIME_RE.test(rawTime)) return { ok: false, code: "INVALID_TIME" };

  const kind = String(payload.kind ?? "task").trim();
  if (!KINDS.has(kind)) return { ok: false, code: "INVALID_KIND" };

  return {
    ok: true,
    kind,
    row: {
      owner_id: ownerId,
      id: randomUUID(),
      title,
      type: "single",
      task_date: date,
      // 没有具体时刻的截止日，默认在当天 20:00 提醒一次；倒计时仍由早报负责。
      remind_time: rawTime || DEFAULT_CLOCK,
      remind_enabled: true,
      priority: "normal"
    }
  };
}

function createRest({ envId, apiKey, fetchImpl }) {
  const base = `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest`;
  return async function rest(path, init = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers || {})
      },
      signal: AbortSignal.timeout(12000)
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw Object.assign(new Error(`REST_${response.status}`), {
        code: `REST_${response.status}`,
        detail: body
      });
    }
    return body;
  };
}

async function findExisting(rest, row) {
  const query = new URLSearchParams({
    owner_id: `eq.${row.owner_id}`,
    task_date: `eq.${row.task_date}`,
    title: `eq.${row.title}`,
    deleted_at: "is.null",
    select: "id",
    limit: "1"
  });
  const found = await rest(`/todo_tasks?${query.toString()}`);
  return Array.isArray(found) && found.length ? String(found[0].id) : null;
}

async function handleRequest(event, { rest, ownerId, siteUrl }) {
  const method = (event.httpMethod || "").toUpperCase();
  if (method !== "POST") return respondJson({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  if (!sameSecret(headerOf(event.headers, "x-bot-secret"))) {
    return respondJson({ ok: false, error: "UNAUTHORIZED" }, 401);
  }

  let payload = null;
  try {
    payload = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body;
  } catch {
    return respondJson({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const normalized = normalize(payload, ownerId);
  if (!normalized.ok) return respondJson({ ok: false, error: normalized.code }, 400);

  try {
    const existingId = await findExisting(rest, normalized.row);
    if (existingId) {
      return respondJson({
        ok: true,
        duplicate: true,
        id: existingId,
        date: normalized.row.task_date,
        time: normalized.row.remind_time,
        site: siteUrl || null
      });
    }

    const inserted = await rest("/todo_tasks", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(normalized.row)
    });

    return respondJson({
      ok: true,
      duplicate: false,
      id: normalized.row.id,
      date: normalized.row.task_date,
      time: normalized.row.remind_time,
      site: siteUrl || null
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "ingest_failed",
      code: String(error.code || "INGEST_FAILED"),
      status: error.detail && error.detail.code ? String(error.detail.code) : undefined
    }));
    return respondJson({ ok: false, error: "INGEST_FAILED" }, 502);
  }
}

exports.main = async (event = {}) => {
  const envId = process.env.APP_ENV_ID;
  const apiKey = process.env.CLOUDBASE_API_KEY;
  const ownerId = process.env.AGENDA_OWNER_ID;
  if (!envId || !apiKey || !ownerId) {
    console.error(JSON.stringify({ event: "missing_configuration" }));
    return respondJson({ ok: false, error: "MISSING_CONFIGURATION" }, 500);
  }
  const rest = createRest({ envId, apiKey, fetchImpl: globalThis.fetch });
  return handleRequest(event, { rest, ownerId, siteUrl: process.env.SITE_URL || "" });
};

exports.normalize = normalize;
exports.sameSecret = sameSecret;
exports.headerOf = headerOf;
exports.isValidDate = isValidDate;
exports.handleRequest = handleRequest;
