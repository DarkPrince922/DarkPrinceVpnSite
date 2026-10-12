#!/usr/bin/env bash
# Помощник поддержки DarkPrince VPN рядом с ботом.
#
#   bash install.sh          — установить или переустановить (ключи спросит, не показывая)
#   bash install.sh update   — обновить код, ключи и базу знаний не трогает
#   bash install.sh logs     — последние строки журнала
#   bash install.sh stop     — остановить
#
# Ключи хранятся только в /opt/dp-support-ai/.env (права 600) и на экран не выводятся.
set -uo pipefail

DIR=/opt/dp-support-ai
BOT_DIR=/opt/remnawave-bedolaga-telegram-bot
RAW=https://raw.githubusercontent.com/DarkPrince922/DarkPrinceVpnSite/main/ops/support-ai
ADMIN_DEFAULT=6058263242

ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

fetch() {
    for f in app.py requirements.txt Dockerfile docker-compose.yml; do
        curl -4 -fsSL -o "$DIR/$f" "$RAW/$f" || die "Не скачался $f"
    done
    # базу знаний не перезаписываем: её правят руками
    [ -f "$DIR/kb.md" ] || curl -4 -fsSL -o "$DIR/kb.md" "$RAW/kb.md" || die "Не скачался kb.md"
    ok "Код скачан в $DIR"
}

bot_env() { grep -m1 "^$1=" "$BOT_DIR/.env" 2>/dev/null | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

secret() {
    local value
    read -rsp "$1: " value </dev/tty
    echo >&2
    printf '%s' "$value"
}

case "${1:-install}" in
install)
    docker inspect remnawave_bot >/dev/null 2>&1 || die "Контейнер remnawave_bot не найден — запускайте на сервере бота"
    mkdir -p "$DIR/data" && chmod 700 "$DIR"
    fetch

    NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' remnawave_bot | awk '{print $1}')
    [ -n "$NET" ] || die "Не нашёл сеть контейнера бота"
    PANEL_URL=$(bot_env REMNAWAVE_API_URL)
    PANEL_COOKIE=$(bot_env REMNAWAVE_SECRET_KEY)
    [ -n "$PANEL_URL" ] || die "В $BOT_DIR/.env нет REMNAWAVE_API_URL"
    ok "Сеть бота: $NET, панель: $PANEL_URL"

    BOT_API_TOKEN=$(grep -m1 '^BOT_API_TOKEN=' "$DIR/.env" 2>/dev/null | cut -d= -f2-)
    if [ -z "$BOT_API_TOKEN" ]; then
        BOT_API_TOKEN=$(docker exec -i remnawave_bot python - 2>/dev/null <<'PY' | grep -m1 '^TOKEN=' | cut -d= -f2-
import asyncio
from app.database.database import AsyncSessionLocal
from app.services.web_api_token_service import web_api_token_service
async def main():
    async with AsyncSessionLocal() as db:
        value, _ = await web_api_token_service.create_token(
            db, name='Support AI', description='ИИ-помощник поддержки', created_by='install')
        await db.commit()
    print('TOKEN=' + value)
asyncio.run(main())
PY
)
        [ -n "$BOT_API_TOKEN" ] || die "Не получилось выпустить токен служебного API бота"
        ok "Выпущен токен служебного API бота «Support AI»"
    else
        ok "Токен служебного API бота уже есть"
    fi

    echo
    echo "Нужны три ключа. Ввод скрыт — так и должно быть."
    AI_KEY=$(secret "1) Ключ AITUNNEL (aitunnel.ru → личный кабинет → API-ключи)")
    TG_TOKEN=$(secret "2) Токен нового бота для черновиков (@BotFather → /newbot)")
    PANEL_TOKEN=$(secret "3) Токен панели только на чтение (users:read, hwid-user-devices:read, nodes:read)")
    read -rp "Ваш Telegram ID [$ADMIN_DEFAULT]: " ADMIN </dev/tty
    ADMIN=${ADMIN:-$ADMIN_DEFAULT}
    [ -n "$AI_KEY" ] && [ -n "$TG_TOKEN" ] && [ -n "$PANEL_TOKEN" ] || die "Все три ключа обязательны"

    umask 077
    cat >"$DIR/.env" <<ENV
BOT_NETWORK=$NET
BOT_API_URL=http://remnawave_bot:8080
BOT_API_TOKEN=$BOT_API_TOKEN
PANEL_URL=$PANEL_URL
PANEL_TOKEN=$PANEL_TOKEN
PANEL_COOKIE=$PANEL_COOKIE
AI_BASE_URL=https://api.aitunnel.ru/v1
AI_API_KEY=$AI_KEY
AI_MODEL=
TG_BOT_TOKEN=$TG_TOKEN
ADMIN_CHAT_ID=$ADMIN
POLL_SECONDS=30
AI_DAILY_LIMIT=150
ENV
    chmod 600 "$DIR/.env"
    ok "Настройки записаны в $DIR/.env"

    warn "Откройте своего нового бота в Telegram и нажмите /start — иначе он не сможет вам писать."
    read -rp "Нажали /start? Enter — продолжить " _ </dev/tty
    (cd "$DIR" && docker compose up -d --build) || die "Не запустилось"
    sleep 8
    docker logs --tail 15 dp_support_ai 2>&1
    echo
    ok "Готово. Если в Telegram пришло «Помощник поддержки запущен» — всё работает."
    ;;
update)
    [ -f "$DIR/.env" ] || die "Сначала bash install.sh"
    fetch
    (cd "$DIR" && docker compose up -d --build) && sleep 5 && docker logs --tail 10 dp_support_ai 2>&1
    ;;
logs)
    docker logs --tail 50 dp_support_ai 2>&1
    ;;
stop)
    (cd "$DIR" && docker compose down) && ok "Остановлен"
    ;;
*)
    sed -n 2,9p "$0"
    ;;
esac
