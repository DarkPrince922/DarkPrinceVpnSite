// Общее для страниц по ссылке из письма: подтверждения почты и смены
// пароля. Запросы идут на свой же домен в /api, как и везде на сайте.

export const $ = (selector) => document.querySelector(selector);

export async function request(path, body) {
    let response;
    try {
        response = await fetch(`/api/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error("Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз.");
    }

    if (response.ok) {
        try {
            return await response.json();
        } catch {
            return {};
        }
    }

    // ссылки из писем одноразовые и живут недолго — самая частая причина
    if (response.status === 400 || response.status === 410 || response.status === 404) {
        throw new Error(
            (await serverMessage(response))
            || "Ссылка уже использована или устарела. Запросите новую."
        );
    }
    if (response.status === 429) {
        throw new Error("Слишком много попыток. Подождите немного и повторите.");
    }
    throw new Error((await serverMessage(response)) || `Ошибка сервера (${response.status}).`);
}

async function serverMessage(response) {
    try {
        const data = await response.json();
        const raw = data.detail ?? data.message ?? data.error;
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw) && typeof raw[0]?.msg === "string") return raw[0].msg;
    } catch {
        // тело не JSON — сообщение подберём по коду
    }
    return null;
}
