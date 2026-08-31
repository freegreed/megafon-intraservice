/**
 * ============================================================
 *  Worker: МегаФон ВАТС → IntraService
 *  Webhook-обработчик для интеграции телефонии и HelpDesk
 * ============================================================
 *
 * Архитектура:
 *   МегаФон ВАТС
 *      ↓ HTTPS POST webhook
 *   Cloudflare Worker (этот файл)
 *      ↓
 *   Cloudflare D1 (защита от дублей, аудит, retry)
 *      ↓
 *   IntraService API (создание заявки)
 *
 * Секреты (задаются через `npx wrangler secret put`):
 *   MEGAFON_CRM_TOKEN      — crm_token из МегаФона
 *   WEBHOOK_SECRET_PATH    — случайный сегмент в URL
 *   INTRASERVICE_URL       — базовый URL IntraService
 *   INTRASERVICE_LOGIN     — логин учётки «Интеграция МегаФон»
 *   INTRASERVICE_PASSWORD  — пароль учётки «Интеграция МегаФон»
 *   MEGAFON_API_URL        — URL API МегаФона (для синхронизации)
 *   MEGAFON_API_TOKEN      — токен API МегаФона
 *   IS_SERVICE_ID          — ID сервиса «Звонки»
 *   IS_TYPE_ID             — ID типа заявки
 *   IS_PRIORITY_ID         — ID приоритета
 *   IS_STATUS_DONE_ID      — ID статуса «Выполнена»
 *   IS_EXECUTOR_ID         — ID исполнителя (учётка интеграции)
 */

// ── Константы бизнес-логики ──────────────────────────────────
const MIN_DURATION_SEC = 10;          // минимальная длительность разговора
const MAX_ATTEMPTS = 5;                // максимум попыток retry

// ── Точка входа Worker ──────────────────────────────────────
export default {
  /**
   * Обработка HTTP-запросов (webhook от МегаФона)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Разрешаем только POST
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    // Проверяем секретный путь
    const secretPath = env.WEBHOOK_SECRET_PATH;
    if (secretPath && !url.pathname.includes(secretPath)) {
      return json({ error: "Not Found" }, 404);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    // Обрабатываем событие
    const result = await handleMegafonEvent(payload, env);
    return json(result.body, result.status);
  },

  /**
   * Cron Trigger — контрольная сверка и retry
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(retryFailedCalls(env));
    ctx.waitUntil(syncUsers(env));
  },
};

// ── Основная логика обработки события ───────────────────────
async function handleMegafonEvent(payload, env) {
  // 1. Проверка crm_token
  if (payload.crm_token !== env.MEGAFON_CRM_TOKEN) {
    await logError(env, null, "AUTH", "Invalid crm_token");
    return { status: 401, body: { error: "Unauthorized" } };
  }

  // 2. Извлекаем данные звонка
  const data = payload.data || payload;
  const callid = String(data.uid || data.callid || data.id || "");
  if (!callid) {
    return { status: 400, body: { error: "Missing callid" } };
  }

  const callType = data.type || payload.type || "";
  const callStatus = data.status || payload.status || "";
  const duration = parseInt(data.duration || "0", 10);
  const recordUrl = data.record || data.recording || "";
  const phone = data.from || data.phone || data.client || "";
  const megafonUser = data.user || data.operator || "";
  const callStart = data.start || data.calldate || data.created || "";

  // 3. Бизнес-условия: только входящие, успешные, > 10 сек
  if (callType !== "incoming") {
    await saveCall(env, { callid, phone, megafonUser, duration, recordUrl, callStart, callType, callStatus, status: "SKIPPED" });
    return { status: 200, body: { result: "skipped", reason: "not incoming" } };
  }

  if (callStatus !== "Success" && callStatus !== "success") {
    await saveCall(env, { callid, phone, megafonUser, duration, recordUrl, callStart, callType, callStatus, status: "SKIPPED" });
    return { status: 200, body: { result: "skipped", reason: "call not success" } };
  }

  if (duration <= MIN_DURATION_SEC) {
    await saveCall(env, { callid, phone, megafonUser, duration, recordUrl, callStart, callType, callStatus, status: "SKIPPED" });
    return { status: 200, body: { result: "skipped", reason: "duration <= 10s" } };
  }

  // 4. Проверка на дубль
  const existing = await env.DB.prepare("SELECT callid, status FROM calls WHERE callid = ?").bind(callid).first();
  if (existing && (existing.status === "CREATED" || existing.status === "PROCESSING")) {
    return { status: 200, body: { result: "duplicate", callid } };
  }

  // 5. Сохраняем событие в D1
  await saveCall(env, { callid, phone, megafonUser, duration, recordUrl, callStart, callType, callStatus, status: "RECEIVED" });

  // 6. Обрабатываем
  try {
    await processCall(env, callid, phone, megafonUser, duration, recordUrl, callStart);
    return { status: 200, body: { result: "created", callid } };
  } catch (err) {
    await markError(env, callid, "PROCESS", err.message);
    return { status: 200, body: { result: "retry", callid, error: err.message } };
  }
}

// ── Обработка звонка: сопоставление + создание заявки ───────
async function processCall(env, callid, phone, megafonUser, duration, recordUrl, callStart) {
  await updateCallStatus(env, callid, "PROCESSING");

  // 1. Найти сотрудника в сопоставлении
  const mapping = await env.DB.prepare(
    "SELECT intraservice_user_id, intraservice_name FROM users_mapping WHERE megafon_login = ? AND active = 1"
  ).bind(megafonUser).first();

  if (!mapping) {
    throw new Error(`Operator not found in mapping: ${megafonUser}`);
  }

  // 2. Создать заявку в IntraService
  const taskId = await createIntraServiceTask(env, {
    phone, duration, recordUrl, callid, callStart,
    creatorId: mapping.intraservice_user_id,
  });

  // 3. Обновить запись
  await env.DB.prepare(
    "UPDATE calls SET status = 'CREATED', intraservice_task_id = ?, updated_at = datetime('now') WHERE callid = ?"
  ).bind(taskId, callid).run();
}

// ── Создание заявки в IntraService ───────────────────────────
async function createIntraServiceTask(env, { phone, duration, recordUrl, callid, callStart, creatorId }) {
  const url = `${env.INTRASERVICE_URL}/api/task`;
  const auth = btoa(`${env.INTRASERVICE_LOGIN}:${env.INTRASERVICE_PASSWORD}`);

  const description = [
    `Номер клиента: ${phone}`,
    `Длительность: ${duration} сек.`,
    `Call ID: ${callid}`,
    `Время: ${callStart}`,
    "",
    recordUrl ? `Запись разговора: <a href="${recordUrl}">Открыть запись</a>` : "Запись отсутствует",
  ].join("\n");

  const body = {
    Name: `Звонок от ${phone}`,
    Description: description,
    ServiceId: parseInt(env.IS_SERVICE_ID, 10),
    TypeId: parseInt(env.IS_TYPE_ID, 10),
    PriorityId: parseInt(env.IS_PRIORITY_ID, 10),
    StatusId: parseInt(env.IS_STATUS_DONE_ID, 10),
    CreatorId: creatorId,
    ExecutorIds: String(env.IS_EXECUTOR_ID),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IntraService HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  // IntraService возвращает Id созданной заявки
  return data.Id || data.id || data.TaskId || data.task_id;
}

// ── Синхронизация сотрудников МегаФон ↔ IntraService ────────
async function syncUsers(env) {
  // 1. Получаем сотрудников из МегаФона
  const megafonRes = await fetch(`${env.MEGAFON_API_URL}/crmapi/v1/users`, {
    headers: { "Authorization": `Bearer ${env.MEGAFON_API_TOKEN}` },
  });
  if (!megafonRes.ok) {
    await logError(env, null, "SYNC_MEGAFON", `HTTP ${megafonRes.status}`);
    return;
  }
  const megafonUsers = await megafonRes.json();
  const mfList = megafonUsers.data || megafonUsers.result || megafonUsers;

  // 2. Получаем пользователей IntraService
  const isAuth = btoa(`${env.INTRASERVICE_LOGIN}:${env.INTRASERVICE_PASSWORD}`);
  const isRes = await fetch(`${env.INTRASERVICE_URL}/api/user`, {
    headers: { "Authorization": `Basic ${isAuth}` },
  });
  if (!isRes.ok) {
    await logError(env, null, "SYNC_INTRASERVICE", `HTTP ${isRes.status}`);
    return;
  }
  const isUsers = await isRes.json();
  const isList = isUsers.data || isUsers.result || isUsers;

  // 3. Строим индекс email → IntraService UserId
  const emailToIS = new Map();
  for (const u of isList) {
    if (u.Email || u.email) {
      emailToIS.set((u.Email || u.email).toLowerCase(), { id: u.Id || u.id, name: u.Name || u.name });
    }
  }

  // 4. Сопоставляем и обновляем D1
  for (const mf of mfList) {
    const login = mf.login || mf.Login;
    const name = mf.name || mf.Name || "";
    const email = (mf.email || mf.Email || "").toLowerCase();
    if (!login) continue;

    const match = emailToIS.get(email);
    await env.DB.prepare(
      `INSERT INTO users_mapping (megafon_login, megafon_name, email, intraservice_user_id, intraservice_name, active, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(megafon_login) DO UPDATE SET
         megafon_name = excluded.megafon_name,
         email = excluded.email,
         intraservice_user_id = excluded.intraservice_user_id,
         intraservice_name = excluded.intraservice_name,
         updated_at = datetime('now')`
    ).bind(login, name, email, match ? match.id : null, match ? match.name : null).run();
  }
}

// ── Retry: повторная обработка звонков в статусе ERROR/RETRY ─
async function retryFailedCalls(env) {
  const rows = await env.DB.prepare(
    "SELECT * FROM calls WHERE status IN ('ERROR','RETRY') AND attempt < ? ORDER BY created_at ASC LIMIT 50"
  ).bind(MAX_ATTEMPTS).all();

  for (const row of rows.results || []) {
    try {
      await processCall(env, row.callid, row.phone, row.megafon_user, row.duration, row.record_url, row.call_start);
    } catch (err) {
      await markError(env, row.callid, "RETRY", err.message);
    }
  }
}

// ── Вспомогательные функции D1 ───────────────────────────────
async function saveCall(env, c) {
  await env.DB.prepare(
    `INSERT INTO calls (callid, phone, megafon_user, duration, record_url, call_start, call_type, call_status, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(callid) DO UPDATE SET
       phone = excluded.phone,
       megafon_user = excluded.megafon_user,
       duration = excluded.duration,
       record_url = excluded.record_url,
       call_start = excluded.call_start,
       call_type = excluded.call_type,
       call_status = excluded.call_status,
       status = excluded.status,
       updated_at = datetime('now')`
  ).bind(c.callid, c.phone, c.megafonUser, c.duration, c.recordUrl, c.callStart, c.callType, c.callStatus, c.status).run();
}

async function updateCallStatus(env, callid, status) {
  await env.DB.prepare(
    "UPDATE calls SET status = ?, updated_at = datetime('now') WHERE callid = ?"
  ).bind(status, callid).run();
}

async function markError(env, callid, errorType, errorMessage) {
  await env.DB.prepare(
    "UPDATE calls SET status = 'ERROR', error_type = ?, error_message = ?, attempt = attempt + 1, updated_at = datetime('now') WHERE callid = ?"
  ).bind(errorType, errorMessage, callid).run();
  await logError(env, callid, errorType, errorMessage);
}

async function logError(env, callid, errorType, errorMessage) {
  await env.DB.prepare(
    "INSERT INTO errors (callid, error_type, error_message, attempt) VALUES (?, ?, ?, 1)"
  ).bind(callid, errorType, errorMessage).run();
}

// ── Утилиты ──────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
