#!/usr/bin/env bash
# Панель Remnawave 2.x → 3.x. Запускать на сервере панели.
#
#   bash panel.sh prepare   — резервная копия, проверка .env, скачивание образов (панель работает)
#   bash panel.sh apply     — переключение на 3.x (панель недоступна 1–3 минуты, VPN работает)
#   bash panel.sh status    — версия, здоровье, хвост логов
#   bash panel.sh rollback  — вернуть 2.x и базу из последней копии
#
# Секреты на экран не выводятся.
set -uo pipefail

CONTAINER=remnawave
DB_CONTAINER=remnawave-db
NEW_IMAGE=remnawave/backend:3
STATE=/root/rw-upgrade

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# Где лежит compose панели — берём из меток контейнера, а не угадываем:
# у тебя он в /root/remnawave_20260618_040001/panel-docker-compose.yml.
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "Контейнер $CONTAINER не найден"
WORKDIR=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CONTAINER")
FILE=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER")
PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")
[ -n "$WORKDIR" ] && [ -f "$FILE" ] || die "Не нашёл compose панели (метки контейнера пустые)"
ENVFILE="$WORKDIR/.env"
[ -f "$ENVFILE" ] || die "Нет $ENVFILE"
dc() { (cd "$WORKDIR" && docker compose -p "$PROJECT" -f "$FILE" "$@"); }

backup() {
    local dir="$STATE/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir" && chmod 700 "$STATE" "$dir"
    cp -a "$FILE" "$ENVFILE" "$dir/" || die "Не смог скопировать compose/.env"
    # pg_dump под теми же пользователем и базой, что в контейнере
    docker exec "$DB_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dir/db.dump" \
        || die "pg_dump не удался — дальше не идём"
    [ -s "$dir/db.dump" ] || die "Пустой дамп базы"
    docker exec -i "$DB_CONTAINER" pg_restore --list <"$dir/db.dump" >/dev/null 2>&1 \
        || die "Дамп не читается"
    echo "$dir" >"$STATE/last-backup"
    ok "Копия: $dir ($(du -h "$dir/db.dump" | cut -f1))"
}

case "${1:-}" in
prepare)
    say "Панель: $FILE (проект $PROJECT)"
    echo "Сейчас: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
    avail=$(df -Pm / | awk 'NR==2{print $4}')
    [ "$avail" -gt 1500 ] || die "Мало места: ${avail} МБ, нужно хотя бы 1500"
    ok "Место: ${avail} МБ"

    say "Проверка .env"
    if grep -q '^APP_SECRET=' "$ENVFILE"; then
        ok "APP_SECRET уже есть"
    elif grep -q '^JWT_AUTH_SECRET=' "$ENVFILE"; then
        ok "Есть JWT_AUTH_SECRET — при apply он станет APP_SECRET с тем же значением (токен бота останется рабочим)"
    else
        die "В .env нет ни APP_SECRET, ни JWT_AUTH_SECRET — пришли вывод, разберёмся"
    fi
    grep -q '^WEBHOOK_ENABLED=true' "$ENVFILE" && ok "Вебхук в бота включён — останется как есть"

    say "Резервная копия"
    backup

    say "Скачиваю новые образы (панель пока работает)"
    docker pull "$NEW_IMAGE" || die "Не скачался $NEW_IMAGE"
    docker pull remnawave/subscription-page:latest || warn "subscription-page не скачался — обновим позже"
    ok "Готово. Дальше: bash panel.sh apply"
    ;;
apply)
    [ -f "$STATE/last-backup" ] || die "Сначала bash panel.sh prepare"
    say "Свежая копия перед переключением"
    backup

    say "Правлю .env и compose"
    if ! grep -q '^APP_SECRET=' "$ENVFILE"; then
        # то же значение, что у JWT_AUTH_SECRET: в 2.8 панель читала именно его
        val=$(grep -m1 '^JWT_AUTH_SECRET=' "$ENVFILE" | cut -d= -f2-)
        [ -n "$val" ] || die "Пустой JWT_AUTH_SECRET"
        printf '\n# 3.x: бывший JWT_AUTH_SECRET, значение то же\nAPP_SECRET=%s\n' "$val" >>"$ENVFILE"
        ok "APP_SECRET добавлен"
    fi
    sed -i -E "s#image:[[:space:]]*['\"]?remnawave/backend:[^'\"[:space:]]*['\"]?#image: $NEW_IMAGE#" "$FILE"
    grep -q "image: $NEW_IMAGE" "$FILE" || die "Не смог поменять образ в $FILE"
    ok "Образ: $NEW_IMAGE"

    say "Запускаю панель 3.x (миграции базы — 1–2 минуты)"
    dc up -d remnawave remnawave-subscription-page || die "docker compose up не прошёл"
    for i in $(seq 1 60); do
        st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null)
        [ "$st" = healthy ] && break
        [ "$st" = exited ] && break
        sleep 5
    done
    if [ "$st" = healthy ]; then
        ok "Панель поднялась: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
    else
        docker logs --tail 60 "$CONTAINER"
        die "Панель не стала healthy ($st). Логи выше. Откат: bash panel.sh rollback"
    fi
    ;;
status)
    echo "Образ: $(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
    echo "Состояние: $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER")"
    docker logs --tail 25 "$CONTAINER" 2>&1
    ;;
rollback)
    dir=$(cat "$STATE/last-backup" 2>/dev/null) || die "Нет копии"
    warn "Верну панель 2.x и базу из $dir. Всё, что изменилось после копии, пропадёт."
    read -r -p "Точно? (да/нет) " a </dev/tty
    [ "$a" = да ] || exit 0
    dc stop remnawave
    cp -a "$dir/$(basename "$FILE")" "$FILE"
    cp -a "$dir/.env" "$ENVFILE"
    docker exec "$DB_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"' >/dev/null \
        || die "Не смог очистить базу"
    docker exec -i "$DB_CONTAINER" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' <"$dir/db.dump" \
        || warn "pg_restore сообщил об ошибках — проверь логи панели"
    dc up -d remnawave remnawave-subscription-page
    ok "Откат выполнен. Ноды тоже верни на 2.8: bash node.sh rollback"
    ;;
*)
    sed -n 2,9p "$0"
    ;;
esac
