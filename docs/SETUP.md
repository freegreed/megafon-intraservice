# Пошаговая установка

## Этап 0. Ничего не деплоить

Сначала получаем:

- реальный URL IntraService;
- параметры сервиса «Звонки»;
- права интеграционной учётки;
- реальный пример MegaFon `history` webhook;
- подтверждение API-доступа MegaFon.

## Этап 1. Cloudflare

На компьютере достаточно Node.js LTS и VS Code. Production-сервер не нужен.

Установить зависимости:

```bash
npm install
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

Задать секреты:

```bash
npx wrangler secret put MEGAFON_CRM_TOKEN
npx wrangler secret put WEBHOOK_SECRET_PATH
npx wrangler secret put INTRASERVICE_URL
npx wrangler secret put INTRASERVICE_LOGIN
npx wrangler secret put INTRASERVICE_PASSWORD
npx wrangler secret put IS_SERVICE_ID
npx wrangler secret put IS_TYPE_ID
npx wrangler secret put IS_PRIORITY_ID
npx wrangler secret put IS_STATUS_DONE_ID
npx wrangler secret put IS_EXECUTOR_ID
```

Значения секретов не отправлять в чат и не коммитить в Git.

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

## Этап 5. MegaFon

В CRM-интеграции ВАТС указать webhook URL:

```text
https://<worker>/webhook/megafon/<WEBHOOK_SECRET_PATH>
```

Тип события: `history`.

Не включать production-события до тестового звонка и проверки payload.

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

## Этап 7. IntraService

Перед первым реальным звонком определить через API вашей версии IntraService:

- ServiceId сервиса «Звонки»;
- TypeId типа заявки;
- PriorityId;
- StatusId «Выполнена»;
- User.Id системной учётки «Интеграция МегаФон»;
- User.Id операторов.

Сначала создать одну тестовую заявку через API и убедиться, что поля `CreatorId` и `ExecutorIds` принимаются вашей версией API.

## Этап 8. Сопоставление сотрудников

После получения реального списка MegaFon users и списка IntraService users заполнить `users_mapping`.

Пример:

```sql
INSERT INTO users_mapping
(megafon_login, megafon_name, email, intraservice_user_id, intraservice_name, active, mapping_status)
VALUES
('ivan', 'Иванов Иван', 'ivanov@example.ru', 152, 'Иванов Иван', 1, 'MATCHED');
```

Автоматическую синхронизацию включаем только после подтверждения API authentication.

## Этап 9. Финальные тесты

Проверить:

- входящий 5 секунд → заявки нет;
- входящий 10 секунд → заявки нет;
- входящий 11 секунд → заявка есть;
- входящий успешный → заявка есть;
- пропущенный → заявки нет;
- исходящий → заявки нет;
- неизвестный оператор → заявка не создаётся от неправильного пользователя;
- повтор webhook → второй заявки нет;
- временная ошибка IntraService → retry;
- 5 неудачных попыток → `ERROR`;
- отсутствующая запись → заявка всё равно создаётся;
- HTTPS запись → ссылка попадает в описание.
