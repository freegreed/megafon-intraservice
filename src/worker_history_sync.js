/*
 * MegaFon VATS -> Cloudflare Worker -> D1 -> IntraService
 *
 * Primary channel: CRM callback cmd=history.
 * Safety channel: MegaFon CRM API /history/json.
 */

const MIN_DURATION_SEC = 10;
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 5;
const MAX_BODY_BYTES = 64 * 1024;
const API_SYNC_DEBOUNCE_SEC = 30;
const API_LOOKBACK_MINUTES = 30;

const IS_SERVICE_ID = 619;
const IS_TYPE_ID = 1024;
const IS_PRIORITY_ID = 11;
const IS_STATUS_DONE_ID = 29;
const IS_EXECUTOR_ID = 1744;
const IS_CREATOR_ID = 1744;

const MEGAFON_API_BASE = "https://vats123691.megapbx.ru/crmapi/v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "megafon-intraservice" });
    }
    if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    if (!url.pathname.startsWith("/webhook/megafon/")) return json({ error: "Not Found" }, 404);

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json({ error: "Payload Too Large" }, 413);

    let payload;
    try {
      payload = await readPayload(request);
    } catch (error) {
      return json({ error: safeErrorMessage(error) }, 400);
    }

    if (payload?.crm_token !== env.MEGAFON_CRM_TOKEN) {
      console.warn("Rejected MegaFon webhook: invalid token");
      return json({ error: "Unauthorized" }, 401);
    }

    const callid = String(payload?.uid || payload?.callid || "").trim();
    const callbackApiKey = request.headers.get("x-api-key") || env.MEGAFON_API_KEY || "";

    // A callback carries the VATS API key in X-API-KEY. For callbacks with a
    // call id, query that exact call. This avoids the expensive period=today
    // request that was producing HTTP 522 responses.
    if (callbackApiKey) {
      ctx.waitUntil(syncMegafonHistory(env, callbackApiKey, "callback", callid));
    }

    const command = String(payload?.cmd || "").toLowerCase();
    if (command !== "history") {
      console.info("MegaFon callback ignored", safePayloadSummary(payload));
      return json({ result: "ignored", reason: "Unsupported command" }, 200);
    }

    const call = parseHistoryPayload(payload);
    if (!call.ok) {
      const diagnostic = safePayloadSummary(payload);
      await logError(env, call.callid || null, "PAYLOAD", `${call.reason}; ${diagnostic}`);
      console.warn(`MegaFon history rejected: ${call.reason}; ${diagnostic}`);
      return json({ result: "rejected", reason: call.reason }, 400);
    }

    const inserted = await insertCallIfAbsent(env, call.data);
    if (!inserted) {
      console.info(`Duplicate webhook ignored: ${call.data.callid}`);
      return json({ result: "duplicate", callid: call.data.callid }, 200);
    }

    if (call.data.status === "RECEIVED") ctx.waitUntil(processClaimedCall(env, call.data.callid));
    return json({ result: "accepted", callid: call.data.callid }, 200);
  },

  async scheduled(_controller, env, ctx) {
    if (env.MEGAFON_API_KEY) {
      ctx.waitUntil(syncMegafonHistory(env, env.MEGAFON_API_KEY, "cron", ""));
    } else {
      console.info("MegaFon API sync skipped: MEGAFON_API_KEY is not configured");
    }
    ctx.waitUntil(retryFailedCalls(env));
  },
};

async function readPayload(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("Payload Too Large");
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON"); }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  throw new Error("Content-Type must be application/json or application/x-www-form-urlencoded");
}

function parseHistoryPayload(payload) {
  const cmd = String(payload?.cmd || "").toLowerCase();
  const type = String(payload?.type || "").toLowerCase();
  const status = String(payload?.status || "").toLowerCase();
  const callid = String(payload?.uid || payload?.callid || "").trim();
  if (cmd !== "history") return { ok: false, reason: "Unsupported command" };
  if (!callid) return { ok: false, reason: "Missing uid/callid" };
  if (type !== "in") return { ok: true, data: skippedCall(payload, callid, "not incoming") };
  if (status !== "success") return { ok: true, data: skippedCall(payload, callid, "not successful") };
  const duration = parseNonNegativeInt(payload?.duration);
  if (duration <= MIN_DURATION_SEC) return { ok: true, data: skippedCall(payload, callid, "duration <= 10s", duration) };
  return {
    ok: true,
    data: {
      callid,
      phone: normalizePhone(payload?.phone || payload?.client),
      megafon_user: String(payload?.user || "").trim(),
      duration,
      record_url: safeUrl(payload?.link || payload?.record),
      call_start: String(payload?.start || "").trim(),
      call_type: type,
      call_status: status,
      status: "RECEIVED",
    },
  };
}

function parseApiCall(item) {
  const callid = String(item?.uid || "").trim();
  const type = String(item?.type || "").toLowerCase();
  const status = String(item?.status || "").toLowerCase();
  const duration = parseNonNegativeInt(item?.duration);
  if (!callid || type !== "in" || status !== "success" || duration <= MIN_DURATION_SEC) return null;
  return {
    callid,
    phone: normalizePhone(item?.client || item?.phone),
    megafon_user: String(item?.user || "").trim(),
    duration,
    record_url: safeUrl(item?.record || item?.link),
    call_start: String(item?.start || "").trim(),
    call_type: "in",
    call_status: "success",
    status: "RECEIVED",
  };
}

async function syncMegafonHistory(env, apiKey, source, uid = "") {
  try {
    const operation = uid ? "megafon_history_uid" : "megafon_history_window";
    if (!(await acquireSyncSlot(env, source, operation, uid))) return;

    const params = uid
      ? new URLSearchParams({ uid })
      : buildHistoryWindowParams(API_LOOKBACK_MINUTES);

    const requestUrl = `${MEGAFON_API_BASE}/history/json?${params.toString()}`;
    const startedAt = Date.now();
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-KEY": apiKey },
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const details = text.replace(/\s+/g, " ").trim().slice(0, 450);
      throw new Error(`MegaFon history API HTTP ${response.status}${details ? `: ${details}` : ""}`);
    }

    let data;
    try { data = JSON.parse(text); } catch { throw new Error("MegaFon history API returned invalid JSON"); }
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    let eligible = 0;
    let inserted = 0;

    for (const item of items) {
      const call = parseApiCall(item);
      if (!call) continue;
      eligible++;
      if (await insertCallIfAbsent(env, call)) {
        inserted++;
        await processClaimedCall(env, call.callid);
      }
    }

    await env.DB.prepare(`INSERT INTO sync_runs(operation,status,details) VALUES(?,?,?)`)
      .bind(
        "megafon_history",
        "SUCCESS",
        JSON.stringify({ source, mode: uid ? "uid" : "window", uid: uid || undefined, received: items.length, eligible, inserted, elapsed_ms: elapsedMs }),
      ).run();
    console.info(`MegaFon history sync ${source}: mode=${uid ? "uid" : "window"}, received=${items.length}, eligible=${eligible}, inserted=${inserted}, elapsed_ms=${elapsedMs}`);
  } catch (error) {
    await logError(env, uid || null, "MEGAFON_API", safeErrorMessage(error));
    console.warn(`MegaFon history sync failed: mode=${uid ? "uid" : "window"}; ${safeErrorMessage(error)}`);
  }
}

function buildHistoryWindowParams(lookbackMinutes) {
  const now = new Date();
  const start = new Date(now.getTime() - lookbackMinutes * 60 * 1000);
  return new URLSearchParams({
    start: formatMegaFonDate(start),
    end: formatMegaFonDate(now),
    type: "in",
    limit: "100",
  });
}

function formatMegaFonDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

async function acquireSyncSlot(env, source, operation, uid = "") {
  const row = await env.DB.prepare(
    `SELECT created_at, details FROM sync_runs WHERE operation=? ORDER BY id DESC LIMIT 1`
  ).bind(operation).first();
  if (row?.created_at) {
    const age = Date.now() - Date.parse(`${String(row.created_at).replace(" ", "T")}Z`);
    const sameUid = uid && String(row.details || "").includes(`"uid":"${uid}"`);
    if (Number.isFinite(age) && age < API_SYNC_DEBOUNCE_SEC * 1000 && (!uid || sameUid)) return false;
  }
  await env.DB.prepare(`INSERT INTO sync_runs(operation,status,details) VALUES(?,?,?)`)
    .bind(operation, "STARTED", JSON.stringify({ source, uid: uid || undefined })).run();
  return true;
}

async function insertCallIfAbsent(env, call) {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO calls
      (callid,phone,megafon_user,duration,record_url,call_start,call_type,call_status,status,error_type,error_message,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).bind(
    call.callid, call.phone, call.megafon_user, call.duration, call.record_url,
    call.call_start, call.call_type, call.call_status, call.status,
    call.error_type || null, call.error_message || null,
  ).run();
  return Number(result.meta?.changes || 0) === 1;
}

async function processClaimedCall(env, callid) {
  const claimed = await env.DB.prepare(
    `UPDATE calls SET status='PROCESSING',updated_at=datetime('now') WHERE callid=? AND status='RECEIVED'`
  ).bind(callid).run();
  if (Number(claimed.meta?.changes || 0) !== 1) return;

  const row = await env.DB.prepare(`SELECT * FROM calls WHERE callid=?`).bind(callid).first();
  if (!row) { await logError(env, callid, "DB", "Call disappeared after claim"); return; }

  try {
    const taskId = await createIntraServiceTask(env, {
      phone: row.phone, duration: row.duration, recordUrl: row.record_url,
      callid: row.callid, callStart: row.call_start,
    });
    if (!taskId) throw new Error("IntraService task ID missing after create/reconciliation");
    await env.DB.prepare(
      `UPDATE calls SET status='CREATED',intraservice_task_id=?,error_type=NULL,error_message=NULL,next_retry_at=NULL,updated_at=datetime('now') WHERE callid=?`
    ).bind(taskId, callid).run();
    console.info(`Call ${callid} -> IntraService task ${taskId}`);
  } catch (error) {
    await scheduleRetry(env, callid, "PROCESS", safeErrorMessage(error));
  }
}

async function createIntraServiceTask(env, { phone, duration, recordUrl, callid, callStart }) {
  const baseUrl = requireHttpsBaseUrl(env.INTRASERVICE_URL);
  const auth = btoa(`${env.INTRASERVICE_LOGIN}:${env.INTRASERVICE_PASSWORD}`);
  const existingBefore = await findExistingIntraServiceTask(env, auth, callid);
  if (existingBefore) {
    console.info(`IntraService task ${existingBefore} already exists for ${callid}`);
    return existingBefore;
  }

  const description = [
    `Номер клиента: ${phone || "не указан"}`,
    `Длительность: ${duration} сек.`,
    `Call ID: ${callid}`,
    `Время: ${callStart || "не указано"}`,
    recordUrl ? `Запись разговора: ${recordUrl}` : "Запись разговора отсутствует",
  ].join("\n");

  const response = await fetch(`${baseUrl}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      Name: `Звонок от ${phone || "неизвестного номера"}`,
      Description: description,
      ServiceId: IS_SERVICE_ID,
      TypeId: IS_TYPE_ID,
      PriorityId: IS_PRIORITY_ID,
      StatusId: IS_STATUS_DONE_ID,
      CreatorId: IS_CREATOR_ID,
      ExecutorIds: String(IS_EXECUTOR_ID),
    }),
  });
  const responseText = await response.text();

  const existingAfter = await findExistingIntraServiceTask(env, auth, callid);
  if (existingAfter) {
    console.info(`Reconciled IntraService task ${existingAfter} for ${callid}`);
    return existingAfter;
  }
  if (!response.ok) {
    const details = responseText.replace(/\s+/g, " ").trim().slice(0, 450);
    throw new Error(`IntraService HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }
  const taskId = extractTaskId(responseText);
  if (taskId) return taskId;
  throw new Error(`IntraService task created but ID could not be extracted${responseText ? `: ${responseText.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`);
}

async function findExistingIntraServiceTask(env, auth, callid) {
  const baseUrl = requireHttpsBaseUrl(env.INTRASERVICE_URL);
  const params = new URLSearchParams({ serviceid: String(IS_SERVICE_ID), fields: "Id,Name,Description", search: `Call ID: ${callid}`, pagesize: "10", page: "1" });
  const response = await fetch(`${baseUrl}/api/task?${params}`, { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`IntraService search HTTP ${response.status}`);
  return extractMatchingTaskId(text, callid);
}

function extractMatchingTaskId(text, callid) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const tasks = Array.isArray(data?.Tasks) ? data.Tasks : Array.isArray(data) ? data : data?.Task ? [data.Task] : [];
    for (const task of tasks) {
      const id = task?.Id ?? task?.id;
      const description = String(task?.Description ?? task?.description ?? "");
      if (id != null && description.includes(`Call ID: ${callid}`)) return String(id);
    }
  } catch {}
  const blocks = text.match(/<Task(?:\s[^>]*)?>[\s\S]*?<\/Task>/gi) || [];
  for (const block of blocks) {
    const description = decodeXmlText(xmlTagValue(block, "Description"));
    if (description.includes(`Call ID: ${callid}`)) {
      const id = xmlTagValue(block, "Id");
      if (id) return id;
    }
  }
  return null;
}

function extractTaskId(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const value = data?.Id ?? data?.id ?? data?.TaskId ?? data?.task_id ?? data?.Task?.Id ?? data?.task?.Id;
    if (value != null && String(value).trim()) return String(value);
  } catch {}
  for (const tag of ["Id", "TaskId", "id", "task_id"]) {
    const value = xmlTagValue(text, tag);
    if (value) return value;
  }
  return null;
}

async function retryFailedCalls(env) {
  const rows = await env.DB.prepare(
    `SELECT callid FROM calls WHERE status='RETRY' AND attempt < ? AND (next_retry_at IS NULL OR next_retry_at <= datetime('now')) ORDER BY updated_at LIMIT 20`
  ).bind(MAX_ATTEMPTS).all();
  for (const row of rows.results || []) await processRetry(env, row.callid);
}

async function processRetry(env, callid) {
  const row = await env.DB.prepare(`SELECT * FROM calls WHERE callid=?`).bind(callid).first();
  if (!row || row.status !== "RETRY") return;
  try {
    const taskId = await createIntraServiceTask(env, { phone: row.phone, duration: row.duration, recordUrl: row.record_url, callid: row.callid, callStart: row.call_start });
    await env.DB.prepare(
      `UPDATE calls SET status='CREATED',intraservice_task_id=?,error_type=NULL,error_message=NULL,next_retry_at=NULL,updated_at=datetime('now') WHERE callid=?`
    ).bind(taskId, callid).run();
    console.info(`Retry ${callid} -> IntraService task ${taskId}`);
  } catch (error) {
    await scheduleRetry(env, callid, "RETRY", safeErrorMessage(error));
  }
}

async function scheduleRetry(env, callid, errorType, message) {
  const row = await env.DB.prepare(`SELECT attempt FROM calls WHERE callid=?`).bind(callid).first();
  const attempt = Number(row?.attempt || 0) + 1;
  if (attempt >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE calls SET status='FAILED',attempt=?,error_type=?,error_message=?,next_retry_at=NULL,updated_at=datetime('now') WHERE callid=?`
    ).bind(attempt, errorType, message, callid).run();
  } else {
    await env.DB.prepare(
      `UPDATE calls SET status='RETRY',attempt=?,error_type=?,error_message=?,next_retry_at=datetime('now','+' || ? || ' minutes'),updated_at=datetime('now') WHERE callid=?`
    ).bind(attempt, errorType, message, RETRY_MINUTES, callid).run();
  }
  await logError(env, callid, errorType, message, attempt);
}

async function logError(env, callid, errorType, message, attempt = 1) {
  try {
    await env.DB.prepare(`INSERT INTO errors(callid,error_type,error_message,attempt) VALUES(?,?,?,?)`)
      .bind(callid || null, errorType, String(message).slice(0, 1000), attempt).run();
  } catch (error) {
    console.error(`Failed to write error log: ${safeErrorMessage(error)}`);
  }
}

function safePayloadSummary(payload) {
  const keys = Object.keys(payload || {}).filter((key) => key !== "crm_token").sort();
  return JSON.stringify({
    keys,
    cmd: String(payload?.cmd || "").trim(),
    type: String(payload?.type || "").trim(),
    status: String(payload?.status || "").trim(),
    uid: String(payload?.uid || "").trim(),
    callid: String(payload?.callid || "").trim(),
    phone: String(payload?.phone || payload?.client || "").trim(),
    user: String(payload?.user || "").trim(),
    start: String(payload?.start || "").trim(),
    duration: String(payload?.duration ?? "").trim(),
    has_link: Boolean(payload?.link || payload?.record),
  });
}

function skippedCall(payload, callid, reason, durationOverride) {
  return {
    callid,
    phone: normalizePhone(payload?.phone || payload?.client),
    megafon_user: String(payload?.user || "").trim(),
    duration: durationOverride ?? parseNonNegativeInt(payload?.duration),
    record_url: safeUrl(payload?.link || payload?.record),
    call_start: String(payload?.start || "").trim(),
    call_type: String(payload?.type || "").trim(),
    call_status: String(payload?.status || "").trim(),
    status: "SKIPPED",
    error_type: "FILTER",
    error_message: reason,
  };
}

function parseNonNegativeInt(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return raw;
}

function safeUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch { return ""; }
}

function requireHttpsBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("HTTPS URL required");
  return url.toString();
}

function xmlTagValue(text, tag) {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXmlText(match[1]) : "";
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
