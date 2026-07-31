// Личный кабинет: вход, подписка, тарифы, баланс, устройства.

import { api, session, ApiError, asArray, parseTariffs, parsePaymentMethods } from "./api.js";
import {
    $, $$, el, clear, rubles, plural, daysWord, daysUntil, dateText, periodText, gb,
    copy, message, busy, qrNode,
} from "./ui.js";

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
        $$(".tab-bar button").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
        $$("[data-tabpanel]").forEach((panel) => {
            panel.classList.toggle("hidden", panel.dataset.tabpanel !== button.dataset.tab);
        });
        const loaders = {
            plans: renderPlans,
            balance: renderBalance,
            devices: renderDevices,
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
    await Promise.all([loadBalance(), renderSubscription()]);
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
    }
}

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
    if (!list.length) {
        panel.append(noSubscriptionCard());
        return;
    }

    if (list.length > 1) panel.append(subscriptionPicker(list));
    panel.append(subscriptionCard(current()));
    panel.append(connectionCard(current()));
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

    const renewBox = el("div", { style: "margin-top:14px" });
    card.append(renewBox);
    renewBox.append(
        el("button", {
            class: "primary",
            onclick: (event) => loadRenewal(renewBox, event.currentTarget),
        }, "Продлить подписку")
    );
    return card;
}

async function loadRenewal(box, button) {
    await busy(button, async () => {
        let options = [];
        try {
            const data = await api.renewalOptions();
            options = asArray(data, ["options", "items"])
                .map((item) => ({
                    days: Number(item.period_days ?? item.days),
                    price: Number(item.price_kopeks ?? item.price),
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
                            await api.renew(option.days);
                            note.className = "small ok";
                            note.textContent = "Подписка продлена.";
                            await Promise.all([loadBalance(), renderSubscription()]);
                        } catch (error) {
                            note.className = "small danger";
                            note.textContent = error.message;
                        }
                    });
                },
            }, `${periodText(option.days)} — ${rubles(option.price)}`));
        }
        box.append(row, note);
        if (state.subscriptions.length > 1) {
            box.append(el("p", {
                class: "tiny muted",
                text: "Продление применяется к активной подписке аккаунта.",
            }));
        }
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
    clear(box).append(
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
            : null
    );
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
        text: "Оплата списывается с баланса кабинета. Если денег не хватает — пополните баланс на соседней вкладке.",
    }));

    const grid = el("div", { class: "grid cols-2" });
    for (const offer of offers) grid.append(tariffCard(offer));
    panel.append(grid);
}

function tariffCard(offer) {
    let selected = offer.periods[0];
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
        }, periodText(period.days))
    );
    periods.append(...buttons);

    return el("div", { class: "card tariff" }, [
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
    panel.append(el("div", { class: "card" }, [
        el("p", { class: "section-title", text: "На счету" }),
        el("div", { class: "days", text: rubles(state.balanceKopeks ?? 0) }),
        el("p", {
            class: "small muted",
            style: "margin-top:8px",
            text: "С этого счёта оплачиваются тарифы, продление и дополнительные устройства.",
        }),
    ]));

    panel.append(topupCard(methods));
    panel.append(transactionsCard());
}

function topupCard(methods) {
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

    const amount = el("input", { type: "number", min: "1", step: "1", value: "300" });
    const method = el("select");
    for (const item of methods) method.append(el("option", { value: item.id }, item.name));

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
                const chosen = methods.find((m) => m.id === method.value);
                const kopeks = Math.round(rublesAmount * 100);
                if (chosen?.min && kopeks < chosen.min) {
                    note.className = "small danger";
                    note.textContent = `Минимальная сумма для этого способа — ${rubles(chosen.min)}.`;
                    return;
                }

                // вкладку открываем заранее: ссылка придёт после запроса, а
                // окно, открытое позже, браузер посчитает всплывающим
                const tab = window.open("", "_blank");
                await busy(event.currentTarget, async () => {
                    try {
                        const payment = await api.topup(kopeks, method.value);
                        if (payment.payment_url) {
                            if (tab) tab.location = payment.payment_url;
                            else window.open(payment.payment_url, "_blank");
                            note.className = "small muted";
                            note.textContent = "Счёт открыт в новой вкладке. После оплаты вернитесь сюда.";
                            clear(pending).append(pendingBlock(method.value, payment.payment_id));
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
                await busy(event.currentTarget, async () => {
                    try {
                        const result = await api.activatePromo(code);
                        const ok = result.success ?? true;
                        promoNote.className = ok ? "small ok" : "small danger";
                        promoNote.textContent = [result.message, result.bonus_description]
                            .filter(Boolean).join(" ") || (ok ? "Промокод активирован!" : "Не удалось активировать промокод.");
                        if (ok) await Promise.all([loadBalance(), renderSubscription()]);
                    } catch (error) {
                        promoNote.className = "small danger";
                        promoNote.textContent = error.message;
                    }
                });
            },
        }, "Активировать"),
        promoNote,
    ]));

    // рефералка
    const referralCard = el("div", { class: "card" }, [el("h3", { text: "Приглашайте друзей" })]);
    panel.append(referralCard);
    try {
        const referral = await api.referral();
        const link = referral.bot_referral_link || referral.referral_link;
        referralCard.append(
            el("p", {
                class: "small muted",
                text: referral.commission_percent
                    ? `Вы получаете ${referral.commission_percent}% с платежей приглашённых.`
                    : "Друг подключается по вашей ссылке — вы получаете вознаграждение.",
            }),
            link ? el("p", { class: "mono", text: link }) : null,
            link ? el("button", {
                class: "btn-sm",
                onclick: (event) => copy(link, event.currentTarget),
            }, "Скопировать ссылку") : null,
            el("div", { class: "kv", style: "margin-top:12px" }, [
                el("span", { class: "k", text: "Приглашено" }),
                el("span", { text: String(referral.total_referrals ?? 0) }),
            ]),
            el("div", { class: "kv" }, [
                el("span", { class: "k", text: "Заработано" }),
                el("span", { text: rubles(referral.total_earnings_kopeks ?? 0) }),
            ])
        );
    } catch {
        referralCard.append(el("p", { class: "small muted", text: "Реферальная программа недоступна." }));
    }

    // аккаунт
    const user = session.user;
    panel.append(el("div", { class: "card" }, [
        el("h3", { text: "Аккаунт" }),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Почта" }),
            el("span", { text: user?.email || "—" }),
        ]),
        el("div", { class: "kv" }, [
            el("span", { class: "k", text: "Telegram" }),
            el("span", { text: user?.username ? `@${user.username}` : (user?.telegram_id ? String(user.telegram_id) : "—") }),
        ]),
        el("div", { class: "row wrap-row", style: "margin-top:14px" }, [
            el("a", { class: "btn btn-sm", href: "/" }, "Скачать приложения"),
            el("a", {
                class: "btn btn-sm",
                href: "https://t.me/skzfeee",
                target: "_blank",
                rel: "noopener",
            }, "Поддержка"),
            el("button", {
                class: "btn-sm",
                onclick: () => $("#logoutButton").click(),
            }, "Выйти"),
        ]),
    ]));
}

// ================= старт =================

if (session.loggedIn) {
    enterCabinet();
    // имя и почта могли измениться в боте
    api.me().then((user) => (session.user = user)).catch(() => { });
} else {
    showAuth();
}
