# МегаФон ВАТС → IntraService

Production-интеграция на собственном Linux-сервере: Node.js + PostgreSQL + Nginx.

## Целевая схема

```text
МегаФон ВАТС
    │ HTTPS POST /webhook/megafon/
    ▼
Nginx :443
    │
    ▼
Node.js 127.0.0.1:3000
    ├── проверка crm_token
    ├── проверка cmd=history
    ├── проверка type=in
    ├── проверка status=success
    ├── проверка duration > 10
    └── PostgreSQL UNIQUE(callid)
             │
             ▼
       IntraService API
             │
             ▼
        заявка «Звонки»

Параллельно каждые 5 минут:
Node.js → MegaFon History API → PostgreSQL → IntraService
```

## Production-параметры

- Hostname: `megafon-api.sm-svetofor.ru`
- Node.js: 24 LTS
- PostgreSQL: 18
- PostgreSQL database: `megafon_intraservice`
- PostgreSQL user: `megafon_app`
- Node.js слушает только `127.0.0.1:3000`
- Nginx принимает внешний HTTPS-трафик
- PostgreSQL не публикуется в Internet

## Бизнес-правило

Создаётся ровно одна заявка IntraService на звонок, если одновременно выполнены условия:

- `cmd=history`;
- входящий звонок `type=in`;
- успешный `status=success`;
- `duration > 10` секунд;
- присутствует `uid`/`callid`.

`callid` является уникальным ключом PostgreSQL. Повторный webhook или повторная обработка не создаёт вторую заявку.

Перед POST в IntraService и после POST выполняется поиск по `Call ID`, чтобы защититься от ситуации, когда IntraService сохранил заявку, но клиент не получил корректный ответ.

## IntraService

- URL: `https://yfo-skfo.intraservice.ru`
- ServiceId: `619` («Звонки»)
- TypeId: `1024`
- PriorityId: `11` («Низкий»)
- StatusId: `29` («Выполнена»)
- CreatorId: `1744`
- ExecutorIds: `1744`

Служебные учётные данные хранятся только на сервере в `/etc/megafon-intraservice.env` и не находятся в Git.

## MegaFon

Webhook принимает как `application/x-www-form-urlencoded`, так и JSON.

Основной endpoint:

`POST https://megafon-api.sm-svetofor.ru/webhook/megafon/`

Для контроля пропущенных webhook Node.js периодически запрашивает MegaFon History API с `X-API-KEY`.

## Retry и идемпотентность

В PostgreSQL сохраняются:

- состояние обработки звонка;
- номер попытки;
- время следующей попытки;
- тип и текст ошибки;
- ID созданной заявки IntraService;
- история ошибок.

Временные ошибки повторяются с экспоненциальной задержкой до 5 попыток.

## Логи

Приложение пишет структурированные логи в stdout/stderr. При запуске через systemd они доступны через `journalctl`.

Для HTTP-вызовов IntraService и MegaFon сохраняется HTTP-статус и тело ответа (с ограничением размера). Пароли, API-ключи и CRM-токен в логи не выводятся.

## Запуск на сервере

```bash
npm install
npm run migrate
npm start
```

Для production используется `deploy/megafon-intraservice.service`.

Пример переменных окружения находится в `.env.example`. Реальный файл с секретами должен находиться вне Git, например `/etc/megafon-intraservice.env`, с правами `600`.

## Проверка

```text
GET /health
```

При исправной БД возвращается HTTP 200:

```json
{"status":"ok","service":"megafon-intraservice","database":"ok"}
```

## Структура

```text
.
├── src/server.js
├── scripts/migrate.js
├── migrations/001_postgresql.sql
├── deploy/megafon-intraservice.service
├── deploy/nginx-megafon-api.conf
├── .env.example
├── package.json
└── docs/
```

Старая Cloudflare-реализация удаляется из рабочего дерева, но остаётся доступной в истории Git.
