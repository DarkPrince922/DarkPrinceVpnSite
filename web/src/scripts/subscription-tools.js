// Управление подпиской: автопродление, смена тарифа, сброс ссылки, трафик.
// То же, что в приложении, на тех же запросах кабинета.

import { api, ApiError, parseTariffs } from "./api.js";
import { el, clear, rubles, dateText, busy, periodText, openTab, toast } from "./ui.js";
import { rememberPending } from "./pending.js";

const note = () => el("p", { class: "small" });

function say(node, text, cls = "small muted") {
    node.className = cls;
    node.textContent = text || "";
}

/** Не хватило денег: запоминаем покупку и ведём на пополнение. */
export async function goTopUp(error, pending, onPending) {
    await rememberPending(pending, error.missingKopeks);
    onPending?.();
    // вкладка «Баланс» могла быть уже загружена — пусть перерисуется с суммой
    window.dispatchEvent(new Event("dp-pending"));
    openTab("balance");
}

export const isNotEnough = (error) => error instanceof ApiError && error.status === 402;

/** Автопродление бывает только у купленного периодного тарифа. */
export const autopayAllowed = (sub) => !sub.is_trial && !sub.is_daily && sub.tariff_id != null;

// ---------------- автопродление ----------------

/**
 * С баланса — переключатель и «за сколько дней»; через СБП — банк сам
 * списывает за следующий период. Включить можно одно: бот сам выключает
 * второе, чтобы не списать дважды.
 */
export function autopayCard(sub) {
    const card = el("div", { class: "card" }, [el("h3", { text: "Автопродление" })]);
    const body = el("div", {}, [el("p", { class: "small muted", text: "Загружаю…" })]);
    card.append(body);
    load();
    return card;

    async function load() {
        let details = null;
        let recurrent = null;
        try {
            details = await api.subscriptionDetails(sub.id);
        } catch {
            // не ответил — покажем из списка
        }
        try {
            recurrent = await api.recurrentStatus(sub.id);
        } catch {
            recurrent = null; // 403 — СБП-автоплатёж выключен в боте
        }
        draw(details?.autopay_enabled ?? sub.autopay_enabled ?? false, details?.autopay_days_before ?? 3, recurrent);
    }

    function draw(enabled, daysBefore, recurrent) {
        clear(body);
        const msg = note();
        body.append(el("p", {
            class: "small muted",
            text: enabled
                ? `Включено: спишем цену продления с баланса за ${daysBefore} дн. до конца подписки.`
                : "Продлим сами, если на балансе хватит денег.",
        }));
        const toggle = el("button", {
            class: enabled ? "btn-sm" : "btn-sm primary",
            onclick: (event) => set(event.currentTarget, !enabled, daysBefore),
        }, enabled ? "Выключить" : "Включить с баланса");
        body.append(el("div", { class: "row wrap-row" }, [toggle]));

        if (enabled) {
            const days = el("div", { class: "periods", style: "margin-top:10px" });
            for (const d of [1, 3, 7]) {
                days.append(el("button", {
                    class: "btn-sm",
                    "aria-selected": String(d === daysBefore),
                    onclick: (event) => set(event.currentTarget, true, d),
                }, `за ${d} дн.`));
            }
            body.append(el("p", { class: "section-title", style: "margin-top:12px", text: "Когда списывать" }), days);
        }

        if (recurrent) {
            body.append(el("p", { class: "section-title", style: "margin-top:14px", text: "Через СБП" }));
            const status = String(recurrent.status || "none").toLowerCase();
            if (status === "active") {
                body.append(el("p", {
                    class: "small ok",
                    text: ["Подключён", recurrent.amount_kopeks ? rubles(recurrent.amount_kopeks) : null,
                        recurrent.next_charge_at ? `следующее списание ${dateText(recurrent.next_charge_at)}` : null]
                        .filter(Boolean).join(" · "),
                }));
                body.append(el("button", { class: "btn-sm", onclick: (e) => cancelSbp(e.currentTarget) }, "Отключить"));
            } else if (!["none", "cancelled", "canceled", "failed", "expired"].includes(status)) {
                body.append(el("p", { class: "small gold", text: "Ждёт подтверждения в банке" }));
                body.append(el("div", { class: "row wrap-row" }, [
                    recurrent.redirect_url ? el("a", { class: "btn btn-sm", href: recurrent.redirect_url, target: "_blank", rel: "noopener" }, "Подтвердить") : null,
                    el("button", { class: "btn-sm", onclick: (e) => cancelSbp(e.currentTarget) }, "Отменить"),
                ]));
            } else {
                body.append(el("p", {
                    class: "small muted",
                    text: "Банк сам спишет оплату за следующий период — баланс пополнять не нужно. Включение выключит автопродление с баланса.",
                }));
                body.append(el("button", { class: "btn-sm", onclick: (e) => enableSbp(e.currentTarget) }, "Подключить"));
            }
        }
        body.append(msg);

        async function set(button, on, days) {
            await busy(button, async () => {
                try {
                    await api.setAutopay(sub.id, on, days);
                    await load();
                } catch (error) {
                    say(msg, error.message, "small danger");
                }
            });
        }

        async function enableSbp(button) {
            // вкладку открываем сразу: ссылка придёт после запроса, а окно,
            // открытое позже, браузер посчитает всплывающим
            const tab = window.open("", "_blank");
            await busy(button, async () => {
                try {
                    const result = await api.enableRecurrent(sub.id);
                    if (!result.redirect_url) throw new Error("Касса не вернула ссылку на подтверждение");
                    if (tab) tab.location = result.redirect_url;
                    else window.open(result.redirect_url, "_blank");
                    say(msg, "Подтвердите автоплатёж в банке и вернитесь сюда.");
                    setTimeout(load, 15000);
                } catch (error) {
                    tab?.close();
                    say(msg, sbpError(error), "small danger");
                }
            });
        }

        async function cancelSbp(button) {
            if (!confirm("Отключить автоплатёж через СБП?")) return;
            await busy(button, async () => {
                try {
                    await api.cancelRecurrent(sub.id);
                    await load();
                } catch (error) {
                    say(msg, error.message, "small danger");
                }
            });
        }
    }
}

function sbpError(error) {
    const text = String(error.message || "");
    if (text.includes("Platega subscription")) return "Касса не смогла оформить автоплатёж. Попробуйте позже.";
    if (text.includes("Trial")) return "У пробной подписки автоплатежа нет.";
    if (error.status === 403) return "Автоплатёж через СБП отключён в боте.";
    return text;
}

// ---------------- смена тарифа ----------------

const SWITCH_ERRORS = [
    ["subscription_expired", "Подписка истекла — сменить её нельзя, купите нужный тариф."],
    ["trial_cannot_switch", "Пробную подписку сменить нельзя — купите тариф."],
    ["Already on this tariff", "Вы уже на этом тарифе."],
    ["already have an active subscription", "У вас уже есть подписка на этот тариф."],
    ["not available", "Этот тариф вам недоступен."],
    ["not found or inactive", "Тариф больше не продаётся."],
];

const switchError = (error) =>
    SWITCH_ERRORS.find(([marker]) => String(error.message).includes(marker))?.[1] || error.message;

/**
 * Смена тарифа: выбрать, на какой, — и увидеть, во что обойдётся. Доплату бот
 * считает за оставшиеся дни, поэтому цена здесь своя, не та, что в магазине.
 */
export function switchCard(sub, onChanged) {
    const card = el("div", { class: "card" }, [
        el("h3", { text: "Сменить тариф" }),
        el("p", {
            class: "small muted",
            text: "Оставшиеся дни перенесутся на новый тариф. Докупленные устройства и трафик не переносятся.",
        }),
    ]);
    const box = el("div");
    card.append(box);
    box.append(el("button", { class: "btn-sm", onclick: (e) => start(e.currentTarget) }, "Выбрать тариф"));
    return card;

    async function start(button) {
        await busy(button, async () => {
            let offers = [];
            try {
                offers = parseTariffs(await api.purchaseOptions()).filter((o) => o.id !== sub.tariff_id);
            } catch (error) {
                clear(box).append(el("p", { class: "small danger", text: error.message }));
                return;
            }
            clear(box);
            if (!offers.length) {
                box.append(el("p", { class: "small muted", text: "Других тарифов сейчас нет." }));
                return;
            }
            const select = el("select");
            for (const offer of offers) select.append(el("option", { value: offer.id }, offer.name));
            const result = el("div");
            box.append(
                el("label", { class: "field" }, [el("span", {}, "Новый тариф"), select]),
                el("button", {
                    class: "btn-sm",
                    onclick: (e) => preview(e.currentTarget, offers.find((o) => String(o.id) === select.value), result),
                }, "Рассчитать"),
                result,
            );
        });
    }

    async function preview(button, offer, result) {
        if (!offer) return;
        const period = offer.periods[0]?.days ?? 30;
        await busy(button, async () => {
            clear(result);
            let p;
            try {
                p = await api.switchPreview(sub.id, offer.id, period);
            } catch (error) {
                result.append(el("p", { class: "small danger", text: switchError(error) }));
                return;
            }
            const cost = Number(p.upgrade_cost_kopeks || 0);
            const missing = Number(p.missing_amount_kopeks || 0);
            const msg = note();
            result.append(...[
                el("div", { class: "kv", style: "margin-top:10px" }, [el("span", { class: "k", text: "Осталось дней" }), el("span", { text: String(p.remaining_days ?? "—") })]),
                el("div", { class: "kv" }, [
                    el("span", { class: "k", text: "Доплата" }),
                    el("span", { text: cost > 0 ? rubles(cost) + (p.discount_percent ? ` (скидка ${p.discount_percent}%)` : "") : "без доплаты" }),
                ]),
                missing > 0 ? el("p", {
                    class: "small gold",
                    text: `На балансе ${rubles(p.balance_kopeks)}, не хватает ${rubles(missing)}. Пополните — и тариф сменится сам.`,
                }) : null,
                el("button", {
                    class: "primary",
                    style: "margin-top:10px",
                    onclick: async (e) => {
                        if (!confirm(`Перейти на «${offer.name}»${cost > 0 ? ` с доплатой ${rubles(cost)}` : ""}?`)) return;
                        await busy(e.currentTarget, async () => {
                            try {
                                await api.switchTariff(sub.id, offer.id, period);
                                say(msg, `Тариф сменён на «${offer.name}».`, "small ok");
                                onChanged?.();
                            } catch (error) {
                                if (isNotEnough(error)) {
                                    await goTopUp(error, {
                                        kind: "switch", subscriptionId: sub.id, tariffId: offer.id,
                                        periodDays: period, price: cost, title: `Переход на «${offer.name}»`,
                                    });
                                } else say(msg, switchError(error), "small danger");
                            }
                        });
                    },
                }, missing > 0 ? "Пополнить и перейти" : "Перейти"),
                msg].filter(Boolean));
        });
    }
}

// ---------------- сброс ссылки ----------------

export function revokeButton(sub, onDone) {
    const msg = note();
    const button = el("button", {
        class: "btn-sm",
        onclick: async (event) => {
            if (!confirm(
                "Сбросить ссылку подписки?\n\nСтарая перестанет работать везде, куда её добавляли вручную " +
                "(Happ, v2rayNG и другие). Наши приложения подхватят новую сами.",
            )) return;
            await busy(event.currentTarget, async () => {
                try {
                    await api.revoke(sub.id);
                    say(msg, "Ссылка сброшена. Добавьте новую в сторонние приложения заново.", "small ok");
                    onDone?.();
                } catch (error) {
                    const wait = String(error.message).match(/in (\d+) seconds/);
                    say(msg, error.status === 429
                        ? `Ссылку уже сбрасывали недавно. Повторить можно через ${Math.ceil((wait ? Number(wait[1]) : 60) / 60)} мин.`
                        : error.status === 403 ? "Сброс ссылки отключён в боте." : error.message, "small danger");
                }
            });
        },
    }, "Сбросить ссылку");
    return el("div", { style: "margin-top:12px" }, [button, msg]);
}

// ---------------- удаление ----------------

/**
 * Удалить можно только закончившуюся подписку — и не во время временного
 * доступа: его бот сначала доводит до конца.
 */
export const isDeletable = (sub) =>
    ["expired", "disabled"].includes(String(sub.status || "").toLowerCase()) && !sub.grace_until;

export function deleteSubscriptionCard(sub, onDone) {
    const msg = note();
    const name = sub.tariff_name || (sub.is_trial ? "Пробная подписка" : `Подписка #${sub.id}`);
    const button = el("button", {
        class: "btn-sm",
        onclick: async (event) => {
            if (!confirm(
                `Удалить «${name}»?\n\nПодписка пропадёт из списка вместе со ссылкой и устройствами. ` +
                "Вернуть её не получится — только купить новую.",
            )) return;
            await busy(event.currentTarget, async () => {
                try {
                    await api.deleteSubscription(sub.id);
                    toast("Подписка удалена");
                    onDone?.();
                } catch (error) {
                    say(msg, error.status === 409
                        ? "Сейчас по подписке идёт временный доступ — удалить её можно, когда он закончится."
                        : error.status === 400 ? "Удалить можно только закончившуюся подписку." : error.message,
                    "small danger");
                }
            });
        },
    }, "Удалить подписку");
    return el("div", { class: "card" }, [
        el("h3", { text: "Подписка закончилась" }),
        el("p", {
            class: "small muted",
            text: "Если она больше не нужна, её можно удалить, чтобы не мешала в списке.",
        }),
        button,
        msg,
    ]);
}

// ---------------- трафик ----------------

export function trafficCard(sub, onDone) {
    const card = el("div", { class: "card hidden" }, [el("h3", { text: "Докупить трафик" })]);
    const row = el("div", { class: "periods" });
    const msg = note();
    card.append(row, msg);
    api.trafficPackages(sub.id).then((data) => {
        const list = (Array.isArray(data) ? data : data.packages || data.items || data.traffic_packages || [])
            .map((p) => ({ gb: Number(p.gb ?? p.traffic_gb), price: Number(p.price_kopeks ?? p.price) }))
            .filter((p) => p.gb > 0 && Number.isFinite(p.price));
        if (!list.length) return;
        card.classList.remove("hidden");
        for (const pkg of list) {
            row.append(el("button", {
                class: "btn-sm",
                onclick: async (event) => {
                    if (!confirm(`Добавить ${pkg.gb} ГБ за ${rubles(pkg.price)}?`)) return;
                    await busy(event.currentTarget, async () => {
                        try {
                            await api.buyTraffic(pkg.gb, sub.id);
                            say(msg, "Трафик добавлен.", "small ok");
                            onDone?.();
                        } catch (error) {
                            say(msg, isNotEnough(error) ? `${error.message}` : error.message, "small danger");
                            if (isNotEnough(error)) msg.append(" ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); openTab("balance"); } }, "Пополнить"));
                        }
                    });
                },
            }, `+${pkg.gb} ГБ — ${rubles(pkg.price)}`));
        }
    }).catch(() => { });
    return card;
}

export { periodText };
