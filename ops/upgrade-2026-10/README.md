# Обновление: панель 3.x, ноды 3.4.2, бот 5.0.0, кабинет 1.80.1

Скрипты ничего не печатают из секретов. Каждый шаг можно повторить.

## 0. Скачать скрипты (на каждом сервере)

```
mkdir -p /root/upg && cd /root/upg && for f in panel.sh node.sh bot.sh; do curl -fsSLO https://raw.githubusercontent.com/DarkPrince922/DarkPrinceVpnSite/main/ops/upgrade-2026-10/$f; done
```

## 1. Подготовка — всё продолжает работать

| Сервер | Команда |
|---|---|
| панель (vm-bossil) | `bash /root/upg/panel.sh prepare` |
| каждая нода | `bash /root/upg/node.sh prepare` |
| бот (kugergin02-vps-1) | `bash /root/upg/bot.sh prepare` и `bash /root/upg/node.sh prepare` |

## 2. Переключение — подряд, без пауз

1. бот: `docker stop remnawave_bot` — чтобы старый бот не писал в новую панель
2. панель: `bash /root/upg/panel.sh apply`
3. все ноды сразу: `bash /root/upg/node.sh apply`
4. бот: `bash /root/upg/bot.sh apply`
5. бот: `bash /root/upg/bot.sh backfill`
6. бот: `bash /root/upg/bot.sh cabinet`

## 3. Проверка

- панель открывается, ноды зелёные
- `/start` в боте, кабинет, приложение: вход, подписка, подключение

## Откат

`bot.sh rollback`, `panel.sh rollback`, `node.sh rollback` — каждый на своём сервере.
