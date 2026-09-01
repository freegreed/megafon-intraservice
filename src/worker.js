/**
 * МегаФон ВАТС → Cloudflare Worker → D1 → IntraService
 *
 * Current integration contract is deliberately limited to data confirmed in
 * this project: IntraService service 619, task type 1024, low priority 11,
 * completed status 29, applicant/service user 1744.
 *
 * MegaFon history webhooks are accepted as either application/x-www-form-urlencoded
 * (native CRM integration format) or JSON. The canonical MegaFon field names are
 * callid and link; uid/record are retained only as compatibility aliases.
 */

const MIN_DURATION_SEC = 10;
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 5;
const MAX_BODY_BYTES = 64 * 1024;
const STALE_PROCESSING_MINUTES = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", service: "megafon-intraservice" });
    }

    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const expectedPath = `/webhook/megafon/${env.WEBHOOK_SECRET_PATH || ""}`;
    if (!env.WEBHOOK_SECRET_PATH || url.pathname !== expectedPath) {
      return json({ error: "Not Found" }, 404);
    }

    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
        return json({ error: "Payload Too Large" }, 413);
      }
    }

    let payload;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json({ error: "Payload Too Large" }, 413);
      }
      payload = parseWebhookBody(raw, request.headers.get("content-type") || "");
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    if (payload?.crm_token !== env.MEGAFON_CRM_TOKEN) {
      console.warn("Rejected MegaFon webhook: invalid token");
      return json({ error: "Unauthorized" }, 401);
    }

    const call = parseHistoryPayload(payload);
    if (!call.ok) {
      await logError(env, call.callid || null, "PAYLOAD", call.reason);
      return json({ result: "rejected", reason: call.reason }, 400);
    }

    const inserted = await insertCallIfAbsent(env, call.data);

    if (!inserted) {
      console.info(`Duplicate webhook ignored: ${call.data.callid}`);
      return json({ result: "duplicate", callid: call.data.callid }, 200);
    }

    // D1 is the durability boundary. If waitUntil is interrupted, the Cron
    // handler also recovers stale PROCESSING rows.
    ctx.waitUntil(processClaimedCall(env, call.data.callid));

    return json({ result: "accepted", callid: call.data.callid }, 200);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(retryFailedCalls(env));
    ctx.waitUntil(recoverStaleProcessing(env));
  },
};

function parseWebhookBody(raw, contentType) {
  const normalizedType = contentType.toLowerCase();

  if (normalizedType.includes("application/json")) {
    return JSON.parse(raw);
  }

  if (normalizedType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }

  throw new Error("Unsupported Content-Type");
}

function parseHistoryPayload(payload) {
  const cmd = String(payload?.cmd || "").trim().toLowerCase();
  const type = String(payload?.type || "").trim().toLowerCase();
  const status = String(payload?.status || "").trim().toLowerCase();
  const callid = String(payload?.callid || payload?.uid || "").trim();

  if (cmd !== "history") {
    return { ok: false, reason: "Unsupported command" };
  }

  if (!callid) {
    return { ok: false, reason: "Missing callid" };
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
  if (!user) {
    return { ok: true, data: skippedCall(payload, callid, "missing operator user", duration) };
  }

  return {
    ok: true,
    data: {
      callid,
      phone: normalizePhone(payload?.phone),
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

function skippedCall(payload, callid, reason, durationOverride) {
  return {
    callid,
    phone: normalizePhone(payload?.phone),
    megafon_user: String(payload?.user || "").trim(),
    duration: durationOverride ?? parseNonNegativeInt(payload?.duration),
    record_url: safeUrl(payload?.link || payload?.record),
    call_start: String(payload?.start || "").trim(),
    call_type: String(payload?.type || "").trim(),
    call_status: String(payload?.status || "").trim().toLowerCase(),
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
      operator: row.megafon_user,
      creatorId: env.IS_CREATOR_ID,
    });

    if (!taskId) {
      throw new Error("IntraService response did not contain task ID");
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

async function createIntraServiceTask(env, { phone, duration, recordUrl, callid, callStart, operator, creatorId }) {
  const baseUrl = requireHttpsBaseUrl(env.INTRASERVICE_URL);
  const url = `${baseUrl}/api/task`;
  const auth = btoa(`${requiredString(env.INTRASERVICE_LOGIN, "INTRASERVICE_LOGIN")}:${requiredString(env.INTRASERVICE_PASSWORD, "INTRASERVICE_PASSWORD")}`);

  const description = [
    `Номер клиента: ${phone || "не указан"}`,
    `Длительность: ${duration} сек.`,
    `Call ID: ${callid}`,
    `Время: ${callStart || "не указано"}`,
    `Оператор ВАТС: ${escapeHtml(operator || "не указан")}`,
    recordUrl
      ? `Запись разговора: <a href="${escapeHtmlAttribute(recordUrl)}">Открыть запись</a>`
      : "Запись разговора отсутствует",
  ].join("<br>");

  const body = {
    Name: `Звонок от ${phone || "неизвестного номера"}`,
    Description: description,
    ServiceId: requiredInt(env.IS_SERVICE_ID, "IS_SERVICE_ID"),
    TypeId: requiredInt(env.IS_TYPE_ID, "IS_TYPE_ID"),
    PriorityId: requiredInt(env.IS_PRIORITY_ID, "IS_PRIORITY_ID"),
    StatusId: requiredInt(env.IS_STATUS_DONE_ID, "IS_STATUS_DONE_ID"),
    CreatorId: requiredInt(creatorId, "IS_CREATOR_ID"),
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

  if (!response.ok) {
    throw new Error(`IntraService HTTP ${response.status}`);
  }

  return extractTaskId(responseText);
}

function extractTaskId(responseText) {
  if (!responseText) return null;

  try {
    const data = JSON.parse(responseText);
    return data.Id ?? data.id ?? data.TaskId ?? data.task_id ?? data.Task?.Id ?? data.task?.Id ?? null;
  } catch {
    const xmlMatch = responseText.match(/<Id>\s*(\d+)\s*<\/Id>/i);
    return xmlMatch ? Number(xmlMatch[1]) : null;
  }
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

async function recoverStaleProcessing(env) {
  await env.DB.prepare(
    `UPDATE calls
     SET status = 'RETRY',
         error_type = 'RECOVERY',
         error_message = 'Recovered stale PROCESSING state',
         next_retry_at = datetime('now'),
         updated_at = datetime('now')
     WHERE status = 'PROCESSING'
       AND updated_at <= datetime('now', ? || ' minutes')`
  ).bind(`-${STALE_PROCESSING_MINUTES}`).run();
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
      operator: row.megafon_user,
      creatorId: env.IS_CREATOR_ID,
    });

    if (!taskId) throw new Error("IntraService task ID missing");

    await env.DB.prepare(
      `UPDATE calls SET status='CREATED', intraservice_task_id=?,
       error_type=NULL, error_message=NULL, next_retry_at=NULL,
       updated_at=datetime('now') WHERE callid=?`
    ).bind(taskId, callid).run();
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
  return String(value ?? "").trim();
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

function requiredInt(value, name) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requireHttpsBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("INTRASERVICE_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
