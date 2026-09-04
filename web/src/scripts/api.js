// Клиент Cabinet API бота Bedolaga. Запросы идут не в панель напрямую, а на
// свой же домен в /api — этим занимается веб-сервер. Так браузеру не нужен
// CORS, а адрес кабинета не виден снаружи и не блокируется отдельно.

const BASE = "/api";

const KEY_ACCESS = "dp_access";
const KEY_REFRESH = "dp_refresh";
const KEY_EXPIRES = "dp_expires";
const KEY_USER = "dp_user";

export const session = {
    get access() {
        return localStorage.getItem(KEY_ACCESS);
    },
    get refresh() {
        return localStorage.getItem(KEY_REFRESH);
    },
    get expiresAt() {
        return Number(localStorage.getItem(KEY_EXPIRES) || 0);
    },
    get user() {
        try {
            return JSON.parse(localStorage.getItem(KEY_USER) || "null");
        } catch {
            return null;
        }
    },
    set user(value) {
        if (value) localStorage.setItem(KEY_USER, JSON.stringify(value));
        else localStorage.removeItem(KEY_USER);
    },
    get loggedIn() {
        return Boolean(this.refresh);
    },
    save(auth) {
        if (!auth || !auth.access_token) return false;
        localStorage.setItem(KEY_ACCESS, auth.access_token);
        if (auth.refresh_token) localStorage.setItem(KEY_REFRESH, auth.refresh_token);
        const seconds = Number(auth.expires_in || 0);
        localStorage.setItem(
            KEY_EXPIRES,
            String(seconds > 0 ? Date.now() + seconds * 1000 : 0)
        );
        if (auth.user) this.user = auth.user;
        return true;
    },
    clear() {
        [KEY_ACCESS, KEY_REFRESH, KEY_EXPIRES, KEY_USER].forEach((key) =>
            localStorage.removeItem(key)
        );
    },
};

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function messageForStatus(status, serverMessage) {
    if (serverMessage) return serverMessage;
    if (status === 400 || status === 422) return "Неверные данные. Проверьте введённые значения.";
    if (status === 401) return "Неверный логин или пароль.";
    if (status === 403) return "Доступ запрещён.";
    if (status === 404) return "Сервис не найден.";
    if (status === 429) return "Слишком много попыток. Подождите немного.";
    if (status >= 500) return "Сервер временно недоступен.";
    return `Ошибка сервера (${status}).`;
}

/** Текст ошибки из тела ответа: у кабинета он лежит по-разному. */
async function extractMessage(response) {
    try {
        const data = await response.clone().json();
        const raw = data.detail ?? data.message ?? data.error;
        if (typeof raw === "string") return raw;
        // FastAPI отдаёт detail массивом объектов при ошибке валидации
        if (Array.isArray(raw) && raw.length && typeof raw[0]?.msg === "string") {
            return raw[0].msg;
        }
    } catch {
        // тело не JSON — сообщение возьмём по коду
    }
    return null;
}

// Обновление строго одиночное: несколько экранов, открывшихся разом, иначе
// отправили бы столько же одинаковых запросов на обновление. Ротации при
// этом нет — /cabinet/auth/refresh возвращает тот же refresh-токен обратно.
let refreshing = null;

async function refreshTokens() {
    if (refreshing) return refreshing;
    const token = session.refresh;
    if (!token) return null;

    refreshing = (async () => {
        try {
            const response = await fetch(`${BASE}/cabinet/auth/refresh`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refresh_token: token }),
            });
            if (!response.ok) {
                // Выходим из аккаунта только когда сервер сказал именно это:
                // токен не принят. Раньше сюда попадал любой ответ 4xx, и
                // человек оказывался на экране входа из-за 429 «слишком
                // часто» или 404 от случайной страницы провайдера — при
                // живой сессии. Остальные коды считаем временными.
                if (response.status === 401 || response.status === 403) session.clear();
                return null;
            }
            const auth = await response.json();
            return session.save(auth) ? auth.access_token : null;
        } catch {
            // сеть недоступна — сессию не трогаем, попробуем позже
            return session.access;
        } finally {
            setTimeout(() => (refreshing = null), 0);
        }
    })();

    return refreshing;
}

async function validAccessToken() {
    const token = session.access;
    if (!token) return null;
    const expiresAt = session.expiresAt;
    if (expiresAt > 0 && Date.now() > expiresAt - 30000) return refreshTokens();
    return token;
}

const AUTH_FREE = /\/cabinet\/auth\/(deeplink|email|password|refresh)/;

/**
 * Запрос к кабинету. На 401 один раз обновляет токен и повторяет.
 * raw = true — вернуть Response целиком (нужно для опроса deeplink,
 * который отвечает 202 и 410).
 */
export async function request(path, { method = "GET", body, query, raw = false } = {}) {
    const url = new URL(`${BASE}/${path}`.replace(/([^:]\/)\/+/g, "$1"), location.origin);
    for (const [key, value] of Object.entries(query || {})) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    }

    const send = async (token) => {
        const headers = {};
        const isForm = typeof FormData !== "undefined" && body instanceof FormData;
        if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
        if (token) headers.Authorization = `Bearer ${token}`;
        return fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
        });
    };

    const needsAuth = !AUTH_FREE.test(url.pathname);
    let response;
    try {
        response = await send(needsAuth ? await validAccessToken() : null);
    } catch {
        throw new ApiError(0, "Нет соединения с сервером. Проверьте интернет.");
    }

    if (response.status === 401 && needsAuth && session.refresh) {
        const token = await refreshTokens();
        if (token) {
            try {
                response = await send(token);
            } catch {
                throw new ApiError(0, "Нет соединения с сервером. Проверьте интернет.");
            }
        }
    }

    if (raw) return response;

    if (!response.ok) {
        throw new ApiError(response.status, messageForStatus(response.status, await extractMessage(response)));
    }
    if (response.status === 204) return {};
    try {
        return await response.json();
    } catch {
        return {};
    }
}

const get = (path, query) => request(path, { query });
const post = (path, body, query) => request(path, { method: "POST", body, query });

export const api = {
    // --- вход ---
    deepLinkRequest: () => post("cabinet/auth/deeplink/request", {}),
    deepLinkPoll: (token) =>
        request("cabinet/auth/deeplink/poll", {
            method: "POST",
            body: { token },
            raw: true,
        }),
    emailLogin: (email, password) => post("cabinet/auth/email/login", { email, password }),
    emailRegister: (email, password, referralCode) =>
        post("cabinet/auth/email/register/standalone", {
            email,
            password,
            language: "ru",
            referral_code: referralCode || undefined,
        }),
    forgotPassword: (email) => post("cabinet/auth/password/forgot", { email }),
    logout: (refreshToken) => post("cabinet/auth/logout", { refresh_token: refreshToken }),
    me: () => get("cabinet/auth/me"),

    // --- подписка ---
    subscriptions: () => get("cabinet/subscriptions"),
    subscription: () => get("cabinet/subscription"),
    connectionLink: () => get("cabinet/subscription/connection-link"),
    trialInfo: () => get("cabinet/subscription/trial"),
    activateTrial: () => post("cabinet/subscription/trial", {}),
    purchaseOptions: () => get("cabinet/subscription/purchase-options"),
    purchaseTariff: (tariffId, periodDays) =>
        post("cabinet/subscription/purchase-tariff", {
            tariff_id: tariffId,
            period_days: periodDays,
        }),
    renewalOptions: () => get("cabinet/subscription/renewal-options"),
    renew: (periodDays) => post("cabinet/subscription/renew", { period_days: periodDays }),

    // --- устройства ---
    devices: (subscriptionId) =>
        get("cabinet/subscription/devices", { subscription_id: subscriptionId }),
    devicePrice: (devices, subscriptionId) =>
        get("cabinet/subscription/devices/price", {
            devices,
            subscription_id: subscriptionId,
        }),
    purchaseDevices: (devices, subscriptionId) =>
        post("cabinet/subscription/devices/purchase", { devices }, { subscription_id: subscriptionId }),
    deleteDevice: (hwid, subscriptionId) =>
        request(`cabinet/subscription/devices/${encodeURIComponent(hwid)}`, {
            method: "DELETE",
            query: { subscription_id: subscriptionId },
        }),

    // --- деньги ---
    balance: () => get("cabinet/balance"),
    paymentMethods: () => get("cabinet/balance/payment-methods"),
    topup: (amountKopeks, method, option) =>
        post("cabinet/balance/topup", {
            amount_kopeks: amountKopeks,
            payment_method: method,
            payment_option: option || undefined,
            language: "ru",
        }),
    transactions: (page = 1) => get("cabinet/balance/transactions", { page, per_page: 20 }),
    checkPending: (method, paymentId) =>
        post(`cabinet/balance/pending-payments/${encodeURIComponent(method)}/${encodeURIComponent(paymentId)}/check`, {}),

    // --- техподдержка ---
    supportConfig: () => get("cabinet/info/support-config"),
    supportTickets: (page = 1) =>
        get("cabinet/tickets", { page, per_page: 100 }),
    createSupportTicket: (title, message, media) =>
        post("cabinet/tickets", {
            title,
            message,
            media_type: media?.media_type,
            media_file_id: media?.file_id,
            media_caption: media && message ? message : undefined,
        }),
    supportTicket: (ticketId) =>
        get(`cabinet/tickets/${encodeURIComponent(ticketId)}`),
    replySupportTicket: (ticketId, message, media) =>
        post(`cabinet/tickets/${encodeURIComponent(ticketId)}/messages`, {
            message,
            media_type: media?.media_type,
            media_file_id: media?.file_id,
            media_caption: media && message ? message : undefined,
        }),
    supportUnreadCount: () => get("cabinet/tickets/notifications/unread-count"),
    markSupportTicketRead: (ticketId) =>
        post(`cabinet/tickets/notifications/ticket/${encodeURIComponent(ticketId)}/read`, {}),
    uploadSupportMedia: (file, mediaType) => {
        const form = new FormData();
        form.append("file", file, file.name || "attachment");
        form.append("media_type", mediaType);
        return request("cabinet/media/upload", { method: "POST", body: form });
    },

    // --- прочее ---
    referral: () => get("cabinet/referral"),
    activatePromo: (code) => post("cabinet/promocode/activate", { code }),
};

// ---------- разбор ответов переменной формы ----------
// Кабинет отдаёт часть списков то массивом, то объектом со списком внутри,
// и названия полей отличаются между версиями бота. Разбираем терпимо.

export function asArray(root, keys) {
    if (Array.isArray(root)) return root;
    if (root && typeof root === "object") {
        for (const key of keys) {
            if (Array.isArray(root[key])) return root[key];
        }
    }
    return [];
}

export function parsePeriods(item) {
    const source = item.period_prices || item.periods || item.prices;
    if (!Array.isArray(source)) return [];
    return source
        .map((p) => ({
            days: Number(p.days ?? p.period_days),
            price: Number(p.price_kopeks ?? p.price),
        }))
        .filter((p) => Number.isFinite(p.days) && Number.isFinite(p.price))
        .sort((a, b) => a.days - b.days);
}

/** Тарифы из purchase-options: массив лежит в разных полях у разных версий. */
export function parseTariffs(root) {
    const arrays = [];
    const collect = (element, depth) => {
        if (depth > 3 || !element) return;
        if (Array.isArray(element)) {
            arrays.push(element);
            return;
        }
        if (typeof element === "object") {
            for (const key of ["tariffs", "items", "options", "plans"]) {
                if (element[key]) collect(element[key], depth + 1);
            }
        }
    };
    collect(root, 0);

    const seen = new Set();
    const offers = [];
    for (const array of arrays) {
        for (const item of array) {
            if (!item || typeof item !== "object" || item.id === undefined) continue;
            const id = Number(item.id);
            if (seen.has(id)) continue;
            const periods = parsePeriods(item);
            if (!periods.length) continue;
            seen.add(id);
            offers.push({
                id,
                name: item.name || `Тариф ${id}`,
                description: item.description || null,
                trafficLimitGb: item.traffic_limit_gb ?? null,
                deviceLimit: item.device_limit ?? null,
                periods,
            });
        }
    }
    return offers;
}

export function parsePaymentMethods(root) {
    return asArray(root, ["methods", "items", "payment_methods"])
        .map((m) => ({
            id: m.method || m.id || "",
            name: m.title || m.name || m.method || m.id || "",
            enabled: m.enabled ?? m.is_enabled ?? true,
            min: m.min_amount_kopeks ?? null,
            max: m.max_amount_kopeks ?? null,
        }))
        .filter((m) => m.enabled && m.id);
}
