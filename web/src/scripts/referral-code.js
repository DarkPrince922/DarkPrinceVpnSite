// Код приглашения, с которым человек пришёл на сайт. Живёт в браузере месяц:
// друг может сначала походить по страницам, скачать приложение и только потом
// зарегистрироваться — приглашение не должно потеряться по дороге.

const KEY = "dp_referral";
const TTL = 30 * 24 * 3600 * 1000;

export const BOT = "VPNbyDPrincebot";

/** Код — латиница и цифры: всё остальное в нём значит, что ссылку исказили. */
export function cleanCode(value) {
    const code = String(value || "").trim();
    return /^[A-Za-z0-9_-]{3,64}$/.test(code) ? code : "";
}

export function saveReferral(code) {
    if (!cleanCode(code)) return;
    try {
        localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
    } catch {
        // приватный режим: код просто не запомнится, ссылка всё равно работает
    }
}

export function savedReferral() {
    try {
        const item = JSON.parse(localStorage.getItem(KEY) || "null");
        if (item && Date.now() - item.at < TTL) return cleanCode(item.code);
    } catch {
        // испорченное значение — как будто его нет
    }
    return "";
}

export function forgetReferral() {
    try {
        localStorage.removeItem(KEY);
    } catch {
        // нечего удалять
    }
}

/** Ссылка, которой делятся: на сайт, где друг выберет Telegram или почту. */
export const inviteLink = (code) => `https://dprince.online/invite?ref=${encodeURIComponent(code)}`;
export const botInviteLink = (code) => `https://t.me/${BOT}?start=${encodeURIComponent(code)}`;
