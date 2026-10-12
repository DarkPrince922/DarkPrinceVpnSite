#!/usr/bin/env python3
"""Кто ходит на dprince.online: поисковые роботы, люди, скачивания, приложения.

Читает журналы nginx (и старые .gz) и печатает только сводку — ни адресов, ни
ссылок подписок наружу не выводит.

    python3 site-stats.py            # за 14 дней
    python3 site-stats.py 30         # за 30 дней
    LOGS=/var/log/nginx/access.log* python3 site-stats.py
"""
import glob
import gzip
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 14
FILES = sorted(glob.glob(os.environ.get("LOGS", "/var/log/nginx/access.log*")))
SINCE = datetime.now(timezone.utc) - timedelta(days=DAYS)

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"')

BOTS = [
    ("Яндекс", re.compile(r"YandexBot|YandexMobileBot|YandexImages|YandexMetrika|YandexRenderResourcesBot", re.I)),
    ("Google", re.compile(r"Googlebot|Google-InspectionTool|GoogleOther|AdsBot-Google", re.I)),
    ("Bing", re.compile(r"bingbot", re.I)),
    ("Mail.ru", re.compile(r"Mail\.RU_Bot", re.I)),
    ("DuckDuckGo", re.compile(r"DuckDuckBot", re.I)),
    ("Telegram (превью ссылок)", re.compile(r"TelegramBot", re.I)),
]
OTHER_BOT = re.compile(r"bot|crawl|spider|slurp|curl|wget|python|go-http|headless|scan|monitor|okhttp|facebookexternalhit", re.I)
PAGE = re.compile(r"^/(?:$|index\.html|help|privacy|terms|invite|cabinet)")
APPS = {
    "/updates/android.json": "Android",
    "/updates/windows-x86_64.json": "Windows",
    "/updates/linux-x86_64.json": "Linux",
}


def lines():
    for path in FILES:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", encoding="utf-8", errors="replace") as f:
                yield from f
        except OSError as e:
            print(f"не прочитать {path}: {e}", file=sys.stderr)


bot_hits = Counter()
bot_pages = defaultdict(set)
bot_last = {}
robots_sitemap = Counter()
human_days = defaultdict(set)
human_views = Counter()
pages = Counter()
sources = Counter()
downloads = defaultdict(set)
apps = defaultdict(set)
cabinet_users = set()
total = 0

for raw in lines():
    m = LINE.match(raw)
    if not m:
        continue
    ip, when, method, path, status, ref, ua = m.groups()
    try:
        t = datetime.strptime(when, "%d/%b/%Y:%H:%M:%S %z")
    except ValueError:
        continue
    if t < SINCE:
        continue
    total += 1
    path = path.split("?", 1)[0]
    day = t.strftime("%Y-%m-%d")

    name = next((n for n, rx in BOTS if rx.search(ua)), None)
    if name:
        bot_hits[name] += 1
        if status.startswith("2") and not path.startswith(("/_astro", "/assets", "/fonts")):
            bot_pages[name].add(path)
        bot_last[name] = max(bot_last.get(name, t), t)
        if path in ("/robots.txt", "/sitemap-index.xml", "/sitemap-0.xml"):
            robots_sitemap[f"{name} {path}"] += 1
        continue

    if path in APPS and status.startswith(("2", "3")):
        apps[APPS[path]].add(ip)
        continue
    if path.startswith("/downloads/") and status in ("200", "206"):
        downloads[path.rsplit("/", 1)[-1]].add(ip)
        continue
    if path.startswith("/api/cabinet/") and status.startswith("2"):
        cabinet_users.add(ip)
        continue
    if OTHER_BOT.search(ua) or not ua or ua == "-":
        continue
    if method == "GET" and status.startswith("2") and PAGE.match(path):
        human_days[day].add(ip)
        human_views[day] += 1
        pages[path] += 1
        r = ref.lower()
        if "dprince.online" in r or r in ("", "-"):
            src = "напрямую / закладка" if r in ("", "-") else None
        elif "yandex" in r or "ya.ru" in r:
            src = "Яндекс"
        elif "google" in r:
            src = "Google"
        elif "t.me" in r or "telegram" in r:
            src = "Telegram"
        elif "vk.com" in r or "vk.ru" in r:
            src = "ВКонтакте"
        else:
            src = "другие сайты"
        if src:
            sources[src] += 1

print(f"Журналы: {len(FILES)} файлов, запросов за {DAYS} дн.: {total}\n")

print("ПОИСКОВЫЕ РОБОТЫ")
if not bot_hits:
    print("  ни одного — сайт поисковики ещё не нашли")
for name, hits in bot_hits.most_common():
    last = bot_last[name].strftime("%d.%m %H:%M")
    print(f"  {name}: {hits} запросов, страниц прочитано {len(bot_pages[name])}, последний раз {last}")
for key, n in sorted(robots_sitemap.items()):
    print(f"    · {key}: {n}")

print("\nЛЮДИ НА САЙТЕ (без роботов)")
for day in sorted(human_days):
    print(f"  {day[8:]}.{day[5:7]}: посетителей {len(human_days[day]):>4}, просмотров {human_views[day]:>5}")
unique = set().union(*human_days.values()) if human_days else set()
print(f"  всего разных посетителей: {len(unique)}")

print("\nОТКУДА ПРИХОДЯТ (просмотры)")
for src, n in sources.most_common():
    print(f"  {src}: {n}")

print("\nПОПУЛЯРНЫЕ СТРАНИЦЫ")
for path, n in pages.most_common(10):
    print(f"  {n:>5}  {path}")

print("\nСКАЧИВАНИЯ (разных адресов)")
for name, ips in sorted(downloads.items(), key=lambda x: -len(x[1])):
    print(f"  {name}: {len(ips)}")

print("\nПРИЛОЖЕНИЯ, проверявшие обновления (≈ живые установки)")
for name in ("Android", "Windows", "Linux"):
    print(f"  {name}: {len(apps.get(name, ()))}")
print(f"\nКабинет на сайте и приложения ходили в API с {len(cabinet_users)} разных адресов")
