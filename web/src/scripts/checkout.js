// Оплата в три шага: срок → способ → готово.
//
// Человек не думает про «баланс». Выбирает срок, выбирает, чем платить, и
// платит ровно столько, сколько не хватает: что лежит на балансе, засчитаем
// сами. Как только деньги придут, подписка оформится сама — для этого
// покупка запоминается так же, как при прежнем «не хватает — пополните»
// (pending.js), и кабинет оплачивает её при следующем чтении баланса.

import { api, asArray, parsePaymentMethods } from "./api.js";
import { el, clear, rubles, periodText, plural } from "./ui.js";
import { rememberPending, loadPending, clearPending } from "./pending.js";

const DAY = 86400000;

const dateShort = (ms) =>
    new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** Значок способа оплаты: по названию кассы — узнаваемый цвет и подпись. */
function methodLook(method) {
    const text = `${method.id} ${method.option || ""} ${method.name}`.toLowerCase();
    if (/sbp|сбп/.test(text)) return { cls: "sbp", label: "СБП", hint: "Через приложение банка, без ввода карты" };
    if (/stars|звезд/.test(text)) return { cls: "stars", label: "★", hint: "Telegram Stars" };
    if (/crypt|крипт|usdt|ton|btc|heleket|cryptobot/.test(text)) return { cls: "crypto", label: "₮", hint: "USDT, TON и другие" };
    if (/card|карт|yookassa|юkassa|visa|mir|мир/.test(text)) return { cls: "bank", svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/></svg>', hint: "Мир, Visa, Mastercard" };
    return { cls: "other", label: "₽", hint: "" };
}

/**
 * Открыть оплату.
 *   kind: "renew" — продлить подписку sub; "buy" — купить тариф offer.
 *   ctx.balance() — текущий баланс в копейках;
 *   ctx.refresh() — перечитать баланс (и оплатить отложенное) и подписку.
 */
export async function openCheckout({ kind, sub = null, offer = null }, ctx) {
    const shade = el("div", { class: "co-shade" });
    const box = el("div", { class: "co", role: "dialog", "aria-modal": "true" });
    shade.append(box);
    document.body.append(shade);
    document.body.classList.add("co-open");

    let watch = null;
    const close = () => {
        clearTimeout(watch);
        shade.remove();
        document.body.classList.remove("co-open");
        document.removeEventListener("keydown", onKey);
    };
    const onKey = (event) => event.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    shade.addEventListener("click", (event) => event.target === shade && close());

    const title = kind === "renew"
        ? `Продление «${sub?.tariff_name || "Подписка"}»`
        : `Тариф «${offer?.name || ""}»`;

    // общий каркас: заголовок, шаги, тело
    const steps = ["Срок", "Оплата", "Готово"];
    const stepper = el("div", { class: "co-steps" });
    const body = el("div", { class: "co-body" });
    box.append(
        el("div", { class: "co-head" }, [
            el("b", { text: title }),
            el("button", { class: "co-x", "aria-label": "Закрыть", onclick: close }, "✕"),
        ]),
        stepper,
        body,
    );
    const setStep = (n) => {
        clear(stepper);
        steps.forEach((name, index) => {
            if (index) stepper.append(el("i"));
            stepper.append(el("span", { class: index < n ? "done" : index === n ? "on" : "" }, [
                el("em", { text: index < n ? "✓" : String(index + 1) }),
                name,
            ]));
        });
    };
    const loading = (text) => clear(body).append(el("div", { class: "co-wait" }, [el("span", { class: "co-ring" }), el("p", { class: "muted", text })]));
    const failed = (text) => clear(body).append(el("p", { class: "msg err", text }));

    // ---------- шаг 1: срок ----------
    setStep(0);
    loading("Загружаю сроки…");
    let periods = [];
    try {
        if (kind === "renew") {
            const data = await api.renewalOptions(sub.id);
            periods = asArray(data, ["options", "items"]).map((item) => ({
                days: Number(item.period_days ?? item.days),
                price: Number(item.price_kopeks ?? item.price),
                highlighted: item.is_highlighted === true,
            }));
        } else {
            periods = offer.periods.map((p) => ({ days: p.days, price: p.price, highlighted: p.highlighted }));
        }
        periods = periods.filter((p) => Number.isFinite(p.days) && p.days > 0 && Number.isFinite(p.price))
            .sort((a, b) => a.days - b.days);
    } catch (error) {
        failed(error.message);
        return;
    }
    if (!periods.length) {
        failed(kind === "renew" ? "Продление для этой подписки сейчас недоступно." : "У тарифа нет сроков.");
        return;
    }

    // от какой даты считать новый срок: продление — от конца текущего
    const end = sub?.end_date ? new Date(sub.end_date).getTime() : NaN;
    const from = kind === "renew" && Number.isFinite(end) && end > Date.now() ? end : Date.now();
    const base = periods[0].price / periods[0].days; // цена дня самого короткого срока
    let chosen = periods.find((p) => p.highlighted) || periods[0];

    const stepPeriod = () => {
        setStep(0);
        clear(body);
        body.append(el("h3", { text: kind === "renew" ? "На сколько продлить?" : "На какой срок?" }));
        if (kind === "renew" && Number.isFinite(end)) {
            body.append(el("p", { class: "muted co-sub", text: `Сейчас — до ${dateShort(end)}` }));
        }
        const list = el("div", { class: "co-list" });
        for (const period of periods) {
            const perMonth = Math.round((period.price / period.days) * 30 / 100) * 100; // до рубля
            const save = Math.round((1 - period.price / period.days / base) * 100);
            const row = el("button", { class: `co-opt${period === chosen ? " on" : ""}`, onclick: () => {
                chosen = period;
                [...list.children].forEach((node) => node.classList.toggle("on", node === row));
            } }, [
                el("span", { class: "co-rad" }),
                el("span", { class: "grow" }, [
                    el("b", {}, [periodText(period.days), save >= 3 ? el("span", { class: "co-badge", text: `−${save}%` }) : null]),
                    el("span", { text: `до ${dateShort(from + period.days * DAY)}${period.days >= 60 ? ` · ${rubles(perMonth)} в месяц` : ""}` }),
                ]),
                el("span", { class: "co-price", text: rubles(period.price) }),
            ]);
            list.append(row);
        }
        body.append(list, el("button", { class: "primary btn-block co-go", onclick: stepPay }, "Дальше"));
    };

    // ---------- шаг 2: оплата ----------
    let methods = null;
    let method = null;

    async function stepPay() {
        setStep(1);
        loading("Считаю…");
        await ctx.refresh().catch(() => { });
        const balance = Math.max(0, Number(ctx.balance() ?? 0));
        const missing = Math.max(0, chosen.price - balance);

        clear(body);
        const what = `${kind === "renew" ? `«${sub?.tariff_name || "Подписка"}»` : `«${offer.name}»`} на ${periodText(chosen.days)}`;
        const summary = el("div", { class: "co-sum" }, [
            el("div", { class: "kv" }, [el("span", { class: "k", text: what }), el("b", { text: rubles(chosen.price) })]),
        ]);
        const back = el("button", { class: "btn-ghost co-back", onclick: stepPeriod }, "← Другой срок");
        const note = el("p", { class: "small danger co-note" });

        // денег на балансе хватает — платить больше нечего
        if (missing === 0) {
            summary.append(
                el("div", { class: "kv" }, [el("span", { class: "k", text: "С баланса" }), el("b", { class: "ok", text: `−${rubles(chosen.price)}` })]),
                el("div", { class: "co-total" }, [el("span", { class: "muted", text: "Доплачивать не нужно" }), el("b", { text: "0 ₽" })]),
            );
            const pay = el("button", { class: "primary btn-block co-go", onclick: async () => {
                pay.disabled = true;
                pay.textContent = "Оплачиваю…";
                try {
                    if (kind === "renew") await api.renew(chosen.days, sub.id);
                    else await api.purchaseTariff(offer.id, chosen.days);
                    await ctx.refresh().catch(() => { });
                    stepDone();
                } catch (error) {
                    pay.disabled = false;
                    pay.textContent = `Оплатить с баланса ${rubles(chosen.price)}`;
                    note.textContent = error.message;
                }
            } }, `Оплатить с баланса ${rubles(chosen.price)}`);
            body.append(el("h3", { text: "Оплата с баланса" }), el("p", { class: "muted co-sub", text: `На балансе ${rubles(balance)} — этого хватает.` }), summary, pay, note, back);
            return;
        }

        // не хватает — выбираем, чем доплатить
        if (!methods) {
            try {
                methods = parsePaymentMethods(await api.paymentMethods());
            } catch {
                methods = [];
            }
        }
        if (!methods.length) {
            body.append(
                el("h3", { text: "Оплата на сайте пока недоступна" }),
                el("p", { class: "muted co-sub", text: "Способы оплаты ещё не подключены. Напишите в поддержку — поможем оплатить." }),
                back,
            );
            return;
        }
        method = method && methods.includes(method) ? method : methods[0];

        const list = el("div", { class: "co-list" });
        const amountOf = (m) => {
            let kopeks = Math.ceil(missing / 100) * 100; // до целого рубля
            if (m?.min && kopeks < m.min) kopeks = m.min;
            return kopeks;
        };
        const total = el("b");
        const extra = el("p", { class: "small muted co-extra" });
        const pay = el("button", { class: "primary btn-block co-go" });
        const paint = () => {
            const amount = amountOf(method);
            total.textContent = rubles(amount);
            pay.textContent = `Оплатить ${rubles(amount)}`;
            extra.textContent = amount > missing + 99
                ? `Минимум для этого способа — ${rubles(method.min)}. Остаток останется на балансе.`
                : "";
        };
        for (const item of methods) {
            const look = methodLook(item);
            const row = el("button", { class: `co-opt${item === method ? " on" : ""}`, onclick: () => {
                method = item;
                [...list.children].forEach((node) => node.classList.toggle("on", node === row));
                paint();
            } }, [
                look.svg ? el("span", { class: `co-pm ${look.cls}`, html: look.svg }) : el("span", { class: `co-pm ${look.cls}`, text: look.label }),
                el("span", { class: "grow" }, [el("b", { text: item.name }), look.hint ? el("span", { text: look.hint }) : null]),
                el("span", { class: "co-rad" }),
            ]);
            list.append(row);
        }
        if (balance > 0) {
            summary.append(el("div", { class: "kv" }, [el("span", { class: "k", text: "С баланса" }), el("b", { class: "ok", text: `−${rubles(Math.min(balance, chosen.price))}` })]));
        }
        summary.append(el("div", { class: "co-total" }, [el("span", { class: "muted", text: "К оплате" }), total]));

        pay.addEventListener("click", async () => {
            const amount = amountOf(method);
            if (method.max && amount > method.max) {
                note.textContent = `Для этого способа сумма не больше ${rubles(method.max)} — выберите другой.`;
                return;
            }
            // вкладку открываем сразу: ссылка придёт после запроса, а окно,
            // открытое позже, браузер посчитает всплывающим и не покажет
            const tab = window.open("", "_blank");
            pay.disabled = true;
            pay.textContent = "Создаю счёт…";
            try {
                await rememberPending({
                    kind, subscriptionId: sub?.id, tariffId: offer?.id, periodDays: chosen.days, price: chosen.price,
                    title: what,
                }, missing);
                const payment = await api.topup(amount, method.id, method.option);
                if (!payment.payment_url) throw new Error(payment.message || "Касса не вернула ссылку на оплату.");
                if (tab) tab.location = payment.payment_url;
                stepWait(payment, method.id, amount);
            } catch (error) {
                tab?.close();
                clearPending();
                pay.disabled = false;
                paint();
                note.textContent = error.message;
            }
        });

        paint();
        body.append(el("h3", { text: "Как удобнее оплатить?" }), list, summary, extra, pay, note, back);
    }

    // ---------- шаг 3: ждём деньги ----------
    function stepWait(payment, methodId, amount) {
        setStep(2);
        clear(body);
        const status = el("p", { class: "muted", text: "Оплатите в открывшейся вкладке — эта страница обновится сама." });
        body.append(
            el("div", { class: "co-wait" }, [
                el("span", { class: "co-ring" }),
                el("h3", { text: `Ждём оплату ${rubles(amount)}` }),
                status,
            ]),
            el("a", { class: "btn btn-block", href: payment.payment_url, target: "_blank", rel: "noopener" }, "Открыть страницу оплаты ещё раз"),
            el("button", { class: "btn-ghost btn-block co-back", onclick: () => tick(true) }, "Я оплатил — проверить"),
        );

        let attempt = 0;
        async function tick(manual = false) {
            clearTimeout(watch);
            attempt += 1;
            try {
                if (payment.payment_id) await api.checkPending(methodId, payment.payment_id);
            } catch {
                // деньги ещё не дошли — спросим позже
            }
            // кабинет при чтении баланса сам оплатит отложенную покупку
            await ctx.refresh().catch(() => { });
            if (!loadPending()) {
                stepDone();
                return;
            }
            if (manual) status.textContent = "Пока не видим оплату. Если вы уже заплатили — подождите минуту, банк иногда задерживает.";
            if (attempt < 80) watch = setTimeout(tick, attempt < 20 ? 4000 : 15000);
        }
        watch = setTimeout(tick, 4000);
    }

    // ---------- готово ----------
    async function stepDone() {
        setStep(3);
        ctx.after?.();
        clear(body);
        let until = from + chosen.days * DAY;
        try {
            const subs = asArray(await api.subscriptions(), ["subscriptions"]);
            const fresh = kind === "renew"
                ? subs.find((s) => s.id === sub.id)
                : subs.filter((s) => s.tariff_id === offer.id).sort((a, b) => new Date(b.end_date) - new Date(a.end_date))[0];
            if (fresh?.end_date) until = new Date(fresh.end_date).getTime();
        } catch {
            // покажем расчётную дату
        }
        body.append(
            el("div", { class: "co-wait" }, [
                el("span", { class: "co-ok", text: "✓" }),
                el("h3", { text: "Оплачено!" }),
                el("p", { class: "muted", text: `${kind === "renew" ? "Подписка продлена" : "Подписка оформлена"} до ${dateShort(until)}` }),
            ]),
            el("button", { class: "primary btn-block", onclick: close }, "Готово"),
        );
    }

    stepPeriod();
}

export const _forTests = { methodLook, plural };
