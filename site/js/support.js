// Техподдержка Bedolaga: тикеты, история сообщений и вложения.
// Браузерный WebSocket не умеет передать обязательный Authorization-заголовок,
// поэтому открытый диалог обновляется коротким REST-опросом.

import { api, session, ApiError } from "./api.js?v=20260801-2";
import { $, el, clear, message, busy } from "./ui.js?v=20260801-2";

const DEFAULT_SUPPORT_URL = "https://t.me/skzfeee";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CHAT_POLL_MS = 8000;
const UNREAD_POLL_MS = 30000;
const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const state = {
    active: false,
    activeTicketId: null,
    config: null,
    tickets: [],
    renderGeneration: 0,
    chatGeneration: 0,
    chatTimer: null,
    unreadTimer: null,
    chatRefs: null,
};

const fallbackConfig = () => ({
    tickets_enabled: true,
    support_type: "both",
    support_url: DEFAULT_SUPPORT_URL,
    support_username: "@skzfeee",
    contact_is_telegram: true,
});

const isClosed = (ticket) => String(ticket?.status || "").toLowerCase() === "closed";

function ticketsFrom(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.tickets)) return data.tickets;
    return [];
}

function contactUrl(config = state.config) {
    const value = String(config?.support_url || "").trim();
    if (value.startsWith("https://") || value.startsWith("tg://")) return value;
    return DEFAULT_SUPPORT_URL;
}

function supportError(error) {
    if (!(error instanceof ApiError)) return error?.message || "Не удалось связаться с поддержкой.";
    const detail = String(error.message || "");
    if (error.status === 400 && /closed/i.test(detail)) return "Обращение уже закрыто.";
    if (error.status === 401) return "Сессия истекла. Войдите в аккаунт ещё раз.";
    if (error.status === 403 && /disabled/i.test(detail)) return "Тикеты временно отключены.";
    if (error.status === 403 && /blocked/i.test(detail)) return "Обращения для этого аккаунта ограничены.";
    if (error.status === 403) return "Поддержка недоступна для этого аккаунта.";
    if (error.status === 404) return "Обращение не найдено.";
    if (error.status === 409) return "У вас уже есть открытое обращение.";
    if (error.status === 413) return "Файл больше 10 МБ.";
    if (error.status === 422) return "Проверьте тему, сообщение и вложение.";
    if (error.status === 429) return "Слишком много сообщений. Попробуйте немного позже.";
    if (error.status >= 500) return "Поддержка временно недоступна.";
    return detail || `Ошибка поддержки (${error.status}).`;
}

function supportTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function fileSize(size) {
    if (!Number.isFinite(size)) return "";
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
    return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

function mediaType(file) {
    if (SAFE_IMAGE_TYPES.has(file.type)) return "photo";
    if (file.type.startsWith("video/")) return "video";
    return "document";
}

function validateFile(file) {
    if (!file) return null;
    if (!file.size) throw new Error("Файл пуст.");
    if (file.size > MAX_FILE_SIZE) throw new Error("Файл больше 10 МБ.");
    return file;
}

async function uploadFile(file) {
    validateFile(file);
    return api.uploadSupportMedia(file, mediaType(file));
}

function loading(panel, text = "Загружаю поддержку…") {
    clear(panel).append(el("div", { class: "card" }, [
        el("span", { class: "spinner" }),
        ` ${text}`,
    ]));
}

function telegramLink(config, label = "Написать напрямую в Telegram") {
    return el("a", {
        class: "btn btn-ghost",
        href: contactUrl(config),
        target: "_blank",
        rel: "noopener",
    }, label);
}

function supportHeader(title, subtitle, back) {
    return el("div", { class: "support-toolbar" }, [
        back ? el("button", { class: "btn-sm btn-ghost", onclick: back }, "← Назад") : null,
        el("div", { class: "grow" }, [
            el("h2", { text: title }),
            subtitle ? el("p", { class: "small muted", text: subtitle }) : null,
        ]),
    ]);
}

function setUnreadBadge(count) {
    const badge = $("#supportBadge");
    const tab = $("#supportTab");
    if (!badge || !tab) return;
    const value = Math.max(0, Number(count) || 0);
    badge.textContent = value > 99 ? "99+" : String(value);
    badge.classList.toggle("hidden", value === 0);
    tab.setAttribute("aria-label", value ? `Поддержка, непрочитанных: ${value}` : "Поддержка");
}

export async function refreshSupportUnread() {
    if (!session.loggedIn) {
        setUnreadBadge(0);
        return 0;
    }
    try {
        const data = await api.supportUnreadCount();
        const count = Number(data?.unread_count ?? data?.count ?? 0);
        setUnreadBadge(count);
        return count;
    } catch {
        return null;
    }
}

export function startSupportUnreadPolling() {
    if (state.unreadTimer) clearInterval(state.unreadTimer);
    refreshSupportUnread();
    state.unreadTimer = setInterval(refreshSupportUnread, UNREAD_POLL_MS);
}

function stopChatPolling() {
    state.chatGeneration += 1;
    if (state.chatTimer) clearTimeout(state.chatTimer);
    state.chatTimer = null;
    state.chatRefs = null;
}

export function deactivateSupport() {
    state.active = false;
    state.activeTicketId = null;
    stopChatPolling();
}

export function stopSupport() {
    deactivateSupport();
    if (state.unreadTimer) clearInterval(state.unreadTimer);
    state.unreadTimer = null;
    setUnreadBadge(0);
}

function ticketStatus(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "closed") return "Закрыто";
    if (normalized === "pending") return "Ожидает";
    if (normalized === "answered") return "Есть ответ";
    return "Открыто";
}

function ticketRow(ticket) {
    const last = ticket.last_message;
    const preview = String(last?.message_text || "").trim()
        || (last?.has_media ? "Вложение" : "Без сообщений");
    return el("button", {
        class: "support-ticket",
        type: "button",
        onclick: () => openSupportTicket(ticket.id),
    }, [
        el("div", { class: "support-ticket-head" }, [
            el("strong", { text: ticket.title || `Обращение #${ticket.id}` }),
            el("span", {
                class: `chip support-status${isClosed(ticket) ? " closed" : ""}`,
                text: ticketStatus(ticket.status),
            }),
        ]),
        el("p", { class: "small muted support-ticket-preview", text: preview }),
        el("span", {
            class: "tiny muted",
            text: `#${ticket.id} · ${supportTime(ticket.updated_at || ticket.created_at)}`,
        }),
    ]);
}

function ticketsDisabledView(panel, config) {
    clear(panel).append(
        supportHeader(
            "Техподдержка",
            "Напишите нам — администратор получит сообщение в Telegram.",
            null
        ),
        el("div", { class: "card" }, [
            el("h3", { text: "Связаться с поддержкой" }),
            el("p", {
                class: "small muted",
                text: "Тикеты сейчас недоступны, но вы можете написать нам напрямую.",
            }),
            telegramLink(config, "Написать в Telegram"),
        ])
    );
}

export async function renderSupport() {
    const panel = $("#panelSupport");
    if (!panel) return;
    state.active = true;
    state.activeTicketId = null;
    stopChatPolling();
    const generation = ++state.renderGeneration;
    loading(panel);

    let config;
    try {
        config = await api.supportConfig();
    } catch {
        config = fallbackConfig();
    }
    if (!state.active || generation !== state.renderGeneration) return;
    state.config = config;

    if (config?.tickets_enabled !== true) {
        ticketsDisabledView(panel, config);
        return;
    }

    let tickets;
    try {
        tickets = ticketsFrom(await api.supportTickets(1));
    } catch (error) {
        if (!state.active || generation !== state.renderGeneration) return;
        clear(panel).append(
            supportHeader("Техподдержка", "Ваши обращения и ответы администратора.", null),
            el("div", { class: "card" }, [
                el("p", { class: "danger", text: supportError(error) }),
                el("div", { class: "support-actions" }, [
                    el("button", { class: "btn-sm", onclick: renderSupport }, "Повторить"),
                    telegramLink(config, "Написать в Telegram"),
                ]),
            ])
        );
        return;
    }
    if (!state.active || generation !== state.renderGeneration) return;

    state.tickets = tickets.sort((a, b) =>
        new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
    );
    const activeTicket = state.tickets.find((ticket) => !isClosed(ticket));

    clear(panel).append(
        el("div", { class: "support-toolbar" }, [
            el("div", { class: "grow" }, [
                el("h2", { text: "Техподдержка" }),
                el("p", {
                    class: "small muted",
                    text: "Ответы сохраняются здесь. Администратор получает ваше обращение в Telegram.",
                }),
            ]),
            el("button", {
                class: "btn-sm btn-ghost",
                title: "Обновить",
                "aria-label": "Обновить обращения",
                onclick: renderSupport,
            }, "↻"),
        ])
    );

    if (!state.tickets.length) {
        panel.append(el("div", { class: "card" }, [
            el("h3", { text: "Обращений пока нет" }),
            el("p", {
                class: "small muted",
                text: "Опишите проблему — новое обращение сразу появится у администратора в Telegram.",
            }),
        ]));
    } else {
        panel.append(el("p", { class: "section-title", text: "Ваши обращения" }));
        const list = el("div", { class: "support-ticket-list" });
        state.tickets.forEach((ticket) => list.append(ticketRow(ticket)));
        panel.append(list);
    }

    const actions = el("div", { class: "support-actions support-actions-bottom" }, [
        el("button", {
            class: "primary btn-block",
            onclick: () => activeTicket
                ? openSupportTicket(activeTicket.id)
                : showCreateTicket(),
        }, activeTicket ? "Открыть текущее обращение" : "Новое обращение"),
    ]);
    if (String(config?.support_type || "").toLowerCase() === "both") {
        actions.append(telegramLink(config));
    }
    panel.append(actions);
}

function attachmentField() {
    const input = el("input", { type: "file", class: "support-file-input" });
    const note = el("span", { class: "small muted", text: "Файл не выбран" });
    const pick = el("button", {
        type: "button",
        class: "btn-sm",
        onclick: () => input.click(),
    }, "Прикрепить файл");
    const remove = el("button", {
        type: "button",
        class: "btn-sm btn-ghost hidden",
        onclick: () => {
            input.value = "";
            update();
        },
    }, "Убрать");

    const update = () => {
        const file = input.files?.[0] || null;
        if (file && file.size > MAX_FILE_SIZE) {
            input.value = "";
            note.className = "small danger";
            note.textContent = "Файл больше 10 МБ.";
            remove.classList.add("hidden");
            return;
        }
        note.className = "small muted";
        note.textContent = file ? `${file.name} · ${fileSize(file.size)}` : "Файл не выбран";
        pick.textContent = file ? "Заменить файл" : "Прикрепить файл";
        remove.classList.toggle("hidden", !file);
    };
    input.addEventListener("change", update);

    return {
        input,
        node: el("div", { class: "support-file" }, [input, pick, note, remove]),
        file: () => input.files?.[0] || null,
        clear: () => {
            input.value = "";
            update();
        },
    };
}

function showCreateTicket() {
    const panel = $("#panelSupport");
    if (!panel) return;
    state.active = true;
    state.activeTicketId = null;
    stopChatPolling();

    const title = el("input", {
        type: "text",
        maxlength: "120",
        placeholder: "Например: не подключается VPN",
        autocomplete: "off",
    });
    const body = el("textarea", {
        maxlength: "4000",
        rows: "6",
        placeholder: "Опишите, что случилось и что уже пробовали сделать",
    });
    const attachment = attachmentField();
    const notice = el("div", { class: "msg hidden" });
    const submit = el("button", { type: "submit", class: "primary" }, "Отправить");
    const form = el("form", { class: "card support-form" }, [
        el("label", { class: "field" }, [el("span", {}, "Тема"), title]),
        el("label", { class: "field" }, [el("span", {}, "Что случилось?"), body]),
        el("div", { class: "support-attachment-field" }, [
            el("span", { class: "support-attachment-label" }, "Вложение, до 10 МБ (необязательно)"),
            attachment.node,
        ]),
        notice,
        el("div", { class: "support-actions" }, [
            submit,
            el("button", { type: "button", class: "btn-ghost", onclick: renderSupport }, "Отмена"),
        ]),
    ]);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const subject = title.value.trim();
        const text = body.value.trim();
        let file;
        try {
            file = validateFile(attachment.file());
        } catch (error) {
            message(notice, error.message);
            return;
        }
        if (subject.length < 3) {
            message(notice, "Тема должна быть не короче трёх символов.");
            title.focus();
            return;
        }
        if (!text && !file) {
            message(notice, "Напишите сообщение или добавьте вложение.");
            body.focus();
            return;
        }

        message(notice, "");
        await busy(submit, async () => {
            try {
                const media = file ? await uploadFile(file) : null;
                const ticket = await api.createSupportTicket(subject, text, media);
                if (!ticket?.id) throw new Error("Сервер не вернул номер обращения.");
                await openSupportTicket(ticket.id);
            } catch (error) {
                if (error instanceof ApiError && error.status === 409) {
                    try {
                        const tickets = ticketsFrom(await api.supportTickets(1));
                        const active = tickets.find((ticket) => !isClosed(ticket));
                        if (active) {
                            await openSupportTicket(active.id);
                            return;
                        }
                    } catch {
                        // исходная ошибка ниже объяснит правило одного тикета
                    }
                }
                message(notice, supportError(error));
            }
        });
    });

    clear(panel).append(
        supportHeader(
            "Новое обращение",
            "Оно сразу появится у администратора в Telegram.",
            renderSupport
        ),
        form
    );
    title.focus();
}

function messageAttachments(item) {
    const mediaItems = Array.isArray(item?.media_items) && item.media_items.length
        ? item.media_items
        : (item?.media_file_id ? [{
            file_id: item.media_file_id,
            token: item.media_token,
            type: item.media_type,
            caption: item.media_caption,
        }] : []);
    const seen = new Set();
    return mediaItems.flatMap((media) => {
        const fileId = media?.file_id;
        const token = media?.token || item?.media_token;
        if (!fileId || !token || seen.has(fileId)) return [];
        seen.add(fileId);
        return [{
            type: media.type || item?.media_type || "document",
            caption: media.caption || item?.media_caption || "",
            url: `/api/cabinet/media/${encodeURIComponent(fileId)}?token=${encodeURIComponent(token)}`,
        }];
    });
}

function messageBubble(item) {
    const fromAdmin = item.is_from_admin === true;
    const bubble = el("div", {
        class: `support-message${fromAdmin ? " from-admin" : " from-user"}`,
    });
    if (fromAdmin) bubble.append(el("strong", { class: "support-author", text: "Поддержка" }));

    const text = String(item.message_text || "").trim();
    if (text) bubble.append(el("p", { text }));

    const attachments = messageAttachments(item);
    for (const attachment of attachments) {
        if (attachment.type === "photo") {
            bubble.append(el("a", {
                class: "support-image-link",
                href: attachment.url,
                target: "_blank",
                rel: "noopener",
            }, el("img", {
                class: "support-image",
                src: attachment.url,
                alt: attachment.caption || "Вложенное изображение",
                loading: "lazy",
            })));
        }
        bubble.append(el("a", {
            class: "support-attachment",
            href: attachment.url,
            target: "_blank",
            rel: "noopener",
        }, attachment.type === "photo" ? "Открыть изображение" :
            (attachment.type === "video" ? "Открыть видео" : "Открыть вложение")));
    }
    if (!text && !attachments.length) bubble.append(el("p", { class: "muted", text: "Сообщение без текста" }));
    bubble.append(el("span", { class: "support-message-meta", text: supportTime(item.created_at) }));

    return el("div", {
        class: `support-message-row${fromAdmin ? " from-admin" : " from-user"}`,
    }, bubble);
}

function messageSignature(ticket) {
    return (ticket.messages || []).map((item) => [
        item.id,
        item.message_text,
        item.media_file_id,
        item.media_token,
        item.created_at,
    ].join(":")).join("|");
}

function replyComposer(ticketId) {
    const text = el("textarea", {
        maxlength: "4000",
        rows: "2",
        placeholder: "Сообщение",
        "aria-label": "Сообщение в поддержку",
    });
    const attachment = attachmentField();
    const notice = el("div", { class: "msg hidden" });
    const send = el("button", { type: "submit", class: "primary" }, "Отправить");
    const form = el("form", { class: "support-reply-form" }, [
        attachment.node,
        el("div", { class: "support-composer-row" }, [text, send]),
        notice,
    ]);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = text.value.trim();
        let file;
        try {
            file = validateFile(attachment.file());
        } catch (error) {
            message(notice, error.message);
            return;
        }
        if (!value && !file) {
            message(notice, "Напишите сообщение или добавьте вложение.");
            text.focus();
            return;
        }

        message(notice, "");
        await busy(send, async () => {
            try {
                const media = file ? await uploadFile(file) : null;
                await api.replySupportTicket(ticketId, value, media);
                text.value = "";
                attachment.clear();
                await refreshOpenTicket(ticketId, true);
            } catch (error) {
                message(notice, supportError(error));
            }
        });
    });

    return form;
}

function updateOpenTicket(ticket, initial = false) {
    const refs = state.chatRefs;
    if (!refs || Number(ticket.id) !== Number(state.activeTicketId)) return;

    refs.title.textContent = ticket.title || `Обращение #${ticket.id}`;
    refs.status.textContent = ticketStatus(ticket.status);
    refs.status.className = `chip support-status${isClosed(ticket) ? " closed" : ""}`;

    const signature = messageSignature(ticket);
    if (signature !== refs.messageSignature) {
        const nearBottom = refs.messages.scrollHeight - refs.messages.scrollTop - refs.messages.clientHeight < 120;
        refs.messageSignature = signature;
        clear(refs.messages);
        const items = [...(ticket.messages || [])].sort((a, b) => Number(a.id) - Number(b.id));
        if (!items.length) {
            refs.messages.append(el("p", { class: "small muted", text: "Сообщений пока нет." }));
        } else {
            items.forEach((item) => refs.messages.append(messageBubble(item)));
        }
        if (initial || nearBottom) requestAnimationFrame(() => {
            refs.messages.scrollTop = refs.messages.scrollHeight;
        });
    }

    const replyState = isClosed(ticket) ? "closed" : (ticket.is_reply_blocked ? "blocked" : "open");
    if (replyState !== refs.replyState) {
        refs.replyState = replyState;
        clear(refs.composer);
        if (replyState === "open") refs.composer.append(replyComposer(ticket.id));
        else refs.composer.append(el("p", {
            class: "small muted support-closed",
            text: replyState === "closed" ? "Обращение закрыто." : "Отправка сообщений ограничена.",
        }));
    }
}

async function refreshOpenTicket(ticketId, showError = false) {
    try {
        const ticket = await api.supportTicket(ticketId);
        if (!state.active || Number(state.activeTicketId) !== Number(ticketId)) return;
        updateOpenTicket(ticket);
        message(state.chatRefs?.notice, "");
        try {
            await api.markSupportTicketRead(ticketId);
        } catch {
            // чтение сообщения важнее счётчика — не мешаем диалогу
        }
        refreshSupportUnread();
    } catch (error) {
        if (showError && state.chatRefs?.notice) message(state.chatRefs.notice, supportError(error));
    }
}

function scheduleChatPoll(ticketId, generation) {
    if (!state.active || generation !== state.chatGeneration) return;
    state.chatTimer = setTimeout(async () => {
        await refreshOpenTicket(ticketId, false);
        scheduleChatPoll(ticketId, generation);
    }, CHAT_POLL_MS);
}

export async function openSupportTicket(ticketId) {
    const panel = $("#panelSupport");
    if (!panel) return;
    state.active = true;
    state.activeTicketId = Number(ticketId);
    stopChatPolling();
    state.activeTicketId = Number(ticketId);
    const generation = state.chatGeneration;
    loading(panel, "Открываю обращение…");

    let ticket;
    try {
        ticket = await api.supportTicket(ticketId);
    } catch (error) {
        if (!state.active || generation !== state.chatGeneration) return;
        clear(panel).append(
            supportHeader("Техподдержка", "Не удалось открыть обращение.", renderSupport),
            el("div", { class: "card" }, [
                el("p", { class: "danger", text: supportError(error) }),
                el("button", { class: "btn-sm", onclick: () => openSupportTicket(ticketId) }, "Повторить"),
            ])
        );
        return;
    }
    if (!state.active || generation !== state.chatGeneration) return;

    const title = el("h2", { text: ticket.title || `Обращение #${ticket.id}` });
    const status = el("span", { class: "chip support-status", text: ticketStatus(ticket.status) });
    const messages = el("div", { class: "support-chat", role: "log", "aria-live": "polite" });
    const notice = el("div", { class: "msg hidden" });
    const composer = el("div", { class: "support-composer" });

    clear(panel).append(
        el("div", { class: "support-toolbar support-chat-head" }, [
            el("button", { class: "btn-sm btn-ghost", onclick: renderSupport }, "← Назад"),
            el("div", { class: "grow" }, [
                title,
                el("p", { class: "tiny muted", text: `Обращение #${ticket.id}` }),
            ]),
            status,
        ]),
        notice,
        el("div", { class: "card support-chat-card" }, [messages, composer])
    );
    state.chatRefs = {
        title,
        status,
        messages,
        notice,
        composer,
        messageSignature: null,
        replyState: null,
    };
    updateOpenTicket(ticket, true);
    try {
        await api.markSupportTicketRead(ticket.id);
    } catch {
        // диалог всё равно открыт
    }
    refreshSupportUnread();
    scheduleChatPoll(ticket.id, generation);
}
