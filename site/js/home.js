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
const platform = /android/i.test(ua)
    ? "android"
    : /windows/i.test(ua)
        ? "windows"
        : /linux|x11/i.test(ua) && !/android/i.test(ua)
            ? "linux"
            : null;

const titles = {
    android: ["Скачать для Android", "downloads/DarkPrinceVPN.apk"],
    windows: ["Скачать для Windows", "downloads/DarkPrinceVPN-windows.zip"],
    linux: ["Как подключить на Linux", "#install"],
};
if (platform) {
    const [text, href] = titles[platform];
    const main = $("#mainDownload");
    main.textContent = text;
    main.href = href;
    const others = Object.keys(titles).filter((key) => key !== platform);
    $("#altLinks").innerHTML = others
        .map((key) => `<a href="${titles[key][1]}">${titles[key][0]}</a>`)
        .join(" · ");
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
