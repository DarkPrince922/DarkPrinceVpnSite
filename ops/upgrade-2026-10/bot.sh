#!/usr/bin/env bash
# Бот Bedolaga 3.67 → 5.0.0 и кабинет 1.57 → 1.80.1. Запускать на сервере бота.
#
#   bash bot.sh prepare    — копии, код 5.0.0, сборка образа заранее (старый бот работает)
#   bash bot.sh apply      — перенос базы на PostgreSQL 18 и запуск бота 5.0 (бот лежит 2–5 минут)
#   bash bot.sh backfill   — привязка подписок к числовым id панели 3.x (сначала проверка, потом запись)
#   bash bot.sh cabinet    — кабинет 1.80.1 вместо старого
#   bash bot.sh status
#   bash bot.sh rollback   — вернуть бота 3.67 на старую базу PostgreSQL 15
#
# apply и backfill — только ПОСЛЕ того, как панель уже на 3.x.
set -uo pipefail

BOT_DIR=/opt/remnawave-bedolaga-telegram-bot
TAG=v5.0.0
CABINET_DIR=/var/www/bedolaga-cabinet
CABINET_URL=https://raw.githubusercontent.com/DarkPrince922/DarkPrinceVpnSite/main/ops/upgrade-2026-10/cabinet-v1.80.1.tar.gz
CABINET_SHA=2806cfcb31ae7243be02f3b5d0bd6ab63849cc100da1de68e4ca8572cc9a42e7
STATE=/root/bot-upgrade

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local a; read -r -p "$1 (да/нет) " a </dev/tty; [ "$a" = да ]; }

cd "$BOT_DIR" 2>/dev/null || die "Нет папки $BOT_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || die "$BOT_DIR — не git-репозиторий, обновлять нужно иначе"

wait_bot() {
    local st
    for i in $(seq 1 72); do
        st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' remnawave_bot 2>/dev/null)
        [ "$st" = healthy ] && return 0
        sleep 5
    done
    docker logs --tail 60 remnawave_bot 2>&1
    return 1
}

case "${1:-}" in
prepare)
    say "Сейчас: $(git describe --tags --always 2>/dev/null)"
    avail=$(df -Pm / | awk 'NR==2{print $4}')
    [ "$avail" -gt 3000 ] || die "Мало места: ${avail} МБ, нужно хотя бы 3000 (копия базы + новый образ)"
    ok "Место: ${avail} МБ"
    docker volume ls -q | grep -q '_postgres_data$' || die "Не нашёл том базы *_postgres_data — пришли вывод 'docker volume ls'"

    say "Копии"
    dir="$STATE/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir" && chmod 700 "$STATE" "$dir"
    cp -a .env docker-compose.yml "$dir/" || die "Не скопировал .env/compose"
    [ -f vpn_logo.png ] && cp -a vpn_logo.png "$dir/"
    git rev-parse HEAD >"$dir/old-commit"
    git diff >"$dir/local-changes.patch"
    docker exec remnawave_bot_db sh -c 'pg_dumpall -U "$POSTGRES_USER"' | gzip >"$dir/db-pg15.sql.gz" \
        || die "Копия базы не снялась"
    echo "$dir" >"$STATE/last-backup"
    ok "Копия: $dir ($(du -sh "$dir" | cut -f1))"

    changed=$(git diff --name-only | grep -v '^vpn_logo.png$' || true)
    if [ -n "$changed" ]; then
        warn "Есть свои правки в файлах бота (сохранены в $dir/local-changes.patch):"
        echo "$changed"
        ask "Обновление их перезапишет. Продолжить?" || exit 1
    fi

    say "Код $TAG"
    git fetch --tags origin || die "git fetch не прошёл"
    git rev-parse "$TAG" >/dev/null 2>&1 || die "Нет тега $TAG"
    git checkout -f "$TAG" || die "Не переключился на $TAG"
    [ -f "$dir/vpn_logo.png" ] && cp -a "$dir/vpn_logo.png" vpn_logo.png
    # единственная переменная, которую 4.0 переименовал (и поменял формат: числа вместо UUID)
    if grep -q '^TRAFFIC_EXCLUDED_USER_UUIDS=' .env; then
        sed -i 's/^TRAFFIC_EXCLUDED_USER_UUIDS=/# 4.0: нужны числовые id панели, а не UUID\n# TRAFFIC_EXCLUDED_USER_UUIDS=/' .env
        warn "TRAFFIC_EXCLUDED_USER_UUIDS закомментирован — в 4.0 нужен TRAFFIC_EXCLUDED_USER_IDS с числовыми id"
    fi
    ok "Код: $(git describe --tags)"

    say "Сборка образа бота и скачивание PostgreSQL 18 (старый бот продолжает работать)"
    docker pull postgres:18-alpine || die "Не скачался postgres:18-alpine"
    docker compose build bot || die "Сборка не прошла"
    ok "Готово. apply — только после обновления панели"
    ;;
apply)
    [ "$(git describe --tags 2>/dev/null)" = "$TAG" ] || die "Сначала bash bot.sh prepare"
    say "Перенос базы на PostgreSQL 18 и запуск бота $TAG"
    bash scripts/pg-upgrade.sh --yes || die "pg-upgrade не прошёл — старая база не тронута. Откат: bash bot.sh rollback"
    say "Жду, пока бот поднимется"
    wait_bot || die "Бот не поднялся, логи выше"
    ok "Бот работает: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health) на /health"
    echo "Дальше: bash bot.sh backfill"
    ;;
backfill)
    say "Проверка привязки (ничего не пишет)"
    docker exec remnawave_bot python -m scripts.backfill_remnawave_ids 2>&1 | tail -40
    echo
    warn "Смотри строки unresolved и conflicts. conflicts должен быть 0."
    if ask "Записать привязку?"; then
        docker exec remnawave_bot python -m scripts.backfill_remnawave_ids --apply 2>&1 | tail -40
        docker restart remnawave_bot >/dev/null && wait_bot && ok "Привязка записана, бот перезапущен"
    fi
    ;;
cabinet)
    say "Кабинет 1.80.1"
    tmp=$(mktemp -d)
    curl -fsSL "$CABINET_URL" -o "$tmp/cab.tgz" || die "Не скачался кабинет"
    echo "$CABINET_SHA  $tmp/cab.tgz" | sha256sum -c --quiet || die "Контрольная сумма не сошлась"
    mkdir -p "$tmp/new" && tar -xzf "$tmp/cab.tgz" -C "$tmp/new" || die "Архив не распаковался"
    [ -f "$tmp/new/index.html" ] || die "В архиве нет index.html"
    old="$CABINET_DIR.1.57-$(date +%Y%m%d-%H%M%S)"
    [ -d "$CABINET_DIR" ] && mv "$CABINET_DIR" "$old"
    mv "$tmp/new" "$CABINET_DIR" && chmod -R a+rX "$CABINET_DIR"
    rm -rf "$tmp"
    ok "Кабинет обновлён. Старый лежит в $old"
    code=$(curl -s -o /dev/null -w '%{http_code}' https://cabinet.darkprincepanel.ru/)
    echo "cabinet.darkprincepanel.ru → $code"
    ;;
status)
    echo "Код: $(git describe --tags --always)"
    docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'remnawave_bot|remnanode'
    echo "health: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health)"
    docker logs --tail 20 remnawave_bot 2>&1
    ;;
rollback)
    dir=$(cat "$STATE/last-backup" 2>/dev/null) || die "Нет копии"
    warn "Верну бота на $(cat "$dir/old-commit" | cut -c1-8) и старую базу PostgreSQL 15. Изменения после переноса пропадут."
    ask "Точно?" || exit 0
    docker compose down
    git checkout -f "$(cat "$dir/old-commit")"
    cp -a "$dir/.env" .env
    [ -f "$dir/vpn_logo.png" ] && cp -a "$dir/vpn_logo.png" vpn_logo.png
    docker compose up -d --build && ok "Бот 3.67 на старой базе. Панель тоже нужно откатить: bash panel.sh rollback"
    ;;
*)
    sed -n 2,12p "$0"
    ;;
esac
