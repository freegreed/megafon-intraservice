# МегаФон ВАТС → IntraService

Serverless-интеграция на Cloudflare Workers + D1.

## Целевая схема

```text
МегаФон ВАТС
    │ HTTPS POST / history
    ▼
Cloudflare Worker
    │
    ├── проверка secret path
    ├── проверка crm_token
    ├── проверка cmd=history
    ├── проверка type=in
    ├── проверка status=success
    ├── проверка duration > 10
    └── идемпотентная запись callid в D1
             │
             ▼
          D1 calls
             │
             ▼
       background processing
             │
             ▼
       IntraService API
             │
             ▼
        заявка «Звонки»
```

## Почему нет VPS

В production не требуется собственный Linux/Windows-сервер, Docker, Nginx или SSH. Worker исполняется в инфраструктуре Cloudflare, D1 используется как техническая БД. Это уменьшает количество компонентов, которые необходимо администрировать.

## Что делает текущая версия

- принимает только `POST`;
- endpoint имеет точный секретный путь `/webhook/megafon/<secret>`;
- проверяет `crm_token`;
- принимает только `cmd=history`;
- принимает только входящие `type=in`;
- принимает только успешные `status=success`;
- создаёт заявку только при `duration > 10` секунд;
- использует `uid` как уникальный `callid`;
- сохраняет событие в D1 до обращения к IntraService;
- защищает от повторной обработки через `INSERT OR IGNORE` + атомарный claim;
- повторяет временно неуспешные операции через Cron Trigger;
- ограничивает число попыток;
- не пишет секреты в логи;
- принимает только HTTPS-ссылку на запись разговора;
- имеет `/health` для технической проверки Worker.

## Важное ограничение

Автоматическая синхронизация сотрудников MegaFon → IntraService пока намеренно не включена. Формат MegaFon `GET /crmapi/v1/users` подтверждён, включая `login`, `name`, `email`, но перед включением синхронизации необходимо подтвердить способ авторизации API именно для вашей ВАТС. До этого сопоставление сотрудников хранится в D1 и заполняется после получения реальных данных.

## Структура

```text
.
├── src/
│   └── worker.js
├── schema.sql
├── wrangler.jsonc
├── package.json
├── .gitignore
├── README.md
└── docs/
    ├── ARCHITECTURE.md
    ├── SECURITY.md
    └── SETUP.md
```

## Перед первым deploy

1. Создать D1:
   `npx wrangler d1 create megafon-intraservice`
2. Полученный `database_id` внести в `wrangler.jsonc`.
3. Применить `schema.sql` к remote D1.
4. Создать все Cloudflare Secrets из `docs/SETUP.md`.
5. Получить реальные `ServiceId`, `TypeId`, `PriorityId`, `StatusId` и `ExecutorId` из IntraService.
6. Получить реальный пример webhook от вашей ВАТС и проверить поля.
7. Только после этого публиковать webhook в MegaFon.

## Тестовый endpoint

После deploy:

`GET /health`

должен вернуть:

```json
{"status":"ok","service":"megafon-intraservice"}
```

Webhook:

`POST /webhook/megafon/<WEBHOOK_SECRET_PATH>`

## Источники и проверка

Архитектура использует штатные механизмы Cloudflare Workers, D1, Secrets и Cron Triggers. Формат MegaFon history и сотрудников должен быть дополнительно проверен на реальной ВАТС перед production-включением. IntraService-параметры заявки должны быть подтверждены по вашей версии API.
