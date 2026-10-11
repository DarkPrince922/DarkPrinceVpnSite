// Покупка, на которую не хватило денег.
//
// Человек выбрал тариф или продление, а на балансе меньше нужного. Запоминаем
// выбор и ведём на пополнение с недостающей суммой; как только деньги придут,
// оплачиваем именно это — и только это. Так же устроено в приложении.
//
// Лежит в localStorage: оплата идёт в другой вкладке, и эту могут закрыть.

import { api, asArray, ApiError } from "./api.js";

const KEY = "dp_pending_purchase";
const TTL_MS = 3 * 60 * 60 * 1000;

export function loadPending() {
    try {
        const pending = JSON.parse(localStorage.getItem(KEY) || "null");
        if (!pending || Date.now() - pending.createdAt > TTL_MS) {
            localStorage.removeItem(KEY);
            return null;
        }
        return pending;
    } catch {
        return null;
    }
}

export function clearPending() {
    localStorage.removeItem(KEY);
}

async function subscriptionsNow() {
    return asArray(await api.subscriptions(), ["subscriptions"]);
}

/**
 * Запомнить покупку. kind: "renew" | "buy" | "switch".
 * Сроки подписок на этот момент нужны, чтобы потом не заплатить дважды: бот
 * умеет и сам оплатить корзину после пополнения.
 */
export async function rememberPending({ kind, subscriptionId, tariffId, periodDays, price, title }, missing) {
    const before = {};
    try {
        for (const sub of await subscriptionsNow()) before[sub.id] = sub.end_date ?? null;
    } catch {
        // не узнали — проверка «уже оплачено» просто будет строже
    }
    localStorage.setItem(KEY, JSON.stringify({
        kind, subscriptionId, tariffId, periodDays, price, title,
        missing: missing ?? price,
        before,
        createdAt: Date.now(),
    }));
}

function alreadyDone(pending, subs) {
    if (pending.kind === "switch") {
        return subs.some((s) => s.id === pending.subscriptionId && s.tariff_id === pending.tariffId);
    }
    const relevant = pending.kind === "renew"
        ? subs.filter((s) => s.id === pending.subscriptionId)
        : subs.filter((s) => s.tariff_id === pending.tariffId);
    return relevant.some((s) => !(s.id in pending.before) || pending.before[s.id] !== (s.end_date ?? null));
}

/**
 * Денег стало достаточно — оплачиваем. Возвращает итог для показа:
 * { status: "paid" | "done" | "wait" | "failed", text }.
 */
export async function completePending(balanceKopeks) {
    const pending = loadPending();
    if (!pending || balanceKopeks < pending.price) return { status: "wait" };

    let subs;
    try {
        subs = await subscriptionsNow();
    } catch {
        return { status: "wait" }; // не знаем, что с подписками, — вслепую не платим
    }
    if (alreadyDone(pending, subs)) {
        clearPending();
        return { status: "done", text: `Готово: «${pending.title}» уже оплачено.` };
    }
    try {
        if (pending.kind === "renew") await api.renew(pending.periodDays, pending.subscriptionId);
        else if (pending.kind === "switch") await api.switchTariff(pending.subscriptionId, pending.tariffId, pending.periodDays);
        else await api.purchaseTariff(pending.tariffId, pending.periodDays);
        clearPending();
        return { status: "paid", text: `Готово: «${pending.title}» оплачено с баланса.` };
    } catch (error) {
        if (error instanceof ApiError && error.status === 402) {
            // цена могла вырасти — ждём ещё пополнения
            pending.missing = error.missingKopeks ?? pending.missing;
            localStorage.setItem(KEY, JSON.stringify(pending));
            return { status: "wait" };
        }
        clearPending();
        return {
            status: "failed",
            text: `Деньги зачислены, но оформить «${pending.title}» не вышло: ${error.message}`,
        };
    }
}
