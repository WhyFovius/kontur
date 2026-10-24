# Контур v2 — эксперимент: Go + Fluent

Отдельный стек в одной папке, основной продукт (Python/FastAPI + M3 Expressive)
не затрагивает. Тот же API-контракт (`/api/v1/...`, евроценты, cookie-сессия),
та же доменная математика: шесть признаков, веса, скор, денежная оценка,
график «факт vs прогноз», метрики.

| Слой | Технология |
| --- | --- |
| Бэкенд | **Go, только стандартная библиотека** (`net/http`, JSON-файл вместо SQLite) |
| Фронтенд | React 19 + TypeScript + Vite, **Fluent 2 / acrylic**: светлая тема, стекло, Segoe UI, радиусы 4–8 px, без Material Web и Framer Motion |
| Порты | Go: **8080** (рядом с Python на 8000), Vite dev: 5173 |

Фронт заметно легче основного: ~77 КБ JS gzip и ~4 КБ CSS gzip.

## Запуск всего стека (Go)

Нужны Go 1.22+ и Node 20+.

```powershell
cd experiments\fluent-go\frontend
npm install
npm run build

cd ..\backend
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "set-a-unique-password"
go run .
```

Открыть http://localhost:8080 и войти под заданными `ADMIN_*`.
Данные лежат в `backend\data\store.json`; при первом запуске создаются
те же 8 демо-аккаунтов, что в основной версии.

Для продакшн-сборки бэкенда:

```powershell
cd experiments\fluent-go\backend
go build -o konturv2.exe .
.\konturv2.exe
```

Переменные окружения: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `COOKIE_SECURE`,
`PORT` (по умолчанию 8080), `DATA_FILE` (по умолчанию `data/store.json`),
`WEB_DIR` (по умолчанию `../frontend/dist`).

## Разработка фронта отдельно

```powershell
cd experiments\fluent-go\frontend
npm run dev
```

Vite (5173) проксирует `/api` и `/metrics` на `127.0.0.1:8000` (Python) или,
если задан `VITE_API_TARGET=http://127.0.0.1:8080`, на Go-бэкенд.

## Что внутри бэкенда

```
backend/main.go      точка входа, env, http.Server
backend/api.go       маршруты /api/v1/*, /metrics, /health, раздача фронта
backend/domain.go    порт churnrisk/domain.py: признаки, скор, деньги, динамика
backend/snapshot.go  нормализация снимка (алиасы полей/коллекций, вложенные услуги)
backend/store.go     JSON-хранилище: снимок, веса, сессии (атомарная запись)
backend/auth.go      пароль администратора, HTTP Basic, лимит попыток, сессии
backend/seed.go      демо-данные (8 аккаунтов, как в Python-версии)
```

Сознательные упрощения эксперимента по сравнению с Python-версией:

- JSON-файл вместо SQLite; анализ пересчитывается на каждый запрос (данных мало).
- OIDC не реализован: `auth/providers` честно сообщает «только пароль»,
  `auth/oidc/login` отвечает 503. Пароль + HTTP Basic работают.
- Валидация снимка облегчена (структура, алиасы, ссылки на аккаунты),
  без полных лимитов/проверок сумм из `churnrisk/storage.py`.
- Округление скора — обычное (`math.Round`), в Python банковское (`round`);
  на демо-данных результаты совпадают.

> Честно про проверку: фронт собран и проверен в песочнице Arena на Python API
> (тот же контракт). Go-код в песочнице **не компилировался** — там нет
> тулчейна Go и сети до него; первая сборка делается у вас: `go build`.
> Если компилятор что-то подсветит — пришлите вывод, поправлю.
