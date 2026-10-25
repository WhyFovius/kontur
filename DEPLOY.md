# Деплой «Контура» на сервер Aéza

Рекомендуемая схема для одного VPS:

```text
Интернет → Caddy (80/443, автоматический HTTPS)
         → churn-risk (127.0.0.1:8000, один Uvicorn-процесс)
         → SQLite в именованном Docker volume kontur-data
```

Для одного сервера PostgreSQL не обязателен: SQLite с WAL достаточен,
проще бэкапится и соответствует одному процессу приложения. PostgreSQL
из профиля Compose нужен при внешней БД, нескольких репликах или
требованиях HA.

## Требования

- VPS на Aéza с Ubuntu 22.04/24.04 или Debian 12;
- ориентировочно от 2 ГБ RAM и 10 ГБ диска для больших снимков;
- домен, A/AAAA-запись которого указывает на сервер;
- открытые порты 22, 80 и 443. Порт 8000 наружу открывать не нужно.

## 1. Установите Docker

На сервере должен работать Docker Engine с Compose v2:

```bash
docker --version
docker compose version
```

Если Docker ещё нет, официальный convenience-скрипт Docker:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```

## 2. Клонируйте проект

```bash
sudo mkdir -p /opt/kontur
sudo chown "$USER":"$USER" /opt/kontur
git clone https://github.com/WhyFovius/kontur.git /opt/kontur
cd /opt/kontur
```

Для production используйте `main` после merge проверенного PR.

## 3. Создайте production-окружение

```bash
cp deploy/production.env.example .env.production
nano .env.production
chmod 600 .env.production
```

Обязательно задайте:

- `SITE_DOMAIN` — реальный домен, например `kontur.example.com`;
- `ADMIN_PASSWORD` — длинный уникальный пароль, например вывод
  `openssl rand -base64 24`;
- `COOKIE_SECURE=true` для публичного HTTPS.

Файл `.env.production` уже игнорируется Git и Docker build context —
не коммитьте его и не отправляйте в чаты.

## 4. Настройте firewall

Пример для UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
sudo ufw status
```

Порт 8000 не открывайте: production-Compose публикует его только на
`127.0.0.1`, а наружу смотрит Caddy.

## 5. Первый запуск

```bash
cd /opt/kontur
docker compose -f docker-compose.prod.yml \
  --env-file .env.production \
  --profile caddy up -d --build
```

Проверка:

```bash
docker compose -f docker-compose.prod.yml \
  --env-file .env.production --profile caddy ps

docker compose -f docker-compose.prod.yml \
  --env-file .env.production --profile caddy logs -f churn-risk caddy

curl -fsS https://ВАШ_ДОМЕН/health
```

Ожидается JSON со статусом приложения. После этого откройте
`https://ВАШ_ДОМЕН`, войдите под `ADMIN_USERNAME`/`ADMIN_PASSWORD` и
загрузите реальный JSON-снимок через интерфейс.

Загрузчик снимка принимает экспортные формы `bonusState` и
`autoprolong`: boolean, числа, строки вида `active`/`off`/
`подключена`/`не активна`, Mongo Extended JSON-обёртки
`{"$numberInt":"1"}` и небольшие status-объекты. Совсем незнакомое
значение флага считается выключенным и больше не отменяет загрузку
всего снимка.

## Если домена пока нет

Для короткой проверки по IP используйте SSH-туннель, а не публичный
порт 8000:

```bash
# на сервере: без Caddy
cd /opt/kontur
# временно COOKIE_SECURE=false в .env.production
docker compose -f docker-compose.prod.yml \
  --env-file .env.production up -d --build
```

Со своего компьютера:

```bash
ssh -L 8000:127.0.0.1:8000 USER@IP_СЕРВЕРА
```

Затем откройте `http://localhost:8000`. Перед публичным запуском
верните `COOKIE_SECURE=true` и используйте профиль Caddy.

## Если на сервере уже есть nginx

Caddy-профиль не запускайте. Приложение поднимите обычным
production-Compose, а nginx настройте примерно так (TLS выпускается
вашим обычным способом, например Certbot):

```nginx
server {
    listen 443 ssl http2;
    server_name ВАШ_ДОМЕН;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Важно для SSE realtime-монитора.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Production-команда Uvicorn уже включает `--proxy-headers`, поэтому
rate-limit входа будет видеть реальный IP клиента, а не один адрес
reverse proxy на всех пользователей.

## Обновление

На сервере:

```bash
cd /opt/kontur
./deploy/update.sh
```

Скрипт делает `git pull --ff-only`, пересобирает образ, перезапускает
контейнеры профиля Caddy и ждёт успешный `/health`. Если используете
свой nginx вместо Caddy:

```bash
WITH_CADDY=0 ./deploy/update.sh
```

Если используете PostgreSQL-профиль, добавьте `WITH_POSTGRES=1`.

Данные SQLite лежат в именованном volume `kontur_kontur-data` и при
обновлении образа не удаляются. Не выполняйте `docker compose down -v`
на production без свежего бэкапа: `-v` удаляет volumes.

## Бэкап SQLite

```bash
cd /opt/kontur
./deploy/backup.sh
ls -lh backups/
```

Скрипт делает online-backup через SQLite Backup API, копирует файл в
`./backups/` на хост и удаляет копии старше 14 дней. Регулярно
выгружайте бэкапы с сервера в другое место: бэкап только на том же VPS
не защищает от потери самого сервера.

Пример cron на 03:15:

```cron
15 3 * * * cd /opt/kontur && ./deploy/backup.sh >> /tmp/kontur-backup.log 2>&1
```

### Восстановление SQLite

Сначала сделайте бэкап текущего состояния. Затем:

```bash
cd /opt/kontur
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

$COMPOSE stop churn-risk
$COMPOSE run --rm --no-deps -T churn-risk sh -c \
  'cat > /app/data/churn.db.restore && mv /app/data/churn.db.restore /app/data/churn.db && rm -f /app/data/churn.db-wal /app/data/churn.db-shm' \
  < ./backups/kontur-YYYYMMDD-HHMMSS.db
$COMPOSE up -d churn-risk
curl -fsS https://ВАШ_ДОМЕН/health
```

## PostgreSQL вместо SQLite

Заполните в `.env.production` `POSTGRES_PASSWORD` и:

```env
DATABASE_URL=postgresql://kontur:ПАРОЛЬ@postgres:5432/kontur
```

Запуск:

```bash
docker compose -f docker-compose.prod.yml \
  --env-file .env.production \
  --profile postgres --profile caddy up -d --build
```

Автоматической миграции данных SQLite → PostgreSQL в проекте нет.
Для PostgreSQL используйте `pg_dump`/`pg_restore`, а не
`deploy/backup.sh`.

## Диагностика

```bash
cd /opt/kontur

# Статус и health контейнеров
docker compose -f docker-compose.prod.yml \
  --env-file .env.production --profile caddy ps

# Логи приложения и Caddy
docker compose -f docker-compose.prod.yml \
  --env-file .env.production --profile caddy logs --tail=200 churn-risk caddy

# Локальная проверка приложения в обход публичного домена
curl -fsS http://127.0.0.1:8000/health
```

Типичные ситуации:

- **После ввода пароля снова возвращает на логин** — при доступе по
  обычному HTTP стоит `COOKIE_SECURE=true`. Либо используйте HTTPS,
  либо только для SSH-туннеля временно поставьте `false`.
- **Caddy не выпускает сертификат** — DNS ещё не указывает на этот
  сервер или закрыты 80/443.
- **Ошибка загрузки снимка** — проверьте, что файл является JSON до
  32 МиБ и сервер обновлён до версии с толерантным `bonusState`.
- **Все пользователи быстро упираются в лимит входа** — приложение
  запущено не production-командой без `--proxy-headers`.

## Контрольный список перед публичным открытием

- [ ] Домен ведёт на Aéza VPS, HTTPS работает без предупреждений.
- [ ] `ADMIN_PASSWORD` уникальный, `.env.production` имеет права 600.
- [ ] `COOKIE_SECURE=true`, порт 8000 не открыт наружу.
- [ ] `/health` отвечает 200 локально и по домену.
- [ ] Реальный снимок загружается, клиенты и сводка отображаются.
- [ ] Сделан первый бэкап и копия выгружена с сервера.
- [ ] На сервере настроены SSH-ключи и обновления ОС.
