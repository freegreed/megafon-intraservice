# МегаФон ВАТС: контракт webhook

## Подтверждённые поля history

По доступной документации REST API ОАТС CRM команда `history` отправляется после успешного звонка и содержит данные звонка и ссылку на запись.

Для внешней истории JSON используется структура с полями:

```json
{
  "cmd": "history",
  "crm_token": "...",
  "uid": "1755936870",
  "type": "in",
  "status": "success",
  "client": "79993808397",
  "user": "admin",
  "user_name": "Администратор",
  "start": "2022-01-20T08:58:42Z",
  "wait": 5,
  "duration": 23,
  "record": ""
}
```

Для CRM webhook документация указывает `phone` как номер клиента. Поэтому Worker принимает `phone` для webhook и `client` не использует как основной источник номера.

## Бизнес-условие

Создаём заявку только если:

```text
cmd = history
AND type = in
AND status = success
AND duration > 10
AND user is present
AND uid is present
```

`duration = 10` не проходит. Требование пользователя — строго более 10 секунд.

## Оператор

Поле `user` — идентификатор пользователя ОАТС, предназначенный для сопоставления на стороне CRM.

API сотрудников `GET /crmapi/v1/users` возвращает как минимум `login`, `name`, `email`, `ext`, `telnum`, `role` и другие поля.

План сопоставления:

```text
history.user
    ↓
GET /crmapi/v1/users
    ↓
login + email
    ↓
IntraService email
    ↓
IntraService User.Id
```

## Что ещё нужно проверить на реальной ВАТС

1. Точный URL API вашей ВАТС.
2. Способ авторизации запросов к `GET /crmapi/v1/users` и `GET /crmapi/v1/history/json`.
3. Реальный JSON webhook от вашей ВАТС.
4. Реальное значение `phone` в webhook.
5. Реальный формат `record`.

До этой проверки автоматическую синхронизацию пользователей не включаем.
