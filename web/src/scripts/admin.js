// Панель админа на сайте: сводка, обращения, люди, выводы, платежи, рассылки.
// Те же запросы, что в приложении, — и права те же: раздел виден, только
// если роль его позволяет.

import { api } from "./api.js";
import { $, $$, el, clear, rubles, dateText, busy, copy } from "./ui.js";

let perms = null;
let section = null;

const allows = (p) => {
    const list = perms?.permissions || [];
    if (list.includes("*:*") || list.includes(p)) return true;
    return list.includes(`${p.split(":")[0]}:*`);
};

const SECTIONS = [
    ["summary", "Сводка", "stats:read"],
    ["tickets", "Обращения", "tickets:read"],
    ["people", "Люди", "users:read"],
    ["withdrawals", "Выводы", "withdrawals:read"],
    ["payments", "Платежи", "payments:read"],
    ["broadcasts", "Рассылки", "broadcasts:read"],
];

/** Показать вкладку «Панель», если человек — админ. */
export async function checkAdmin() {
    try {
        const r = await api.isAdmin();
        if (!r.is_admin) return;
        perms = await api.permissions();
        $("#adminTab")?.classList.remove("hidden");
    } catch {
        // не админ или не ответило — вкладки нет
    }
}

export async function renderAdmin() {
    const panel = $("#panelAdmin");
    if (!perms) {
        try {
            perms = await api.permissions();
        } catch (error) {
            clear(panel).append(el("div", { class: "card" }, [el("p", { class: "danger", text: error.message })]));
            return;
        }
    }
    const available = SECTIONS.filter(([, , p]) => allows(p));
    if (!available.length) {
        clear(panel).append(el("div", { class: "card" }, [el("p", { class: "muted", text: "Ваша роль не даёт доступа ни к одному разделу." })]));
        return;
    }
    if (!available.some(([key]) => key === section)) section = available[0][0];
    clear(panel);
    const bar = el("div", { class: "periods", style: "margin-bottom:14px" });
    for (const [key, title] of available) {
        bar.append(el("button", {
            class: "btn-sm",
            "aria-selected": String(key === section),
            onclick: () => { section = key; renderAdmin(); },
        }, title));
    }
    const body = el("div");
    panel.append(bar, body);
    ({ summary, tickets, people, withdrawals, payments, broadcasts })[section](body);
}

const note = () => el("p", { class: "small" });
const say = (node, text, cls = "small muted") => { node.className = cls; node.textContent = text || ""; };
const card = (title, ...children) => el("div", { class: "card" }, [title ? el("h3", { text: title }) : null, ...children]);
const kv = (k, v) => el("div", { class: "kv" }, [el("span", { class: "k", text: k }), el("span", { text: String(v) })]);
const fail = (body, error) => clear(body).append(card(null, el("p", { class: "danger", text: error.message })));

// ---------------- сводка ----------------

async function summary(body) {
    body.append(card(null, el("span", { class: "spinner" })));
    try {
        const d = await api.adminDashboard();
        const s = d.subscriptions || {};
        const f = d.financial || {};
        const n = d.nodes || {};
        clear(body).append(el("div", { class: "grid cols-2" }, [
            card("Подписки", kv("Активных", s.active ?? 0), kv("Платных", s.paid ?? 0), kv("Пробных", s.trial ?? 0), kv("Истекших", s.expired ?? 0),
                kv("Куплено сегодня", s.purchased_today ?? 0), kv("За неделю", s.purchased_week ?? 0)),
            card("Деньги", kv("Сегодня", rubles(f.income_today_kopeks)), kv("За месяц", rubles(f.income_month_kopeks)), kv("Всего", rubles(f.income_total_kopeks))),
            card("Серверы", kv("Онлайн", `${n.online ?? 0} из ${n.total ?? 0}`), kv("Пользователей онлайн", n.total_users_online ?? 0),
                ...(n.nodes || []).filter((x) => !x.is_connected && !x.is_disabled).map((x) => el("p", { class: "small danger", text: `● ${x.name} не отвечает` }))),
        ]));
    } catch (error) {
        fail(body, error);
    }
}

// ---------------- обращения ----------------

let ticketFilter = "";

async function tickets(body) {
    const filters = el("div", { class: "periods", style: "margin-bottom:12px" });
    for (const [value, title] of [["", "Все"], ["open", "Открытые"], ["answered", "Отвеченные"], ["closed", "Закрытые"]]) {
        filters.append(el("button", { class: "btn-sm", "aria-selected": String(value === ticketFilter), onclick: () => { ticketFilter = value; renderAdmin(); } }, title));
    }
    const list = card(null, el("span", { class: "spinner" }));
    body.append(filters, list);
    try {
        const data = await api.adminTickets(ticketFilter || undefined);
        clear(list);
        const items = data.items || [];
        if (!items.length) list.append(el("p", { class: "small muted", text: "Обращений нет." }));
        for (const t of items) {
            const last = t.last_message;
            const waiting = t.status !== "closed" && last && !last.is_from_admin;
            list.append(el("div", { class: "list-item", style: "cursor:pointer", onclick: () => openTicket(body, t.id) }, [
                el("div", { class: "grow" }, [
                    el("div", { class: "title", text: `#${t.id} · ${t.title}` }),
                    el("div", { class: "tiny muted", text: [userName(t.user), ticketStatus(t.status), dateText(t.updated_at)].filter(Boolean).join(" · ") }),
                ]),
                waiting ? el("span", { class: "chip gold", text: "ждёт ответа" }) : null,
            ]));
        }
    } catch (error) {
        fail(list, error);
    }
}

const ticketStatus = (s) => ({ open: "открыто", answered: "отвечено", closed: "закрыто", pending: "ждёт" }[s] || s);
const userName = (u) => !u ? "" : (u.first_name || (u.username ? `@${u.username}` : (u.email || `ID ${u.telegram_id || u.id}`)));

async function openTicket(body, id) {
    clear(body).append(card(null, el("span", { class: "spinner" })));
    let t;
    try {
        t = await api.adminTicket(id);
    } catch (error) {
        fail(body, error);
        return;
    }
    clear(body);
    const head = card(`#${t.id} · ${t.title}`,
        el("p", { class: "small muted", text: [userName(t.user), ticketStatus(t.status)].filter(Boolean).join(" · ") }),
        el("div", { class: "row wrap-row" }, [
            el("button", { class: "btn-sm", onclick: () => renderAdmin() }, "← К списку"),
            t.user && allows("users:read") ? el("button", { class: "btn-sm", onclick: () => openPerson(body, t.user.id) }, "Карточка клиента") : null,
            allows("tickets:close") ? el("button", {
                class: "btn-sm",
                onclick: async (e) => busy(e.currentTarget, async () => {
                    await api.adminTicketStatus(t.id, t.status === "closed" ? "open" : "closed").catch((err) => alert(err.message));
                    openTicket(body, t.id);
                }),
            }, t.status === "closed" ? "Открыть снова" : "Закрыть") : null,
        ]));
    const chat = card(null);
    for (const m of t.messages || []) {
        chat.append(el("div", { class: "list-item", style: "display:block" }, [
            el("div", { class: m.is_from_admin ? "tiny gold" : "tiny muted", text: `${m.is_from_admin ? "Поддержка" : "Клиент"} · ${dateText(m.created_at)}` }),
            el("div", { class: "small", style: "white-space:pre-wrap", text: m.message_text || (m.has_media ? "[вложение]" : "") }),
        ]));
    }
    body.append(head, chat);
    if (allows("tickets:reply") && t.status !== "closed") {
        const text = el("textarea", { rows: "4", placeholder: "Ответ клиенту" });
        const msg = note();
        body.append(card("Ответить", text, el("button", {
            class: "primary",
            onclick: async (e) => {
                if (!text.value.trim()) return;
                await busy(e.currentTarget, async () => {
                    try {
                        await api.adminReply(t.id, text.value.trim());
                        openTicket(body, t.id);
                    } catch (error) {
                        say(msg, error.message, "small danger");
                    }
                });
            },
        }, "Отправить"), msg));
    }
}

// ---------------- люди ----------------

let peopleQuery = "";

async function people(body) {
    const input = el("input", { type: "search", placeholder: "Имя, @ник, Telegram ID или почта", value: peopleQuery });
    const list = el("div");
    const search = async () => {
        peopleQuery = input.value.trim();
        clear(list).append(card(null, el("span", { class: "spinner" })));
        try {
            const data = await api.adminUsers(peopleQuery || undefined);
            const users = data.users || [];
            const c = card(`Найдено: ${data.total ?? users.length}`);
            for (const u of users) {
                c.append(el("div", { class: "list-item", style: "cursor:pointer", onclick: () => openPerson(body, u.id) }, [
                    el("div", { class: "grow" }, [
                        el("div", { class: "title", text: u.full_name || (u.username ? `@${u.username}` : `ID ${u.telegram_id || u.id}`) }),
                        el("div", { class: "tiny muted", text: [u.tariff_name, u.has_subscription ? `${u.days_remaining} дн.` : "без подписки", rubles(u.balance_kopeks), u.status === "blocked" ? "заблокирован" : null].filter(Boolean).join(" · ") }),
                    ]),
                ]));
            }
            clear(list).append(c);
        } catch (error) {
            fail(list, error);
        }
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && search());
    body.append(card(null, el("div", { class: "row" }, [input, el("button", { class: "btn-sm", onclick: search }, "Найти")])), list);
    search();
}

async function openPerson(body, id) {
    clear(body).append(card(null, el("span", { class: "spinner" })));
    let u;
    try {
        u = await api.adminUser(id);
    } catch (error) {
        fail(body, error);
        return;
    }
    const reload = () => openPerson(body, id);
    clear(body);
    const blocked = u.status === "blocked";
    const msg = note();
    body.append(card(u.full_name || (u.username ? `@${u.username}` : `ID ${u.telegram_id}`),
        el("p", { class: "small muted", text: [u.username && `@${u.username}`, u.telegram_id && `TG ${u.telegram_id}`, u.email].filter(Boolean).join(" · ") }),
        kv("Баланс", rubles(u.balance_kopeks)),
        kv("Потратил всего", rubles(u.total_spent_kopeks)),
        kv("С нами с", dateText(u.created_at)),
        kv("Статус", blocked ? "заблокирован" : "активен"),
        el("div", { class: "row wrap-row", style: "margin-top:12px" }, [
            el("button", { class: "btn-sm", onclick: () => renderAdmin() }, "← Назад"),
            allows("payments:read") && u.telegram_id ? el("button", {
                class: "btn-sm",
                onclick: () => { paymentsQuery = String(u.telegram_id); paymentsPeriod = "all"; section = "payments"; renderAdmin(); },
            }, "Платежи клиента") : null,
            allows("users:block") ? el("button", {
                class: "btn-sm",
                onclick: async (e) => {
                    if (!confirm(blocked ? "Снять блокировку?" : "Заблокировать? Клиент потеряет доступ к VPN.")) return;
                    await busy(e.currentTarget, async () => {
                        try {
                            await (blocked ? api.adminUnblock(id) : api.adminBlock(id));
                            reload();
                        } catch (error) { say(msg, error.message, "small danger"); }
                    });
                },
            }, blocked ? "Разблокировать" : "Заблокировать") : null,
        ]),
        msg,
    ));

    if (allows("users:balance")) {
        const amount = el("input", { type: "number", step: "1", placeholder: "Сумма, ₽ (минус — списать)" });
        const m = note();
        body.append(card("Баланс", amount, el("button", {
            class: "btn-sm",
            style: "margin-top:8px",
            onclick: async (e) => {
                const kopeks = Math.round(Number(amount.value) * 100);
                if (!kopeks) return;
                if (!confirm(`${kopeks > 0 ? "Начислить" : "Списать"} ${rubles(Math.abs(kopeks))}?`)) return;
                await busy(e.currentTarget, async () => {
                    try {
                        await api.adminBalance(id, kopeks, "Правка с сайта");
                        reload();
                    } catch (error) { say(m, error.message, "small danger"); }
                });
            },
        }, "Применить"), m));
    }

    const subs = (u.subscriptions && u.subscriptions.length ? u.subscriptions : (u.subscription ? [u.subscription] : []));
    for (const s of subs) {
        const m = note();
        const act = async (button, payload, done) => busy(button, async () => {
            try {
                await api.adminSubscriptionAction(id, { subscription_id: s.id, ...payload });
                say(m, done, "small ok");
                setTimeout(reload, 800);
            } catch (error) { say(m, error.message, "small danger"); }
        });
        const days = el("input", { type: "number", min: "1", value: "30" });
        const gbInput = el("input", { type: "number", min: "1", value: "50" });
        const devices = el("input", { type: "number", min: "1", value: String(s.device_limit || 1) });
        body.append(card(s.tariff_name || (s.is_trial ? "Пробная подписка" : `Подписка #${s.id}`),
            kv("Статус", s.is_active ? "активна" : (s.status || "—")),
            kv("До", `${dateText(s.end_date)} · ${s.days_remaining ?? 0} дн.`),
            kv("Трафик", s.traffic_limit_gb ? `${Number(s.traffic_used_gb || 0).toFixed(1)} из ${s.traffic_limit_gb} ГБ` : "безлимит"),
            kv("Устройств", s.device_limit),
            allows("users:subscription") ? el("div", { class: "grid cols-2", style: "margin-top:10px" }, [
                el("div", {}, [el("label", { class: "field" }, [el("span", {}, "Дней"), days]),
                    el("div", { class: "row wrap-row" }, [
                        el("button", { class: "btn-sm", onclick: (e) => act(e.currentTarget, { action: "extend", days: Number(days.value) }, "Продлено") }, "Продлить"),
                        el("button", { class: "btn-sm", onclick: (e) => confirm("Сократить срок?") && act(e.currentTarget, { action: "shorten", days: Number(days.value) }, "Сокращено") }, "Сократить"),
                    ])]),
                el("div", {}, [el("label", { class: "field" }, [el("span", {}, "Трафик, ГБ"), gbInput]),
                    el("button", { class: "btn-sm", onclick: (e) => act(e.currentTarget, { action: "add_traffic", traffic_gb: Number(gbInput.value) }, "Трафик добавлен") }, "Добавить трафик")]),
                el("div", {}, [el("label", { class: "field" }, [el("span", {}, "Лимит устройств"), devices]),
                    el("button", { class: "btn-sm", onclick: (e) => act(e.currentTarget, { action: "set_device_limit", device_limit: Number(devices.value) }, "Лимит изменён") }, "Изменить")]),
            ]) : null,
            m,
        ));
    }

    if (allows("users:send_message")) {
        const text = el("textarea", { rows: "3", placeholder: "Сообщение придёт в Telegram от бота" });
        const m = note();
        body.append(card("Написать клиенту", text, el("button", {
            class: "btn-sm",
            style: "margin-top:8px",
            onclick: async (e) => {
                if (!text.value.trim()) return;
                await busy(e.currentTarget, async () => {
                    try {
                        await api.adminSendMessage(id, text.value.trim());
                        text.value = "";
                        say(m, "Отправлено.", "small ok");
                    } catch (error) { say(m, error.message, "small danger"); }
                });
            },
        }, "Отправить"), m));
    }
}

// ---------------- выводы ----------------

let withdrawalFilter = "pending";

async function withdrawals(body) {
    const filters = el("div", { class: "periods", style: "margin-bottom:12px" });
    for (const [value, title] of [["pending", "Ждут"], ["approved", "Одобрены"], ["completed", "Выплачены"], ["rejected", "Отклонены"], ["", "Все"]]) {
        filters.append(el("button", { class: "btn-sm", "aria-selected": String(value === withdrawalFilter), onclick: () => { withdrawalFilter = value; renderAdmin(); } }, title));
    }
    const list = card(null, el("span", { class: "spinner" }));
    body.append(filters, list);
    try {
        const data = await api.adminWithdrawals(withdrawalFilter || undefined);
        clear(list);
        if (data.pending_count) list.append(el("p", { class: "small gold", text: `Ждут решения: ${data.pending_count} на ${rubles(data.pending_total_kopeks)}` }));
        if (!(data.items || []).length) list.append(el("p", { class: "small muted", text: "Заявок нет." }));
        for (const w of data.items || []) list.append(withdrawalItem(w));
    } catch (error) {
        fail(list, error);
    }
}

const riskText = (l) => ({ critical: ["риск критический", "danger"], high: ["риск высокий", "danger"], medium: ["риск средний", "gold"] }[l] || ["риск низкий", "ok"]);

function withdrawalItem(w) {
    const m = note();
    const risk = el("div");
    const [rt, rc] = riskText(w.risk_level);
    const decide = async (button, action) => {
        let comment = null;
        if (action !== "complete") {
            comment = prompt(action === "approve" ? "Комментарий для клиента (необязательно)" : "Причина отказа — её увидит клиент");
            if (comment === null) return;
        } else if (!confirm("Отметить, что деньги переведены?")) return;
        await busy(button, async () => {
            try {
                await api.adminWithdrawalAction(w.id, action, comment);
                renderAdmin();
            } catch (error) { say(m, error.message, "small danger"); }
        });
    };
    return el("div", { class: "list-item", style: "display:block" }, [
        el("div", { class: "row", style: "justify-content:space-between" }, [
            el("strong", { text: rubles(w.amount_kopeks) }),
            el("span", { class: `small ${rc}`, text: rt }),
        ]),
        el("div", { class: "tiny muted", text: [w.first_name || (w.username && `@${w.username}`) || `ID ${w.telegram_id || w.user_id}`, dateText(w.created_at), w.status].join(" · ") }),
        w.payment_details ? el("p", { class: "small mono", style: "margin:6px 0", text: w.payment_details }) : null,
        w.admin_comment ? el("p", { class: "tiny muted", text: `Комментарий: ${w.admin_comment}` }) : null,
        risk,
        el("div", { class: "row wrap-row" }, [
            w.payment_details ? el("button", { class: "btn-sm", onclick: (e) => copy(w.payment_details, e.currentTarget) }, "Скопировать реквизиты") : null,
            el("button", {
                class: "btn-sm",
                onclick: async (e) => busy(e.currentTarget, async () => {
                    try {
                        const d = await api.adminWithdrawal(w.id);
                        const a = d.risk_analysis || {};
                        clear(risk).append(...[
                            el("p", { class: "tiny", text: `Рефералов ${d.total_referrals} · заработал ${rubles(d.total_earnings_kopeks)} · баланс ${rubles(d.balance_kopeks)}` }),
                            ...(a.flags || []).map((f) => el("p", { class: "tiny", style: "margin:0", text: f })),
                            a.recommendation_text ? el("p", { class: "tiny gold", text: a.recommendation_text }) : null].filter(Boolean));
                    } catch (error) { say(m, error.message, "small danger"); }
                }),
            }, "Риски"),
            w.status === "pending" && allows("withdrawals:approve") ? el("button", { class: "btn-sm primary", onclick: (e) => decide(e.currentTarget, "approve") }, "Одобрить") : null,
            w.status === "pending" && allows("withdrawals:reject") ? el("button", { class: "btn-sm", onclick: (e) => decide(e.currentTarget, "reject") }, "Отклонить") : null,
            w.status === "approved" && allows("withdrawals:approve") ? el("button", { class: "btn-sm primary", onclick: (e) => decide(e.currentTarget, "complete") }, "Выплачено") : null,
        ]),
        m,
    ]);
}

// ---------------- платежи ----------------

let paymentsQuery = "";
let paymentsStatus = "all";
let paymentsPeriod = "7d";

async function payments(body) {
    const input = el("input", { type: "search", placeholder: "Счёт, @ник, Telegram ID или почта", value: paymentsQuery });
    const status = el("div", { class: "periods" });
    for (const [v, t] of [["all", "Все"], ["pending", "Ждут"], ["paid", "Оплачены"], ["cancelled", "Отменены"]]) {
        status.append(el("button", { class: "btn-sm", "aria-selected": String(v === paymentsStatus), onclick: () => { paymentsQuery = input.value.trim(); paymentsStatus = v; renderAdmin(); } }, t));
    }
    const period = el("div", { class: "periods", style: "margin-top:8px" });
    for (const [v, t] of [["24h", "Сутки"], ["7d", "Неделя"], ["30d", "Месяц"], ["all", "Всё время"]]) {
        period.append(el("button", { class: "btn-sm", "aria-selected": String(v === paymentsPeriod), onclick: () => { paymentsQuery = input.value.trim(); paymentsPeriod = v; renderAdmin(); } }, t));
    }
    const list = card(null, el("span", { class: "spinner" }));
    const go = () => { paymentsQuery = input.value.trim(); renderAdmin(); };
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
    body.append(card(null, el("div", { class: "row" }, [input, el("button", { class: "btn-sm", onclick: go }, "Найти")]), el("div", { style: "margin-top:10px" }, [status, period])), list);
    try {
        const data = await api.adminPayments(paymentsQuery || undefined, paymentsStatus, paymentsPeriod);
        clear(list);
        const items = data.items || [];
        if (!items.length) list.append(el("p", { class: "small muted", text: "Платежей не найдено." }));
        if (data.total > items.length) list.append(el("p", { class: "tiny muted", text: `Показаны ${items.length} из ${data.total} — уточните поиск` }));
        for (const p of items) {
            const m = note();
            list.append(el("div", { class: "list-item", style: "display:block" }, [
                el("div", { class: "row", style: "justify-content:space-between" }, [
                    el("strong", { text: rubles(p.amount_kopeks) }),
                    el("span", { class: p.is_paid ? "small ok" : "small gold", text: `${p.status_emoji || ""} ${p.status_text || p.status}`.trim() }),
                ]),
                el("div", { class: "tiny muted", text: [p.method_display || p.method, dateText(p.created_at), p.user_username && `@${p.user_username}`, p.user_telegram_id && `ID ${p.user_telegram_id}`].filter(Boolean).join(" · ") }),
                p.identifier ? el("div", { class: "tiny muted mono", text: p.identifier }) : null,
                p.is_checkable && !p.is_paid && allows("payments:edit") ? el("button", {
                    class: "btn-sm",
                    style: "margin-top:6px",
                    onclick: async (e) => busy(e.currentTarget, async () => {
                        try {
                            const r = await api.adminCheckPayment(p.method, p.id);
                            say(m, r.message || "Проверено", r.status_changed ? "small ok" : "small muted");
                        } catch (error) { say(m, error.message, "small danger"); }
                    }),
                }, "Проверить у кассы") : null,
                m,
            ]));
        }
    } catch (error) {
        fail(list, error);
    }
}

// ---------------- рассылки ----------------

async function broadcasts(body) {
    const holder = card(null, el("span", { class: "spinner" }));
    body.append(holder);
    let filters, emailFilters, buttons, history;
    try {
        [filters, emailFilters, buttons, history] = await Promise.all([
            api.adminBroadcastFilters(),
            api.adminEmailFilters().catch(() => null),
            api.adminBroadcastButtons().catch(() => ({ buttons: [] })),
            api.adminBroadcasts(),
        ]);
    } catch (error) {
        fail(holder, error);
        return;
    }
    clear(body);
    if (allows("broadcasts:create")) body.append(broadcastForm(filters, emailFilters, buttons.buttons || []));
    const list = card("История");
    for (const b of history.items || []) list.append(broadcastItem(b));
    if (!(history.items || []).length) list.append(el("p", { class: "small muted", text: "Рассылок ещё не было." }));
    body.append(list);
    if ((history.items || []).some((b) => ["queued", "in_progress", "cancelling"].includes(b.status))) {
        setTimeout(() => section === "broadcasts" && !$("#panelAdmin").classList.contains("hidden") && renderAdmin(), 5000);
    }
}

function broadcastForm(filters, emailFilters, buttons) {
    const all = [...(filters.filters || []), ...(filters.tariff_filters || []), ...(filters.custom_filters || [])];
    const channel = el("select");
    for (const [v, t] of [["telegram", "Telegram"], ["email", "Почта"], ["both", "Telegram и почта"]]) channel.append(el("option", { value: v }, t));
    if (!emailFilters) channel.querySelectorAll("option").forEach((o) => o.value !== "telegram" && o.remove());
    const target = el("select");
    const fillTargets = () => {
        clear(target);
        const list = channel.value === "email" ? (emailFilters?.filters || []) : all;
        for (const f of list) target.append(el("option", { value: f.key }, `${f.label}${f.count != null ? ` · ${f.count}` : ""}`));
    };
    channel.addEventListener("change", () => { fillTargets(); draw(); });
    fillTargets();

    const text = el("textarea", { rows: "5", maxlength: "4000", placeholder: "Текст сообщения. Можно HTML: <b>, <i>, <a href>" });
    const chosen = new Set(buttons.filter((b) => b.default).map((b) => b.key));
    const btnRow = el("div", { class: "periods" });
    for (const b of buttons) {
        btnRow.append(el("button", {
            class: "btn-sm",
            "aria-selected": String(chosen.has(b.key)),
            onclick: (e) => {
                chosen.has(b.key) ? chosen.delete(b.key) : chosen.add(b.key);
                e.currentTarget.setAttribute("aria-selected", String(chosen.has(b.key)));
            },
        }, b.label));
    }
    const subject = el("input", { type: "text", maxlength: "255", placeholder: "Тема письма" });
    const html = el("textarea", { rows: "8", placeholder: "HTML письма. {{user_name}} и {{email}} подставятся сами." });
    // предпросмотр письма — в песочнице, без скриптов
    const preview = el("iframe", { sandbox: "", style: "width:100%;height:320px;border:1px solid var(--outline);border-radius:12px;background:#fff;margin-top:8px" });
    html.addEventListener("input", () => (preview.srcdoc = html.value.replace(/\{\{user_name\}\}/g, "Иван").replace(/\{\{email\}\}/g, "ivan@example.com")));

    const tgBox = el("div", {}, [
        el("label", { class: "field" }, [el("span", {}, "Текст в Telegram"), text]),
        buttons.length ? el("p", { class: "section-title", text: "Кнопки под сообщением" }) : null,
        btnRow,
    ]);
    const emailBox = el("div", {}, [
        el("label", { class: "field" }, [el("span", {}, "Тема письма"), subject]),
        el("label", { class: "field" }, [el("span", {}, "HTML письма"), html]),
        el("p", { class: "section-title", text: "Предпросмотр" }),
        preview,
    ]);
    const msg = note();
    const draw = () => {
        tgBox.classList.toggle("hidden", channel.value === "email");
        emailBox.classList.toggle("hidden", channel.value === "telegram");
    };
    draw();

    return card("Новая рассылка",
        el("div", { class: "grid cols-2" }, [
            el("label", { class: "field" }, [el("span", {}, "Куда"), channel]),
            el("label", { class: "field" }, [el("span", {}, "Кому"), target]),
        ]),
        tgBox, emailBox,
        el("button", {
            class: "primary",
            style: "margin-top:12px",
            onclick: async (e) => {
                const isTg = channel.value !== "email";
                const isMail = channel.value !== "telegram";
                if (isTg && !text.value.trim()) return say(msg, "Напишите текст.", "small danger");
                if (isMail && (!subject.value.trim() || !html.value.trim())) return say(msg, "Нужны тема и HTML письма.", "small danger");
                if (!confirm(`Отправить рассылку: ${target.selectedOptions[0]?.textContent}?`)) return;
                await busy(e.currentTarget, async () => {
                    try {
                        await api.adminSendBroadcast({
                            channel: channel.value,
                            target: target.value,
                            message_text: isTg ? text.value.trim() : null,
                            selected_buttons: [...chosen],
                            email_subject: isMail ? subject.value.trim() : null,
                            email_html_content: isMail ? html.value.trim() : null,
                        });
                        say(msg, "Рассылка запущена.", "small ok");
                        setTimeout(renderAdmin, 800);
                    } catch (error) { say(msg, error.message, "small danger"); }
                });
            },
        }, "Отправить"),
        msg,
    );
}

const broadcastStatus = (s) => ({ queued: "в очереди", in_progress: "идёт", completed: "завершена", partial: "частично", failed: "ошибка", cancelled: "остановлена", cancelling: "останавливается" }[s] || s);

function broadcastItem(b) {
    const running = ["queued", "in_progress"].includes(b.status);
    return el("div", { class: "list-item", style: "display:block" }, [
        el("div", { class: "row", style: "justify-content:space-between" }, [
            el("span", { class: "small", text: [b.target_type, b.channel !== "telegram" ? b.channel : null, dateText(b.created_at)].filter(Boolean).join(" · ") }),
            el("span", { class: running ? "small gold" : (b.status === "completed" ? "small ok" : "small danger"), text: broadcastStatus(b.status) }),
        ]),
        b.message_text || b.email_subject ? el("p", { class: "tiny muted", style: "margin:4px 0", text: (b.email_subject || b.message_text).slice(0, 160) }) : null,
        running && b.total_count ? el("div", { class: "bar" }, [el("i", { style: `width:${Math.round(b.progress_percent || 0)}%` })]) : null,
        el("p", { class: "tiny muted", style: "margin:4px 0", text: `Доставлено ${b.sent_count} из ${b.total_count}${b.blocked_count ? ` · заблокировали бота ${b.blocked_count}` : ""}${b.failed_count ? ` · ошибок ${b.failed_count}` : ""}` }),
        running && allows("broadcasts:send") ? el("button", {
            class: "btn-sm",
            onclick: async (e) => busy(e.currentTarget, async () => {
                await api.adminStopBroadcast(b.id).catch((err) => alert(err.message));
                renderAdmin();
            }),
        }, "Остановить") : null,
    ]);
}

export { $$ };
