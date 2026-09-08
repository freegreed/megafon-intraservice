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
    recordUrl ? `Запись разговора: ${recordUrl}` : "Запись разговора отсутствует",
  ].join("\n");

  const body = {
    Name: `Звонок от ${phone || "неизвестного номера"}`,
    Description: description,
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
  await pool.query(
    `INSERT INTO errors(callid,error_type,error_message,attempt) VALUES($1,$2,$3,$4)`,
    [callid, errorType, message, nextAttempt],
  );
  log("error", "Call processing failed", { callid, status, attempt: nextAttempt, errorType, error: message });
}

async function retryFailedCalls() {
  const result = await pool.query(
    `SELECT callid FROM calls
     WHERE status='RETRY' AND attempt < $1
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     ORDER BY created_at ASC LIMIT 50`,
    [MAX_ATTEMPTS],
  );
  for (const row of result.rows) await processCall(row.callid, "RETRY");
}

function parseApiRows(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["history", "History", "calls", "Calls", "data", "Data", "result", "Result"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function normalizeHistoryRow(row) {
  const type = String(row?.type || row?.Type || "").toLowerCase();
  const status = String(row?.status || row?.Status || "").toLowerCase();
  const callid = String(row?.uid || row?.callid || row?.CallId || row?.id || "").trim();
  const duration = parseNonNegativeInt(row?.duration ?? row?.Duration);
  return {
    callid,
    type,
    status,
    duration,
    phone: normalizePhone(row?.client || row?.phone || row?.Client || row?.Phone),
    user: String(row?.user || row?.User || "").trim(),
    start: String(row?.start || row?.Start || "").trim(),
    record: safeUrl(row?.record || row?.link || row?.Record || row?.Link),
  };
}

async function reconcileMegaFonHistory() {
  const minutes = Math.max(5, Number(process.env.MEGAFON_HISTORY_LOOKBACK_MINUTES || 15));
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60_000);
  const params = new URLSearchParams({
    start: formatApiDate(start),
    end: formatApiDate(end),
    type: "in",
    limit: "1000",
  });

  const base = new URL(String(process.env.MEGAFON_API_URL));
  const url = new URL("history/json", `${base.toString().replace(/\/$/, "")}/`);
  url.search = params.toString();

  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-API-KEY": process.env.MEGAFON_API_KEY },
  });
  const responseText = await response.text();
  log("info", "MegaFon History API response", {
    status: response.status,
    ok: response.ok,
    url: `${url.origin}${url.pathname}${url.search}`,
    body: responseText.slice(0, 20_000),
  });
  if (!response.ok) throw new Error(`MegaFon History API HTTP ${response.status}: ${responseText.slice(0, 2000)}`);

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error("MegaFon History API returned invalid JSON");
  }

  let accepted = 0;
  for (const raw of parseApiRows(data)) {
    const row = normalizeHistoryRow(raw);
    if (!row.callid || row.type !== "in" || row.status !== "success" || row.duration <= MIN_DURATION_SEC) continue;

    const inserted = await insertCall({
      callid: row.callid,
      phone: row.phone,
      megafon_user: row.user,
      duration: row.duration,
      record_url: row.record,
      call_start: row.start,
      call_type: row.type,
      call_status: row.status,
      status: "RECEIVED",
    });
    if (inserted) {
      accepted += 1;
      void processCall(row.callid).catch((error) => log("error", "Async reconciliation processing failed", { callid: row.callid, error: safeErrorMessage(error) }));
    }
  }

  log("info", "MegaFon history reconciliation completed", { rows: parseApiRows(data).length, accepted });
}

function formatApiDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function withReconcileLock(fn) {
  const client = await pool.connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(6191744) AS locked");
    if (!lock.rows[0].locked) return false;
    try {
      await fn();
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock(6191744)");
    }
  } finally {
    client.release();
  }
}

async function reconcile() {
  const locked = await withReconcileLock(async () => {
    await retryFailedCalls();
    await reconcileMegaFonHistory();
  });
  if (!locked) log("info", "Reconciliation skipped: another process holds the lock");
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    try {
      await pool.query("SELECT 1");
      return jsonResponse(res, 200, { status: "ok", service: "megafon-intraservice", database: "ok" });
    } catch (error) {
      return jsonResponse(res, 503, { status: "error", database: safeErrorMessage(error) });
    }
  }

  if (req.method !== "POST" || !url.pathname.startsWith("/webhook/megafon/")) {
    return jsonResponse(res, 404, { error: "Not Found" });
  }

  try {
    const payload = await readPayload(req);
    if (payload?.crm_token !== process.env.MEGAFON_CRM_TOKEN) {
      log("warn", "Rejected MegaFon webhook: invalid token");
      return jsonResponse(res, 401, { error: "Unauthorized" });
    }

    const command = String(payload?.cmd || "").toLowerCase();
    if (command !== "history") {
      log("info", "MegaFon callback ignored", safePayloadSummary(payload));
      return jsonResponse(res, 200, { result: "ignored", reason: "Unsupported command" });
    }

    const call = parseHistoryPayload(payload);
    if (!call.ok) {
      log("warn", "MegaFon history rejected", { reason: call.reason, payload: safePayloadSummary(payload) });
      return jsonResponse(res, 400, { result: "rejected", reason: call.reason });
    }

    const inserted = await insertCall(call.data);
    if (!inserted) {
      log("info", "Duplicate webhook ignored", { callid: call.data.callid });
      return jsonResponse(res, 200, { result: "duplicate", callid: call.data.callid });
    }

    void processCall(call.data.callid).catch((error) => {
      log("error", "Async webhook processing failed", { callid: call.data.callid, error: safeErrorMessage(error) });
    });

    return jsonResponse(res, 200, { result: "accepted", callid: call.data.callid });
  } catch (error) {
    const message = safeErrorMessage(error);
    const status = message === "Payload Too Large" ? 413 : 400;
    log("error", "Webhook request failed", { error: message });
    return jsonResponse(res, status, { error: message });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    log("error", "Unhandled HTTP error", { error: safeErrorMessage(error) });
    if (!res.headersSent) jsonResponse(res, 500, { error: "Internal Server Error" });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  log("info", "Server started", { host: HOST, port: PORT });
});

const reconcileInterval = setInterval(() => {
  reconcile().catch((error) => log("error", "Scheduled reconciliation failed", { error: safeErrorMessage(error) }));
}, 5 * 60_000);
reconcileInterval.unref();

process.on("SIGTERM", async () => {
  clearInterval(reconcileInterval);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  clearInterval(reconcileInterval);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});

export { reconcile };
