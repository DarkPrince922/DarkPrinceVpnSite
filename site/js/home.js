import { $, $$ } from "./ui.js";

$("#year").textContent = new Date().getFullYear();

// вкладки инструкций
$$(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
        $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
        $$("[data-panel]").forEach((panel) => {
            panel.classList.toggle("hidden", panel.dataset.panel !== button.dataset.tab);
        });
    });
});

// какая система у гостя — ту кнопку и показываем главной
const ua = navigator.userAgent;
// iPadOS 13+ представляется маком, отличаем по сенсорному экрану
const isIos = /iphone|ipad|ipod/i.test(ua)
    || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
const platform = /android/i.test(ua)
    ? "android"
    : isIos
        ? "ios"
        : /windows/i.test(ua)
            ? "windows"
            : /linux|x11/i.test(ua)
                ? "linux"
                : null;

const titles = {
    android: ["Скачать для Android", "downloads/DarkPrinceVPN.apk"],
    ios: ["Установить для iPhone", "https://apps.apple.com/app/id6756943388"],
    windows: ["Скачать для Windows", "downloads/DarkPrinceVPN-setup.exe"],
    linux: ["Как подключить на Linux", "#install"],
};
if (platform) {
    const [text, href] = titles[platform];
    const main = $("#mainDownload");
    main.textContent = text;
    main.href = href;

    // и инструкцию сразу открываем на нужной вкладке
    $$(".tabs button").find((b) => b.dataset.tab === platform)?.click();
}

// версии и размеры файлов лежат в отдельном файле: обновить сборку —
// значит положить новый файл и поправить одну строку в downloads.json
try {
    const response = await fetch("downloads.json", { cache: "no-cache" });
    if (response.ok) {
        const data = await response.json();
        for (const [key, node, link] of [
            ["android", $("#verAndroid"), $("#dlAndroid")],
            ["windows", $("#verWindows"), $("#dlWindows")],
        ]) {
            const item = data[key];
            if (!item) continue;
            if (item.file) link.href = item.file;
            node.textContent = [
                item.version ? `версия ${item.version}` : null,
                item.size,
                item.date,
            ].filter(Boolean).join(" · ");
        }
    }
} catch {
    // файла нет — ссылки всё равно работают
}
