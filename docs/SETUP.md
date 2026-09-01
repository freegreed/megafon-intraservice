# Пошаговая установка

## Этап 0. Проверяем конфигурацию

Подтверждённые параметры текущей интеграции:

```text
IntraService URL: https://yfo-skfo.intraservice.ru
ServiceId:        619   («Звонки»)
TypeId:           1024
PriorityId:       11    («Низкий»)
StatusId:         29    («Выполнена»)
CreatorId:        1744  («Служебный аккаунт», роль «Клиент»)
```

ID исполнителя не задаётся: в текущем чате он не подтверждён.

## Этап 1. Cloudflare

На компьютере достаточно Node.js LTS и VS Code.

Установить зависимости:

```bash
npm install
```

Запустить регрессионные тесты:

```bash
npm test
```

Авторизовать Wrangler:

```bash
npx wrangler login
```

Проверить:

```bash
npx wrangler whoami
```

## Этап 2. D1

Создать БД:

```bash
npx wrangler d1 create megafon-intraservice
```

Команда вернёт `database_id`. Его нужно вставить в `wrangler.jsonc` вместо:

```text
REPLACE_WITH_D1_DATABASE_ID
```

Применить схему:

```bash
npx wrangler d1 execute megafon-intraservice --remote --file=schema.sql
```

Проверить таблицы:

```bash
npx wrangler d1 execute megafon-intraservice --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

## Этап 3. Secrets

Задать только секреты:

```bash
npx wrangler secret put MEGAFON_CRM_TOKEN
npx wrangler secret put WEBHOOK_SECRET_PATH
npx wrangler secret put INTRASERVICE_LOGIN
npx wrangler secret put INTRASERVICE_PASSWORD
```

Секреты не отправлять в чат и не коммитить в Git.

## Этап 4. Первый deploy

```bash
npx wrangler deploy
```

Получить URL Worker.

Проверить:

```text
GET https://<worker>/health
```

Ожидаемый ответ:

```json
{"status":"ok","service":"megafon-intraservice"}
```

Webhook URL:

```text
https://<worker>/webhook/megafon/<WEBHOOK_SECRET_PATH>
```

## Этап 5. МегаФон ВАТС

В настройках интеграции CRM вашей ВАТС указать webhook URL Worker.

Для `history` Worker ожидает стандартные поля:

```text
cmd=history
type=in
status=Success
user=<оператор>
phone=<номер>
start=<время>
duration=<секунды>
callid=<уникальный ID>
link=<HTTPS запись>
crm_token=<ключ>
```

Нативный формат МегаФон — `application/x-www-form-urlencoded`; Worker также принимает JSON.

## Этап 6. Тестовый звонок

Сделать входящий звонок с разговором более 10 секунд.

Проверить Worker logs:

```bash
npx wrangler tail
```

Проверить D1:

```bash
npx wrangler d1 execute megafon-intraservice --remote --command="SELECT callid, phone, megafon_user, duration, status, intraservice_task_id FROM calls ORDER BY id DESC LIMIT 20;"
```

## Этап 7. Контроль создания заявки

Ожидаемая заявка:

```text
Сервис:     619 — «Звонки»
Тип:        1024
Приоритет:  11 — «Низкий»
Статус:     29 — «Выполнена»
Заявитель:  1744 — «Служебный аккаунт»
```

Исполнитель не задаётся API-интеграцией.

## Этап 8. Финальные тесты

Проверить:

- входящий 5 секунд → заявки нет;
- входящий 10 секунд → заявки нет;
- входящий 11 секунд → заявка есть;
- входящий успешный → заявка есть;
- пропущенный → заявки нет;
- исходящий → заявки нет;
- повтор одного `callid` → второй заявки нет;
- временная ошибка IntraService → retry;
- 5 неудачных попыток → `ERROR`;
- зависший `PROCESSING` более 10 минут → восстановление в `RETRY`;
- отсутствующая запись → заявка всё равно создаётся;
- HTTPS запись → ссылка попадает в описание.

Фактическое создание заявки в вашей production-системе нельзя считать подтверждённым до выполнения тестового звонка с реальными секретами.
