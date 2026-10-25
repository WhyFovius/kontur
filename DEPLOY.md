# Деплой «Контура» на сервер Aéza

Рекомендуемая схема для одного VPS:

```text
Интернет → Caddy (80/443, автоматический HTTPS)
         → churn-risk (127.0.0.1:8000, один Uvicorn-процесс)
         → SQLite в именованном Docker volume kontur-data
           (+ отдельные SQLite-копии демо-предпросмотра в workspaces/)
```

Для одного сервера PostgreSQL не обязателен: SQLite с WAL достаточен,
проще бэкапится и соответствует одному процессу приложения. PostgreSQL
из профиля Compose нужен при внешней БД, нескольких репликах или
требованиях HA.

## Требования

- VPS на Aéza с Ubuntu 22.04/24.04 или Debian 12;
- ориентировочно от 2 ГБ RAM и 10 ГБ диска для больших снимков;
- публичное DNS-имя, указывающее на сервер: собственный домен,
  бесплатный поддомен DuckDNS или имя `sslip.io`, собранное из IPv4
  сервера (см. раздел «Публичный адрес без купленного домена»);
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

- `SITE_DOMAIN` — реальное публичное имя сайта, например
  `kontur.example.com`, `kontur.duckdns.org` или без аккаунта в DNS —
  `kontur.203-0-113-10.sslip.io` для сервера `203.0.113.10`;
- `ADMIN_PASSWORD` — длинный уникальный пароль, например вывод
  `openssl rand -base64 24`;
- `COOKIE_SECURE=true` для публичного HTTPS.

Публичная регистрация по умолчанию включена как демо-предпросмотр.
Посетитель сначала видит обязательное предупреждение, затем получает
отдельную предзаполненную SQLite-копию со всеми функциями; рабочее
пространство администратора ему недоступно. Для этого режима можно
изменить `MAX_REGISTERED_USERS` (по умолчанию 200) или полностью
отключить новые регистрации через `PUBLIC_REGISTRATION_ENABLED=false`.
Копии лежат в `/app/data/workspaces` внутри того же Docker volume.

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
загрузите реальный JSON-снимок через интерфейс. Отдельно проверьте
кнопку «Создать демо-аккаунт»: новый пользователь должен попасть не в
административные данные, а в свою предзаполненную копию с профилем
«Демо-предпросмотр».

Загрузчик снимка принимает экспортные формы `bonusState` и
`autoprolong`: boolean, числа, строки вида `active`/`off`/
`подключена`/`не активна`, Mongo Extended JSON-обёртки
`{"$numberInt":"1"}` и небольшие status-объекты. Совсем незнакомое
значение флага считается выключенным и больше не отменяет загрузку
всего снимка.

## Публичный адрес без купленного домена

Купленный домен остаётся лучшим вариантом для постоянного адреса, но
для открытого демо он не обязателен. Нельзя просто опубликовать
приложение как `http://IP:8000`: пароли и cookie пойдут без TLS, а
порт приложения окажется снаружи в обход Caddy. Вместо этого дайте
Caddy публичное DNS-имя одним из двух способов.

### Самый быстрый вариант: sslip.io

`sslip.io` — wildcard-DNS: IPv4 сервера, записанный через дефисы,
автоматически разрешается обратно в этот IP. Для сервера
`203.0.113.10` подойдёт:

```env
SITE_DOMAIN=kontur.203-0-113-10.sslip.io
COOKIE_SECURE=true
PUBLIC_REGISTRATION_ENABLED=true
```

Никакой аккаунт или DNS-запись не нужны. Перед первым запуском
проверьте разрешение имени и затем стартуйте обычный профиль Caddy:

```bash
getent hosts kontur.203-0-113-10.sslip.io

docker compose -f docker-compose.prod.yml \
  --env-file .env.production \
  --profile caddy up -d --build

curl -fsS https://kontur.203-0-113-10.sslip.io/health
```

Caddy получит публично доверенный сертификат именно для этого
hostname через ACME HTTP-01, поэтому порты 80/443 должны быть
доступны из интернета. У этого бесплатного имени есть компромиссы:
оно зависит от стороннего DNS, перестанет подходить при смене IP, а
общий лимит выпуска сертификатов для `sslip.io` иногда может
задержать первый выпуск. Если Caddy в логах сообщает о rate limit,
подождите и повторите либо перейдите на DuckDNS/собственный домен.

### Более аккуратный бесплатный вариант: DuckDNS

Зарегистрируйтесь на DuckDNS, создайте поддомен вида
`kontur.duckdns.org` и укажите для него текущий IPv4 сервера. Затем
поставьте это имя в `SITE_DOMAIN` и запускайте тот же профиль Caddy.
Для VPS с постоянным IP отдельный DuckDNS-updater и его токен на
сервере не нужны: HTTP-01 проверка идёт через публичные 80/443.

### Защита открытого демо

- Смените пароль root, если он когда-либо попадал на скриншоты или в
  чаты. Настройте отдельного sudo-пользователя и SSH-ключ; вход по
  паролю и root-login отключайте только после проверки ключа во
  второй SSH-сессии.
- Снаружи открыты только SSH, 80 и 443. Приложение остаётся на
  `127.0.0.1:8000`, наружу его публикует только Caddy.
- `ADMIN_PASSWORD` сгенерируйте случайно и храните только в
  `.env.production` с правами 600. Администраторское пространство
  отделено от публичных демо-копий, но пароль администратора всё
  равно является полным доступом к нему.
- Входящий в репозиторий `deploy/Caddyfile` не проксирует публичный
  `/metrics`: эти агрегаты относятся к администраторскому
  пространству. Оператор по-прежнему может читать их на самом
  сервере через `curl http://127.0.0.1:8000/metrics`.
- Оставьте `PUBLIC_REGISTRATION_ENABLED=true`, чтобы посетители сами
  проверяли все функции в своих изолированных копиях. Следите за
  `MAX_REGISTERED_USERS`, свободным диском и числом файлов в volume:
  публичный пользователь может загружать снимки и запускать
  симулятор в своей копии. При злоупотреблениях уменьшите лимит или
  временно поставьте `PUBLIC_REGISTRATION_ENABLED=false` — вход
  администратора от этого не пострадает.
- Настройте бэкап из раздела ниже и храните копию вне этого VPS.

Быстрые туннели вида `trycloudflare.com` для постоянного открытого
демо не подходят: адрес случайный и меняется при перезапуске, а
Server-Sent Events там не поддерживаются, поэтому Live-монитор и
уведомления будут работать не полностью.

### Только локальная проверка через SSH-туннель

Если публичное имя ещё не готово, для короткой проверки по IP
используйте SSH-туннель, а не публичный порт 8000:

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

    # Администраторские Prometheus-агрегаты не публикуем наружу.
    location = /metrics {
        return 404;
    }

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

Скрипт делает online-backup через SQLite Backup API и пишет один архив
`kontur-YYYYMMDD-HHMMSS.tar.gz` в `./backups/` на хосте. В архиве
лежат основная БД `churn.db` (администраторское пространство,
зарегистрированные пользователи и сессии) и каталог `workspaces/` со
всеми изолированными демо-копиями. Копии старше 14 дней удаляются.
Регулярно выгружайте бэкапы с сервера в другое место: бэкап только на
том же VPS не защищает от потери самого сервера.

Пример cron на 03:15:

```cron
15 3 * * * cd /opt/kontur && ./deploy/backup.sh >> /tmp/kontur-backup.log 2>&1
```

### Восстановление SQLite

Сначала сделайте бэкап текущего состояния. Затем распакуйте нужный
архив на хосте во временный каталог и потоково передайте его содержимое
в одноразовый контейнер — так восстановленные файлы создадутся от
пользователя приложения, а не от root:

```bash
cd /opt/kontur
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

restore_dir="$(mktemp -d)"
tar -xzf ./backups/kontur-YYYYMMDD-HHMMSS.tar.gz -C "$restore_dir"

$COMPOSE stop churn-risk
tar -cf - -C "$restore_dir" . | $COMPOSE run --rm --no-deps -T churn-risk python -c '
import io
import sys
import tarfile
from pathlib import Path

root = Path("/app/data")
(root / "workspaces").mkdir(parents=True, exist_ok=True)
allowed = {"churn.db"}
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode="r:") as archive:
    for member in archive.getmembers():
        name = member.name.removeprefix("./")
        if not member.isfile():
            continue
        if name not in allowed and not (
            name.startswith("workspaces/") and name.endswith(".db") and "/" not in name[11:]
        ):
            raise SystemExit(f"unexpected backup member: {member.name}")
        source = archive.extractfile(member)
        if source is None:
            continue
        target = root / name
        temporary = target.with_suffix(target.suffix + ".restore")
        temporary.write_bytes(source.read())
        temporary.replace(target)
        for suffix in ("-wal", "-shm"):
            Path(str(target) + suffix).unlink(missing_ok=True)
'
rm -rf "$restore_dir"
$COMPOSE up -d churn-risk
curl -fsS https://ВАШ_ДОМЕН/health
```

Старые бэкапы формата `kontur-*.db` содержат только основную БД: их
можно восстановить прежним способом, но демо-пространства из них не
появятся.

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
`deploy/backup.sh`. Учтите: даже при PostgreSQL изолированные
демо-пространства остаются отдельными SQLite-файлами в
`/app/data/workspaces`, поэтому этот каталог нужно архивировать
отдельно от дампа PostgreSQL.

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

- [ ] Публичное имя ведёт на Aéza VPS, HTTPS работает без предупреждений.
- [ ] Пароль root сменён, если он где-либо засветился; SSH-ключ проверен.
- [ ] `ADMIN_PASSWORD` уникальный, `.env.production` имеет права 600.
- [ ] `COOKIE_SECURE=true`, порт 8000 не открыт наружу.
- [ ] `/health` отвечает 200 локально и по публичному адресу.
- [ ] Публичный `/metrics` возвращает 404, а локальный на сервере — 200.
- [ ] В инкогнито создан демо-аккаунт: данные уже есть, функции работают,
      а изменения не видны после входа администратором.
- [ ] Реальный снимок загружается администратором, клиенты и сводка отображаются.
- [ ] Сделан первый бэкап и копия выгружена с сервера.
- [ ] На сервере настроены обновления ОС и мониторинг свободного диска.
