// Личный кабинет: вход, подписка, тарифы, баланс, устройства, поддержка.

import { api, session, ApiError, asArray, parseTariffs, parsePaymentMethods } from "./api.js";
import {
    $, $$, el, clear, rubles, plural, daysWord, daysUntil, dateText, periodText, gb,
    copy, message, busy, qrNode,
} from "./ui.js";
import {
    renderSupport, deactivateSupport, startSupportUnreadPolling, refreshSupportUnread,
} from "./support.js";
import { emailLinkCard } from "./email-link.js";
import {
    autopayCard, autopayAllowed, switchCard, revokeButton, trafficCard, goTopUp, isNotEnough,
} from "./subscription-tools.js";
import { loadPending, clearPending, completePending } from "./pending.js";
import { toast, openTab } from "./ui.js";
import { renderBonus, invalidateBonus, promoStrip } from "./bonus.js";
import { docsCard } from "./docs.js";
import { startEvents, stopEvents } from "./events.js";
import { checkAdmin, renderAdmin } from "./admin.js";

const state = {
    subscriptions: [],
    currentId: null,
    balanceKopeks: null,
};

// ================= вход =================

let registerMode = false;

function showAuth() {
    $("#authView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
    $("#logoutButton").classList.add("hidden");
    $("#balanceChip").classList.add("hidden");
}

function showApp() {
    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#logoutButton").classList.remove("hidden");
}

$("#toggleRegister").addEventListener("click", () => {
    registerMode = !registerMode;
    $("#authTitle").textContent = registerMode ? "Регистрация" : "Вход в кабинет";
    $("#emailSubmit").textContent = registerMode ? "Зарегистрироваться" : "Войти";
    $("#toggleRegister").textContent = registerMode
        ? "Уже есть аккаунт? Войти"
        : "Нет аккаунта? Регистрация";
    $("#referralField").classList.toggle("hidden", !registerMode);
    $("#forgotButton").classList.toggle("hidden", registerMode);
    $("#passwordInput").autocomplete = registerMode ? "new-password" : "current-password";
    message($("#authMessage"), "");
});

$("#emailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#emailInput").value.trim();
    const password = $("#passwordInput").value;
    message($("#authMessage"), "");

    await busy($("#emailSubmit"), async () => {
        try {
            if (registerMode) {
                const auth = await api.emailRegister(email, password, $("#referralInput").value.trim());
                if (session.save(auth)) {
                    await enterCabinet();
                } else {
                    message(
                        $("#authMessage"),
                        auth.message || "Подтвердите почту по ссылке из письма, затем войдите.",
                        "info"
                    );
                }
            } else {
                const auth = await api.emailLogin(email, password);
                if (session.save(auth)) await enterCabinet();
                else message($("#authMessage"), auth.message || "Не удалось войти.");
            }
        } catch (error) {
            message($("#authMessage"), error.message);
        }
    });
});

$("#forgotButton").addEventListener("click", async () => {
    const email = $("#emailInput").value.trim();
    if (!email.includes("@")) {
        message($("#authMessage"), "Введите почту, на которую зарегистрирован аккаунт.");
        return;
    }
    await busy($("#forgotButton"), async () => {
        try {
            await api.forgotPassword(email);
        } catch {
            // ответ намеренно одинаковый: существование почты не подтверждаем
        }
        message($("#authMessage"), "Если такая почта у нас есть, письмо уже отправлено.", "info");
    });
});

// Вход через Telegram: просим одноразовый токен, открываем бота и ждём
// подтверждения. Вкладку открываем сразу по клику — если открыть её после
// запроса, браузер посчитает это всплывающим окном и заблокирует.
let polling = false;

$("#telegramButton").addEventListener("click", async () => {
    if (polling) return;
    const tab = window.open("", "_blank");
    message($("#authMessage"), "");

    let request;
    try {
        request = await api.deepLinkRequest();
    } catch (error) {
        tab?.close();
        message($("#authMessage"), error.message);
        return;
    }

    const bot = request.bot_username;
    if (!bot) {
        tab?.close();
        message($("#authMessage"), "Сервер не вернул имя бота.");
        return;
    }

    const url = `https://t.me/${bot}?start=webauth_${request.token}`;
    if (tab) tab.location = url;
    else window.location = url; // вкладку заблокировали — уходим в бота сами

    message($("#authMessage"), "Подтвердите вход в Telegram — я подожду.", "info");
    polling = true;
    $("#telegramButton").disabled = true;

    const deadline = Date.now() + (Number(request.expires_in) || 300) * 1000;
    try {
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            let response;
            try {
                response = await api.deepLinkPoll(request.token);
            } catch {
                continue; // сеть моргнула — продолжаем ждать
            }
            if (response.status === 200) {
                const auth = await response.json();
                if (session.save(auth)) {
                    tab?.close();
                    await enterCabinet();
                    return;
                }
                message($("#authMessage"), "Сервер вернул пустой ответ.");
                return;
            }
            if (response.status === 410) {
                message($("#authMessage"), "Время авторизации истекло, попробуйте ещё раз.");
                return;
            }
        }
        message($("#authMessage"), "Время авторизации истекло, попробуйте ещё раз.");
    } finally {
        polling = false;
        $("#telegramButton").disabled = false;
    }
});

$("#logoutButton").addEventListener("click", async () => {
    stopEvents();
    const refresh = session.refresh;
    try {
        if (refresh) await api.logout(refresh);
    } catch {
        // сервер мог не ответить — локальную сессию всё равно чистим
    }
    session.clear();
    location.reload();
});

// ================= вкладки =================

$$(".tab-bar button").forEach((button) => {
    button.addEventListener("click", () => {
        if (button.dataset.tab !== "support") deactivateSupport();
        const url = new URL(location.href);
        url.hash = button.dataset.tab === "support" ? "support" : "";
        history.replaceState(null, "", url);
        $$(".tab-bar button").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
        $$("[data-tabpanel]").forEach((panel) => {
            panel.classList.toggle("hidden", panel.dataset.tabpanel !== button.dataset.tab);
        });
        const loaders = {
            plans: renderPlans,
            balance: renderBalance,
            devices: renderDevices,
            bonus: renderBonus,
            admin: renderAdmin,
            support: renderSupport,
            more: renderMore,
        };
        loaders[button.dataset.tab]?.();
    });
});

// ================= общее =================

function loading(node) {
    clear(node).append(
        el("div", { class: "card" }, [el("span", { class: "spinner" }), " Загружаю…"])
    );
}

function errorCard(text, retry) {
    return el("div", { class: "card" }, [
        el("p", { class: "danger", text }),
        retry && el("button", { class: "btn-sm", onclick: retry }, "Повторить"),
    ]);
}

async function enterCabinet() {
    showApp();
    startSupportUnreadPolling();
    startEvents();
    checkAdmin();
    await Promise.all([loadBalance(), renderSubscription()]);
    if (location.hash === "#support") $("#supportTab")?.click();
}

async function loadBalance() {
    try {
        const data = await api.balance();
        state.balanceKopeks = Number(data.balance_kopeks ?? 0);
        const chip = $("#balanceChip");
        chip.textContent = rubles(state.balanceKopeks);
        chip.classList.remove("hidden");
    } catch {
        // баланс не критичен для остального кабинета
        return;
    }
    // денег стало достаточно — оплачиваем то, ради чего пополняли
    const pending = loadPending();
    if (pending && state.balanceKopeks >= pending.price && !completing) {
        completing = true;
        try {
            const result = await completePending(state.balanceKopeks);
            if (result.text) toast(result.text, result.status === "failed" ? "err" : "info");
            if (result.status !== "wait") {
                const data = await api.balance().catch(() => null);
                if (data) {
                    state.balanceKopeks = Number(data.balance_kopeks ?? 0);
                    $("#balanceChip").textContent = rubles(state.balanceKopeks);
                }
                renderSubscription();
                if (balanceLoaded) renderBalance(true);
            }
        } finally {
            completing = false;
        }
    }
}

let completing = false;

const current = () => state.subscriptions.find((s) => s.id === state.currentId) || null;

// ================= подписка =================

async function renderSubscription() {
    const panel = $("#panelSub");
    loading(panel);

    let list = [];
    try {
        const data = await api.subscriptions();
        list = asArray(data, ["subscriptions"]);
    } catch (error) {
        clear(panel).append(errorCard(error.message, renderSubscription));
        return;
    }

    // у аккаунта без мультитарифа списка может не быть — берём одиночную
    if (!list.length) {
        try {
            const single = await api.subscription();
            if (single && (single.id || single.subscription_url)) list = [single];
        } catch {
            // подписки просто нет
        }
    }

    state.subscriptions = list;
    if (!list.some((s) => s.id === state.currentId)) {
        state.currentId = (list.find((s) => isActive(s)) || list[0])?.id ?? null;
    }

    clear(panel);
    // напоминания из кабинета — первыми: это то, что админ просит сделать сейчас
    const remindersBox = el("div", { class: "reminders" });
    panel.append(remindersBox);
    renderReminders(remindersBox);
    if (!list.length) {
        panel.append(noSubscriptionCard());
        return;
    }

    if (list.length > 1) panel.append(subscriptionPicker(list));
    const sub = current();
    // Подписка без тарифа: продлить её нельзя, докупки не продаются —
    // только переход на тариф. Карточки, которые кончились бы отказом, не рисуем.
    const legacy = sub.requires_tariff_selection === true;
    panel.append(subscriptionCard(sub));
    panel.append(connectionCard(sub));
    if (legacy) return;
    if (isActive(sub) && autopayAllowed(sub)) panel.append(autopayCard(sub));
    if (isActive(sub) && !sub.is_trial && sub.tariff_id != null) {
        panel.append(switchCard(sub, () => Promise.all([loadBalance(), renderSubscription()])));
    }
    const limitGb = Number(sub.traffic_limit_gb ?? 0);
    if (isActive(sub) && limitGb > 0) {
        panel.append(trafficCard(sub, () => Promise.all([loadBalance(), renderSubscription()])));
    }
}

/** Путь веб-кабинета из кнопки напоминания → вкладка этого кабинета. */
function reminderTab(target) {
    const path = String(target || "").toLowerCase();
    if (/balance|topup/.test(path)) return "balance";
    if (/referral|partner|gift|promo|loyalty|discount/.test(path)) return "bonus";
    if (/support|ticket/.test(path)) return "support";
    if (/device/.test(path)) return "devices";
    if (/subscription|tariff|purchase|renew/.test(path)) return "plans";
    if (/faq|info|rules|news/.test(path)) return "more";
    return null;
}

async function renderReminders(box) {
    let cards = [];
    try {
        cards = asArray(await api.reminders(), ["items"]);
    } catch {
        return; // напоминания — не главное, без них страница работает
    }
    for (const card of cards) {
        const node = el("div", { class: "card" });
        const button = card.button && card.button.text && card.button.target ? card.button : null;
        node.append(...[
            el("div", { class: "sub-head" }, [
                el("h3", { style: "margin:0", text: card.title || "" }),
                el("button", {
                    class: "btn-sm",
                    "aria-label": "Закрыть",
                    onclick: () => {
                        node.remove();
                        api.dismissReminder(card.id).catch(() => {});
                    },
                }, "✕"),
            ]),
            card.body ? el("p", { class: "small muted", style: "white-space:pre-line;margin:8px 0 0", text: card.body }) : null,
            button ? el("button", {
                class: "primary",
                style: "margin-top:12px",
                onclick: () => {
                    if (button.kind === "cabinet") {
                        const tab = reminderTab(button.target);
                        if (tab) openTab(tab);
                        else window.open(`https://cabinet.darkprincepanel.ru/${button.target.replace(/^\//, "")}`, "_blank", "noopener");
                    } else {
                        window.open(button.target, "_blank", "noopener");
                    }
                },
            }, button.text) : null,
        ].filter(Boolean));
        box.append(node);
    }
}

const isActive = (sub) =>
    ["active", "trial", "активна"].includes(String(sub.status || "").toLowerCase()) ||
    sub.is_active === true;

function noSubscriptionCard() {
    return el("div", { class: "card" }, [
        el("h2", { text: "Подписки пока нет" }),
        el("p", {
            class: "small muted",
            text: "Выберите тариф — оплата спишется с баланса кабинета. Пробный период, если он доступен, тоже находится на вкладке «Тарифы».",
        }),
        el("button", {
            class: "primary",
            onclick: () => $$(".tab-bar button").find((b) => b.dataset.tab === "plans")?.click(),
        }, "Выбрать тариф"),
    ]);
}

function subscriptionPicker(list) {
    const select = el("select", {
        onchange: (event) => {
            state.currentId = Number(event.target.value);
            // устройства у каждой подписки свои — перечитать при следующем открытии
            devicesLoaded = false;
            renderSubscription();
        },
    });
    for (const sub of list) {
        const name = sub.tariff_name || (sub.is_trial ? "Пробная подписка" : `Подписка #${sub.id}`);
        select.append(el("option", { value: sub.id, selected: sub.id === state.currentId }, name));
    }
    return el("div", { class: "card" }, [
        el("p", { class: "section-title", text: "Ваши подписки" }),
        select,
    ]);
}

function subscriptionCard(sub) {
    const days = sub.days_left ?? daysUntil(sub.end_date);
    const used = Number(sub.traffic_used_gb ?? 0);
    const limit = sub.traffic_limit_gb;
    const unlimited = limit === null || limit === undefined || Number(limit) === 0;
    const share = unlimited || !limit ? 0 : Math.min(1, used / Number(limit));

    const card = el("div", { class: "card" }, [
        el("div", { class: "sub-head" }, [
            el("div", {}, [
                el("h2", {
                    style: "margin-bottom:2px",
                    text: sub.tariff_name || (sub.is_trial ? "Пробная подписка" : "Подписка"),
                }),
                el("p", {
                    class: "small muted",
                    style: "margin:0",
                    text: isActive(sub) ? "Активна" : "Неактивна",
                }),
            ]),
            el("div", { style: "text-align:right" }, [
                el("div", { class: "days", text: days === null ? "—" : String(days) }),
                el("div", { class: "tiny muted", text: days === null ? "" : `${daysWord(days)} осталось` }),
            ]),
        ]),
        // при безлимите полоса заполнения только сбивает с толку
        unlimited ? null : el("div", { class: "bar" }, [el("i", { style: `width:${Math.round(share * 100)}%` })]),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Трафик" }),
            el("span", { text: unlimited ? `${gb(used)} · безлимит` : `${gb(used)} из ${gb(limit)}` }),
        ]),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Устройств по тарифу" }),
            el("span", { text: sub.device_limit ?? "—" }),
        ]),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Действует до" }),
            el("span", { text: dateText(sub.end_date) }),
        ]),
    ]);

    if (sub.grace_until) {
        card.append(el("p", {
            class: "small",
            style: "color:var(--warn,#e0a63a);margin:10px 0 0",
            text: `Временный доступ до ${dateText(sub.grace_until)}. Продлите подписку, чтобы VPN не отключился.`,
        }));
    }
    if (sub.requires_tariff_selection === true) {
        card.append(
            el("p", {
                class: "small muted",
                style: "margin:14px 0 8px",
                text: "Подписка оформлена до появления тарифов. Продлить её можно, перейдя на тариф.",
            }),
            el("button", { class: "primary", onclick: () => openTab("plans") }, "Выбрать тариф"),
        );
        return card;
    }

    const renewBox = el("div", { style: "margin-top:14px" });
    card.append(renewBox);
    renewBox.append(
        el("button", {
            class: "primary",
            onclick: (event) => loadRenewal(renewBox, event.currentTarget, sub),
        }, "Продлить подписку")
    );
    return card;
}

async function loadRenewal(box, button, sub) {
    await busy(button, async () => {
        let options = [];
        try {
            const data = await api.renewalOptions(sub.id);
            options = asArray(data, ["options", "items"])
                .map((item) => ({
                    days: Number(item.period_days ?? item.days),
                    price: Number(item.price_kopeks ?? item.price),
                    highlighted: item.is_highlighted === true,
                }))
                .filter((item) => Number.isFinite(item.days) && Number.isFinite(item.price))
                .sort((a, b) => a.days - b.days);
        } catch (error) {
            clear(box).append(el("p", { class: "small danger", text: error.message }));
            return;
        }

        clear(box);
        if (!options.length) {
            box.append(el("p", {
                class: "small muted",
                text: "Продление для этой подписки сейчас недоступно.",
            }));
            return;
        }

        box.append(el("p", { class: "section-title", text: "На какой срок продлить" }));
        const note = el("p", { class: "small muted" });
        const row = el("div", { class: "periods" });
        for (const option of options) {
            row.append(el("button", {
                class: "btn-sm",
                onclick: async (event) => {
                    if (!confirm(`Продлить на ${periodText(option.days)} за ${rubles(option.price)}? Сумма спишется с баланса.`)) return;
                    await busy(event.currentTarget, async () => {
                        try {
                            await api.renew(option.days, sub.id);
                            note.className = "small ok";
                            note.textContent = "Подписка продлена.";
                            await Promise.all([loadBalance(), renderSubscription()]);
                        } catch (error) {
                            if (isNotEnough(error)) {
                                await goTopUp(error, {
                                    kind: "renew", subscriptionId: sub.id, periodDays: option.days, price: option.price,
                                    title: `${sub.tariff_name || "Подписка"} · продление на ${periodText(option.days)}`,
                                }, () => (balanceLoaded = false));
                                return;
                            }
                            note.className = "small danger";
                            note.textContent = error.message;
                        }
                    });
                },
            }, `${option.highlighted ? "★ " : ""}${periodText(option.days)} — ${rubles(option.price)}`));
        }
        box.append(row, note);
    });
}

function connectionCard(sub) {
    const card = el("div", { class: "card" }, [
        el("h3", { text: "Подключение" }),
        el("p", {
            class: "small muted",
            text: "В наших приложениях ничего вводить не нужно — они забирают подписку сами. Ссылка ниже нужна для сторонних клиентов, например на Linux.",
        }),
    ]);

    const body = el("div");
    card.append(body);

    const url = sub.subscription_url;
    if (isActive(sub)) card.append(revokeButton(sub, () => renderSubscription()));
    if (url) fillConnection(body, url);
    else {
        const button = el("button", {
            class: "btn-sm",
            onclick: async (event) => {
                await busy(event.currentTarget, async () => {
                    try {
                        const data = await api.connectionLink();
                        const link = data.subscription_url;
                        if (link) fillConnection(body, link);
                        else body.append(el("p", { class: "small muted", text: "Ссылка недоступна." }));
                    } catch (error) {
                        body.append(el("p", { class: "small danger", text: error.message }));
                    }
                });
            },
        }, "Показать ссылку подписки");
        body.append(button);
    }
    return card;
}

function fillConnection(box, url) {
    clear(box).append(...[
        el("p", { class: "mono", text: url }),
        el("div", { class: "row wrap-row", style: "margin-bottom:14px" }, [
            el("button", {
                class: "btn-sm",
                onclick: (event) => copy(url, event.currentTarget),
            }, "Скопировать ссылку"),
            el("a", { class: "btn btn-sm", href: "/#install" }, "Как подключить"),
        ]),
        window.qrcode
            ? el("div", {}, [
                el("p", { class: "section-title", text: "или отсканируйте телефоном" }),
                qrNode(url),
            ])
            : null].filter(Boolean));
}

// ================= тарифы =================

let plansLoaded = false;

async function renderPlans(force = false) {
    const panel = $("#panelPlans");
    if (plansLoaded && !force) return;
    plansLoaded = true;
    loading(panel);

    let offers = [];
    let trial = null;
    try {
        offers = parseTariffs(await api.purchaseOptions());
    } catch (error) {
        clear(panel).append(errorCard(error.message, () => renderPlans(true)));
        return;
    }
    try {
        trial = await api.trialInfo();
    } catch {
        // пробного периода может не быть вовсе
    }

    clear(panel);
    promoStrip().then((strip) => strip && panel.prepend(strip)).catch(() => { });

    const trialAvailable = trial && (trial.available ?? trial.is_available);
    if (trialAvailable) {
        panel.append(el("div", { class: "card" }, [
            el("h3", { text: "Пробный период" }),
            el("p", {
                class: "small muted",
                text: trial.message || (trial.duration_days
                    ? `${trial.duration_days} ${daysWord(trial.duration_days)} бесплатно.`
                    : "Доступен бесплатный пробный период."),
            }),
            el("button", {
                class: "primary",
                onclick: async (event) => {
                    await busy(event.currentTarget, async () => {
                        try {
                            await api.activateTrial();
                            await renderSubscription();
                            renderPlans(true);
                        } catch (error) {
                            alert(error.message);
                        }
                    });
                },
            }, "Активировать"),
        ]));
    }

    if (!offers.length) {
        panel.append(el("div", { class: "card" }, [
            el("p", { class: "muted", text: "Тарифы сейчас недоступны. Попробуйте позже." }),
        ]));
        return;
    }

    panel.append(el("p", {
        class: "small muted after-card",
        text: "Оплата списывается с баланса кабинета. Не хватит — переведём на пополнение, и подписка оплатится сама, как только деньги придут.",
    }));

    const grid = el("div", { class: "grid cols-2" });
    for (const offer of offers) grid.append(tariffCard(offer));
    panel.append(grid);
}

function tariffCard(offer) {
    let selected = offer.periods.find((p) => p.highlighted) || offer.periods[0];
    const price = el("div", { class: "price", text: rubles(selected.price) });
    const note = el("p", { class: "small" });
    const periods = el("div", { class: "periods" });

    const buttons = offer.periods.map((period) =>
        el("button", {
            class: "btn-sm",
            "aria-selected": String(period === selected),
            onclick: () => {
                selected = period;
                price.textContent = rubles(period.price);
                [...periods.children].forEach((child, index) =>
                    child.setAttribute("aria-selected", String(offer.periods[index] === selected))
                );
            },
        }, `${period.highlighted ? "★ " : ""}${periodText(period.days)}`)
    );
    periods.append(...buttons);

    return el("div", { class: "card tariff" }, [
        offer.highlighted ? el("span", { class: "chip", style: "color:var(--gold,#d9ad52);margin-bottom:8px;display:inline-block;align-self:flex-start;width:auto" }, "★ Выгодно") : null,
        el("h3", { text: offer.name }),
        offer.description && el("p", { class: "small muted", text: offer.description }),
        el("div", { class: "row wrap-row", style: "margin-bottom:6px" }, [
            offer.trafficLimitGb ? el("span", { class: "chip" }, `${offer.trafficLimitGb} ГБ`) : el("span", { class: "chip" }, "Безлимит"),
            offer.deviceLimit ? el("span", { class: "chip" }, `${offer.deviceLimit} ${plural(offer.deviceLimit, "устройство", "устройства", "устройств")}`) : null,
        ]),
        periods,
        price,
        el("button", {
            class: "primary btn-block",
            style: "margin-top:12px",
            onclick: async (event) => {
                if (!confirm(`Купить «${offer.name}» на ${periodText(selected.days)} за ${rubles(selected.price)}?`)) return;
                await busy(event.currentTarget, async () => {
                    try {
                        await api.purchaseTariff(offer.id, selected.days);
                        note.className = "small ok";
                        note.textContent = "Готово! Подписка активна.";
                        await Promise.all([loadBalance(), renderSubscription()]);
                    } catch (error) {
                        if (isNotEnough(error)) {
                            await goTopUp(error, {
                                kind: "buy", tariffId: offer.id, periodDays: selected.days, price: selected.price,
                                title: `${offer.name} · ${periodText(selected.days)}`,
                            }, () => (balanceLoaded = false));
                            return;
                        }
                        note.className = "small danger";
                        note.textContent = error.message;
                    }
                });
            },
        }, "Купить"),
        note,
    ]);
}

// ================= баланс =================

let balanceLoaded = false;
window.addEventListener("dp-pending", () => (balanceLoaded = false));

async function renderBalance(force = false) {
    const panel = $("#panelBalance");
    if (balanceLoaded && !force) return;
    balanceLoaded = true;
    loading(panel);

    let methods = [];
    try {
        methods = parsePaymentMethods(await api.paymentMethods());
    } catch {
        // способы оплаты могли не отдаться — покажем это ниже
    }

    clear(panel);
    const pending = loadPending();
    if (pending) {
        panel.append(el("div", { class: "msg info" }, [
            el("strong", { text: `Ждёт оплаты: ${pending.title}` }),
            el("br"),
            `Не хватает ${rubles(pending.missing)}. Пополните — и оплатим сами, как только деньги придут. `,
            el("a", {
                href: "#",
                onclick: (e) => { e.preventDefault(); clearPending(); renderBalance(true); },
            }, "Отменить"),
        ]));
    }
    panel.append(el("div", { class: "card" }, [
        el("p", { class: "section-title", text: "На счету" }),
        el("div", { class: "days", text: rubles(state.balanceKopeks ?? 0) }),
        el("p", {
            class: "small muted",
            style: "margin-top:8px",
            text: "С этого счёта оплачиваются тарифы, продление и дополнительные устройства.",
        }),
    ]));

    // пришли за недостающей суммой — подставляем её, округлив до рубля
    const prefill = pending ? Math.max(10, Math.ceil(pending.missing / 100)) : 300;
    panel.append(topupCard(methods, prefill));
    panel.append(transactionsCard());
}

function topupCard(methods, prefill = 300) {
    const note = el("p", { class: "small" });

    if (!methods.length) {
        return el("div", { class: "card" }, [
            el("h3", { text: "Пополнение" }),
            el("p", {
                class: "small muted",
                text: "Способы оплаты сейчас недоступны. Пополнить баланс можно в Telegram-боте.",
            }),
        ]);
    }

    const amount = el("input", { type: "number", min: "1", step: "1", value: String(prefill) });
    const method = el("select");
    for (const item of methods) method.append(el("option", { value: item.key }, item.name));

    const quick = el("div", { class: "amounts" });
    for (const value of [100, 300, 500, 1000]) {
        quick.append(el("button", {
            class: "btn-sm",
            onclick: () => (amount.value = String(value)),
        }, `${value} ₽`));
    }

    const pending = el("div");

    return el("div", { class: "card" }, [
        el("h3", { text: "Пополнить баланс" }),
        quick,
        el("label", { class: "field" }, [el("span", {}, "Сумма, ₽"), amount]),
        el("label", { class: "field" }, [el("span", {}, "Способ оплаты"), method]),
        el("button", {
            class: "primary",
            onclick: async (event) => {
                const rublesAmount = Number(amount.value);
                if (!Number.isFinite(rublesAmount) || rublesAmount <= 0) {
                    note.className = "small danger";
                    note.textContent = "Введите сумму.";
                    return;
                }
                const chosen = methods.find((m) => m.key === method.value);
                const kopeks = Math.round(rublesAmount * 100);
                if (chosen?.min && kopeks < chosen.min) {
                    note.className = "small danger";
                    note.textContent = `Минимальная сумма для этого способа — ${rubles(chosen.min)}.`;
                    return;
                }
                if (chosen?.max && kopeks > chosen.max) {
                    note.className = "small danger";
                    note.textContent = `Максимальная сумма для этого способа — ${rubles(chosen.max)}.`;
                    return;
                }

                // вкладку открываем заранее: ссылка придёт после запроса, а
                // окно, открытое позже, браузер посчитает всплывающим
                const tab = window.open("", "_blank");
                await busy(event.currentTarget, async () => {
                    try {
                        const payment = await api.topup(kopeks, chosen.id, chosen.option);
                        if (payment.payment_url) {
                            if (tab) tab.location = payment.payment_url;
                            else window.open(payment.payment_url, "_blank");
                            note.className = "small muted";
                            note.textContent = "Счёт открыт в новой вкладке. После оплаты вернитесь сюда.";
                            clear(pending).append(pendingBlock(chosen.id, payment.payment_id));
                            watchPayment(chosen.id, payment.payment_id);
                        } else {
                            tab?.close();
                            note.className = "small muted";
                            note.textContent = payment.message || "Счёт создан.";
                        }
                    } catch (error) {
                        tab?.close();
                        note.className = "small danger";
                        note.textContent = error.message;
                    }
                });
            },
        }, "Пополнить"),
        note,
        pending,
    ]);
}

/**
 * Пока висит счёт, сами спрашиваем, дошли ли деньги, — сначала часто, потом
 * реже. Без этого после оплаты приходилось жать «проверить».
 */
let paymentWatch = null;

function watchPayment(method, paymentId) {
    if (!paymentId) return;
    clearTimeout(paymentWatch);
    const start = state.balanceKopeks;
    let attempt = 0;
    const tick = async () => {
        attempt += 1;
        try {
            await api.checkPending(method, paymentId);
        } catch {
            // не дошёл ещё — спросим позже
        }
        await loadBalance();
        if (state.balanceKopeks !== start) {
            toast(`Баланс пополнен: ${rubles(state.balanceKopeks)}`);
            if (balanceLoaded) renderBalance(true);
            return;
        }
        if (attempt < 40) paymentWatch = setTimeout(tick, attempt < 12 ? 5000 : 15000);
    };
    paymentWatch = setTimeout(tick, 5000);
}

function pendingBlock(method, paymentId) {
    if (!paymentId) return el("span");
    const status = el("p", { class: "small muted" });
    return el("div", { style: "margin-top:12px" }, [
        el("button", {
            class: "btn-sm",
            onclick: async (event) => {
                await busy(event.currentTarget, async () => {
                    try {
                        await api.checkPending(method, paymentId);
                    } catch {
                        // платёж мог ещё не дойти — просто перечитаем баланс
                    }
                    await loadBalance();
                    renderBalance(true);
                    status.textContent = `Баланс обновлён: ${rubles(state.balanceKopeks ?? 0)}`;
                });
            },
        }, "Я оплатил — проверить"),
        status,
    ]);
}

function transactionsCard() {
    const card = el("div", { class: "card" }, [el("h3", { text: "История" })]);
    const list = el("div", {}, [el("p", { class: "small muted", text: "Загружаю…" })]);
    card.append(list);

    api.transactions(1)
        .then((data) => {
            const items = data.items || data.transactions || [];
            clear(list);
            if (!items.length) {
                list.append(el("p", { class: "small muted", text: "Операций пока нет." }));
                return;
            }
            for (const item of items.slice(0, 20)) {
                const amount = Number(item.amount_kopeks ?? 0);
                list.append(el("div", { class: "list-item" }, [
                    el("div", { class: "grow" }, [
                        el("div", { class: "title", text: item.description || item.type || "Операция" }),
                        el("div", { class: "tiny muted", text: dateText(item.created_at) }),
                    ]),
                    el("div", {
                        class: amount < 0 ? "muted" : "ok",
                        text: `${amount > 0 ? "+" : ""}${rubles(amount)}`,
                    }),
                ]));
            }
        })
        .catch(() => {
            clear(list).append(el("p", { class: "small muted", text: "История недоступна." }));
        });

    return card;
}

// ================= устройства =================

let devicesLoaded = false;

async function renderDevices(force = false) {
    const panel = $("#panelDevices");
    if (devicesLoaded && !force) return;
    devicesLoaded = true;
    loading(panel);

    const subId = state.currentId;
    let devices = [];
    let info = {};
    try {
        const data = await api.devices(subId);
        devices = asArray(data, ["devices"]);
        info = data || {};
    } catch (error) {
        clear(panel).append(errorCard(error.message, () => renderDevices(true)));
        return;
    }

    let price = null;
    try {
        price = await api.devicePrice(1, subId);
    } catch {
        // цену могли не отдать — тогда просто не покажем докупку
    }

    clear(panel);

    const limit = info.device_limit ?? price?.current_device_limit ?? null;
    const card = el("div", { class: "card" }, [
        el("h3", { text: "Подключённые устройства" }),
        el("p", {
            class: "small muted",
            text: limit === null
                ? `Устройств: ${devices.length}`
                : `Занято ${devices.length} из ${limit}. Освободить место можно, отключив старое устройство.`,
        }),
    ]);

    if (!devices.length) {
        card.append(el("p", { class: "small muted", text: "Пока ни одного. Устройство появляется здесь после первого подключения." }));
    }

    for (const device of devices) {
        const title = device.local_name || device.device_model || device.platform || "Устройство";
        const subtitle = [device.platform, device.device_model]
            .filter((value) => value && value !== title)
            .join(" · ");
        card.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [
                el("div", { class: "title", text: title }),
                el("div", { class: "tiny muted", text: [subtitle, dateText(device.created_at)].filter(Boolean).join(" · ") }),
            ]),
            el("button", {
                class: "btn-sm",
                onclick: async (event) => {
                    if (!confirm(`Отключить «${title}»? Устройство потеряет доступ и освободит место в лимите.`)) return;
                    await busy(event.currentTarget, async () => {
                        try {
                            await api.deleteDevice(device.hwid, subId);
                            renderDevices(true);
                        } catch (error) {
                            alert(error.message);
                        }
                    });
                },
            }, "Отключить"),
        ]));
    }

    panel.append(card);
    panel.append(devicePurchaseCard(price, subId));

    // уменьшить лимит — если бот разрешает
    try {
        const reduction = await api.deviceReductionInfo(subId);
        const current = Number(reduction.current_device_limit ?? limit ?? 0);
        const min = Number(reduction.min_device_limit ?? 1);
        if (reduction.available && current > min) {
            const target = el("input", { type: "number", min: String(min), max: String(current - 1), value: String(current - 1) });
            const note = el("p", { class: "small" });
            panel.append(el("div", { class: "card" }, [
                el("h3", { text: "Уменьшить лимит устройств" }),
                el("p", { class: "small muted", text: `Сейчас ${current}. Лишние устройства придётся сначала отключить.` }),
                el("label", { class: "field" }, [el("span", {}, "Новый лимит"), target]),
                el("button", {
                    class: "btn-sm",
                    onclick: async (event) => {
                        const n = Math.max(min, Math.min(current - 1, Number(target.value) || min));
                        if (!confirm(`Уменьшить лимит до ${n}?`)) return;
                        await busy(event.currentTarget, async () => {
                            try {
                                await api.reduceDevices(n, subId);
                                await renderSubscription();
                                renderDevices(true);
                            } catch (error) {
                                note.className = "small danger";
                                note.textContent = error.message;
                            }
                        });
                    },
                }, "Уменьшить"),
                note,
            ]));
        }
    } catch {
        // уменьшение недоступно — просто не показываем
    }
}

function devicePurchaseCard(price, subId) {
    const perDevice = price?.price_per_device_kopeks ?? null;
    const available = (price?.available ?? true) && perDevice !== null;

    if (!available) {
        // почему кнопки нет — иначе непонятно, ограничение это или сбой
        const reason = price?.message || price?.reason || price?.detail
            || "Докупка устройств для этого тарифа недоступна.";
        return el("div", { class: "card" }, [
            el("h3", { text: "Больше устройств" }),
            el("p", { class: "small muted", text: reason }),
        ]);
    }

    const count = el("input", { type: "number", min: "1", max: String(price?.max_device_limit || 10), value: "1" });
    const total = el("div", { class: "price gold", text: rubles(perDevice) });
    count.addEventListener("input", () => {
        const n = Math.max(1, Number(count.value) || 1);
        total.textContent = rubles(perDevice * n);
    });
    const note = el("p", { class: "small" });

    return el("div", { class: "card" }, [
        el("h3", { text: "Больше устройств" }),
        el("p", { class: "small muted", text: `${rubles(perDevice)} за устройство. Оплата спишется с баланса.` }),
        el("label", { class: "field" }, [el("span", {}, "Сколько добавить"), count]),
        total,
        el("button", {
            class: "primary",
            style: "margin-top:12px",
            onclick: async (event) => {
                const n = Math.max(1, Number(count.value) || 1);
                if (!confirm(`Добавить ${n} ${plural(n, "устройство", "устройства", "устройств")} за ${rubles(perDevice * n)}?`)) return;
                await busy(event.currentTarget, async () => {
                    try {
                        await api.purchaseDevices(n, subId);
                        note.className = "small ok";
                        note.textContent = "Готово, лимит увеличен.";
                        await Promise.all([loadBalance(), renderSubscription()]);
                        renderDevices(true);
                    } catch (error) {
                        note.className = "small danger";
                        note.textContent = error.message;
                    }
                });
            },
        }, "Докупить"),
        note,
    ]);
}

// ================= ещё =================

let moreLoaded = false;

/** Отказы кабинета по промокоду: код в detail.code, текст там английский. */
const PROMO_ERRORS = {
    not_found: "Такого промокода нет. Проверьте, правильно ли он введён.",
    expired: "Срок действия промокода закончился.",
    inactive: "Промокод отключён.",
    not_yet_valid: "Промокод ещё не начал действовать.",
    used: "Промокод уже использовали максимальное число раз.",
    already_used_by_user: "Вы уже активировали этот промокод.",
    active_discount_exists: "У вас уже есть активная скидка — сначала используйте её.",
    no_subscription_for_days: "Этот промокод продлевает подписку, а у вас её пока нет. Сначала оформите подписку или пробный период.",
    subscription_not_found: "Подписка не найдена. Обновите страницу.",
    not_first_purchase: "Промокод действует только на первую покупку.",
    daily_limit: "Слишком много промокодов за сегодня. Попробуйте завтра.",
    trial_subscription_exists: "Пробный промокод не подходит: у вас уже есть подписка.",
    traffic_not_applicable: "Промокод добавляет трафик, а у вашей подписки он и так безлимитный.",
};

/**
 * Активация промокода. Код на дни при нескольких подписках кабинет сам не
 * применяет — присылает список, и человек выбирает, куда добавить дни.
 */
async function applyPromo(code, subscriptionId, note) {
    try {
        const result = await api.activatePromo(code, subscriptionId);
        if (result.error === "select_subscription" && result.eligible_subscriptions?.length) {
            note.className = "small";
            note.replaceChildren(
                el("span", { text: "К какой подписке добавить дни?" }),
                ...result.eligible_subscriptions.map((sub) => el("button", {
                    class: "btn-sm",
                    style: "display:block;margin-top:8px",
                    onclick: (event) => busy(event.currentTarget, () => applyPromo(code, sub.id, note)),
                }, `${sub.tariff_name || `Подписка #${sub.id}`}${sub.days_left > 0 ? ` · осталось ${sub.days_left} дн.` : " · истекла"}`)),
            );
            return;
        }
        const ok = result.success ?? true;
        note.className = ok ? "small ok" : "small danger";
        // message у кабинета английский — показываем, что именно дал код
        note.textContent = ok ? (result.bonus_description || "Промокод активирован!") : "Не удалось активировать промокод.";
        if (ok) await Promise.all([loadBalance(), renderSubscription()]);
    } catch (error) {
        note.className = "small danger";
        note.textContent = PROMO_ERRORS[error.code] || error.message;
    }
}

async function renderMore(force = false) {
    const panel = $("#panelMore");
    if (moreLoaded && !force) return;
    moreLoaded = true;
    clear(panel);

    // промокод
    const promoInput = el("input", { type: "text", placeholder: "PROMO2026" });
    const promoNote = el("p", { class: "small" });
    panel.append(el("div", { class: "card" }, [
        el("h3", { text: "Промокод" }),
        el("label", { class: "field" }, [el("span", {}, "Код"), promoInput]),
        el("button", {
            onclick: async (event) => {
                const code = promoInput.value.trim();
                if (!code) return;
                await busy(event.currentTarget, () => applyPromo(code, null, promoNote));
            },
        }, "Активировать"),
        promoNote,
    ]));

    // приглашения, подарки и скидки — на вкладке «Бонусы»
    panel.append(el("div", { class: "card" }, [
        el("h3", { text: "Бонусы" }),
        el("p", { class: "small muted", text: "Приглашения и вывод денег, подарки, скидки и уровни лояльности." }),
        el("button", { class: "btn-sm", onclick: () => $$(".tab-bar button").find((b) => b.dataset.tab === "bonus")?.click() }, "Открыть"),
    ]));
    panel.append(docsCard());

    // аккаунт
    const user = session.user;
    // почты нет — вошли через Telegram: предлагаем привязать, чтобы входить
    // и без него
    if (user && !user.email) {
        panel.append(emailLinkCard(() => {
            api.me().then((fresh) => (session.user = fresh)).catch(() => { });
        }));
    }
    panel.append(el("div", { class: "card" }, [
        el("h3", { text: "Аккаунт" }),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Почта" }),
            el("span", {
                text: user?.email
                    ? user.email + (user.email_verified === false ? " (не подтверждена — проверьте письмо)" : "")
                    : "—",
            }),
        ]),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Telegram" }),
            el("span", { text: user?.username ? `@${user.username}` : (user?.telegram_id ? String(user.telegram_id) : "—") }),
        ]),
        el("div", { class: "row wrap-row", style: "margin-top:14px" }, [
            el("a", { class: "btn btn-sm", href: "/" }, "Скачать приложения"),
            el("button", {
                class: "btn-sm",
                onclick: () => $("#supportTab")?.click(),
            }, "Техподдержка"),
            el("button", {
                class: "btn-sm",
                onclick: () => $("#logoutButton").click(),
            }, "Выйти"),
        ]),
    ]));
}

// ================= живые события =================

const EVENT_TEXT = {
    "balance.topup": (e) => `Баланс пополнен${e.amount_kopeks ? ` на ${rubles(e.amount_kopeks)}` : ""}`,
    "autopay.success": (e) => `Подписка продлена автоматически${e.amount_kopeks ? `, списано ${rubles(e.amount_kopeks)}` : ""}`,
    "autopay.insufficient_funds": (e) => `Автопродление не прошло: на балансе не хватает${e.required_kopeks ? ` ${rubles(Math.max(0, e.required_kopeks - (e.balance_kopeks || 0)))}` : " денег"}`,
    "autopay.failed": (e) => `Автопродление не прошло${e.reason ? `: ${e.reason}` : ""}`,
    "subscription.expired": () => "Подписка закончилась",
    "ticket.admin_reply": () => "Поддержка ответила на ваше обращение",
    "referral.bonus": (e) => `Бонус за приглашённого${e.bonus_kopeks ? `: ${rubles(e.bonus_kopeks)}` : ""}`,
};

window.addEventListener("cabinet-event", (event) => {
    const data = event.detail || {};
    const type = String(data.type || "");
    const text = EVENT_TEXT[type]?.(data);
    if (text) toast(text, type.startsWith("autopay.") && type !== "autopay.success" ? "err" : "info");
    if (type.startsWith("balance.") || type === "payment.received" || type.startsWith("autopay.")) {
        loadBalance();
        if (balanceLoaded) renderBalance(true);
    }
    if (type.startsWith("subscription.") || type.startsWith("autopay.")) {
        renderSubscription();
        devicesLoaded = false;
    }
    if (type.startsWith("referral.")) invalidateBonus();
    if (type.startsWith("ticket.")) refreshSupportUnread();
    // админу — новое обращение или ответ клиента: открытая панель обновится сама
    if ((type === "ticket.new" || type === "ticket.user_reply") && !$("#panelAdmin").classList.contains("hidden")) renderAdmin();
});

window.addEventListener("dp-subscription-changed", () => renderSubscription());
window.addEventListener("dp-balance-changed", () => loadBalance());

// ================= старт =================

if (session.loggedIn) {
    enterCabinet();
    // имя и почта могли измениться в боте
    api.me().then((user) => (session.user = user)).catch(() => { });
} else {
    showAuth();
}
