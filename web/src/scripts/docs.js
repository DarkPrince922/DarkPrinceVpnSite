// Вопросы и документы: FAQ, правила, оферта, политика, условия автоплатежей —
// что включено в боте. Текст приходит от бота разметкой Telegram (HTML) или
// Markdown, поэтому выводим через свой фильтр: только безопасные теги.

import { api } from "./api.js";
import { el, clear } from "./ui.js";

const DOCS = [
    ["rules", "rules", "Правила сервиса"],
    ["offer", "public-offer", "Публичная оферта"],
    ["privacy", "privacy-policy", "Политика конфиденциальности"],
    ["recurrent", "recurrent-payments", "Условия автоплатежей"],
];

export function docsCard() {
    const card = el("div", { class: "card" }, [el("h3", { text: "Вопросы и документы" })]);
    const body = el("div", {}, [el("p", { class: "small muted", text: "Загружаю…" })]);
    card.append(body);
    load();
    return card;

    async function load() {
        const [visibility, faq] = await Promise.all([
            api.infoVisibility().catch(() => ({ faq: true, rules: true, privacy: true, offer: true, recurrent: false })),
            api.faq().catch(() => []),
        ]);
        clear(body);
        const pages = (Array.isArray(faq) ? faq : []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (pages.length) {
            body.append(el("p", { class: "section-title", text: "Частые вопросы" }));
            for (const page of pages) body.append(item(page.title, async () => page.content || ""));
        }
        const docs = DOCS.filter(([key]) => visibility[key]);
        if (docs.length) {
            body.append(el("p", { class: "section-title", style: "margin-top:12px", text: "Документы" }));
            for (const [, path, title] of docs) {
                body.append(item(title, async () => (await api.infoDoc(path)).content || ""));
            }
        }
        if (!pages.length && !docs.length) body.append(el("p", { class: "small muted", text: "Пока пусто." }));
    }
}

/** Раскрывающийся пункт: текст грузится при первом открытии. */
function item(title, fetchText) {
    const content = el("div", { class: "small", style: "padding:6px 0 12px" });
    let loaded = false;
    const details = el("details", { class: "list-item", style: "display:block" }, [
        el("summary", { style: "cursor:pointer", text: title }),
        content,
    ]);
    details.addEventListener("toggle", async () => {
        if (!details.open || loaded) return;
        loaded = true;
        content.textContent = "Загружаю…";
        try {
            clear(content).append(renderText(await fetchText()));
        } catch (error) {
            content.textContent = error.message;
        }
    });
    return details;
}

const ALLOWED = new Set(["B", "STRONG", "I", "EM", "U", "S", "CODE", "PRE", "BR", "P", "UL", "OL", "LI", "A", "H1", "H2", "H3", "H4", "BLOCKQUOTE"]);

/** Безопасный вывод: из HTML оставляем только простые теги и ссылки http(s). */
export function renderText(text) {
    const looksHtml = /<(b|i|u|s|a|p|br|strong|em|code|pre|h[1-6]|ul|ol|li)[\s>/]/i.test(text);
    const html = looksHtml ? text.replace(/\n/g, "<br>") : markdownToHtml(text);
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    return sanitize(doc.body.firstChild);
}

function sanitize(node) {
    const out = document.createDocumentFragment();
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            out.append(document.createTextNode(child.textContent));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (!ALLOWED.has(child.tagName)) {
                out.append(sanitize(child)); // тег выкидываем, текст оставляем
                continue;
            }
            const copy = document.createElement(child.tagName);
            if (child.tagName === "A") {
                const href = child.getAttribute("href") || "";
                if (/^https?:\/\//i.test(href)) {
                    copy.setAttribute("href", href);
                    copy.setAttribute("target", "_blank");
                    copy.setAttribute("rel", "noopener noreferrer");
                }
            }
            copy.append(sanitize(child));
            out.append(copy);
        }
    }
    return out;
}

function markdownToHtml(text) {
    const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escape(text)
        .split("\n")
        .map((line) => {
            const heading = line.match(/^#{1,6}\s+(.*)$/);
            if (heading) return `<b>${heading[1]}</b>`;
            if (/^\s*[-*]\s+/.test(line)) return "• " + line.replace(/^\s*[-*]\s+/, "");
            return line;
        })
        .join("<br>")
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
