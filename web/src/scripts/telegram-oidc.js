// Вход Telegram по стандарту OpenID Connect — так же, как «Войти через Google».
//
// Окно входа открывает библиотека Telegram (oauth.telegram.org/js/telegram-login.js),
// она же возвращает подписанный id_token. Его проверяет бот: и для входа
// (POST /cabinet/auth/telegram/oidc), и для привязки к аккаунту по почте.
// В отличие от старого виджета, у OIDC адресов сайта может быть несколько —
// их список задаётся боту в @BotFather → Bot Settings → Web Login.
//
// Включён ли OIDC у бота и с каким client_id, сайт спрашивает у самого бота.
// Выключен или библиотека не загрузилась — остаются прежние способы.

import { api } from "./api.js";

const SDK = "https://oauth.telegram.org/js/telegram-login.js?3";

let preparing = null;
let ready = false;
let handler = null;

function loadSdk() {
    return new Promise((resolve) => {
        if (window.Telegram?.Login) return resolve(true);
        const script = document.createElement("script");
        script.src = SDK;
        script.async = true;
        const timer = setTimeout(() => resolve(false), 8000);
        script.onload = () => {
            clearTimeout(timer);
            resolve(Boolean(window.Telegram?.Login));
        };
        script.onerror = () => {
            clearTimeout(timer);
            resolve(false);
        };
        document.head.append(script);
    });
}

/** Подготовить вход заранее: окно Telegram должно открываться сразу по нажатию, без ожидания. */
export function prepareTelegramOidc() {
    preparing ??= (async () => {
        try {
            const config = await api.telegramLoginConfig();
            if (!config?.oidc_enabled || !config.oidc_client_id) return false;
            if (!(await loadSdk())) return false;
            window.Telegram.Login.init(
                {
                    client_id: Number(config.oidc_client_id) || config.oidc_client_id,
                    request_access: ["write"],
                    lang: "ru",
                },
                (data) => handler?.(data || {})
            );
            ready = true;
        } catch {
            ready = false;
        }
        return ready;
    })();
    return preparing;
}

export const telegramOidcReady = () => ready;

/**
 * Открыть окно Telegram. [onResult] получит { id_token } или { error }.
 * Звать прямо из обработчика нажатия — иначе браузер заблокирует окно.
 */
export function openTelegramOidc(onResult) {
    handler = onResult;
    window.Telegram.Login.open();
}

/** Документы, с которыми новый человек соглашается при регистрации, — ключи бота и наши страницы. */
export const LEGAL_DOCUMENTS = {
    public_offer: ["Условия использования", "/terms.html"],
    privacy_policy: ["Политику конфиденциальности", "/privacy.html"],
};
