# Архитектура

## 1. Основной поток

```text
MegaFon VATS
   │
   │ POST cmd=history
   ▼
Cloudflare Worker
   │
   ├─ exact path check
   ├─ crm_token check
   ├─ JSON validation
   ├─ cmd=history
   ├─ type=in
   ├─ status=success
   ├─ duration > 10
   │
   ▼
D1: calls
   │
   ├─ duplicate? → stop
   └─ new call → RECEIVED
             │
             ▼
        background job
             │
             ▼
      users_mapping
             │
             ▼
       IntraService API
             │
             ▼
       CREATED + task ID
```

## 2. Почему D1 ставится перед IntraService

Если IntraService временно недоступен, событие уже сохранено. Worker не зависит от одного синхронного HTTP-запроса для сохранения факта звонка.

## 3. Идемпотентность

`uid` MegaFon используется как уникальный `callid`.

Первичная запись выполняется через `INSERT OR IGNORE`. После этого Worker атомарно переводит запись из `RECEIVED` в `PROCESSING`. Второй параллельный webhook не сможет получить тот же claim.

## 4. Retry

Состояния:

- `RECEIVED` — событие принято;
- `PROCESSING` — один Worker обрабатывает событие;
- `CREATED` — заявка создана;
- `SKIPPED` — звонок не соответствует бизнес-условиям;
- `RETRY` — временная ошибка, будет повтор;
- `ERROR` — достигнут лимит попыток.

Retry использует экспоненциальную задержку с верхним пределом 60 минут. Cron запускается каждые 5 минут, поэтому точный момент повторной попытки зависит от времени запуска Cron.

## 5. Контрольная сверка

Следующим этапом добавляется отдельная reconciliation-задача: получение истории MegaFon за небольшой перекрывающийся период и сравнение с D1. Она нужна как защита от ситуации, когда webhook не дошёл до Cloudflare.

Эта часть не включена в production-код до подтверждения API-аутентификации и реального формата истории вашей ВАТС.

## 6. Сотрудники

MegaFon history содержит идентификатор оператора `user`. API сотрудников возвращает `login`, `name`, `email` и другие поля. Планируемое сопоставление:

```text
MegaFon user/login
        ↓
MegaFon email
        ↓
IntraService email
        ↓
IntraService User.Id
        ↓
CreatorId
```

Если email отсутствует или неоднозначен, заявка не должна создаваться от имени случайного сотрудника. Такой звонок переводится в ошибку/контроль.
