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
    constructor(status, message, missingKopeks = null, code = null) {
        super(message);
        this.status = status;
        /** Сколько не хватает на балансе — только у ответа 402. */
        this.missingKopeks = missingKopeks;
        /** Машинный код отказа из {"detail": {"code": …}} — у новых разделов кабинета. */
        this.code = code;
    }
}

async function extractCode(response) {
    try {
        const raw = (await response.clone().json()).detail;
        return raw && typeof raw === "object" && typeof raw.code === "string" ? raw.code : null;
    } catch {
        return null;
    }
}

/** Сумма недостачи из тела ответа 402: {"detail": {"missing_amount": копейки}}. */
async function extractMissing(response) {
    if (response.status !== 402) return null;
    try {
        const data = await response.clone().json();
        const raw = data.detail;
        const missing = raw && typeof raw === "object" ? (raw.missing_amount ?? raw.missing_kopeks) : null;
        return typeof missing === "number" ? missing : null;
    } catch {
        return null;
    }
}

function messageForStatus(status, serverMessage) {
    if (serverMessage) return serverMessage;
    if (status === 400 || status === 422) return "Неверные данные. Проверьте введённые значения.";
    if (status === 401) return "Неверный логин или пароль.";
    if (status === 402) return "Не хватает средств на балансе. Пополните счёт и повторите.";
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
        // У кабинета 402 значит ровно одно: не хватило денег на балансе.
        // Подробности он кладёт объектом и по-английски, поэтому берём
        // отсюда только сумму, а текст собираем свой.
        if (response.status === 402) {
            // бот кладёт сумму в missing_amount (копейки); старое имя — на всякий случай
            // снятие суточного с паузы отвечает {required, balance}, а не missing_amount
            const missing = raw && typeof raw === "object"
                ? (raw.missing_amount ?? raw.missing_kopeks
                    ?? (typeof raw.required === "number" && typeof raw.balance === "number" ? raw.required - raw.balance : null))
                : null;
            return typeof missing === "number" && missing > 0
                ? `Не хватает ${(missing / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽ на балансе. Пополните счёт и повторите.`
                : null;
        }
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
                // Выходим из аккаунта только на 401. Раньше сюда попадал
                // любой ответ 4xx, и человек оказывался на экране входа из-за
                // 429 «слишком часто» или 404 от страницы провайдера вместо
                // кабинета — при живой сессии.
                //
                // 401 достаточно: /cabinet/auth/refresh отвечает им на любую
                // беду с токеном — просрочен, отозван, нет в базе, аккаунт не
                // активен, — и никогда не отвечает 403. Значит 403 пришёл не
                // от кабинета, а от чего-то по дороге.
                if (response.status === 401) session.clear();
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

// Без токена — только вход, регистрация с нуля, подтверждение почты и
// пароль. «email» целиком сюда нельзя: соседний /email/register без хвоста —
// это привязка почты к уже вошедшему аккаунту, ей токен нужен.
const AUTH_FREE = /\/cabinet\/auth\/(deeplink|email\/(login|register\/standalone|verify|resend)|password|refresh)/;

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
        throw new ApiError(
            response.status,
            messageForStatus(response.status, await extractMessage(response)),
            await extractMissing(response),
            await extractCode(response),
        );
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
const patch = (path, body, query) => request(path, { method: "PATCH", body, query });
const del = (path, query) => request(path, { method: "DELETE", query });

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

    // привязка почты к вошедшему аккаунту и объединение с занятой почтой
    linkEmail: (email, password) => post("cabinet/auth/email/register", { email, password }),
    // смена почты: код приходит на новый адрес
    requestEmailChange: (newEmail) => post("cabinet/auth/email/change", { new_email: newEmail }),
    verifyEmailChange: (code) => post("cabinet/auth/email/change/verify", { code }),
    cancelEmailChange: () => post("cabinet/auth/email/change/cancel", {}),
    emailChangeStatus: () => get("cabinet/auth/email/change/status"),
    // привязка Telegram: данные, которыми Telegram подписал вход
    linkTelegram: (data) => post("cabinet/auth/account/link/telegram", {
        id: data.id, first_name: data.first_name, last_name: data.last_name, username: data.username,
        photo_url: data.photo_url, auth_date: data.auth_date, hash: data.hash,
    }),
    verifyEmailMerge: (code) => post("cabinet/auth/email/merge/verify", { code }),
    mergePreview: (token) => get(`cabinet/auth/merge/${encodeURIComponent(token)}`),
    executeMerge: (token, keepFrom) =>
        post(`cabinet/auth/merge/${encodeURIComponent(token)}`, { keep_subscription_from: keepFrom }),

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
    // номер подписки обязателен: без него кабинет продлевает ту, что считает
    // текущей, а не ту, на которую нажали
    renewalOptions: (subscriptionId) =>
        get("cabinet/subscription/renewal-options", { subscription_id: subscriptionId }),
    renew: (periodDays, subscriptionId) =>
        post("cabinet/subscription/renew", { period_days: periodDays }, { subscription_id: subscriptionId }),

    // автопродление
    subscriptionDetails: (subscriptionId) => get("cabinet/subscription", { subscription_id: subscriptionId }),
    setAutopay: (subscriptionId, enabled, daysBefore) =>
        patch("cabinet/subscription/autopay", { enabled, days_before: daysBefore }, { subscription_id: subscriptionId }),
    recurrentStatus: (subscriptionId) =>
        get("cabinet/subscription/platega-recurrent", { subscription_id: subscriptionId }),
    enableRecurrent: (subscriptionId) =>
        post("cabinet/subscription/platega-recurrent/enable", {}, { subscription_id: subscriptionId }),
    cancelRecurrent: (subscriptionId) =>
        post("cabinet/subscription/platega-recurrent/cancel", {}, { subscription_id: subscriptionId }),

    // смена тарифа и сброс ссылки
    switchPreview: (subscriptionId, tariffId, periodDays) =>
        post("cabinet/subscription/tariff/switch/preview", { tariff_id: tariffId, period_days: periodDays }, { subscription_id: subscriptionId }),
    switchTariff: (subscriptionId, tariffId, periodDays) =>
        post("cabinet/subscription/tariff/switch", { tariff_id: tariffId, period_days: periodDays }, { subscription_id: subscriptionId }),
    revoke: (subscriptionId) => post("cabinet/subscription/revoke", {}, { subscription_id: subscriptionId }),
    // удалить закончившуюся подписку; действующую бот не удаляет
    deleteSubscription: (subscriptionId) => del(`cabinet/subscriptions/${subscriptionId}`),
    // пауза суточного тарифа: одна ручка и ставит, и снимает
    toggleDailyPause: (subscriptionId) => post("cabinet/subscription/pause", {}, { subscription_id: subscriptionId }),

    // трафик
    trafficPackages: (subscriptionId) =>
        get("cabinet/subscription/traffic-packages", { subscription_id: subscriptionId }),
    buyTraffic: (gb, subscriptionId) =>
        post("cabinet/subscription/traffic", { gb }, { subscription_id: subscriptionId }),

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
    deviceReductionInfo: (subscriptionId) =>
        get("cabinet/subscription/devices/reduction-info", { subscription_id: subscriptionId }),
    reduceDevices: (newLimit, subscriptionId) =>
        post("cabinet/subscription/devices/reduce", { new_device_limit: newLimit }, { subscription_id: subscriptionId }),
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
    // код на дни при нескольких подписках: кабинет просит subscription_id
    // карточки напоминаний на главной — их заводит админ в кабинете
    reminders: () => get("cabinet/reminders/active", { lang: "ru" }),
    dismissReminder: (id) => post(`cabinet/reminders/${id}/dismiss`),

    activatePromo: (code, subscriptionId = null) =>
        post("cabinet/promocode/activate", subscriptionId ? { code, subscription_id: subscriptionId } : { code }),

    // рефералка целиком
    referralTerms: () => get("cabinet/referral/terms"),
    referralList: () => get("cabinet/referral/list", { page: 1, per_page: 100 }),
    referralEarnings: () => get("cabinet/referral/earnings", { page: 1, per_page: 100 }),
    withdrawalBalance: () => get("cabinet/referral/withdrawal/balance"),
    withdrawalHistory: () => get("cabinet/referral/withdrawal/history"),
    createWithdrawal: (amountKopeks, details) =>
        post("cabinet/referral/withdrawal/create", { amount_kopeks: amountKopeks, payment_details: details }),
    cancelWithdrawal: (id) => post(`cabinet/referral/withdrawal/${encodeURIComponent(id)}/cancel`, {}),

    // подарки
    giftConfig: () => get("cabinet/gift/config"),
    giftPurchase: (body) => post("cabinet/gift/purchase", body),
    giftStatus: (token) => get(`cabinet/gift/purchase/${encodeURIComponent(token)}`),
    giftsSent: () => get("cabinet/gift/sent"),
    giftsReceived: () => get("cabinet/gift/received"),
    giftActivate: (code) => post("cabinet/gift/activate", { code }),

    // скидки и уровни
    promoOffers: () => get("cabinet/promo/offers"),
    activeDiscount: () => get("cabinet/promo/active-discount"),
    claimOffer: (offerId) => post("cabinet/promo/claim", { offer_id: offerId }),
    groupDiscounts: () => get("cabinet/promo/group-discounts"),
    loyaltyTiers: () => get("cabinet/promo/loyalty-tiers"),

    // вопросы и документы
    infoVisibility: () => get("cabinet/info/visibility"),
    faq: () => get("cabinet/info/faq", { language: "ru" }),
    infoDoc: (kind) => get(`cabinet/info/${kind}`, { language: "ru" }),

    // --- админка ---
    isAdmin: () => get("cabinet/auth/me/is-admin"),
    permissions: () => get("cabinet/auth/me/permissions"),
    adminDashboard: () => get("cabinet/admin/stats/dashboard"),
    // инбаунды всех профилей панели — конструктору, чтобы не повторить тег
    adminInbounds: () => get("cabinet/admin/remnawave/inbounds"),
    adminTickets: (status) => get("cabinet/admin/tickets", { page: 1, per_page: 50, status }),
    adminTicket: (id) => get(`cabinet/admin/tickets/${encodeURIComponent(id)}`),
    adminReply: (id, message) => post(`cabinet/admin/tickets/${encodeURIComponent(id)}/reply`, { message }),
    adminTicketStatus: (id, status) => post(`cabinet/admin/tickets/${encodeURIComponent(id)}/status`, { status }),
    adminUsers: (search, offset = 0) =>
        get("cabinet/admin/users", { search, limit: 30, offset, sort_by: "created_at" }),
    adminUser: (id) => get(`cabinet/admin/users/${encodeURIComponent(id)}`),
    adminBalance: (id, amountKopeks, description) =>
        post(`cabinet/admin/users/${encodeURIComponent(id)}/balance`, { amount_kopeks: amountKopeks, description }),
    adminSubscriptionAction: (id, body) => post(`cabinet/admin/users/${encodeURIComponent(id)}/subscription`, body),
    adminBlock: (id) => post(`cabinet/admin/users/${encodeURIComponent(id)}/block`, {}),
    adminUnblock: (id) => post(`cabinet/admin/users/${encodeURIComponent(id)}/unblock`, {}),
    adminSendMessage: (id, text) => post(`cabinet/admin/users/${encodeURIComponent(id)}/send-message`, { text }),
    adminWithdrawals: (status) => get("cabinet/admin/withdrawals", { status, limit: 50 }),
    adminWithdrawal: (id) => get(`cabinet/admin/withdrawals/${encodeURIComponent(id)}`),
    adminWithdrawalAction: (id, action, comment) =>
        post(`cabinet/admin/withdrawals/${encodeURIComponent(id)}/${action}`, action === "complete" ? undefined : { comment: comment || null }),
    adminPayments: (search, statusFilter, period) =>
        get("cabinet/admin/payments/search", { search, status_filter: statusFilter, period, per_page: 50 }),
    adminCheckPayment: (method, id) =>
        post(`cabinet/admin/payments/${encodeURIComponent(method)}/${encodeURIComponent(id)}/check`, {}),
    adminBroadcastFilters: () => get("cabinet/admin/broadcasts/filters"),
    adminBroadcastButtons: () => get("cabinet/admin/broadcasts/buttons"),
    adminEmailFilters: () => get("cabinet/admin/broadcasts/email-filters"),
    adminBroadcasts: () => get("cabinet/admin/broadcasts", { limit: 20 }),
    adminSendBroadcast: (body) => post("cabinet/admin/broadcasts/send", body),
    adminStopBroadcast: (id) => post(`cabinet/admin/broadcasts/${encodeURIComponent(id)}/stop`, {}),
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
            // самый выгодный срок — по отметке админа
            highlighted: p.is_highlighted === true,
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
                highlighted: item.is_highlighted === true,
                periods,
            });
        }
    }
    return offers;
}

/**
 * Способы оплаты — по варианту на строку. У части касс внутри одного способа
 * несколько вариантов (у Platega — СБП и карта): бот присылает их в options,
 * и выбранный нужно передать в payment_option. Раньше варианты не читались,
 * и оплатить можно было только первым — по СБП.
 */
export function parsePaymentMethods(root) {
    const out = [];
    for (const m of asArray(root, ["methods", "items", "payment_methods"])) {
        const id = m.method || m.id || "";
        const enabled = m.enabled ?? m.is_enabled ?? true;
        if (!id || !enabled) continue;
        const base = {
            id,
            name: m.title || m.name || m.method || m.id || "",
            min: m.min_amount_kopeks ?? null,
            max: m.max_amount_kopeks ?? null,
        };
        const options = Array.isArray(m.options) ? m.options.filter((o) => o && o.id) : [];
        if (!options.length) {
            out.push({ ...base, option: null, key: id });
            continue;
        }
        for (const option of options) {
            out.push({
                ...base,
                option: String(option.id),
                key: `${id}/${option.id}`,
                name: option.name || option.description || `${base.name} ${option.id}`,
            });
        }
    }
    return out;
}
