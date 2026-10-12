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
- Никогда не обещай возврат денег, компенсацию, бонусы, исключения и продление —
  это решает только админ. Такие обращения помечай escalate = true.
- Escalate = true также для: вывода реферальных денег, жалоб, сбоев у многих клиентов,
  подозрения на раздачу подписки, всего, где нужен доступ к панели или деньгам.
- Не упоминай внутренние слова (панель, HWID-лимит в настройках, токены, логи) в ответе
  клиенту иначе как простыми словами: «ID устройства», «лимит устройств».
- Не пересказывай клиенту его личные данные целиком.

Ответь строго JSON-объектом:
{"diagnosis": "что происходит, 1–3 предложения для админа",
 "reply": "готовый текст ответа клиенту",
 "escalate": true/false,
 "reason": "почему нужен админ, если escalate"}"""


async def ask_model(facts, dialog):
    kb = KB_FILE.read_text() if KB_FILE.exists() else ""
    body = {
        "model": await pick_model(),
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": f"{RULES}\n\n# База знаний\n{kb}"},
            {"role": "user", "content": f"# Факты о клиенте\n{facts}\n\n# Переписка\n{dialog}"},
        ],
    }
    async def call(payload):
        async with session.post(f"{AI_BASE}/chat/completions", json=payload,
                                headers={"Authorization": f"Bearer {AI_KEY}"},
                                timeout=aiohttp.ClientTimeout(total=120)) as r:
            return r.status, await r.json(content_type=None)

    status, data = await call(body)
    if status == 400:
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

    question = "\n".join((m.get("message_text") or "").strip() for m in messages
                         if not m.get("is_from_admin") and m["id"] > max([x["id"] for x in messages if x.get("is_from_admin")] or [0]))
    facts = await facts_for(ticket)
    try:
        result = await ask_model(facts, dialog_text(ticket))
    except Exception as e:
        log.error("модель не ответила: %s", e)
        result = {"diagnosis": f"Модель не ответила: {e}", "reply": "", "escalate": True, "reason": "черновика нет"}

    draft_id = f"{tid}-{last['id']}"
    draft = {
        "ticket_id": int(tid), "after": last["id"], "title": ticket.get("title"),
        "question": question or "[без текста]", "diagnosis": result.get("diagnosis", ""),
        "reply": (result.get("reply") or "").strip(), "escalate": bool(result.get("escalate")),
        "reason": result.get("reason", ""),
    }
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
    if any(m.get("is_from_admin") and m["id"] > draft["after"] for m in ticket.get("messages", [])):
        return "уже есть ответ поддержки — этот черновик не отправлен"
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
        if msg.get("text") == "/start":
            await tg("sendMessage", chat_id=ADMIN_ID, text="Помощник поддержки на связи. Черновики ответов будут приходить сюда.")
        return
    draft = state["drafts"].get(draft_id)
    text = (msg.get("text") or "").strip()
    if not draft or not text:
        return
    problem = await send_reply(draft, text)
    draft["reply"] = text
    footer = f"⛔ {problem}" if problem else "✅ <b>Отправлено с правками</b>"
    await tg("editMessageText", chat_id=ADMIN_ID, message_id=draft["message_id"], text=draft_card(draft, footer)[:4000], parse_mode="HTML")
    await tg("sendMessage", chat_id=ADMIN_ID, text="Не отправлено: " + problem if problem else "Отправлено ✅")
    state["drafts"].pop(draft_id, None)
    save_state()


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
        await tg("sendMessage", chat_id=ADMIN_ID, text=f"🤖 Помощник поддержки запущен. Модель: {AI_MODEL}.")
        await asyncio.gather(tickets_loop(), telegram_loop())


if __name__ == "__main__":
    asyncio.run(main())
