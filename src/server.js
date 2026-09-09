import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const MIN_DURATION_SEC = 10;
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 5;

const IS_SERVICE_ID = 619;
const IS_TYPE_ID = 1024;
const IS_PRIORITY_ID = 11;
const IS_STATUS_DONE_ID = 29;
const IS_EXECUTOR_ID = 1744;
const IS_CREATOR_ID = 1744;

const requiredEnv = [
  "DATABASE_URL",
  "MEGAFON_CRM_TOKEN",
  "MEGAFON_API_KEY",
  "MEGAFON_API_URL",
  "INTRASERVICE_URL",
  "INTRASERVICE_LOGIN",
  "INTRASERVICE_PASSWORD",
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => {
  console.error("PostgreSQL pool error", error);
});

function log(level, message, details = undefined) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: "megafon-intraservice",
    message,
  };
  if (details !== undefined) entry.details = details;
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify(entry),
  );
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 1000);
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readRequestBody(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("Payload Too Large");

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) throw new Error("Payload Too Large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readPayload(req) {
  const raw = await readRequestBody(req);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON");
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }

  throw new Error("Content-Type must be application/json or application/x-www-form-urlencoded");
}

function normalizePhone(value) {
  const original = String(value ?? "").trim();
  if (!original) return "";
  const digits = original.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("9")) return `+7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  return original;
}

function safeUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function parseNonNegativeInt(value) {
  const number = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(number) && number >= 0 ? number : 0;
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
  if (duration <= MIN_DURATION_SEC) {
    return { ok: true, data: skippedCall(payload, callid, "duration <= 10s", duration) };
  }

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

async function insertCall(call) {
  const result = await pool.query(
    `INSERT INTO calls
      (callid, phone, megafon_user, duration, record_url, call_start,
       call_type, call_status, status, error_type, error_message, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (callid) DO NOTHING
     RETURNING id`,
    [
      call.callid,
      call.phone,
      call.megafon_user,
      call.duration,
      call.record_url,
      call.call_start,
      call.call_type,
      call.call_status,
      call.status,
      call.error_type || null,
      call.error_message || null,
    ],
  );
  return result.rowCount === 1;
}

async function claimCall(callid, fromStatus) {
  const result = await pool.query(
    `UPDATE calls SET status='PROCESSING', updated_at=NOW()
     WHERE callid=$1 AND status=$2
     RETURNING *`,
    [callid, fromStatus],
  );
  return result.rows[0] || null;
}

async function processCall(callid, fromStatus = "RECEIVED") {
  const row = await claimCall(callid, fromStatus);
  if (!row) return;

  try {
    const taskId = await createIntraServiceTask({
      phone: row.phone,
      duration: row.duration,
      recordUrl: row.record_url,
      callid: row.callid,
      callStart: row.call_start,
    });

    if (!taskId) throw new Error("IntraService task ID missing after create/reconciliation");

    await pool.query(
      `UPDATE calls SET status='CREATED', intraservice_task_id=$1,
       error_type=NULL, error_message=NULL, next_retry_at=NULL,
       updated_at=NOW() WHERE callid=$2`,
      [taskId, callid],
    );
    log("info", "Call processed", { callid, taskId });
  } catch (error) {
    await scheduleRetry(callid, "PROCESS", safeErrorMessage(error));
  }
}

function requireHttpsBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("INTRASERVICE_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function extractMatchingTaskId(text, callid) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const tasks = Array.isArray(data?.Tasks)
      ? data.Tasks
      : Array.isArray(data)
        ? data
        : data?.Task
          ? [data.Task]
          : [];
    for (const task of tasks) {
      const id = task?.Id ?? task?.id;
      const description = String(task?.Description ?? task?.description ?? "");
      if (id != null && description.includes(`Call ID: ${callid}`)) return String(id);
    }
  } catch {
    // XML fallback below.
  }

  const blocks = text.match(/<Task(?:\s[^>]*)?>[\s\S]*?<\/Task>/gi) || [];
  for (const block of blocks) {
    const description = xmlTagValue(block, "Description");
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
    const id = data?.Id ?? data?.id ?? data?.TaskId ?? data?.task_id ?? data?.Task?.Id ?? data?.task?.Id;
    return id == null || id === "" ? null : String(id);
  } catch {
    const id = xmlTagValue(text, "Id") || xmlTagValue(text, "TaskId");
    return id || null;
  }
}

function xmlTagValue(text, tag) {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim() : "";
}

async function intraserviceRequest(method, path, body = undefined) {
  const baseUrl = requireHttpsBaseUrl(process.env.INTRASERVICE_URL);
  const auth = Buffer.from(`${process.env.INTRASERVICE_LOGIN}:${process.env.INTRASERVICE_PASSWORD}`).toString("base64");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseText = await response.text();
  log("info", "IntraService HTTP response", {
    method,
    path,
    status: response.status,
    ok: response.ok,
    body: responseText.slice(0, 20_000),
  });
  return { response, responseText, auth };
}

async function findExistingIntraServiceTask(callid) {
  const params = new URLSearchParams({
    serviceid: String(IS_SERVICE_ID),
    fields: "Id,Name,Description",
    search: `Call ID: ${callid}`,
    pagesize: "10",
    page: "1",
  });
  const { response, responseText } = await intraserviceRequest("GET", `/api/task?${params.toString()}`);
  if (!response.ok) throw new Error(`IntraService search HTTP ${response.status}: ${responseText.slice(0, 1000)}`);
  return extractMatchingTaskId(responseText, callid);
}

async function createIntraServiceTask({ phone, duration, recordUrl, callid, callStart }) {
  const existingBefore = await findExistingIntraServiceTask(callid);
  if (existingBefore) {
    log("info", "Existing IntraService task found before POST", { callid, taskId: existingBefore });
    return existingBefore;
  }

  const description = [
    `Номер клиента: ${phone || "не указан"}`,
    `Длительность: ${duration} сек.`,
    `Call ID: ${callid}`,
    `Время: ${callStart || "не указано"}`,
  ].join("\n");

  const body = {
    Name: `Звонок от ${phone || "неизвестного номера"}`,
    Description: description,
    Comment: recordUrl ? `Запись разговора: ${recordUrl}` : "Запись разговора отсутствует",
    ServiceId: IS_SERVICE_ID,
    TypeId: IS_TYPE_ID,
    PriorityId: IS_PRIORITY_ID,
    StatusId: IS_STATUS_DONE_ID,
    CreatorId: IS_CREATOR_ID,
    ExecutorIds: String(IS_EXECUTOR_ID),
  };

  const { response, responseText } = await intraserviceRequest("POST", "/api/task", body);

  const existingAfter = await findExistingIntraServiceTask(callid);
  if (existingAfter) {
    log("info", "IntraService task reconciled after POST", { callid, taskId: existingAfter });
    return existingAfter;
  }

  if (!response.ok) {
    throw new Error(`IntraService HTTP ${response.status}: ${responseText.slice(0, 2000)}`);
  }

  const taskId = extractTaskId(responseText);
  if (!taskId) {
    throw new Error(`IntraService task created but ID could not be extracted: ${responseText.slice(0, 2000)}`);
  }
  return taskId;
}

async function scheduleRetry(callid, errorType, message) {
  const result = await pool.query("SELECT attempt FROM calls WHERE callid=$1", [callid]);
  const nextAttempt = Number(result.rows[0]?.attempt || 0) + 1;
  const terminal = nextAttempt >= MAX_ATTEMPTS;
  const status = terminal ? "ERROR" : "RETRY";
  const delayMinutes = Math.min(RETRY_MINUTES * 2 ** Math.max(0, nextAttempt - 1), 60);

  await pool.query(
    `UPDATE calls SET status=$1,error_type=$2,error_message=$3,attempt=$4,
      next_retry_at=CASE WHEN $1='RETRY' THEN NOW()+($5 || ' minutes')::interval ELSE NULL END,
      updated_at=NOW() WHERE callid=$6`,
    [status, errorType, message, nextAttempt, String(delayMinutes), callid],
  );

  log(terminal ? "error" : "warn", "Call processing failed", {
    callid,
    errorType,
    error: message,
    attempt: nextAttempt,
    nextRetryAtMinutes: terminal ? null : delayMinutes,
    terminal,
  });
}

async function retryDueCalls() {
  const result = await pool.query(
    `SELECT callid FROM calls
     WHERE status='RETRY' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
     ORDER BY next_retry_at ASC LIMIT 20`,
  );
  for (const row of result.rows) {
    await processCall(row.callid, "RETRY");
  }
}

async function reconcileHistory() {
  const base = String(process.env.MEGAFON_API_URL || "").replace(/\/$/, "");
  const apiKey = process.env.MEGAFON_API_KEY;
  const url = `${base}/crmapi/v1/history/json?type=in&limit=100`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body = await response.text();
    log("info", "MegaFon history response", {
      status: response.status,
      ok: response.ok,
      body: body.slice(0, 20_000),
    });
    if (!response.ok) return;

    let rows;
    try {
      rows = JSON.parse(body);
    } catch (error) {
      log("warn", "MegaFon history JSON parse failed", { error: safeErrorMessage(error) });
      return;
    }

    if (!Array.isArray(rows)) return;
    for (const item of rows) {
      const parsed = parseHistoryPayload({
        cmd: "history",
        type: item?.type,
        status: item?.status,
        uid: item?.uid,
        phone: item?.phone,
        client: item?.client,
        user: item?.user,
        duration: item?.duration,
        record: item?.record,
        start: item?.start,
      });
      if (!parsed.ok) continue;
      const inserted = await insertCall(parsed.data);
      if (inserted && parsed.data.status === "RECEIVED") {
        await processCall(parsed.data.callid);
      }
    }
  } catch (error) {
    log("error", "MegaFon history reconciliation failed", { error: safeErrorMessage(error) });
  }
}

async function startup() {
  await pool.query("SELECT 1");
  log("info", "Database connected");
  await reconcileHistory();
  setInterval(() => reconcileHistory().catch((error) => log("error", "History interval failed", { error: safeErrorMessage(error) })), 60_000);
  setInterval(() => retryDueCalls().catch((error) => log("error", "Retry interval failed", { error: safeErrorMessage(error) })), 30_000);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      await pool.query("SELECT 1");
      return jsonResponse(res, 200, { status: "ok", service: "megafon-intraservice", database: "ok" });
    }

    if (req.method !== "POST" || req.url !== "/webhook/megafon/") {
      return jsonResponse(res, 404, { error: "Not found" });
    }

    const payload = await readPayload(req);
    log("info", "MegaFon webhook received", { summary: safePayloadSummary(payload) });

    if (String(payload?.crm_token || "") !== process.env.MEGAFON_CRM_TOKEN) {
      return jsonResponse(res, 401, { error: "Unauthorized" });
    }

    const parsed = parseHistoryPayload(payload);
    if (!parsed.ok) return jsonResponse(res, 200, { result: "ignored", reason: parsed.reason });

    const inserted = await insertCall(parsed.data);
    if (inserted && parsed.data.status === "RECEIVED") {
      await processCall(parsed.data.callid);
      return jsonResponse(res, 200, { result: "accepted", callid: parsed.data.callid });
    }

    return jsonResponse(res, 200, { result: "ignored", reason: inserted ? parsed.data.error_message || parsed.data.status : "duplicate", callid: parsed.data.callid });
  } catch (error) {
    const message = safeErrorMessage(error);
    log("error", "Webhook handling failed", { error: message });
    return jsonResponse(res, message === "Payload Too Large" ? 413 : 400, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  log("info", "Server started", { host: HOST, port: PORT });
});

startup().catch((error) => {
  log("error", "Startup failed", { error: safeErrorMessage(error) });
  process.exit(1);
});
