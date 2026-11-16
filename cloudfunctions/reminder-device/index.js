"use strict";

const { createHash } = require("node:crypto");

function sha256(str) {
  return createHash("sha256").update(str).digest("hex");
}

function extractToken(headers = {}) {
  const custom = headers["x-device-token"] || headers["X-Device-Token"];
  if (custom && /^[a-f0-9]{64}$/i.test(custom.trim())) return custom.trim().toLowerCase();

  const auth = headers["authorization"] || headers["Authorization"] || "";
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(auth.trim());
  return match ? match[1].toLowerCase() : null;
}

function respondJson(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Device-Token, Authorization"
    },
    body: JSON.stringify(data)
  };
}

function createRpc({ envId, apiKey, fetchImpl }) {
  return async function rpc(name, args) {
    const response = await fetchImpl(
      `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(args || {}),
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) {
      throw Object.assign(new Error(`RPC_HTTP_${response.status}`), { code: `RPC_HTTP_${response.status}` });
    }
    const json = await response.json();
    return json && Object.prototype.hasOwnProperty.call(json, "data") ? json.data : json;
  };
}

async function handleRequest(event, { rpc }) {
  const method = (event.httpMethod || "").toUpperCase();
  if (method === "OPTIONS") return respondJson({}, 204);
  if (method !== "POST") return respondJson({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  let body = {};
  if (typeof event.body === "string" && event.body.trim()) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return respondJson({ ok: false, error: "INVALID_JSON" }, 400);
    }
  }

  const rawPath = event.path || "";
  // 兼容直接访问或网关传递子路径：/api/reminder/device/pair, /pair, etc.
  const subAction = rawPath.replace(/^.*\/api\/reminder\/device\/?/, "").replace(/^\//, "");

  if (subAction === "pair") {
    const code = String(body.code || "").trim();
    const name = String(body.name || "").trim();
    const tokenHash = String(body.tokenHash || "").trim().toLowerCase();
    if (!/^\d{6}$/.test(code) || !name || !/^[a-f0-9]{64}$/.test(tokenHash)) {
      return respondJson({ ok: false, error: "INVALID_PARAMS" }, 400);
    }
    const result = await rpc("reminder_device_pair", {
      p_code: code,
      p_name: name,
      p_token_hash: tokenHash
    });
    return respondJson(result, result?.ok ? 200 : 400);
  }

  const token = extractToken(event.headers);
  if (!token) {
    return respondJson({ ok: false, error: "MISSING_OR_INVALID_TOKEN" }, 401);
  }
  const tokenHash = sha256(token);

  if (subAction === "feed") {
    const now = body.now || new Date().toISOString();
    const result = await rpc("reminder_device_feed", {
      p_token_hash: tokenHash,
      p_now: now
    });
    return respondJson(result, result?.ok ? 200 : 401);
  }

  if (subAction === "ack") {
    const taskId = String(body.taskId || "").trim();
    const remindDate = String(body.remindDate || "").trim();
    const status = String(body.status || "sent").trim();
    if (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(remindDate)) {
      return respondJson({ ok: false, error: "INVALID_PARAMS" }, 400);
    }
    const success = await rpc("reminder_device_ack", {
      p_token_hash: tokenHash,
      p_task_id: taskId,
      p_remind_date: remindDate,
      p_status: status
    });
    return respondJson({ ok: Boolean(success) }, success ? 200 : 400);
  }

  if (subAction === "complete") {
    const taskId = String(body.taskId || "").trim();
    const remindDate = String(body.remindDate || "").trim();
    if (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(remindDate)) {
      return respondJson({ ok: false, error: "INVALID_PARAMS" }, 400);
    }
    const result = await rpc("reminder_device_complete", {
      p_token_hash: tokenHash,
      p_task_id: taskId,
      p_remind_date: remindDate
    });
    return respondJson(result, result?.ok ? 200 : 400);
  }

  return respondJson({ ok: false, error: "ACTION_NOT_FOUND" }, 404);
}

exports.main = async (event = {}, context = {}) => {
  const envId = process.env.APP_ENV_ID;
  const apiKey = process.env.CLOUDBASE_API_KEY;
  if (!envId || !apiKey) {
    return respondJson({ ok: false, error: "SERVER_CONFIG_MISSING" }, 500);
  }

  const fetchImpl = globalThis.fetch;
  const rpc = createRpc({ envId, apiKey, fetchImpl });

  try {
    return await handleRequest(event, { rpc });
  } catch (error) {
    console.error(JSON.stringify({ event: "device_endpoint_error", message: error.message }));
    return respondJson({ ok: false, error: "INTERNAL_ERROR" }, 500);
  }
};

exports.handleRequest = handleRequest;
exports.extractToken = extractToken;
exports.sha256 = sha256;
