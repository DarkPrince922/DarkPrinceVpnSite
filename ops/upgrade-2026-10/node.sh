#!/usr/bin/env bash
# Нода Remnawave 2.x → 3.x. Запускать на каждом сервере с нодой
# (и на сервере бота — там тоже стоит remnanode).
#
#   bash node.sh prepare   — скачать образ заранее (нода работает)
#   bash node.sh apply     — перезапуск на 3.x (VPN на этом сервере пропадёт на 10–30 секунд)
#   bash node.sh status
#   bash node.sh rollback  — вернуть прежний образ
set -uo pipefail

NEW_TAG=3.4.2
STATE=/root/rw-node-upgrade

ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# контейнер ноды — по образу, имя у всех может быть своё
C=$(docker ps -a --format '{{.Names}} {{.Image}}' | awk '$2 ~ /(^|\/)remnawave\/node(:|$)/ {print $1; exit}')
[ -n "$C" ] || die "Нода (образ remnawave/node) на этом сервере не найдена"
WORKDIR=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$C")
FILE=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$C")
PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$C")
[ -n "$WORKDIR" ] && [ -f "$FILE" ] || die "Нода $C запущена не через docker compose — обнови её вручную"
SERVICE=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$C")
dc() { (cd "$WORKDIR" && docker compose -p "$PROJECT" -f "$FILE" "$@"); }
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$C")

case "${1:-}" in
prepare)
    echo "Нода: $C, образ $IMAGE, compose $FILE"
    mkdir -p "$STATE" && cp -a "$FILE" "$STATE/compose.backup.yml" && echo "$IMAGE" >"$STATE/old-image"
    docker pull "remnawave/node:$NEW_TAG" || die "Не скачался remnawave/node:$NEW_TAG"
    ok "Образ скачан. Дальше: bash node.sh apply"
    ;;
apply)
    [ -f "$STATE/old-image" ] || die "Сначала bash node.sh prepare"
    # любая прежняя версия: 2.7.0, 2.8.0, latest, без тега, с docker.io/ впереди
    sed -i -E "s#image:[[:space:]]*['\"]?([a-z0-9.-]+/)?remnawave/node(:[^'\"[:space:]]*)?['\"]?[[:space:]]*\$#image: remnawave/node:$NEW_TAG#" "$FILE"
    grep -q "image: remnawave/node:$NEW_TAG" "$FILE" || die "Не смог поменять образ в $FILE — пришли его содержимое"
    dc up -d "$SERVICE" || die "docker compose up не прошёл"
    sleep 8
    st=$(docker inspect -f '{{.State.Status}}' "$C" 2>/dev/null)
    [ "$st" = running ] || { docker logs --tail 40 "$C"; die "Нода не запустилась ($st)"; }
    ok "Нода на $(docker inspect -f '{{.Config.Image}}' "$C"), работает"
    docker logs --tail 8 "$C" 2>&1
    ;;
status)
    echo "$C: $IMAGE, $(docker inspect -f '{{.State.Status}}' "$C")"
    docker logs --tail 15 "$C" 2>&1
    ;;
rollback)
    [ -f "$STATE/compose.backup.yml" ] || die "Нет копии compose"
    cp -a "$STATE/compose.backup.yml" "$FILE"
    dc up -d "$SERVICE" && ok "Нода возвращена на $(cat "$STATE/old-image")"
    ;;
*)
    sed -n 2,9p "$0"
    ;;
esac
