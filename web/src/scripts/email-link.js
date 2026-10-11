// Привязка почты к аккаунту, вошедшему через Telegram.
//
// С почтой в тот же аккаунт можно входить и без Telegram. Если почта уже
// занята другим аккаунтом, бот предлагает объединить их: шлёт на неё
// 6-значный код (так он убеждается, что почта ваша), показывает оба аккаунта
// и спрашивает, чью подписку оставить. Запросы — те, что есть у бота:
// POST /cabinet/auth/email/register, /email/merge/verify,
// GET и POST /cabinet/auth/merge/{token}.

import { api, session } from "./api.js";
import { el, clear, rubles, dateText, message, busy } from "./ui.js";

// Ошибки привязки бот пишет по-английски — те, что человек реально встретит.
const KNOWN = [
    ["already linked to your account", "Эта почта уже привязана к вашему аккаунту."],
    ["cannot be linked", "Эту почту привязать нельзя."],
    ["not configured", "Бот сейчас не может отправлять письма. Попробуйте позже."],
    ["Invalid confirmation code", "Неверный код. Проверьте письмо и попробуйте снова."],
    ["Too many invalid attempts", "Слишком много неверных попыток. Начните заново."],
    ["No pending account merge", "Время на подтверждение вышло. Начните заново."],
    ["invalid or expired", "Время на подтверждение вышло. Начните заново."],
    ["temporarily blocked", "Объединение пока недоступно. Попробуйте позже."],
    ["Too many requests", "Слишком часто. Подождите минуту и попробуйте снова."],
];

export function linkErrorText(error) {
    const text = String(error?.message || error || "");
    const known = KNOWN.find(([marker]) => text.toLowerCase().includes(marker.toLowerCase()));
    return known ? known[1] : text || "Не получилось. Попробуйте позже.";
}

/**
 * Карточка привязки. [onChanged] — вызывается, когда почта привязана или
 * аккаунты объединены: странице пора перечитать пользователя.
 */
export function emailLinkCard(onChanged) {
    const card = el("div", { class: "card" });
    const note = el("p", { class: "msg hidden" });

    const field = (label, input) => el("label", { class: "field" }, [el("span", {}, label), input]);

    function showForm() {
        clear(card);
        const email = el("input", { type: "email", autocomplete: "email", placeholder: "you@example.com" });
        const password = el("input", { type: "password", autocomplete: "new-password" });
        const repeat = el("input", { type: "password", autocomplete: "new-password" });
        card.append(
            el("h3", { text: "Привязать почту" }),
            el("p", {
                class: "small muted",
                text: "С почтой в этот аккаунт можно будет входить и без Telegram. " +
                    "Пароль придумайте новый, от 8 символов.",
            }),
            field("Почта", email),
            field("Пароль", password),
            field("Пароль ещё раз", repeat),
            el("button", {
                class: "btn",
                onclick: async (event) => {
                    const address = email.value.trim();
                    const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? "Проверьте адрес почты"
                        : password.value.length < 8 ? "Пароль — не короче 8 символов"
                        : password.value !== repeat.value ? "Пароли не совпадают" : "";
                    if (problem) return message(note, problem);
                    await busy(event.currentTarget, async () => {
                        try {
                            const result = await api.linkEmail(address, password.value);
                            if (result.merge_required) return showCode(address);
                            showDone(
                                /linked/i.test(result.message || "") ? "Почта привязана" : "Проверьте почту",
                                /linked/i.test(result.message || "")
                                    ? `Теперь в этот аккаунт можно входить и по адресу ${address} с паролем.`
                                    : `Мы отправили письмо на ${address}. Перейдите по ссылке из него — после этого ` +
                                      "в этот аккаунт можно будет входить и по почте. Письма нет — проверьте «Спам»."
                            );
                            onChanged?.();
                        } catch (error) {
                            message(note, linkErrorText(error));
                        }
                    });
                },
            }, "Привязать"),
            note
        );
    }

    function showCode(address) {
        clear(card);
        message(note, "");
        const code = el("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code" });
        card.append(
            el("h3", { text: "Эта почта уже есть у другого аккаунта" }),
            el("p", {
                class: "small muted",
                text: `Их можно объединить в один. Мы отправили 6-значный код на ${address} — ` +
                    "введите его, чтобы подтвердить, что почта ваша.",
            }),
            field("Код из письма", code),
            el("div", { class: "row wrap-row" }, [
                el("button", {
                    class: "btn",
                    onclick: async (event) => {
                        const value = code.value.replace(/\D/g, "");
                        if (value.length !== 6) return message(note, "Код — 6 цифр из письма");
                        await busy(event.currentTarget, async () => {
                            try {
                                const result = await api.verifyEmailMerge(value);
                                if (!result.merge_token) throw new Error("Бот не прислал подтверждение объединения");
                                const preview = await api.mergePreview(result.merge_token);
                                showChoose(result.merge_token, preview);
                            } catch (error) {
                                message(note, linkErrorText(error));
                            }
                        });
                    },
                }, "Подтвердить"),
                el("button", { class: "btn-sm", onclick: showForm }, "Другая почта"),
            ]),
            note
        );
    }

    // Выбрать надо только подписку: у аккаунта она одна. Остальное бот
    // сводит в один аккаунт сам.
    function showChoose(token, preview) {
        clear(card);
        message(note, "");
        let keep = preview.primary.id;
        const option = (label, user) => {
            const sub = user.subscription;
            const input = el("input", { type: "radio", name: "keepSub", value: String(user.id) });
            input.checked = user.id === keep;
            input.addEventListener("change", () => (keep = user.id));
            return el("label", { class: "card", style: "display:flex;gap:12px;align-items:flex-start;cursor:pointer;margin:8px 0" }, [
                input,
                el("span", {}, [
                    el("span", { class: "small muted", style: "display:block", text: label }),
                    el("b", { text: sub ? sub.tariff_name || "Подписка" : "Без подписки" }),
                    el("span", {
                        class: "small muted", style: "display:block",
                        text: [
                            sub?.end_date ? `до ${dateText(sub.end_date)}` : null,
                            `баланс ${rubles(user.balance_kopeks || 0)}`,
                            user.email || (user.username ? `@${user.username}` : null),
                        ].filter(Boolean).join(" · "),
                    }),
                ]),
            ]);
        };
        card.append(
            el("h3", { text: "Какую подписку оставить?" }),
            el("p", { class: "small muted", text: "Вторая пропадёт — это нельзя будет отменить." }),
            option("Этот аккаунт", preview.primary),
            option("Аккаунт с почтой", preview.secondary),
            el("button", {
                class: "btn",
                onclick: async (event) => {
                    if (!confirm("Объединить аккаунты? Отменить это нельзя.")) return;
                    await busy(event.currentTarget, async () => {
                        try {
                            const result = await api.executeMerge(token, keep);
                            session.save(result);
                            showDone("Аккаунты объединены",
                                "Теперь это один аккаунт: в него можно входить и через Telegram, и по почте.");
                            onChanged?.();
                        } catch (error) {
                            message(note, linkErrorText(error));
                        }
                    });
                },
            }, "Объединить аккаунты"),
            note
        );
    }

    function showDone(title, text) {
        clear(card);
        card.append(el("h3", { text: title }), el("p", { class: "small", text }));
    }

    showForm();
    return card;
}
