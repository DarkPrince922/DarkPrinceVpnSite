// Страница по ссылке-приглашению: /invite?ref=КОД. Отдельным файлом —
// политика безопасности сайта запрещает встроенные скрипты.

import { $ } from "./verify.js";
import { cleanCode, saveReferral, botInviteLink } from "./referral-code.js";

const code = cleanCode(new URLSearchParams(location.search).get("ref"));
const rubles = (kopeks) => `${Math.round(kopeks / 100)} ₽`;

if (!code) {
    $("#title").textContent = "Ссылка неполная";
    $("#text").textContent =
        "В ссылке нет кода приглашения. Попросите друга прислать её ещё раз — или просто " +
        "зарегистрируйтесь, VPN работает и без приглашения.";
    $("#hint").classList.add("hidden");
} else {
    saveReferral(code);
    $("#telegram").href = botInviteLink(code);
    // условия публичные: показываем, что друг получит, если программа это даёт
    fetch("/api/cabinet/referral/terms")
        .then((r) => (r.ok ? r.json() : null))
        .then((terms) => {
            if (!terms?.first_topup_bonus_kopeks) return;
            const from = terms.minimum_topup_kopeks > 0 ? ` от ${rubles(terms.minimum_topup_kopeks)}` : "";
            $("#bonus").textContent = `🎁 ${rubles(terms.first_topup_bonus_kopeks)} на баланс при первом пополнении${from}`;
            $("#bonus").classList.remove("hidden");
        })
        .catch(() => { });
}
