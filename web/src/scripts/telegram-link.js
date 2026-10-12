// Привязка Telegram к аккаунту, созданному по почте.
//
// Вход Telegram здесь — переход на oauth.telegram.org и обратно, а не виджет
// на странице: виджет — это чужой скрипт и рамка, а политика безопасности
// сайта их не пускает. Telegram возвращает человека на кабинет с подписанными
// данными в #tgAuthResult, бот проверяет подпись своим токеном
// (POST /cabinet/auth/account/link/telegram). Если этот Telegram уже есть
// у другого аккаунта — бот предлагает объединить их, как с почтой.
//
// Telegram пускает только с домена, указанного боту в @BotFather → Bot
// Settings → Domain, поэтому там должен стоять dprince.online.

import { api } from "./api.js";
import { el, clear, message, busy } from "./ui.js";
import { mergeChoice, linkErrorText } from "./email-link.js";

// Номер бота @VPNbyDPrincebot — цифры до двоеточия в его токене, не секрет.
// Пусто — карточка не показывается.
export const TELEGRAM_BOT_ID = "";

let returned = null;

/** Забрать данные, с которыми Telegram вернул на страницу, и убрать их из адреса. */
export function finishTelegramLink() {
    const match = location.hash.match(/tgAuthResult=([^&]+)/);
    if (!match) return null;
    history.replaceState(null, "", location.pathname + location.search);
    try {
        const base64 = decodeURIComponent(match[1]).replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (c) => c.charCodeAt(0));
        const data = JSON.parse(new TextDecoder().decode(bytes));
        returned = data && data.id && data.hash ? data : null;
    } catch {
        returned = null;
    }
    return returned;
}

function startTelegramAuth() {
    const url = new URL("https://oauth.telegram.org/auth");
    url.searchParams.set("bot_id", TELEGRAM_BOT_ID);
    url.searchParams.set("origin", location.origin);
    url.searchParams.set("request_access", "write");
    url.searchParams.set("return_to", `${location.origin}/cabinet.html`);
    location.href = url.toString();
}

/** Карточка «Привязать Telegram». [onChanged] — перечитать пользователя после привязки. */
export function telegramLinkCard(onChanged) {
    if (!TELEGRAM_BOT_ID) return null;
    const card = el("div", { class: "card" });
    const note = el("p", { class: "msg hidden" });

    function showStart() {
        clear(card);
        card.append(
            el("h3", { text: "Привязать Telegram" }),
            el("p", {
                class: "small muted",
                text: "Чтобы входить в этот аккаунт и через Telegram, пользоваться ботом и приглашать " +
                    "друзей ссылкой прямо в бота. Откроется Telegram — подтвердите вход, и вы вернётесь сюда.",
            }),
            el("button", { class: "btn", onclick: startTelegramAuth }, "Привязать Telegram"),
            note
        );
    }

    async function link(data) {
        clear(card);
        card.append(el("h3", { text: "Привязываю Telegram…" }), note);
        try {
            const result = await api.linkTelegram(data);
            if (result.merge_required && result.merge_token) {
                const preview = await api.mergePreview(result.merge_token);
                mergeChoice(card, note, result.merge_token, preview, {
                    other: "Аккаунт в Telegram",
                    done: "Теперь это один аккаунт: в него можно входить и по почте, и через Telegram.",
                    onChanged,
                });
                card.prepend(el("p", {
                    class: "small muted",
                    text: "Этот Telegram уже есть у другого аккаунта — их можно объединить в один.",
                }));
                return;
            }
            clear(card);
            card.append(
                el("h3", { text: "Telegram привязан" }),
                el("p", { class: "small", text: "Теперь в этот аккаунт можно входить и через Telegram." })
            );
            onChanged?.();
        } catch (error) {
            showStart();
            message(note, linkErrorText(error));
        }
    }

    if (returned) {
        const data = returned;
        returned = null;
        link(data);
    } else {
        showStart();
    }
    return card;
}

export const hasTelegramReturn = () => Boolean(returned);
