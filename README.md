# МегаФон ВАТС → IntraService

Интеграция принимает историю звонков МегаФон ВАТС, сохраняет событие в Cloudflare D1 и создаёт заявку через REST API IntraService.

## Подтверждённая конфигурация IntraService

| Параметр | Значение |
|---|---:|
| Сервис «Звонки» | `619` |
| Тип заявки | `1024` |
| Приоритет | `11` — низкий |
| Статус | `29` — «Выполнена» |
| Заявитель | `1744` — «Служебный аккаунт», системная роль «Клиент» |
| IntraService URL | `https://yfo-skfo.intraservice.ru` |

Эти значения взяты только из текущего проекта и предоставленных в этом чате данных. Не использовать значения из других проектов.

## Входящий webhook МегаФон

Основной формат REST-интеграции МегаФон — `application/x-www-form-urlencoded`. Worker также принимает JSON как совместимый вариант.

Для команды `history` используются поля:

- `cmd=history`;
- `type=in` — входящий звонок;
- `status=Success` — успешный звонок;
- `user` — идентификатор пользователя ВАТС;
- `phone` — номер клиента;
- `start` — время начала;
- `duration` — длительность;
- `callid` — уникальный ID звонка;
- `link` — ссылка на запись разговора;
- `crm_token` — ключ CRM.

Worker принимает только успешные входящие звонки длительностью **более 10 секунд**. `callid` является уникальным ключом, поэтому повтор одного webhook не создаёт вторую заявку.

## Создание заявки

Worker отправляет `POST /api/task` в IntraService с Basic Authentication. API IntraService работает с Basic Authentication и для создания заявки принимает поля объекта Task. citeturn6search0turn3search1

В заявку передаются:

```text
ServiceId  = 619
TypeId     = 1024
PriorityId = 11
StatusId   = 29
CreatorId  = 1744
```

`ExecutorIds` **не задаётся**, поскольку в текущем чате конкретный ID исполнителя не подтверждён. Это исключает ошибочное назначение заявки случайному пользователю. API IntraService допускает `ExecutorIds` как отдельное поле, но его значение здесь намеренно не используется. citeturn4search0

## Надёжность

Событие сначала фиксируется в D1, после чего выполняется создание заявки. Для повторных попыток используются состояния `RETRY` и `ERROR`. Дополнительно Cron восстанавливает зависшие записи `PROCESSING`, если фоновая обработка была прервана.

## Структура

```text
.
├── src/
│   └── worker.js
├── tests/
│   └── worker.test.js
├── schema.sql
├── wrangler.jsonc
├── package.json
├── .gitignore
└── docs/
    ├── ARCHITECTURE.md
    ├── SECURITY.md
    └── SETUP.md
```

## Локальная проверка

```bash
npm install
npm test
```

## Production

Перед deploy необходимо задать только секреты:

```bash
npx wrangler secret put MEGAFON_CRM_TOKEN
npx wrangler secret put WEBHOOK_SECRET_PATH
npx wrangler secret put INTRASERVICE_LOGIN
npx wrangler secret put INTRASERVICE_PASSWORD
```

ID D1 остаётся отдельным инфраструктурным параметром и должен быть указан в `wrangler.jsonc`. Секреты не хранить в Git. Cloudflare рекомендует хранить чувствительные значения в Secrets, а обычные конфигурационные значения — в `vars`. citeturn10search0turn10search2turn10search3

## Ограничение проверки

Код и конфигурация проверены статически и регрессионными тестами в репозитории. Фактический production-запрос к вашему IntraService невозможно подтвердить без реальных учётных данных и без выполнения тестового звонка из вашей ВАТС. Поэтому утверждать, что заявка уже успешно создаётся в вашей системе, **я не могу подтвердить** до такого теста.
