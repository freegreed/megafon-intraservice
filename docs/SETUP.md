# Пошаговая установка

## Этап 0. Подтверждённые параметры проекта

В текущем проекте используются:

- IntraService URL: `https://yfo-skfo.intraservice.ru`
- ServiceId: `619`
- TypeId: `1024`
- PriorityId: `11` — низкий
- StatusId: `29` — Выполнена
- ExecutorId: `1744` — «Служебный аккаунт»
- CreatorId: `1744` — «Служебный аккаунт»
- D1 database: `megafon-intraservice`
- D1 database ID: `ea1c5ad2-1a8e-404d-a2b2-bebdba22e8c5`

Параметры MegaFon ВАТС, подтверждённые в текущем проекте:

- API URL ВАТС: `https://vats123691.megapbx.ru/crmapi/v1`
- webhook CRM token: хранится только в Cloudflare Secret
- webhook path: хранится только в Cloudflare Secret

Секретные значения не отправлять в чат и не коммитить в Git.

## Этап 1. Cloudflare

Production-сервер и программы на пользовательском компьютере для работы интеграции не нужны. Worker собирается Cloudflare Workers Builds из подключённого GitHub-репозитория.

## Этап 2. D1

База уже создана и привязана к Worker через binding `DB`.

Схема должна содержать таблицы `calls`, `errors`, `users_mapping` и `sync_runs`.

`users_mapping` пока не используется в создании заявок: для текущей версии не требуется сопоставление оператора MegaFon с пользователем IntraService.

## Этап 3. Secrets

Worker требует только пять секретов:

```text
MEGAFON_CRM_TOKEN
WEBHOOK_SECRET_PATH
INTRASERVICE_URL
INTRASERVICE_LOGIN
INTRASERVICE_PASSWORD
```

Старые секреты `IS_SERVICE_ID`, `IS_TYPE_ID`, `IS_PRIORITY_ID`, `IS_STATUS_DONE_ID`, `IS_EXECUTOR_ID`, если они уже были созданы, можно оставить. Worker их больше не использует и не требует при deploy.

Cloudflare проверяет наличие секретов, перечисленных в `secrets.required`, во время deploy. urlДокументация Cloudflare по Secretshttps://developers.cloudflare.com/workers/configuration/secrets/

## Этап 4. Deploy

После изменения GitHub-репозитория Cloudflare Workers Builds должен автоматически запустить новый build.

Ожидаемый результат:

```text
Initializing   ✓
Cloning       ✓
Installing    ✓
Deploying     ✓
```

После успешного deploy проверить:

```text
GET https://<worker>/health
```

Ожидаемый ответ:

```json
{"status":"ok","service":"megafon-intraservice"}
```

## Этап 5. MegaFon

В CRM-интеграции ВАТС необходимо указать адрес CRM/webhook, который будет предоставлен после успешного deploy Worker:

```text
https://<worker>/webhook/megafon/<WEBHOOK_SECRET_PATH>
```

Важно: `https://vats123691.megapbx.ru/crmapi/v1` — это API самой ВАТС. Это не адрес webhook Worker.

## Этап 6. Обработка history

Worker принимает два формата тела webhook:

- `application/json`;
- `application/x-www-form-urlencoded`.

Из события используются:

```text
cmd
crm_token
uid / callid
 type
status
phone / client
user
start
duration
record
```

Бизнес-условие создания заявки:

```text
cmd = history
AND type = in
AND status = success
AND duration > 10
```

Оператор `user` сохраняется в D1, но отсутствие `user` больше не блокирует создание заявки.

Для номера используется `phone`; если он отсутствует, допускается `client`.

## Этап 7. Создание заявки IntraService

При прохождении фильтра создаётся заявка со следующими параметрами:

```text
ServiceId   = 619
TypeId      = 1024
PriorityId  = 11
StatusId    = 29
CreatorId   = 1744
ExecutorIds = 1744
```

Заявитель/создатель и исполнитель — один служебный аккаунт IntraService ID 1744.

В описание передаются:

- номер клиента;
- длительность разговора;
- Call ID;
- время звонка;
- ссылка на запись, если `record` содержит HTTPS URL.

## Этап 8. Дубликаты и ошибки

`uid`/`callid` хранится в D1 с уникальным ограничением. Повторное событие с тем же идентификатором не создаёт вторую заявку.

При ошибке обращения к IntraService:

- событие сохраняется в D1;
- выполняется retry;
- интервал увеличивается до 60 минут;
- после 5 неудачных попыток запись получает статус `ERROR`.

## Этап 9. Финальный тест

Проверить последовательно:

1. `GET /health` → HTTP 200.
2. Входящий звонок 5 секунд → заявки нет.
3. Входящий звонок 10 секунд → заявки нет.
4. Входящий звонок 11+ секунд → заявка создаётся.
5. Исходящий звонок → заявки нет.
6. Пропущенный звонок → заявки нет.
7. Повтор того же `uid` → второй заявки нет.
8. В заявке ServiceId = 619.
9. Тип = 1024.
10. Приоритет = 11.
11. Статус = 29 «Выполнена».
12. Исполнитель = 1744 «Служебный аккаунт».
13. Запись разговора попадает в описание, если MegaFon передал HTTPS URL.

Не включать массовую обработку production-событий до успешного одиночного тестового звонка.
