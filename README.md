# Контур

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.12" />
  <img src="https://img.shields.io/badge/FastAPI-API-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/React-19-149ECA?style=for-the-badge&logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Compose" />
</p>

<p align="center">
  <strong>Аналитика риска оттока и платформа удержания клиентов</strong>
</p>

<p align="center">
  Объяснимый скоринг · Финансовая оценка риска · Realtime-мониторинг · Очередь действий
</p>

Контур помогает находить клиентов, которые могут не продлить услуги, объяснять причины риска и определять действия, которые реально улучшат удержание. Платформа сочетает в себе скоринг, финансовый анализ и рабочий процесс с приоритетами по клиентам, чтобы команды продаж и клиентского успеха могли действовать быстрее и точнее.

> Важно: оценка риска в Контуре — это объяснимая эвристическая модель, а не обученная ML-модель и не вероятность оттока. Основной фокус — интерпретация и управляемость решения.

## Что умеет Контур

- Рейтинг клиентов: скор 0–100, уровни риска, причины оценки, фильтрация и сортировка.
- Финансовая аналитика: регулярная выручка, потенциальные потери и прогноз непродлений.
- Очередь спасения: приоритет клиента, рекомендуемое действие, дедлайн и сумма пополнения.
- Настраиваемая модель: веса признаков можно менять в интерфейсе, а параметры сохраняются в базе.
- Realtime-мониторинг: события риска, уведомления и обновления через Server-Sent Events (SSE).
- DEMO / Dev Panel: генератор сценариев, симулятор потока, история событий и Flight Recorder для отладки и демонстраций.
- Импорт данных: загрузка JSON через интерфейс или API с валидацией и атомарной заменой снимка.
- Вход и наблюдаемость: пароль администратора, опциональный OIDC/SSO, HTTP Basic для клиентов API и Prometheus-метрики.

## Архитектура и стек

| Уровень | Технологии | Назначение |
| --- | --- | --- |
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic v2 | REST API, валидация и серверная логика |
| Frontend | React 19, TypeScript, Vite 6 | Клиентская панель |
| UI и анимации | Material Design 3 Expressive, @material/web, Framer Motion 12 | Компоненты интерфейса и переходы |
| База данных | SQLite по умолчанию; PostgreSQL 16 опционально, psycopg 3 | Снимки, настройки модели, сессии и история событий |
| Аутентификация | Сессии, HTTP Basic, httpx, PyJWT[crypto] | Парольный вход и опциональный OIDC |
| Запуск | Docker, Docker Compose v2 | Сборка и запуск приложения |
| Проверки | unittest, httpx, Ruff, TypeScript, Vite | Backend-тесты, lint и сборка frontend |

## Быстрый старт

Самый простой вариант — Docker Compose. Python и Node.js на хосте для запуска приложения не требуются.

### 1) Клонируйте репозиторий

```bash
git clone https://github.com/WhyFovius/kontur.git
cd kontur
```

### 2) Создайте конфигурацию

Для Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
```

Для Linux / macOS:

```bash
cp .env.example .env
nano .env
```

В `.env` задайте пароль администратора:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-unique-password
```

> Замените `ADMIN_PASSWORD` на уникальный пароль. Для стандартного запуска с SQLite другие параметры обычно менять не нужно.

### 3) Запустите приложение

```bash
docker compose up --build -d
```

После запуска откройте:

```text
http://localhost:8000
```

Войдите в интерфейс под учетными данными из `.env`.

### 4) Проверка состояния

```bash
docker compose ps
docker compose logs -f churn-risk
```

### 5) Остановка

```bash
docker compose down
```

Данные в каталоге `data/` сохраняются между запусками. Если нужно изменить порт, задайте переменную `PORT` в `.env`, например:

```env
PORT=8080
```

После этого приложение будет доступно по адресу:

```text
http://localhost:8080
```

## Подк��ючение к API

Приложение предоставляет REST API и Swagger UI для быстрого тестирования.

После запуска доступны:

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

Для API запросов используется HTTP Basic или сессии в зависимости от сценария использования.

## Наблюдаемость и мониторинг

- Прометейские метрики в приложении
- Server-Sent Events (SSE) для realtime-канала риска
- История событий и Flight Recorder для диагностики сценариев
- Логи контейнера через `docker compose logs -f`

## Структура проекта

```text
kontur/
├── app/                 # Backend приложения
├── frontend/            # React / TypeScript клиент
├── data/                # SQLite и данные демо-сценариев
├── docker-compose.yml   # Запуск окружения
├── Dockerfile           # Образ приложения
├── .env.example         # Пример настроек окружения
├── README.md            # Документация проекта
├── requirements*.txt    # Зависимости Python
├── package.json         # Скрипты и зависимости frontend
└── ...
```

## Разработка локально

Если вы хотите запускать проект в режиме разработки, используйте локальные зависимости и отдельный dev-процесс вместо Docker Compose.

Проверьте наличие установленных инструментов:

- Python 3.12+
- Node.js 20+
- Docker / Docker Compose

Далее:

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Для frontend:

```bash
cd frontend
npm install
npm run dev
```

## Рекомендации по использованию

- Настраивайте веса признаков на основе реальной бизнес-логики, а не только статистики.
- Используйте демо-сценарии и Flight Recorder для проверки логики принятия решений.
- Не используйте автоматический импорт данных без валидации модели и бизнес-правил.
- Следите за метриками и событиями риска в realtime-режиме, чтобы быстро реагировать на отклонения.

## Лицензия

Проект распространяется в рамках лицензии, указанной в репозитории.

## Контакты и поддержка

Для вопросов, предложений или сотрудничества используйте issues в GitHub-репозитории проекта.

---

Сделано с акцентом на прозрачность, управляемость и практический результат. Контур — это не просто «скоринг», а рабочая система для принятия решений по удержанию клиентов.