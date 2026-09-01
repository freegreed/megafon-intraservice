# Архитектура

## 1. Основной поток

```text
МегаФон ВАТС
   │
   │ POST cmd=history
   │ application/x-www-form-urlencoded
   ▼
Cloudflare Worker
   │
   ├─ exact secret path
   ├─ crm_token
   ├─ parse form-urlencoded / JSON
   ├─ cmd=history
   ├─ type=in
   ├─ status=Success
   ├─ duration > 10
   │
   ▼
D1: calls
   │
   ├─ duplicate? → stop
   └─ new call → RECEIVED
             │
             ▼
        background processing
             │
             ▼
       IntraService POST /api/task
             │
             ├─ ServiceId 619
             ├─ TypeId 1024
             ├─ PriorityId 11
             ├─ StatusId 29
             └─ CreatorId 1744
             │
             ▼
       заявка «Звонки»
```

## 2. Роль заявителя

В текущей конфигурации заявитель не определяется по оператору ВАТС. Используется подтверждённый пользователь IntraService:

```text
UserId 1744
Служебный аккаунт
системная роль: Клиент
```

Поле `megafon_user` сохраняется в D1 и добавляется в описание заявки для аудита, но не используется для выбора заявителя или исполнителя.

## 3. Параметры заявки

```text
ServiceId  = 619
TypeId     = 1024
PriorityId = 11
StatusId   = 29
CreatorId  = 1744
```

Конкретный `ExecutorId` в текущем чате не подтверждён, поэтому `ExecutorIds` намеренно не отправляется. Это позволяет IntraService применить собственные правила назначения исполнителя, если они настроены на сервисе.

## 4. Идемпотентность

`callid` МегаФон используется как уникальный `callid` в D1.

Первичная запись выполняется через `INSERT OR IGNORE`. После этого Worker атомарно переводит запись из `RECEIVED` в `PROCESSING`. Второй параллельный webhook не сможет получить тот же claim.

## 5. Retry и восстановление

Состояния:

- `RECEIVED` — событие принято;
- `PROCESSING` — один Worker обрабатывает событие;
- `CREATED` — заявка создана;
- `SKIPPED` — звонок не соответствует условиям;
- `RETRY` — временная ошибка, будет повтор;
- `ERROR` — достигнут лимит попыток.

Retry использует экспоненциальную задержку с верхним пределом 60 минут. Cron запускается каждые 5 минут.

Дополнительно записи, зависшие в `PROCESSING` более 10 минут, переводятся обратно в `RETRY`. Это защищает от потери обработки после завершения HTTP-вызова и ограничения `waitUntil`.

## 6. Входной формат

Нативная REST-интеграция МегаФон передаёт `history` в формате form-urlencoded. Worker поддерживает также JSON для совместимости.

Канонические поля:

```text
cmd, type, status, user, phone, start,
duration, callid, link, crm_token
```

`callid` является идентификатором идемпотентности, `link` сохраняется как HTTPS-ссылка на запись.
