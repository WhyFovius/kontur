<p align="right">
<a href="README.md">🇷🇺 Русский</a> · <a href="README.en.md">🇬🇧 English</a>
</p>

<div align="center">
<h1>Контур</h1>
<p><strong>Аналитика риска оттока и платформа удержания клиентов</strong></p>
<p>Объяснимый скоринг · Финансовая оценка риска · Realtime-мониторинг · Очередь действий</p>
<p>
<img src="https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.12">
<img src="https://img.shields.io/badge/FastAPI-API-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI">
<img src="https://img.shields.io/badge/React-19-149ECA?style=for-the-badge&logo=react&logoColor=white" alt="React 19">
<img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
<img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Compose">
</p>
<p>
<a href="#быстрый-старт">Быстрый старт</a> ·
<a href="#стек-технологий">Стек</a> ·
<a href="#api-и-документация">API</a> ·
<a href="#локальная-разработка">Разработка</a>
</p>
</div>

Что такое «Контур»
«Контур» помогает находить клиентов, которые могут не продлить услуги, объяснять причины риска и определять, кому команда удержания должна уделить внимание в первую очередь. Система анализирует снимок аккаунтов, услуг и транзакций, оценивает финансовый риск и формирует очередь следующих действий.

Важно: оценка риска — объяснимая эвристическая модель, а не обученная ML-модель и не вероятность оттока.

Возможности
Рейтинг клиентов — скор 0–100, уровни риска, причины оценки, фильтрация и сортировка.
Финансовая аналитика — регулярная выручка, потенциальные потери и прогноз непродлений.
Очередь спасения — приоритет клиента, рекомендуемое действие, дедлайн и сумма пополнения.
Настраиваемая модель — веса признаков можно менять в интерфейсе; настройки сохраняются в базе.
Realtime-мониторинг — события риска, уведомления и обновления через Server-Sent Events (SSE).
DEMO / Dev Panel — генератор сценариев, симулятор потока, история событий и Flight Recorder. DEMO-данные изолированы от загруженного снимка.
Импорт данных — загрузка JSON через интерфейс или API с валидацией и атомарной заменой снимка.
Вход и наблюдаемость — пароль администратора, опциональный OIDC/SSO, HTTP Basic для клиентов API и Prometheus-метрики.
Стек технологий
Уровень	Технологии	Назначение
Backend	Python 3.12, FastAPI, Uvicorn, Pydantic v2	REST API, валидация и серверная логика
Frontend	React 19, TypeScript, Vite 6	Клиентская панель
UI и анимации	Material Design 3 Expressive, @material/web, Framer Motion 12	Компоненты интерфейса и переходы
База данных	SQLite по умолчанию; PostgreSQL 16 опционально, psycopg 3	Снимки, настройки модели, сессии и история событий
Аутентификация	Сессии, HTTP Basic, httpx, PyJWT[crypto]	Парольный вход и опциональный OIDC
Запуск	Docker, Docker Compose v2	Сборка и запуск приложения
Проверки	unittest, httpx, Ruff, TypeScript, Vite	Backend-тесты, lint и сборка frontend
Быстрый старт
Самый простой вариант — Docker Compose. Python и Node.js на хосте для запуска приложения не требуются.

1. Склонируйте репозиторий
git clone https://github.com/WhyFovius/kontur.git
cd kontur
2. Создайте конфигурацию
Windows PowerShell:

Copy-Item .env.example .env
notepad .env
Linux / macOS:

cp .env.example .env
nano .env
В .env задайте свой пароль администратора:

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-unique-password
Замените значение ADMIN_PASSWORD на уникальный пароль. Для стандартного запуска с SQLite другие параметры менять не нужно.

3. Запустите приложение
docker compose up --build -d
Откройте http://localhost:8000 и войдите с учётными данными из .env.

При первом запуске приложение автоматически создаёт демонстрационные данные. SQLite используется по умолчанию; база хранится в data/churn.db и сохраняется между перезапусками.

Проверить состояние и посмотреть логи:

docker compose ps
docker compose logs -f churn-risk
Остановить приложение:

docker compose down
Данные в data/ при этом остаются на месте. Порт можно изменить в .env, например PORT=8080, затем открыть http://localhost:8080.
