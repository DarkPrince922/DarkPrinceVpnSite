// Вкладка «Бонусы»: скидки и уровни, подарки, приглашения с выводом денег.

import { api, ApiError } from "./api.js";
import { $, el, clear, rubles, dateText, busy, copy, plural, openTab } from "./ui.js";

const say = (node, text, cls = "small muted") => {
    node.className = cls;
    node.textContent = text || "";
};

let loaded = false;

export async function renderBonus(force = false) {
    const panel = $("#panelBonus");
    if (loaded && !force) return;
    loaded = true;
    clear(panel);
    // у каждого раздела своя обёртка, и отступ «карточка + карточка» между
    // ними не срабатывал — карточки соседних разделов слипались
    for (const part of [promoSection(), giftSection(), referralSection()]) {
        part.classList.add("bonus-part");
        panel.append(part);
    }
}

/** Перечитать вкладку при следующем открытии (после покупок и событий). */
export function invalidateBonus() {
    loaded = false;
}

// ================= скидки и уровни =================

function promoSection() {
    const wrap = el("div");
    load();
    return wrap;

    async function load() {
        const [offers, discount, group, loyalty] = await Promise.all([
            api.promoOffers().catch(() => []),
            api.activeDiscount().catch(() => null),
            api.groupDiscounts().catch(() => null),
            api.loyaltyTiers().catch(() => null),
        ]);
        clear(wrap);
        const open = (Array.isArray(offers) ? offers : []).filter((o) => o.is_active && !o.is_claimed);

        if (discount?.is_active && discount.discount_percent > 0) {
            wrap.append(el("div", { class: "card" }, [
                el("h3", { text: `Действует скидка ${discount.discount_percent}%` }),
                el("p", {
                    class: "small muted",
                    text: (discount.expires_at ? `До ${dateText(discount.expires_at)}. ` : "") +
                        "Цены во вкладке «Тарифы» уже с ней — скидка сработает на одну покупку.",
                }),
            ]));
        }

        if (open.length) {
            const card = el("div", { class: "card" }, [el("h3", { text: "Для вас" })]);
            for (const offer of open) {
                const msg = el("p", { class: "small" });
                card.append(el("div", { class: "list-item" }, [
                    el("div", { class: "grow" }, [
                        el("div", { class: "title", text: offerTitle(offer) }),
                        offer.expires_at ? el("div", { class: "tiny gold", text: `Забрать до ${dateText(offer.expires_at)}` }) : null,
                        msg,
                    ]),
                    el("button", {
                        class: "btn-sm primary",
                        onclick: async (event) => {
                            await busy(event.currentTarget, async () => {
                                try {
                                    const result = await api.claimOffer(offer.id);
                                    say(msg, result.discount_percent
                                        ? `Скидка ${result.discount_percent}% активирована — она уже в ценах тарифов.`
                                        : "Готово: доступ к дополнительным серверам открыт.", "small ok");
                                    setTimeout(load, 1500);
                                } catch (error) {
                                    say(msg, claimError(error), "small danger");
                                }
                            });
                        },
                    }, "Забрать"),
                ]));
            }
            wrap.append(card);
        }

        const tiers = loyalty?.tiers || [];
        if (tiers.length) {
            const spent = Number(loyalty.current_spent_rubles || 0);
            const card = el("div", { class: "card" }, [
                el("h3", { text: "Уровни" }),
                el("p", { class: "small", text: `Вы потратили ${rubles(Math.round(spent * 100))}.` }),
            ]);
            if (loyalty.next_tier_name && loyalty.next_tier_threshold_rubles) {
                const left = Math.max(0, Math.round((loyalty.next_tier_threshold_rubles - spent) * 100));
                card.append(
                    el("div", { class: "bar" }, [el("i", { style: `width:${Math.min(100, Math.round(loyalty.progress_percent || 0))}%` })]),
                    el("p", { class: "small muted", text: `До уровня «${loyalty.next_tier_name}» — ${rubles(left)}` }),
                );
            } else {
                card.append(el("p", { class: "small ok", text: "У вас максимальный уровень." }));
            }
            for (const tier of tiers) {
                card.append(el("div", { class: "kv" }, [
                    el("span", { class: tier.is_current ? "gold" : (tier.is_achieved ? "ok" : "k") },
                        tier.name + (tier.is_current ? " · ваш уровень" : "")),
                    el("span", { class: "small muted", text: `от ${rubles(Math.round(tier.threshold_rubles * 100))} · ${discountsText(tier)}` }),
                ]));
            }
            wrap.append(card);
        } else if (group?.group_name && hasDiscounts(group)) {
            wrap.append(el("div", { class: "card" }, [
                el("h3", { text: `Ваша группа: ${group.group_name}` }),
                el("p", { class: "small muted", text: discountsText(group) }),
            ]));
        }
    }
}

function offerTitle(offer) {
    if (String(offer.effect_type).toLowerCase() === "test_access") return "Пробный доступ к дополнительным серверам";
    if (offer.discount_percent) return `Скидка ${offer.discount_percent}% на подписку`;
    return "Специальное предложение";
}

function claimError(error) {
    const text = String(error.message || "");
    if (text.includes("already been claimed")) return "Это предложение уже активировано.";
    if (text.includes("expired")) return "Срок предложения вышел.";
    if (text.includes("Active subscription required")) return "Нужна действующая подписка.";
    return text;
}

const hasDiscounts = (g) =>
    (g.server_discount_percent || 0) > 0 || (g.traffic_discount_percent || 0) > 0 ||
    (g.device_discount_percent || 0) > 0 || Object.values(g.period_discounts || {}).some((v) => v > 0);

function discountsText(g) {
    const parts = [];
    if (g.server_discount_percent > 0) parts.push(`−${g.server_discount_percent}% на подписку`);
    Object.entries(g.period_discounts || {})
        .map(([days, pct]) => [Number(days), pct])
        .filter(([days, pct]) => days > 0 && pct > 0)
        .sort((a, b) => a[0] - b[0])
        .forEach(([days, pct]) => parts.push(`−${pct}% от ${days} дн.`));
    if (g.traffic_discount_percent > 0) parts.push(`−${g.traffic_discount_percent}% на трафик`);
    if (g.device_discount_percent > 0) parts.push(`−${g.device_discount_percent}% на устройства`);
    return parts.join(", ") || "без скидок";
}

// ================= подарки =================

const GIFT_ERRORS = [
    ["Insufficient balance", "На балансе не хватает денег — выберите оплату картой или СБП."],
    ["Invalid email", "Проверьте почту получателя."],
    ["Invalid Telegram", "Проверьте ник в Telegram: латиница, цифры и _, от 5 символов."],
    ["Cannot gift to yourself", "Себе подарок не отправить."],
    ["Cannot activate your own gift", "Свой подарок активировать нельзя — отправьте код другу."],
    ["Code too short", "Код слишком короткий. Скопируйте его целиком."],
    ["Gift not found", "Подарок не найден. Проверьте код."],
    ["cannot be activated", "Этот подарок уже активирован или срок его действия вышел."],
    ["Payment provider", "Касса не ответила. Попробуйте позже или другим способом."],
    ["not enabled", "Подарки отключены в боте."],
];
const giftError = (error) =>
    GIFT_ERRORS.find(([m]) => String(error.message).includes(m))?.[1] || error.message;

const giftCode = (token) => `GIFT-${token}`;
const giftShareText = (code, title) =>
    `Дарю тебе VPN${title ? ` «${title}»` : ""}!\nКод подарка: ${code}\n` +
    "Введи его в приложении DarkPrince VPN (Ещё → Подарки) или в личном кабинете на dprince.online.";

const giftStatus = (s) => ({
    delivered: "активирован", paid: "ждёт активации", pending_activation: "ждёт активации",
    pending: "ждёт оплаты", failed: "оплата не прошла", expired: "истёк",
}[s] || s);

function giftSection() {
    const wrap = el("div");
    wrap.append(activateCard());
    load();
    return wrap;

    async function load() {
        const [config, sent, received] = await Promise.all([
            api.giftConfig().catch(() => null),
            api.giftsSent().catch(() => []),
            api.giftsReceived().catch(() => []),
        ]);
        if (config?.is_enabled && config.tariffs?.length) wrap.append(buyCard(config));
        if (sent?.length) wrap.append(listCard("Я подарил", sent, true));
        if (received?.length) wrap.append(listCard("Мне подарили", received, false));
    }
}

function activateCard() {
    const input = el("input", { type: "text", placeholder: "GIFT-…", autocomplete: "off" });
    const msg = el("p", { class: "small" });
    return el("div", { class: "card" }, [
        el("h3", { text: "Мне подарили код" }),
        el("label", { class: "field" }, [el("span", {}, "Код подарка"), input]),
        el("button", {
            class: "primary",
            onclick: async (event) => {
                const code = input.value.trim();
                if (code.length < 8) return say(msg, "Введите код целиком.", "small danger");
                await busy(event.currentTarget, async () => {
                    try {
                        const r = await api.giftActivate(code);
                        say(msg, `Подарок активирован${r.tariff_name ? `: ${r.tariff_name}` : ""}${r.period_days ? ` · ${r.period_days} дн.` : ""}. Подписка — на вкладке «Подписка».`, "small ok");
                        input.value = "";
                        window.dispatchEvent(new Event("dp-subscription-changed"));
                    } catch (error) {
                        say(msg, giftError(error), "small danger");
                    }
                });
            },
        }, "Активировать"),
        msg,
    ]);
}

function buyCard(config) {
    const card = el("div", { class: "card" }, [el("h3", { text: "Подарить подписку" })]);
    const tariff = el("select");
    for (const t of config.tariffs) tariff.append(el("option", { value: t.id }, t.name));
    const period = el("select");
    const payment = el("select");
    const recipient = el("input", { type: "text", placeholder: "@ник в Telegram или почта (необязательно)" });
    const wish = el("textarea", { rows: "2", maxlength: "300", placeholder: "Пожелание (необязательно)" });
    const msg = el("p", { class: "small" });
    const result = el("div");

    const methods = [{ value: "balance", label: `С баланса` }];
    for (const m of config.payment_methods || []) {
        const opts = m.sub_options || [];
        if (!opts.length) methods.push({ value: m.method_id, label: m.display_name });
        // так кабинет склеивает способ и вариант: platega_2
        for (const o of opts) methods.push({ value: `${m.method_id}_${o.id}`, label: o.name });
    }
    for (const m of methods) payment.append(el("option", { value: m.value }, m.label));

    const fillPeriods = () => {
        const t = config.tariffs.find((x) => String(x.id) === tariff.value);
        clear(period);
        for (const p of t?.periods || []) {
            period.append(el("option", { value: p.days },
                `${p.days} дн. — ${rubles(p.price_kopeks)}${p.discount_percent ? ` (−${p.discount_percent}%)` : ""}`));
        }
    };
    tariff.addEventListener("change", fillPeriods);
    fillPeriods();

    card.append(
        el("label", { class: "field" }, [el("span", {}, "Тариф"), tariff]),
        el("label", { class: "field" }, [el("span", {}, "Срок"), period]),
        el("label", { class: "field" }, [el("span", {}, "Кому"), recipient]),
        el("label", { class: "field" }, [el("span", {}, "Пожелание"), wish]),
        el("label", { class: "field" }, [el("span", {}, `Оплата · на балансе ${rubles(config.balance_kopeks)}`), payment]),
        el("button", { class: "primary", onclick: (e) => buy(e.currentTarget) }, "Подарить"),
        msg,
        result,
    );
    return card;

    async function buy(button) {
        const to = recipient.value.trim();
        const type = !to ? null : (to.slice(1).includes("@") ? "email" : "telegram");
        const gateway = payment.value !== "balance";
        const tab = gateway ? window.open("", "_blank") : null;
        await busy(button, async () => {
            try {
                const r = await api.giftPurchase({
                    tariff_id: Number(tariff.value),
                    period_days: Number(period.value),
                    recipient_type: type,
                    recipient_value: type === "telegram" ? to.replace(/^@/, "") : (type ? to : null),
                    gift_message: wish.value.trim() || null,
                    payment_mode: gateway ? "gateway" : "balance",
                    payment_method: gateway ? payment.value : null,
                });
                const title = tariff.selectedOptions[0]?.textContent;
                if (r.warning === "telegram_unresolvable") say(msg, "Бот не знает этот ник — отправьте код другу сами.", "small gold");
                if (r.payment_url) {
                    if (tab) tab.location = r.payment_url;
                    else window.open(r.payment_url, "_blank");
                    say(msg, "Оплатите в открывшейся вкладке — код подарка появится здесь.");
                    waitForGift(r.purchase_token, title, result);
                } else {
                    showCode(result, giftCode(r.purchase_token), title);
                    window.dispatchEvent(new Event("dp-balance-changed"));
                }
            } catch (error) {
                tab?.close();
                say(msg, giftError(error), "small danger");
            }
        });
    }
}

function waitForGift(token, title, result) {
    let attempt = 0;
    const tick = async () => {
        attempt += 1;
        try {
            const s = await api.giftStatus(token);
            if (s.is_claimable || s.status === "delivered") {
                showCode(result, giftCode(s.purchase_token || token), title);
                return;
            }
            if (["failed", "expired"].includes(s.status)) {
                clear(result).append(el("p", { class: "small danger", text: "Оплата подарка не прошла." }));
                return;
            }
        } catch {
            // ещё не дошло
        }
        if (attempt < 60) setTimeout(tick, attempt < 12 ? 5000 : 15000);
    };
    setTimeout(tick, 5000);
}

function showCode(box, code, title) {
    const text = giftShareText(code, title);
    clear(box).append(el("div", { class: "msg info", style: "margin-top:12px" }, [
        el("strong", { text: "🎁 Подарок готов" }),
        el("p", { class: "mono", style: "margin:8px 0", text: code }),
        el("div", { class: "row wrap-row" }, [
            el("button", { class: "btn-sm", onclick: (e) => copy(code, e.currentTarget) }, "Скопировать код"),
            el("button", { class: "btn-sm", onclick: (e) => copy(text, e.currentTarget) }, "Скопировать сообщение для друга"),
        ]),
        el("p", { class: "tiny muted", style: "margin-top:8px", text: "Активировать код может любой, у кого он окажется, — делитесь лично." }),
    ]));
}

function listCard(title, items, sent) {
    const card = el("div", { class: "card" }, [el("h3", { text: title })]);
    for (const g of items) {
        const claimable = sent && ["paid", "pending_activation"].includes(g.status);
        card.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [
                el("div", { class: "title", text: [g.tariff_name, `${g.period_days} дн.`].filter(Boolean).join(" · ") }),
                el("div", {
                    class: "tiny muted",
                    text: [giftStatus(g.status), g.activated_by_username && `активировал ${g.activated_by_username}`,
                        g.gift_recipient_value && `для ${g.gift_recipient_value}`, g.sender_display && `от ${g.sender_display}`,
                        dateText(g.created_at)].filter(Boolean).join(" · "),
                }),
            ]),
            claimable ? el("button", {
                class: "btn-sm",
                onclick: (e) => copy(giftShareText(giftCode(g.token), g.tariff_name), e.currentTarget),
            }, "Скопировать код") : null,
        ]));
    }
    return card;
}

// ================= приглашения =================

function referralSection() {
    const wrap = el("div");
    load();
    return wrap;

    async function load() {
        let info;
        try {
            info = await api.referral();
        } catch {
            wrap.append(el("div", { class: "card" }, [el("p", { class: "small muted", text: "Реферальная программа недоступна." })]));
            return;
        }
        const [terms, list, earnings, wd, history] = await Promise.all([
            api.referralTerms().catch(() => null),
            api.referralList().catch(() => null),
            api.referralEarnings().catch(() => null),
            api.withdrawalBalance().catch(() => null),
            api.withdrawalHistory().catch(() => null),
        ]);
        clear(wrap);
        const link = info.bot_referral_link || info.referral_link;
        const percent = terms?.commission_percent ?? info.commission_percent;
        const rules = [];
        if (terms?.first_payment_commission_percent && terms.first_payment_commission_percent !== percent) {
            rules.push(`${terms.first_payment_commission_percent}% с первого пополнения друга`);
            if (percent) rules.push(`${percent}% со всех следующих`);
        } else if (percent) rules.push(`${percent}% с каждого пополнения друга — на ваш баланс`);
        if (terms?.inviter_bonus_kopeks > 0) rules.push(`${rubles(terms.inviter_bonus_kopeks)} вам, когда друг пополнит впервые`);
        if (terms?.first_topup_bonus_kopeks > 0) rules.push(`${rubles(terms.first_topup_bonus_kopeks)} другу за первое пополнение`);
        if (terms?.minimum_topup_kopeks > 0) rules.push(`Считаются пополнения от ${rubles(terms.minimum_topup_kopeks)}`);

        wrap.append(el("div", { class: "card" }, [
            el("h3", { text: "Приглашайте друзей" }),
            ...rules.map((r) => el("p", { class: "small", style: "margin:0 0 4px", text: `• ${r}` })),
            link ? el("p", { class: "mono", style: "margin-top:10px", text: link }) : null,
            link ? el("div", { class: "row wrap-row" }, [
                el("button", { class: "btn-sm", onclick: (e) => copy(link, e.currentTarget) }, "Скопировать ссылку"),
                el("button", {
                    class: "btn-sm",
                    onclick: (e) => copy(`Попробуй наш VPN — быстрый и надёжный. Подключайся: ${link}`, e.currentTarget),
                }, "Скопировать приглашение"),
            ]) : null,
            info.referral_code ? el("p", { class: "tiny muted", style: "margin-top:8px", text: `Код для регистрации по почте: ${info.referral_code}` }) : null,
            el("div", { class: "kv", style: "margin-top:12px" }, [el("span", { class: "k", text: "Приглашено" }), el("span", { text: String(info.total_referrals ?? 0) })]),
            el("div", { class: "kv" }, [el("span", { class: "k", text: "Платят" }), el("span", { text: String(info.active_referrals ?? 0) })]),
            el("div", { class: "kv" }, [el("span", { class: "k", text: "Заработано" }), el("span", { class: "gold", text: rubles(info.total_earnings_kopeks ?? 0) })]),
        ]));

        if (wd?.is_withdrawal_enabled) wrap.append(withdrawCard(wd, history?.items || [], () => { clear(wrap); load(); }));

        const people = list?.items || [];
        if (people.length) {
            const card = el("div", { class: "card" }, [el("h3", { text: `Приглашённые · ${people.length}` })]);
            for (const p of people) {
                card.append(el("div", { class: "list-item" }, [
                    el("div", { class: "grow" }, [
                        el("div", { class: "title", text: p.first_name || (p.username ? `@${p.username}` : `Друг #${p.id}`) }),
                        el("div", { class: p.has_paid ? "tiny ok" : "tiny muted", text: [`с ${dateText(p.created_at)}`, p.has_paid ? "платит" : (p.has_subscription ? "с подпиской" : "ещё не платил")].join(" · ") }),
                    ]),
                ]));
            }
            wrap.append(card);
        }

        const earned = earnings?.items || [];
        if (earned.length) {
            const card = el("div", { class: "card" }, [el("h3", { text: "Начисления" })]);
            for (const e of earned) {
                card.append(el("div", { class: "list-item" }, [
                    el("div", { class: "grow" }, [
                        el("div", { class: "title", text: earningReason(e.reason) }),
                        el("div", { class: "tiny muted", text: [e.referral_first_name || (e.referral_username && `@${e.referral_username}`), dateText(e.created_at)].filter(Boolean).join(" · ") }),
                    ]),
                    el("div", { class: "ok", text: `+${rubles(e.amount_kopeks)}` }),
                ]));
            }
            wrap.append(card);
        }
    }
}

const earningReason = (r) => ({
    referral_first_topup: "Бонус за первое пополнение",
    referral_commission_topup: "Процент с пополнения",
    referral_commission: "Процент с пополнения",
    referral_registration_pending: "Бонус за регистрацию",
}[r] || "Начисление");

const withdrawalState = (s) => ({
    pending: ["на проверке", "muted"], approved: ["одобрена", "ok"], completed: ["выплачено", "ok"],
    rejected: ["отклонена", "danger"], cancelled: ["отменена", "danger"],
}[s] || [s, "muted"]);

function withdrawCard(wd, history, reload) {
    const msg = el("p", { class: "small" });
    const card = el("div", { class: "card" }, [
        el("h3", { text: "Вывод денег" }),
        el("div", { class: "days", text: rubles(wd.available_total) }),
        el("p", {
            class: "small muted",
            text: [wd.min_amount_kopeks > 0 && `минимум ${rubles(wd.min_amount_kopeks)}`,
                wd.pending > 0 && `в обработке ${rubles(wd.pending)}`,
                wd.withdrawn > 0 && `выведено ${rubles(wd.withdrawn)}`].filter(Boolean).join(" · "),
        }),
    ]);
    if (!wd.can_request) {
        card.append(el("p", { class: "small gold", text: wd.cannot_request_reason || "Сейчас вывести нельзя." }));
    } else {
        const amount = el("input", { type: "number", min: "1", step: "1", value: String(Math.floor(wd.available_total / 100)) });
        const details = el("textarea", { rows: "2", maxlength: "500", placeholder: wd.requisites_text || "Номер карты или телефон для СБП и банк" });
        card.append(
            el("label", { class: "field" }, [el("span", {}, "Сумма, ₽"), amount]),
            el("label", { class: "field" }, [el("span", {}, "Реквизиты"), details]),
            el("button", {
                class: "primary",
                onclick: async (event) => {
                    const kopeks = Math.round(Number(amount.value) * 100);
                    if (!(kopeks > 0)) return say(msg, "Введите сумму.", "small danger");
                    if (kopeks < wd.min_amount_kopeks) return say(msg, `Минимум для вывода — ${rubles(wd.min_amount_kopeks)}.`, "small danger");
                    if (kopeks > wd.available_total) return say(msg, `Доступно не больше ${rubles(wd.available_total)}.`, "small danger");
                    if (details.value.trim().length < 5) return say(msg, "Укажите реквизиты: карту или телефон для СБП и банк.", "small danger");
                    await busy(event.currentTarget, async () => {
                        try {
                            await api.createWithdrawal(kopeks, details.value.trim());
                            say(msg, "Заявка отправлена. Деньги придут после проверки.", "small ok");
                            setTimeout(reload, 1500);
                        } catch (error) {
                            say(msg, error.message, "small danger");
                        }
                    });
                },
            }, "Отправить заявку"),
        );
    }
    card.append(msg);
    for (const w of history) {
        const [text, cls] = withdrawalState(w.status);
        card.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [
                el("div", { class: "title", text: rubles(w.amount_kopeks) }),
                el("div", { class: `tiny ${cls}`, text: [dateText(w.created_at), text, w.admin_comment].filter(Boolean).join(" · ") }),
            ]),
            w.status === "pending" ? el("button", {
                class: "btn-sm",
                onclick: async (event) => {
                    if (!confirm("Отменить заявку?")) return;
                    await busy(event.currentTarget, async () => {
                        try {
                            await api.cancelWithdrawal(w.id);
                            reload();
                        } catch (error) {
                            say(msg, error.message, "small danger");
                        }
                    });
                },
            }, "Отменить") : null,
        ]));
    }
    return card;
}

// ================= полоса со скидкой на «Тарифах» =================

/** «Для вас есть предложение» или «действует скидка N%» — над тарифами. */
export async function promoStrip() {
    const [offers, discount] = await Promise.all([
        api.promoOffers().catch(() => []),
        api.activeDiscount().catch(() => null),
    ]);
    const waiting = (Array.isArray(offers) ? offers : []).filter((o) => o.is_active && !o.is_claimed).length;
    let text = null;
    if (waiting) text = "🎁 Для вас есть персональное предложение — заберите скидку во вкладке «Бонусы».";
    else if (discount?.is_active && discount.discount_percent > 0) {
        text = `Действует скидка ${discount.discount_percent}%${discount.expires_at ? ` до ${dateText(discount.expires_at)}` : ""} — уже в ценах.`;
    }
    if (!text) return null;
    return el("div", {
        class: "msg info",
        style: "cursor:pointer",
        onclick: () => openTab("bonus"),
        text,
    });
}

export { ApiError, plural };
