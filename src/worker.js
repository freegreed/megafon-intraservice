/**
 * МегаФон ВАТС → Cloudflare Worker → D1 → IntraService
 *
 * Production rules:
 * - принимает POST на /webhook/megafon/ и любой путь под /webhook/megafon/;
 * - принимает JSON и application/x-www-form-urlencoded;
 * - проверяет crm_token;
 * - обрабатывает только cmd=history, type=in, status=success;
 * - создаёт заявку только если duration > 10 секунд;
 * - использует uid/callid как идемпотентный идентификатор звонка;
 * - использует D1 как идемпотентное хранилище и очередь retry;
 * - перед созданием и после POST проверяет IntraService по Call ID, чтобы retry
 *   никогда не создавал вторую заявку после успешного POST;
 * - не требует сопоставления оператора MegaFon для создания заявки;
 * - заявитель и исполнитель IntraService — служебный аккаунт ID 1744;
 * - никогда не пишет секреты в логи.
 */

const MIN_DURATION_SEC = 10;
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 5;
const MAX_BODY_BYTES = 64 * 1024;

const IS_SERVICE_ID = 619;
const IS_TYPE_ID = 1024;
const IS_PRIORITY_ID = 11;
const IS_STATUS_DONE_ID = 29;
const IS_EXECUTOR_ID = 1744;
const IS_CREATOR_ID = 1744;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "megafon-intraservice" });
    }

    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const webhookBasePath = "/webhook/megafon/";
    if (!url.pathname.startsWith(webhookBasePath)) {
      return json({ error: "Not Found" }, 404);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Payload Too Large" }, 413);
    }

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

    const command = String(payload?.cmd || "").toLowerCase();

    // MegaFon can send several CRM callback types. Only the history callback
    // is used for ticket creation. Other valid callbacks must be acknowledged
    // with HTTP 200 so MegaFon does not retry them as failed deliveries.
    if (command !== "history") {
      console.info("MegaFon callback ignored", safePayloadSummary(payload));
      return json({ result: "ignored", reason: "Unsupported command" }, 200);
    }

    const call = parseHistoryPayload(payload);
    if (!call.ok) {
      const diagnostic = safePayloadSummary(payload);
      await logError(
        env,
        call.callid || null,
        "PAYLOAD",
        `${call.reason}; ${diagnostic}`,
      );
      console.warn(`MegaFon history rejected: ${call.reason}; ${diagnostic}`);
      return json({ result: "rejected", reason: call.reason }, 400);
    }

    const inserted = await insertCallIfAbsent(env, call.data);

    if (!inserted) {
      console.info(`Duplicate webhook ignored: ${call.data.callid}`);
      return json({ result: "duplicate", callid: call.data.callid }, 200);
    }

    ctx.waitUntil(processClaimedCall(env, call.data.callid));

    return json({ result: "accepted", callid: call.data.callid }, 200);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(retryFailedCalls(env));
  },
};

async function readPayload(request) {
  const raw = await request.text();

  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error("Payload Too Large");
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();

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

function parseHistoryPayload(payload) {
  const cmd = String(payload?.cmd || "").toLowerCase();
  const type = String(payload?.type || "").toLowerCase();
  const status = String(payload?.status || "").toLowerCase();
  const callid = String(payload?.uid || payload?.callid || "").trim();

  if (cmd !== "history") {
    return { ok: false, reason: "Unsupported command" };
  }

  if (!callid) {
    return { ok: false, reason: "Missing uid/callid" };
  }

  if (type !== "in") {
    return { ok: true, data: skippedCall(payload, callid, "not incoming") };
  }

  if (status !== "success") {
    return { ok: true, data: skippedCall(payload, callid, "not successful") };
  }

  const duration = parseNonNegativeInt(payload?.duration);
  if (duration <= MIN_DURATION_SEC) {
    return { ok: true, data: skippedCall(payload, callid, "duration <= 10s", duration) };
  }

  const user = String(payload?.user || "").trim();

  return {
    ok: true,
    data: {
      callid,
      phone: normalizePhone(payload?.phone || payload?.client),
      megafon_user: user,
      duration,
      record_url: safeUrl(payload?.link || payload?.record),
      call_start: String(payload?.start || "").trim(),
      call_type: type,
      call_status: status,
      status: "RECEIVED",
    },
  };
}

function safePayloadSummary(payload) {
  const keys = Object.keys(payload || {})
    .filter((key) => key !== "crm_token")
    .sort();

  const cmd = String(payload?.cmd || "").trim();
  const type = String(payload?.type || "").trim();
  const status = String(payload?.status || "").trim();
  const uid = String(payload?.uid || "").trim();
  const callid = String(payload?.callid || "").trim();
  const phone = String(payload?.phone || payload?.client || "").trim();
  const user = String(payload?.user || "").trim();
  const start = String(payload?.start || "").trim();
  const duration = String(payload?.duration ?? "").trim();

  return JSON.stringify({
    keys,
    cmd,
    type,
    status,
    uid,
    callid,
    phone,
    user,
    start,
    duration,
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

async function insertCallIfAbsent(env, call) {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO calls
      (callid, phone, megafon_user, duration, record_url, call_start,
       call_type, call_status, status, error_type, error_message, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
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
    )
    .run();

  return Number(result.meta?.changes || 0) === 1;
}

async function processClaimedCall(env, callid) {
  const claimed = await env.DB.prepare(
    `UPDATE calls
     SET status = 'PROCESSING', updated_at = datetime('now')
     WHERE callid = ? AND status = 'RECEIVED'`
  ).bind(callid).run();

  if (Number(claimed.meta?.changes || 0) !== 1) {
    return;
  }

  const row = await env.DB.prepare("SELECT * FROM calls WHERE callid = ?")
    .bind(callid)
    .first();

  if (!row) {
    await logError(env, callid, "DB", "Call disappeared after claim");
    return;
  }

  try {
    const taskId = await createIntraServiceTask(env, {
      phone: row.phone,
      duration: row.duration,
      recordUrl: row.record_url,
      callid: row.callid,
      callStart: row.call_start,
    });

    if (!taskId) {
      throw new Error("IntraService task ID missing after create/reconciliation");
    }

    await env.DB.prepare(
      `UPDATE calls
       SET status = 'CREATED', intraservice_task_id = ?,
           error_type = NULL, error_message = NULL,
           next_retry_at = NULL, updated_at = datetime('now')
       WHERE callid = ?`
    ).bind(taskId, callid).run();

    console.info(`Call ${callid} -> IntraService task ${taskId}`);
  } catch (error) {
    await scheduleRetry(env, callid, "PROCESS", safeErrorMessage(error));
  }
}

async function createIntraServiceTask(env, { phone, duration, recordUrl, callid, callStart }) {
  const baseUrl = requireHttpsBaseUrl(env.INTRASERVICE_URL);
  const auth = btoa(`${env.INTRASERVICE_LOGIN}:${env.INTRASERVICE_PASSWORD}`);

  // Safety check: if a previous attempt already created the task but failed
  // while reading its response, never create another task.
  const existingBefore = await findExistingIntraServiceTask(env, auth, callid);
  if (existingBefore) {
    console.info(`IntraService task ${existingBefore} already exists for ${callid}`);
    return existingBefore;
  }

  const url = `${baseUrl}/api/task`;

  const description = [
    `Номер клиента: ${phone || "не указан"}`,
    `Длительность: ${duration} сек.`,
    `Call ID: ${callid}`,
    `Время: ${callStart || "не указано"}`,
    recordUrl
      ? `Запись разговора: ${recordUrl}`
      : "Запись разговора отсутствует",
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();

  // Reconcile even after an HTTP error: some systems may persist the task
  // before returning an error/timeout to the client.
  const existingAfter = await findExistingIntraServiceTask(env, auth, callid);
  if (existingAfter) {
    console.info(`Reconciled IntraService task ${existingAfter} for ${callid}`);
    return existingAfter;
  }

  if (!response.ok) {
    const details = responseText.replace(/\s+/g, " ").trim().slice(0, 450);
    throw new Error(
      `IntraService HTTP ${response.status}${details ? `: ${details}` : ""}`,
    );
  }

  const taskId = extractTaskId(responseText);
  if (taskId) {
    return taskId;
  }

  throw new Error(
    `IntraService task created but ID could not be extracted${responseText ? `: ${responseText.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`,
  );
}

async function findExistingIntraServiceTask(env, auth, callid) {
  const baseUrl = requireHttpsBaseUrl(env.INTRASERVICE_URL);
  const params = new URLSearchParams({
    serviceid: String(IS_SERVICE_ID),
    fields: "Id,Name,Description",
    search: `Call ID: ${callid}`,
    pagesize: "10",
    page: "1",
  });

  const response = await fetch(`${baseUrl}/api/task?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`IntraService search HTTP ${response.status}`);
  }

  return extractMatchingTaskId(text, callid);
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
      if (id != null && description.includes(`Call ID: ${callid}`)) {
        return String(id);
      }
    }
  } catch {
    // Try XML below.
  }

  const taskBlocks = text.match(/<Task(?:\s[^>]*)?>[\s\S]*?<\/Task>/gi) || [];
  for (const block of taskBlocks) {
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
    return String(
      data?.Id ??
      data?.id ??
      data?.TaskId ??
      data?.task_id ??
      data?.Task?.Id ??
      data?.task?.Id ??
      "",
    ) || null;
  } catch {
    const id = xmlTagValue(text, "Id") || xmlTagValue(text, "TaskId");
    return id ? String(id) : null;
  }
}

function xmlTagValue(text, tag) {
  const match = text.match(new RegExp(`<${tag}(?:\s[^>]*)?>([\s\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function retryFailedCalls(env) {
  const rows = await env.DB.prepare(
    `SELECT callid
     FROM calls
     WHERE status = 'RETRY'
       AND attempt < ?
       AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
     ORDER BY created_at ASC
     LIMIT 50`
  ).bind(MAX_ATTEMPTS).all();

  for (const row of rows.results || []) {
    await processRetry(env, row.callid);
  }
}

async function processRetry(env, callid) {
  const claimed = await env.DB.prepare(
    `UPDATE calls
     SET status = 'PROCESSING', updated_at = datetime('now')
     WHERE callid = ? AND status = 'RETRY'`
  ).bind(callid).run();

  if (Number(claimed.meta?.changes || 0) !== 1) {
    return;
  }

  const row = await env.DB.prepare("SELECT * FROM calls WHERE callid = ?")
    .bind(callid)
    .first();

  if (!row) return;

  try {
    const taskId = await createIntraServiceTask(env, {
      phone: row.phone,
      duration: row.duration,
      recordUrl: row.record_url,
      callid: row.callid,
      callStart: row.call_start,
    });

    if (!taskId) throw new Error("IntraService task ID missing after retry/reconciliation");

    await env.DB.prepare(
      `UPDATE calls SET status='CREATED', intraservice_task_id=?,
       error_type=NULL, error_message=NULL, next_retry_at=NULL,
       updated_at=datetime('now') WHERE callid=?`
    ).bind(taskId, callid).run();

    console.info(`Retry ${callid} -> IntraService task ${taskId}`);
  } catch (error) {
    await scheduleRetry(env, callid, "RETRY", safeErrorMessage(error));
  }
}

async function scheduleRetry(env, callid, errorType, message) {
  const row = await env.DB.prepare("SELECT attempt FROM calls WHERE callid = ?")
    .bind(callid)
    .first();

  const nextAttempt = Number(row?.attempt || 0) + 1;
  const terminal = nextAttempt >= MAX_ATTEMPTS;
  const status = terminal ? "ERROR" : "RETRY";
  const delayMinutes = Math.min(RETRY_MINUTES * Math.pow(2, Math.max(0, nextAttempt - 1)), 60);

  await env.DB.prepare(
    `UPDATE calls
     SET status = ?, error_type = ?, error_message = ?, attempt = ?,
         next_retry_at = CASE WHEN ? = 'RETRY' THEN datetime('now', ? || ' minutes') ELSE NULL END,
         updated_at = datetime('now')
     WHERE callid = ?`
  ).bind(status, errorType, message, nextAttempt, status, String(delayMinutes), callid).run();

  await env.DB.prepare(
    `INSERT INTO errors (callid, error_type, error_message, attempt)
     VALUES (?, ?, ?, ?)`
  ).bind(callid, errorType, message, nextAttempt).run();

  console.error(`Call ${callid} processing failed; status=${status}; attempt=${nextAttempt}`);
}

async function logError(env, callid, errorType, message) {
  await env.DB.prepare(
    `INSERT INTO errors (callid, error_type, error_message, attempt)
     VALUES (?, ?, ?, 1)`
  ).bind(callid, errorType, message).run();
}

function normalizePhone(value) {
  const original = String(value ?? "").trim();
  if (!original) return "";

  const digits = original.replace(/\D/g, "");

  if (digits.length === 10 && digits.startsWith("9")) {
    return `+7${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }

  if (digits.length === 11 && digits.startsWith("7")) {
    return `+${digits}`;
  }

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

function requireHttpsBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("INTRASERVICE_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function safeErrorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
