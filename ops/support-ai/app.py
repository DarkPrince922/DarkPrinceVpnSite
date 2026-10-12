"""ИИ-помощник поддержки DarkPrince VPN.

Следит за обращениями в боте, собирает картину по клиенту (подписка, устройства,
приложение, ноды) и присылает админу в Telegram диагноз и черновик ответа.
Клиенту ничего не уходит, пока админ не нажмёт «Отправить».

Права:
  * служебный API бота — читать обращения и клиентов, отвечать в обращение;
  * панель — токен только на чтение (users, hwid-user-devices, nodes);
  * модель видит статус подписки, устройства и названия приложений — без почты,
    IP-адресов и ссылок подписки.
"""

import asyncio
import base64
import html
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp

log = logging.getLogger("support-ai")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        raise SystemExit(f"Не задан {name} в .env")
    return value


BOT_API = env("BOT_API_URL", "http://remnawave_bot:8080").rstrip("/")
BOT_TOKEN = env("BOT_API_TOKEN", required=True)
PANEL_URL = env("PANEL_URL", required=True).rstrip("/")
PANEL_TOKEN = env("PANEL_TOKEN", required=True)
PANEL_COOKIE = env("PANEL_COOKIE", "")  # «имя:значение», как REMNAWAVE_SECRET_KEY у бота
# любой OpenAI-совместимый API: AITUNNEL (https://api.aitunnel.ru/v1), DeepSeek, OpenRouter
AI_BASE = env("AI_BASE_URL", "https://api.aitunnel.ru/v1").rstrip("/")
AI_KEY = env("AI_API_KEY", required=True)
AI_MODEL = env("AI_MODEL", "")
TG_TOKEN = env("TG_BOT_TOKEN", required=True)
TG_API = env("TG_API_URL", "https://api.telegram.org").rstrip("/")
ADMIN_ID = int(env("ADMIN_CHAT_ID", required=True))
POLL = int(env("POLL_SECONDS", "30"))
DAILY_LIMIT = int(env("AI_DAILY_LIMIT", "150"))  # не больше стольких черновиков в сутки
QUIET = int(env("QUIET_SECONDS", "45"))  # ждать, пока клиент допишет мысль
VISION = env("AI_VISION", "true").lower() == "true"  # показывать модели фото от клиента
# Свободное плавание: простые вопросы помощник закрывает сам, сложные — админу.
# Переключается и командой /auto в Telegram.
AUTO_DEFAULT = env("AUTO_MODE", "off").lower() == "on"
AUTO_MIN_CONFIDENCE = float(env("AUTO_MIN_CONFIDENCE", "0.8"))
AUTO_MAX_PER_TICKET = int(env("AUTO_MAX_PER_TICKET", "2"))  # дальше — пусть ответит человек
# Что недавно менялось: релизы и коммиты наших открытых репозиториев.
GITHUB_REPOS = env("GITHUB_REPOS", "DarkPrince922/Androidvpnapp@claude/android-vpn-telegram-auth-knhmjh=Приложение Android,"
                   "DarkPrince922/darkprincevpnwindows@main=Приложение Windows,"
                   "DarkPrince922/darkprincevpnlinux@main=Приложение Linux,"
                   "DarkPrince922/DarkPrinceVpnSite@main=Сайт и кабинет")
GITHUB_TOKEN = env("GITHUB_TOKEN", "")
VERSIONS_URL = env("VERSIONS_URL", "https://dprince.online/downloads.json")
MAX_AGE = int(env("MAX_AGE_HOURS", "24"))  # старые обращения не трогаем — например, при первом запуске

DATA = Path(env("DATA_DIR", "/data"))
KB_FILE = Path(env("KB_FILE", "/app/kb.md"))
STATE_FILE = DATA / "state.json"


# ---------------- состояние ----------------

def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"handled": {}, "drafts": {}, "prompts": {}, "tg_offset": 0, "day": "", "used": 0}


def save_state():
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False))
    tmp.replace(STATE_FILE)


state = load_state()


# ---------------- HTTP ----------------

session: aiohttp.ClientSession


async def bot_api(method, path, **kw):
    async with session.request(method, f"{BOT_API}{path}", headers={"X-API-Key": BOT_TOKEN},
                               timeout=aiohttp.ClientTimeout(total=30), **kw) as r:
        if r.status >= 400:
            raise RuntimeError(f"бот {method} {path}: HTTP {r.status}")
        return await r.json()


async def bot_file(file_id, limit=5 * 1024 * 1024):
    """Файл из обращения (фото клиента) — байты и тип."""
    async with session.get(f"{BOT_API}/media/{file_id}", headers={"X-API-Key": BOT_TOKEN},
                           timeout=aiohttp.ClientTimeout(total=60)) as r:
        if r.status >= 400:
            raise RuntimeError(f"файл {file_id}: HTTP {r.status}")
        data = await r.content.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError("файл больше 5 МБ")
        return data, r.headers.get("Content-Type", "image/jpeg").split(";")[0]


def panel_cookies():
    if ":" in PANEL_COOKIE:
        name, value = PANEL_COOKIE.split(":", 1)
        return {name: value}
    return {PANEL_COOKIE: PANEL_COOKIE} if PANEL_COOKIE else {}


async def panel(path):
    async with session.get(f"{PANEL_URL}{path}", headers={"Authorization": f"Bearer {PANEL_TOKEN}"},
                           cookies=panel_cookies(), timeout=aiohttp.ClientTimeout(total=20)) as r:
        if r.status >= 400:
            raise RuntimeError(f"панель {path}: HTTP {r.status}")
        return (await r.json()).get("response")


async def tg_photo(data, mime, caption):
    """Фото — загрузкой: file_id основного бота другому боту не годится."""
    form = aiohttp.FormData()
    form.add_field("chat_id", str(ADMIN_ID))
    form.add_field("caption", caption[:1000])
    form.add_field("photo", data, filename="photo." + (mime.split("/")[-1] or "jpg"), content_type=mime)
    async with session.post(f"{TG_API}/bot{TG_TOKEN}/sendPhoto", data=form, timeout=aiohttp.ClientTimeout(total=60)) as r:
        result = await r.json()
        if not result.get("ok"):
            raise RuntimeError(f"telegram sendPhoto: {result.get('description')}")


async def tg(method, **params):
    async with session.post(f"{TG_API}/bot{TG_TOKEN}/{method}", json=params,
                            timeout=aiohttp.ClientTimeout(total=60)) as r:
        data = await r.json()
        if not data.get("ok"):
            raise RuntimeError(f"telegram {method}: {data.get('description')}")
        return data["result"]


# ---------------- модель ----------------

def choose_model(ids):
    """DeepSeek Flash, самый свежий. У посредников в списке сотни моделей —
    берём именно DeepSeek, а не любую «flash» (у Gemini она тоже есть)."""
    deepseek = [i for i in ids if "deepseek" in i.lower()]
    flash = sorted((i for i in deepseek if "flash" in i.lower()), reverse=True)
    if flash:
        return flash[0]
    for name in ("deepseek-chat", "deepseek-v4", "deepseek-v3"):
        found = sorted((i for i in deepseek if name in i.lower() and "r1" not in i.lower()), reverse=True)
        if found:
            return found[0]
    return None


async def pick_model():
    """Название модели спрашиваем у провайдера, если не задано руками в AI_MODEL."""
    global AI_MODEL
    if AI_MODEL:
        return AI_MODEL
    try:
        async with session.get(f"{AI_BASE}/models", headers={"Authorization": f"Bearer {AI_KEY}"},
                               timeout=aiohttp.ClientTimeout(total=20)) as r:
            ids = [m["id"] for m in (await r.json()).get("data", [])]
    except Exception as e:
        raise SystemExit(f"Не получилось спросить список моделей у {AI_BASE}: {e}")
    AI_MODEL = choose_model(ids)
    if not AI_MODEL:
        raise SystemExit("У провайдера нет моделей DeepSeek — впишите нужную в AI_MODEL в .env. "
                         "Доступны: " + ", ".join(ids[:40]))
    log.info("модель: %s (всего у провайдера моделей: %d)", AI_MODEL, len(ids))
    return AI_MODEL


RULES = """Ты — помощник поддержки VPN-сервиса DarkPrince VPN. Твоя задача — разобраться
в обращении клиента по фактам ниже и подготовить ответ, который админ отправит
от имени поддержки.

Правила:
- Пиши по-русски, вежливо и коротко: 2–6 предложений, шаги — списком. Обращайся на «вы».
- Опирайся только на факты о клиенте и на базу знаний. Не выдумывай функции, цены,
  сроки и ссылки. Если чего-то не знаешь — так и скажи в диагнозе, а в ответе пообещай
  разобраться.
- Не угадывай. В ответе клиенту не бывает «скорее всего», «наверное», «обычно», «как
  правило»: предположения — только в диагнозе для админа. Не хвали серверы, протоколы и
  приложения как «лучше» или «устойчивее», если этого нет в базе знаний. Нет в фактах и
  базе знаний — значит «уточним и ответим», а confidence не выше 0.5.
- Клиент задал несколько вопросов — ответь на каждый по порядку.
- Не пиши «без ограничений» и подобного, если это прямо не сказано в фактах или базе знаний.
- Никогда не обещай возврат денег, компенсацию, бонусы, исключения и продление —
  это решает только админ. Такие обращения помечай escalate = true.
- Escalate = true также для: вывода реферальных денег, жалоб, сбоев у многих клиентов,
  подозрения на раздачу подписки, всего, где нужен доступ к панели или деньгам.
- Если escalate = true, в ответе клиенту не пиши, чего мы «не можем» или «не обещаем».
  Скажи тепло, что вопрос передан администратору и он ответит лично, и помоги с тем,
  что можно решить сейчас. С недовольным клиентом не спорь и не оправдывайся.
- Если факты расходятся со словами клиента (например, он пишет «не работает три дня»,
  а устройства подключались сегодня), напиши это в диагнозе для админа, но не
  уличай клиента в ответе.
- Не упоминай внутренние слова (панель, HWID-лимит в настройках, токены, логи) в ответе
  клиенту иначе как простыми словами: «ID устройства», «лимит устройств».
- Не пересказывай клиенту его личные данные целиком.

- Раздел «Что недавно менялось» — для тебя. Используй его, чтобы понять, исправлена ли
  проблема и в какой версии. Клиенту говори только простыми словами («в последнем
  обновлении приложения это исправили — обновитесь до версии 2.0.8»). Никогда не упоминай
  коммиты, код, репозитории, ветки, внутренние названия, админку и инструменты администратора.
- Если клиент недоволен прошлым ответом поддержки или пишет третий раз по одной проблеме —
  escalate = true.

Ответь строго JSON-объектом:
{"diagnosis": "что происходит, 1–3 предложения для админа",
 "reply": "готовый текст ответа клиенту",
 "escalate": true/false,
 "reason": "почему нужен админ, если escalate",
 "confidence": число от 0 до 1 — насколько ты уверен, что ответ полностью решает вопрос
   клиента и опирается только на факты и базу знаний}"""


changes_cache = {"at": 0.0, "text": ""}

# Изменения, о которых клиенту говорить незачем: админка, служебные инструменты, сборка.
INTERNAL = ("админк", "помощник поддержки", "конструктор", "заметки к релизу", "merge", "ci ", "ops", "сборк",
            "панель:", "скрипт", "загрузки:", "downloads.json", "выпустить", "релиз ", "релиз:", "readme")


# Слова, при которых сам не отвечает, что бы ни решила модель: деньги, претензии, угрозы.
RISKY = re.compile(r"верн[иу]т|возврат|деньг|рубл|оплатил|списал|списани|компенс|чарджбэк|жалоб|претензи|"
                   r"мошен|обман|развод|суд|роспотреб|банк|отзыв|вывод|вывести|реферальн", re.I)


async def changes_digest():
    """Версии приложений и что менялось за три недели. Кэш на час: GitHub без ключа даёт 60 запросов в час."""
    if time.time() - changes_cache["at"] < 3600 and changes_cache["text"]:
        return changes_cache["text"]
    lines = []
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    try:
        async with session.get(VERSIONS_URL, timeout=aiohttp.ClientTimeout(total=15)) as r:
            v = await r.json(content_type=None)
        parts = [f"{name.capitalize()} {info.get('version')} от {info.get('date')}" for name, info in v.items() if isinstance(info, dict) and info.get("version")]
        lines.append("Текущие версии наших приложений (на dprince.online): " + "; ".join(parts) + ".")
    except Exception as e:
        log.warning("версии приложений: %s", e)
    since = datetime.fromtimestamp(time.time() - 21 * 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for item in filter(None, (x.strip() for x in GITHUB_REPOS.split(","))):
        repo_branch, _, label = item.partition("=")
        repo, _, branch = repo_branch.partition("@")
        try:
            if "Android" in label:
                async with session.get(f"https://api.github.com/repos/{repo}/releases", params={"per_page": 4},
                                       headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as r:
                    for rel in await r.json():
                        notes = [l.strip("•- ").strip() for l in (rel.get("body") or "").splitlines()
                                 if l.strip().startswith(("•", "-"))]
                        if notes:
                            lines.append(f"{label}, релиз {rel.get('tag_name')} ({(rel.get('published_at') or '')[:10]}): " + "; ".join(notes))
            async with session.get(f"https://api.github.com/repos/{repo}/commits",
                                   params={"sha": branch or "main", "since": since, "per_page": 25},
                                   headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as r:
                commits = await r.json()
            for c in commits if isinstance(commits, list) else []:
                subject = c["commit"]["message"].splitlines()[0].strip()
                if any(word in subject.lower() for word in INTERNAL):
                    continue
                lines.append(f"{label}, {c['commit']['author']['date'][:10]}: {subject}")
        except Exception as e:
            log.warning("изменения %s: %s", repo, e)
    changes_cache.update(at=time.time(), text="\n".join(lines[:80]))
    return changes_cache["text"]


async def ask_model(facts, dialog, images=()):
    kb = KB_FILE.read_text() if KB_FILE.exists() else ""
    changes = await changes_digest()
    text = f"# Факты о клиенте\n{facts}\n\n# Переписка\n{dialog}"
    content = text
    if images:
        # фото клиента — обычно скриншот ошибки; модель умеет их читать
        content = [{"type": "text", "text": text + "\n\nНиже — фото, которые приложил клиент."}] + [
            {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode())}}
            for data, mime in images
        ]
    body = {
        "model": await pick_model(),
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": f"{RULES}\n\n# База знаний\n{kb}\n\n# Что недавно менялось (только для тебя)\n{changes or 'нет данных'}"},
            {"role": "user", "content": content},
        ],
    }
    async def call(payload):
        async with session.post(f"{AI_BASE}/chat/completions", json=payload,
                                headers={"Authorization": f"Bearer {AI_KEY}"},
                                timeout=aiohttp.ClientTimeout(total=120)) as r:
            return r.status, await r.json(content_type=None)

    status, data = await call(body)
    if status == 400 and images:
        # модель или посредник не принимает картинки — спрашиваем без них
        log.warning("модель не приняла фото, отвечает без них")
        body["messages"][1]["content"] = text + "\n\n(Клиент приложил фото, но показать его не удалось.)"
        status, data = await call(body)
    if status == 400 and "response_format" in body:
        # не все посредники пропускают строгий JSON-режим — просим JSON словами
        body.pop("response_format")
        status, data = await call(body)
    if status >= 400:
        raise RuntimeError(f"модель: HTTP {status} {str(data)[:200]}")
    text = data["choices"][0]["message"]["content"]
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        result = json.loads(match.group(0)) if match else {"diagnosis": "Модель ответила не JSON", "reply": text, "escalate": True}
    usage = data.get("usage", {})
    log.info("модель: %s токенов на вход, %s на выход", usage.get("prompt_tokens"), usage.get("completion_tokens"))
    return result


# ---------------- факты о клиенте ----------------

def ago(iso):
    if not iso:
        return "никогда"
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    minutes = int((datetime.now(timezone.utc) - dt).total_seconds() // 60)
    if minutes < 60:
        return f"{minutes} мин назад"
    if minutes < 48 * 60:
        return f"{minutes // 60} ч назад"
    return f"{minutes // 1440} дн назад"


def app_name(user_agent):
    return (user_agent or "неизвестно").split("/")[0].split(" ")[0][:30]


async def facts_for(ticket):
    lines = []
    try:
        user = await bot_api("GET", f"/users/{ticket['user_id']}")
    except Exception as e:
        return f"Клиента не удалось загрузить: {e}"
    lines.append(f"Клиент: с нами с {user['created_at'][:10]}, баланс {user['balance_rubles']} ₽, "
                 f"платил раньше: {'да' if user.get('has_had_paid_subscription') else 'нет'}, "
                 f"вход: {'Telegram' if user.get('telegram_id') else 'почта'}.")
    subs = user.get("subscriptions") or ([user["subscription"]] if user.get("subscription") else [])
    if not subs:
        lines.append("Подписок нет.")
    for sub in subs:
        lines.append(
            f"\nПодписка «{sub.get('tariff_name') or ('пробная' if sub.get('is_trial') else 'без тарифа')}»: "
            f"статус {sub.get('actual_status') or sub.get('status')}, до {sub['end_date'][:10]}, "
            f"трафик {sub.get('traffic_used_gb', 0):.1f} из {sub.get('traffic_limit_gb') or '∞'} ГБ, "
            f"устройств по тарифу {sub.get('device_limit') or 'без ограничений'}."
        )
        short = (sub.get("subscription_url") or "").rstrip("/").rsplit("/", 1)[-1]
        if not short:
            continue
        try:
            pu = await panel(f"/api/users/by-short-uuid/{short}")
            traffic = pu.get("userTraffic") or {}
            lines.append(f"  В панели: статус {pu.get('status')}, лимит устройств {pu.get('hwidDeviceLimit')} "
                         f"(0 — без ограничений), последнее подключение к VPN: {ago(traffic.get('onlineAt'))}.")
            devices = (await panel(f"/api/hwid/devices/{pu['id']}") or {}).get("devices", [])
            if devices:
                lines.append(f"  Устройств с ID: {len(devices)}:")
                for d in devices[:8]:
                    lines.append(f"   - {d.get('platform') or '?'} {d.get('deviceModel') or ''}, приложение "
                                 f"{app_name(d.get('userAgent'))}, последний раз {ago(d.get('updatedAt'))}")
            else:
                lines.append("  Устройств с ID нет — приложение не передаёт ID устройства или подписку ещё не добавляли.")
            history = await panel(f"/api/users/{pu['id']}/subscription-request-history")
            records = history if isinstance(history, list) else (history or {}).get("records", [])
            records = sorted(records, key=lambda r: r.get("requestAt", ""))[-5:]
            if records:
                lines.append("  Последние обновления подписки: " + "; ".join(
                    f"{app_name(r.get('userAgent'))} {ago(r.get('requestAt'))}" for r in records))
        except Exception as e:
            lines.append(f"  Данные панели недоступны: {e}")
    try:
        nodes = await panel("/api/nodes") or []
        down = [n["name"] for n in nodes if not n.get("isDisabled") and not n.get("isConnected")]
        lines.append(f"\nСерверы: работают {sum(1 for n in nodes if n.get('isConnected'))} из "
                     f"{sum(1 for n in nodes if not n.get('isDisabled'))}" + (f"; не отвечают: {', '.join(down)}" if down else "") + ".")
    except Exception as e:
        lines.append(f"Статус серверов недоступен: {e}")
    return "\n".join(lines)


def dialog_text(ticket):
    out = []
    for m in sorted(ticket.get("messages", []), key=lambda m: m["id"])[-12:]:
        who = "Поддержка" if m.get("is_from_admin") else "Клиент"
        text = (m.get("message_text") or "").strip()
        if m.get("has_media"):
            text = (text + " " if text else "") + "[приложил фото или файл]"
        out.append(f"{who}: {text}")
    return f"Тема: {ticket.get('title')}\n" + "\n".join(out)


# ---------------- черновики ----------------

def esc(text):
    return html.escape(str(text or ""))


def keyboard(draft_id):
    return {"inline_keyboard": [[
        {"text": "✅ Отправить", "callback_data": f"send:{draft_id}"},
        {"text": "✏️ Изменить", "callback_data": f"edit:{draft_id}"},
        {"text": "🙅 Сам", "callback_data": f"skip:{draft_id}"},
    ]]}


def draft_card(d, footer=""):
    flag = "⚠️ <b>Нужен админ</b>: " + esc(d.get("reason") or "") + "\n\n" if d.get("escalate") else ""
    return (f"🆕 <b>Обращение #{d['ticket_id']}</b> · {esc(d['title'])}\n"
            f"<i>{esc(d['question'])[:600]}</i>\n\n"
            f"{flag}🔎 {esc(d['diagnosis'])}\n\n"
            f"✍️ <b>Черновик:</b>\n{esc(d['reply'])}" + (f"\n\n{footer}" if footer else ""))


def new_day():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if state.get("day") != today:
        state["day"], state["used"] = today, 0


async def process_ticket(brief):
    tid = str(brief["id"])
    ticket = await bot_api("GET", f"/tickets/{tid}")
    messages = sorted(ticket.get("messages", []), key=lambda m: m["id"])
    if not messages or messages[-1].get("is_from_admin"):
        return
    last = messages[-1]
    if state["handled"].get(tid) == last["id"]:
        return
    # клиент мог ещё дописывать — ждём тишины
    created = datetime.fromisoformat(last["created_at"].replace("Z", "+00:00"))
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - created).total_seconds()
    if age < QUIET:
        return
    if age > MAX_AGE * 3600:
        state["handled"][tid] = last["id"]
        save_state()
        return
    new_day()
    if state["used"] >= DAILY_LIMIT:
        log.warning("дневной лимит черновиков исчерпан")
        return
    state["used"] += 1
    state["handled"][tid] = last["id"]
    save_state()

    last_admin = max([x["id"] for x in messages if x.get("is_from_admin")] or [0])
    fresh = [m for m in messages if not m.get("is_from_admin") and m["id"] > last_admin]
    question = "\n".join((m.get("message_text") or "").strip() for m in fresh).strip()

    # клиент дописал — прежний черновик по этому обращению больше не годится
    for key, old in list(state["drafts"].items()):
        if old["ticket_id"] == int(tid):
            state["drafts"].pop(key)
            try:
                await tg("editMessageText", chat_id=ADMIN_ID, message_id=old["message_id"],
                         text=draft_card(old, "⏭ Клиент дописал — смотрите новый черновик ниже")[:4000], parse_mode="HTML")
            except Exception:
                pass

    # фото из новых сообщений клиента: не больше трёх
    images, new_photos = [], []
    seen = set(state.setdefault("photos_sent", []))
    for m in fresh:
        ids = [x.get("file_id") for x in (m.get("media_items") or []) if x.get("type", "photo") == "photo"]
        if not ids and m.get("media_file_id") and (m.get("media_type") or "photo") == "photo":
            ids = [m["media_file_id"]]
        for file_id in ids:
            if len(images) >= 3:
                break
            try:
                images.append(await bot_file(file_id))
                if file_id not in seen:
                    new_photos.append((file_id, images[-1]))
            except Exception as e:
                log.warning("фото из обращения #%s не скачалось: %s", tid, e)
    # админу — только фото, которых он ещё не видел (клиент мог дописать текст к тому же фото)
    for file_id, (data, mime) in new_photos:
        try:
            await tg_photo(data, mime, f"📎 Фото из обращения #{tid}")
            state["photos_sent"] = (state["photos_sent"] + [file_id])[-500:]
        except Exception as e:
            log.warning("фото в Telegram не ушло: %s", e)

    facts = await facts_for(ticket)
    try:
        result = await ask_model(facts, dialog_text(ticket), images if VISION else ())
    except Exception as e:
        log.error("модель не ответила: %s", e)
        result = {"diagnosis": f"Модель не ответила: {e}", "reply": "", "escalate": True, "reason": "черновика нет"}

    draft_id = f"{tid}-{last['id']}"
    auto_count = state.setdefault("auto_count", {}).get(tid, 0)
    try:
        confidence = float(result.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    draft = {
        "ticket_id": int(tid), "after": last["id"], "title": ticket.get("title"),
        "question": question or "[без текста]", "diagnosis": result.get("diagnosis", ""),
        "reply": (result.get("reply") or "").strip(), "escalate": bool(result.get("escalate")),
        "reason": result.get("reason", ""), "confidence": confidence,
    }

    if RISKY.search(question) and not draft["escalate"]:
        draft["escalate"] = True
        draft["reason"] = draft["reason"] or "деньги или претензия — отвечает только человек"
    can_auto = (state.get("auto", AUTO_DEFAULT) and draft["reply"] and not draft["escalate"]
                and confidence >= AUTO_MIN_CONFIDENCE and auto_count < AUTO_MAX_PER_TICKET)
    if can_auto:
        problem = await send_reply(draft, draft["reply"])
        if not problem:
            state["auto_count"][tid] = auto_count + 1
            await tg("sendMessage", chat_id=ADMIN_ID, parse_mode="HTML",
                     text=draft_card(draft, f"🤖 <b>Ответил сам</b> (уверенность {confidence:.0%})")[:4000])
            save_state()
            return
        log.info("автоответ на #%s не отправлен: %s", tid, problem)

    if state.get("auto", AUTO_DEFAULT) and auto_count >= AUTO_MAX_PER_TICKET and not draft["escalate"]:
        draft["escalate"], draft["reason"] = True, f"клиент пишет снова после {auto_count} автоответов — нужен человек"
    msg = await tg("sendMessage", chat_id=ADMIN_ID, text=draft_card(draft)[:4000], parse_mode="HTML",
                   reply_markup=keyboard(draft_id) if draft["reply"] else None)
    draft["message_id"] = msg["message_id"]
    state["drafts"][draft_id] = draft
    # старые черновики не копим
    for key in list(state["drafts"])[:-100]:
        state["drafts"].pop(key, None)
    save_state()


async def send_reply(draft, text):
    """Ответить в обращение. Если тем временем уже ответили — не дублируем."""
    ticket = await bot_api("GET", f"/tickets/{draft['ticket_id']}")
    later = [m for m in ticket.get("messages", []) if m["id"] > draft["after"]]
    if any(m.get("is_from_admin") for m in later):
        return "уже есть ответ поддержки — этот черновик не отправлен"
    if later:
        return "клиент дописал после черновика — дождитесь нового черновика"
    await bot_api("POST", f"/tickets/{draft['ticket_id']}/reply", json={"message_text": text})
    return None


async def on_callback(cq):
    if cq["from"]["id"] != ADMIN_ID:
        return
    action, _, draft_id = cq.get("data", "").partition(":")
    draft = state["drafts"].get(draft_id)
    if not draft:
        await tg("answerCallbackQuery", callback_query_id=cq["id"], text="Черновик устарел")
        return
    if action == "send":
        problem = await send_reply(draft, draft["reply"])
        footer = f"⛔ {problem}" if problem else "✅ <b>Отправлено</b>"
        await tg("editMessageText", chat_id=ADMIN_ID, message_id=draft["message_id"], text=draft_card(draft, footer)[:4000], parse_mode="HTML")
        await tg("answerCallbackQuery", callback_query_id=cq["id"], text="Не отправлено" if problem else "Отправлено")
        state["drafts"].pop(draft_id, None)
    elif action == "edit":
        prompt = await tg("sendMessage", chat_id=ADMIN_ID, text=f"Пришлите исправленный ответ на обращение #{draft['ticket_id']} ответом на это сообщение.",
                          reply_markup={"force_reply": True, "input_field_placeholder": "Ответ клиенту"})
        state["prompts"][str(prompt["message_id"])] = draft_id
        await tg("sendMessage", chat_id=ADMIN_ID, text=draft["reply"])  # чтобы было что скопировать и поправить
        await tg("answerCallbackQuery", callback_query_id=cq["id"])
    elif action == "skip":
        await tg("editMessageText", chat_id=ADMIN_ID, message_id=draft["message_id"], text=draft_card(draft, "🙅 Отвечаете сами")[:4000], parse_mode="HTML")
        await tg("answerCallbackQuery", callback_query_id=cq["id"])
        state["drafts"].pop(draft_id, None)
    save_state()


async def on_message(msg):
    if msg.get("from", {}).get("id") != ADMIN_ID:
        return
    reply_to = str((msg.get("reply_to_message") or {}).get("message_id", ""))
    draft_id = state["prompts"].pop(reply_to, None)
    if not draft_id:
        await on_command((msg.get("text") or "").strip())
        return
    draft = state["drafts"].get(draft_id)
    text = (msg.get("text") or "").strip()
    if not draft:
        await tg("sendMessage", chat_id=ADMIN_ID, text="Этот черновик устарел: клиент дописал. Смотрите новый.")
        return
    if not text:
        return
    problem = await send_reply(draft, text)
    draft["reply"] = text
    footer = f"⛔ {problem}" if problem else "✅ <b>Отправлено с правками</b>"
    await tg("editMessageText", chat_id=ADMIN_ID, message_id=draft["message_id"], text=draft_card(draft, footer)[:4000], parse_mode="HTML")
    await tg("sendMessage", chat_id=ADMIN_ID, text="Не отправлено: " + problem if problem else "Отправлено ✅")
    state["drafts"].pop(draft_id, None)
    save_state()


async def on_command(text):
    auto = state.get("auto", AUTO_DEFAULT)
    if text in ("/auto on", "/auto_on"):
        state["auto"] = True
        save_state()
        await tg("sendMessage", chat_id=ADMIN_ID, text=(
            "🤖 Свободное плавание включено. Простые вопросы отвечу сам (уверенность от "
            f"{AUTO_MIN_CONFIDENCE:.0%}), деньги, жалобы и всё непонятное — пришлю вам. "
            f"На одно обращение — не больше {AUTO_MAX_PER_TICKET} автоответов. Выключить: /auto off"))
    elif text in ("/auto off", "/auto_off"):
        state["auto"] = False
        save_state()
        await tg("sendMessage", chat_id=ADMIN_ID, text="✋ Свободное плавание выключено: только черновики с кнопками.")
    elif text in ("/status", "/start", "/help"):
        new_day()
        await tg("sendMessage", chat_id=ADMIN_ID, text=(
            f"Помощник поддержки на связи. Модель: {AI_MODEL}.\n"
            f"Режим: {'свободное плавание 🤖' if auto else 'черновики ✋'}.\n"
            f"Черновиков сегодня: {state.get('used', 0)} из {DAILY_LIMIT}.\n\n"
            "/auto on — отвечать на простое самому\n/auto off — только черновики\n/status — это сообщение"))


# ---------------- циклы ----------------

async def tickets_loop():
    while True:
        try:
            for status in ("open", "pending"):
                for brief in await bot_api("GET", "/tickets", params={"status": status, "limit": 50}):
                    try:
                        await process_ticket(brief)
                    except Exception as e:
                        log.error("обращение #%s: %s", brief.get("id"), e)
        except Exception as e:
            log.error("список обращений: %s", e)
        await asyncio.sleep(POLL)


async def telegram_loop():
    while True:
        try:
            updates = await tg("getUpdates", offset=state.get("tg_offset", 0), timeout=50,
                               allowed_updates=["message", "callback_query"])
            for u in updates:
                state["tg_offset"] = u["update_id"] + 1
                try:
                    if "callback_query" in u:
                        await on_callback(u["callback_query"])
                    elif "message" in u:
                        await on_message(u["message"])
                except Exception as e:
                    log.error("telegram: %s", e)
            save_state()
        except Exception as e:
            log.error("telegram getUpdates: %s", e)
            await asyncio.sleep(5)


async def main():
    global session
    async with aiohttp.ClientSession() as s:
        session = s
        await pick_model()
        auto = state.get("auto", AUTO_DEFAULT)
        await tg("sendMessage", chat_id=ADMIN_ID, text=f"🤖 Помощник поддержки запущен. Модель: {AI_MODEL}. "
                                                       f"Режим: {'свободное плавание' if auto else 'черновики'}. /status — подробнее")
        await asyncio.gather(tickets_loop(), telegram_loop())


if __name__ == "__main__":
    asyncio.run(main())
