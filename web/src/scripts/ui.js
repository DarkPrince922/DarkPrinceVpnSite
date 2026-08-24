// Мелкие помощники: разметка, форматирование, буфер обмена, QR.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Создание узла: el("div", {class: "card"}, "текст" | узел | [узлы]) */
export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "html") node.innerHTML = value;
        else if (key === "text") node.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2), value);
        } else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export function clear(node) {
    while (node.firstChild) node.firstChild.remove();
    return node;
}

// ---------- форматирование ----------

export function rubles(kopeks) {
    const value = Number(kopeks || 0) / 100;
    const text = Math.abs(value - Math.round(value)) < 0.005
        ? value.toFixed(0)
        : value.toFixed(2);
    return `${text} ₽`;
}

export function plural(count, one, few, many) {
    const n = Math.abs(count) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return many;
    if (n1 > 1 && n1 < 5) return few;
    if (n1 === 1) return one;
    return many;
}

export const daysWord = (n) => plural(n, "день", "дня", "дней");

/** Дней до даты окончания; null, если дату не разобрать. */
export function daysUntil(endDate) {
    if (!endDate) return null;
    const end = new Date(endDate);
    if (Number.isNaN(end.getTime())) return null;
    const diff = end.getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
}

export function dateText(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

export function periodText(days) {
    if (days % 365 === 0) {
        const years = days / 365;
        return `${years} ${plural(years, "год", "года", "лет")}`;
    }
    if (days % 30 === 0) {
        const months = days / 30;
        return `${months} ${plural(months, "месяц", "месяца", "месяцев")}`;
    }
    return `${days} ${daysWord(days)}`;
}

export const gb = (value) =>
    value === null || value === undefined ? "∞" : `${Number(value).toFixed(1)} ГБ`;

// ---------- взаимодействие ----------

export async function copy(text, button) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // clipboard недоступен без https или в старом браузере — запасной путь
        const area = el("textarea", { style: "position:fixed;opacity:0" });
        area.value = text;
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
    }
    if (button) {
        const original = button.textContent;
        button.textContent = "Скопировано";
        setTimeout(() => (button.textContent = original), 1600);
    }
}

/** Сообщение в блок: type = "err" | "info", пустой текст прячет блок. */
export function message(node, text, type = "err") {
    if (!node) return;
    node.className = `msg ${type}`;
    node.textContent = text || "";
    node.classList.toggle("hidden", !text);
}

/** Кнопка на время запроса: блокируется и показывает крутилку. */
export async function busy(button, work) {
    if (!button) return work();
    const label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>';
    try {
        return await work();
    } finally {
        button.disabled = false;
        button.innerHTML = label;
    }
}

// ---------- QR ----------

/**
 * Рисует QR ссылки подписки. Библиотека qrcode.js подбирает версию сама,
 * но у длинных ссылок первая попытка может не поместиться — повышаем версию,
 * пока не влезет.
 */
export function qrNode(text, size = 176) {
    for (let version = 4; version <= 40; version += 1) {
        try {
            const qr = window.qrcode(version, "M");
            qr.addData(text);
            qr.make();
            const cells = qr.getModuleCount();
            const scale = Math.max(1, Math.floor(size / cells));
            const wrapper = el("div", { class: "qr", html: qr.createImgTag(scale, 0) });
            return wrapper;
        } catch {
            // не поместилось — следующая версия
        }
    }
    return el("div", { class: "small muted", text: "Ссылка слишком длинная для QR" });
}
