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
    linux: ["Скачать для Linux", "downloads/DarkPrinceVPN.AppImage"],
};
if (platform) {
    const [text, href] = titles[platform];
    const main = $("#mainDownload");
    main.textContent = text;
    main.href = href;

    // и инструкцию сразу открываем на нужной вкладке
    $$(".tabs button").find((b) => b.dataset.tab === platform)?.click();
}

// На Linux одного файла мало: пакет для Arch, .deb и AppImage ставятся
// по-разному, и гость сам знает свой дистрибутив лучше, чем мы по User-Agent.
// Поэтому кнопка не качает сразу, а открывает окно с выбором. Ссылки в окне
// настоящие, так что без JS и по «сохранить ссылку как» всё тоже работает.
const picker = $("#linuxPicker");
if (typeof picker?.showModal === "function") {
    for (const button of [$("#dlLinux"), $("#mainDownload")]) {
        button.addEventListener("click", (event) => {
            // главная кнопка ведёт на Linux только у гостей с Linux
            if (button.id === "mainDownload" && platform !== "linux") return;
            event.preventDefault();
            picker.showModal();
        });
    }
    $("#pickerClose").addEventListener("click", () => picker.close());
    // клик по затемнению: цель события — сам dialog, попадания в его содержимое
    // приходят от вложенных узлов
    picker.addEventListener("click", (event) => {
        if (event.target === picker) picker.close();
    });
    // выбрали сборку — окно закрывать, скачивание уже пошло
    for (const link of $$("[data-pick]", picker)) {
        link.addEventListener("click", () => picker.close());
    }
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
            ["linux", $("#verLinux"), $("#dlLinux")],
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

        // у Linux один номер версии на три сборки, размер у каждой свой
        for (const [key, build] of Object.entries(data.linux?.builds || {})) {
            const link = $(`[data-pick="${key}"]`);
            if (!link) continue;
            if (build.file) link.href = build.file;
            if (build.size) link.textContent = `Скачать · ${build.size}`;
        }
    }
} catch {
    // файла нет — ссылки всё равно работают
}
