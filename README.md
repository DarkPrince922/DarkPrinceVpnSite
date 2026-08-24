# Сайт DarkPrince VPN

Страница загрузки приложений и личный кабинет: вход через Telegram и почту,
подписка, тарифы, баланс, устройства, промокоды, рефералы и тикеты
техподдержки с перепиской и вложениями.

Сайт статический — HTML, CSS и несколько файлов JavaScript, без сборки,
без npm, без базы данных. Всё, что ему нужно от сервера, — отдавать файлы
и переносить запросы `/api/*` в кабинет бота.

## Почему запросы идут через свой домен

Браузер обращается не к кабинету напрямую, а на `/api/cabinet/...` того же
домена; веб-сервер переносит запрос дальше. Это даёт три вещи сразу:

* не нужен CORS — кабинет не приходится ничего настраивать;
* адрес кабинета не виден в исходниках страницы;
* кабинет не нужно открывать наружу отдельным доменом, а значит его не
  заблокируют отдельно от сайта.

## Установка

Ставится на тот сервер, где работает бот с кабинетом: тогда API доступен
по `127.0.0.1` и наружу вообще не выходит.

### 1. Направить домен

A-запись `dprince.online` — на IP сервера. Сертификат выпустится только после
того, как DNS разойдётся; проверить: `getent hosts dprince.online`.

### 2. Положить файлы

```bash
sudo mkdir -p /srv/darkprince
sudo git clone https://github.com/DarkPrince922/DarkPrinceVpnSite.git /srv/darkprince
```

Обновлять потом: `sudo git -C /srv/darkprince pull`.

### 3. Подключить к nginx

На сервере уже есть nginx — им отдаётся кабинет. Добавляем ещё один сайт:

```bash
sudo cp /srv/darkprince/deploy/nginx.conf /etc/nginx/sites-available/dprince.online
sudo ln -s /etc/nginx/sites-available/dprince.online /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Выпустить сертификат

```bash
sudo certbot --nginx -d dprince.online
```

Certbot сам допишет в конфиг 443-й порт, пути к сертификату и переадресацию
с http. Конфиг из репозитория специально начинается только с 80-го порта:
с `listen 443` до выпуска сертификата nginx бы не запустился.

Если API кабинета когда-нибудь переедет с 8080 — поправить нужно строку
`proxy_pass` в том же файле.

Для вложений техподдержки nginx должен принимать запросы до 12 МБ. В конфиге
из репозитория это уже задано: Bedolaga ограничивает сам файл 10 МБ, а остаток
нужен для multipart-обвязки запроса.

**Конфиг живёт вне репозитория.** `git pull` обновляет только сайт: файл в
`/etc/nginx/` — это отдельная копия, и она останется прежней. Если в
`deploy/nginx.conf` что-то поменялось, копируем заново:

```bash
sudo cp /srv/darkprince/deploy/nginx.conf /etc/nginx/sites-available/dprince.online
sudo nginx -t && sudo systemctl reload nginx
```

Certbot дописывает свои строки в тот же файл, поэтому после копирования
проверьте, что блок с 443 и сертификатом на месте — если нет, повторите
`sudo certbot --nginx -d dprince.online`, он допишет их снова.

### 5. Положить приложения

```bash
sudo cp DarkPrinceVPN.apk          /srv/darkprince/site/downloads/
sudo cp DarkPrinceVPN-setup.exe    /srv/darkprince/site/downloads/
sudo cp DarkPrinceVPN.pkg.tar.zst  /srv/darkprince/site/downloads/
sudo cp DarkPrinceVPN.deb          /srv/darkprince/site/downloads/
sudo cp DarkPrinceVPN.AppImage     /srv/darkprince/site/downloads/
```

Имена файлов должны быть именно такими — на них ссылаются кнопки. Версию и
размер, которые показываются под кнопками, поправьте в
`site/downloads.json`: это единственное место, где они записаны, и оно же
перебивает адрес, зашитый в вёрстку.

Клиенты для Windows и Linux лежат в релизах своих репозиториев — сервер
забирает их оттуда сам:

```bash
WIN=https://github.com/DarkPrince922/DarkprincevpnWindows/releases/download
LIN=https://github.com/DarkPrince922/DarkPrinceVpnLinux/releases/download
AND=https://github.com/DarkPrince922/Androidvpnapp/releases/download

sudo curl -fSL "$AND/v1.2.12/DarkPrinceVPN-1.2.12.apk" \
     -o /srv/darkprince/site/downloads/DarkPrinceVPN.apk

sudo curl -fSL "$WIN/v1.2.2/DarkPrinceVPN-1.2.2-setup.exe" \
     -o /srv/darkprince/site/downloads/DarkPrinceVPN-setup.exe

sudo curl -fSL "$LIN/v1.2.2/DarkPrinceVPN-1.2.2-x86_64.pkg.tar.zst" \
     -o /srv/darkprince/site/downloads/DarkPrinceVPN.pkg.tar.zst
sudo curl -fSL "$LIN/v1.2.2/DarkPrinceVPN-1.2.2-amd64.deb" \
     -o /srv/darkprince/site/downloads/DarkPrinceVPN.deb
sudo curl -fSL "$LIN/v1.2.2/DarkPrinceVPN-1.2.2-x86_64.AppImage" \
     -o /srv/darkprince/site/downloads/DarkPrinceVPN.AppImage

sha256sum /srv/darkprince/site/downloads/DarkPrinceVPN.apk \
          /srv/darkprince/site/downloads/DarkPrinceVPN-setup.exe \
          /srv/darkprince/site/downloads/DarkPrinceVPN.pkg.tar.zst \
          /srv/darkprince/site/downloads/DarkPrinceVPN.deb \
          /srv/darkprince/site/downloads/DarkPrinceVPN.AppImage
```

### Манифесты обновлений

Приложения обновляются сами и спрашивают о новой версии эти файлы. Они
собираются в релизах и лежат там же, где сборки:

```bash
sudo mkdir -p /srv/darkprince/site/updates

sudo curl -fSL "$WIN/v1.2.2/windows-x86_64.json" \
     -o /srv/darkprince/site/updates/windows-x86_64.json
sudo curl -fSL "$LIN/v1.2.2/linux-x86_64.json" \
     -o /srv/darkprince/site/updates/linux-x86_64.json
sudo curl -fSL "$AND/v1.2.12/android.json" \
     -o /srv/darkprince/site/updates/android.json
```

Манифест и сборку кладём **вместе**: они
ссылаются друг на друга, и манифест, обогнавший файл, отправит людей качать
версию, которой ещё нет.

Манифесты появляются в релизе, только если сборку было чем подписать —
в репозитории приложения должен быть секрет `TAURI_SIGNING_PRIVATE_KEY`. Без
него релиз соберётся как обычно, но обновления до людей не поедут; в журнале
прогона об этом будет предупреждение.

Для Linux сайт отдаёт три сборки: кнопка открывает окно с выбором
дистрибутива. Нужны все три файла — если какой-то не положить, соответствующая
строчка в окне даст 404. Размеры у сборок разные, поэтому в `downloads.json`
у Linux общая версия и свой размер у каждой сборки.

Версии в командах — те, что лежат в релизах на момент правки; подставляйте
свежие. Пакет `.pkg.tar.zst` появился в релизе Linux-клиента v1.1.1: в более
старых лежат только AppImage и `.deb`.

Имя файла на сайте намеренно без версии: ссылка тогда не меняется от релиза
к релизу, а версия показывается из `downloads.json`. Последняя строка печатает
контрольную сумму — её стоит сверить с указанной в описании релиза: так видно,
что файл доехал целиком, а не оборвался на середине.

## Про кеш

Имена файлов не содержат версии, поэтому браузеру нельзя оставлять решение
о свежести: без заголовков он кеширует стили и скрипты на своё усмотрение, и
обновление сайта доезжает до людей когда попало — при полностью выложенных
файлах. Заголовки задаются картой в `nginx.conf`:

* разметка, стили, скрипты — `no-cache`: браузер хранит файл, но каждый раз
  переспрашивает; не изменился — прилетает пустой ответ 304;
* `/downloads/` — `public, max-age=300`: сборки большие, но меняются;
* `/updates/` — `no-store`: закешированный манифест обновлений означает,
  что новая версия до приложений просто не доедет.

Заголовки считаются картой, а не через `add_header` внутри `location`,
специально: свой `add_header` в location отменяет все серверные разом, и
страницы остались бы без CSP.

## Что проверить после запуска

1. Главная открывается, кнопка скачивания подставляется под систему гостя.
2. Файлы скачиваются: `https://ваш-домен/downloads/DarkPrinceVPN.apk`.
3. В кабинете работает вход через Telegram: кнопка открывает бота, после
   подтверждения страница сама пускает внутрь.
4. Виден баланс и подписка — значит `/api` доехал до кабинета. Если вместо
   этого ошибка, проверьте порт из шага 2.
5. На вкладке «Поддержка» создаётся обращение, оно приходит администратору в
   Telegram, а ответ появляется в открытом диалоге сайта не позднее 8 секунд.

## Структура

```
site/
  index.html        главная: описание, кнопки загрузки, инструкции
  cabinet.html      вход и личный кабинет
  privacy.html      политика конфиденциальности
  terms.html        условия использования
  downloads.json    версии и размеры сборок
  app.css           оформление, общее для всех страниц
  js/
    api.js          клиент кабинета: запросы, токены, обновление сессии
    ui.js           мелкие помощники: разметка, форматы, QR
    home.js         поведение главной
    cabinet.js      вход и основные вкладки кабинета
    support.js      тикеты поддержки, чат, вложения и счётчик ответов
    qrcode.js       генератор QR (Kazuhiko Arase, MIT)
deploy/
  Caddyfile         вариант с Caddy
  nginx.conf        вариант с nginx
  docker-compose.yml
```

## Что стоит поправить руками

* В `privacy.html` и `terms.html` — ссылки на поддержку (сейчас
  `@ваш_бот_поддержки`) и проверить, что написанное совпадает с тем, как
  сервис работает на самом деле.
* В `index.html` — тексты на главной, если захотите другие формулировки.

## Про токены

Сессия хранится в браузере (`localStorage`) — так же, как в приложениях.
Refresh-токен обновляется строго по одному запросу за раз: бот меняет его при
каждом обновлении, и параллельные запросы иначе выбрасывали бы пользователя
из аккаунта.
