# Интеграция МегаФон ВАТС → IntraService

## Архитектура

МегаФон ВАТС → HTTPS POST webhook → Cloudflare Worker → Cloudflare D1 → IntraService API

**Без собственного сервера, без VPS, без Docker.** Всё работает в инфраструктуре Cloudflare.

---

## Этапы развёртывания

### Шаг 0. Установить инструменты на компьютер

1. **Node.js LTS** — скачать с https://nodejs.org и установить.
2. **Visual Studio Code** — скачать с https://code.visualstudio.com.
3. Открыть терминал и проверить:
   ```bash
   node -v
   npm -v
