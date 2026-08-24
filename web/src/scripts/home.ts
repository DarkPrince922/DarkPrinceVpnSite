/**
 * Поведение главной страницы.
 *
 * Astro собирает этот файл в отдельный скрипт с хешем в имени. Встроить его в
 * разметку нельзя: политика безопасности в nginx разрешает только script-src
 * 'self', и встроенный скрипт браузер просто не выполнит.
 */

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
    root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
    Array.from(root.querySelectorAll<T>(sel));

const calmly = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Появление блоков при прокрутке.
//
// Класс .reveal прячет элемент, поэтому вешаем его из скрипта и только на то,
// что сейчас ниже экрана: иначе первый экран успел бы отрисоваться и моргнуть,
// а без JS страница осталась бы пустой.
if (!calmly && "IntersectionObserver" in window) {
    const watcher = new IntersectionObserver(
        (entries, self) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                entry.target.classList.add("shown");
                self.unobserve(entry.target);
            }
        },
        { rootMargin: "0px 0px -10% 0px" },
    );

    for (const node of $$(".platform, .feature, #install .card, #ios-note .card")) {
        if (node.getBoundingClientRect().top < innerHeight) continue;
        node.classList.add("reveal");
        watcher.observe(node);
    }
}

// вкладки инструкций
const tabs = $$<HTMLButtonElement>(".tabs button");
for (const button of tabs) {
    button.addEventListener("click", () => {
        for (const other of tabs) {
            other.setAttribute("aria-selected", String(other === button));
        }
        for (const panel of $$<HTMLElement>("[data-panel]")) {
            panel.classList.toggle("hidden", panel.dataset.panel !== button.dataset.tab);
        }
    });
}

// какая система у гостя — ту кнопку и показываем главной
const ua = navigator.userAgent;
// iPadOS 13+ представляется маком, отличаем по сенсорному экрану
const isIos =
    /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
const platform = /android/i.test(ua)
    ? "android"
    : isIos
      ? "ios"
      : /windows/i.test(ua)
        ? "windows"
        : /linux|x11/i.test(ua)
          ? "linux"
          : null;

const titles: Record<string, [string, string]> = {
    android: ["Скачать для Android", "/downloads/DarkPrinceVPN.apk"],
    ios: ["Установить для iPhone", "https://apps.apple.com/app/id6756943388"],
    windows: ["Скачать для Windows", "/downloads/DarkPrinceVPN-setup.exe"],
    linux: ["Скачать для Linux", "/downloads/DarkPrinceVPN.AppImage"],
};

const main = $<HTMLAnchorElement>("#mainDownload");
if (platform && main) {
    const [text, href] = titles[platform];
    main.textContent = text;
    main.href = href;

    // и инструкцию сразу открываем на нужной вкладке
    tabs.find((b) => b.dataset.tab === platform)?.click();
}

// На Linux одного файла мало: пакет для Arch, .deb и AppImage ставятся
// по-разному, и гость сам знает свой дистрибутив лучше, чем мы по User-Agent.
// Поэтому кнопка не качает сразу, а открывает окно с выбором.
const picker = $<HTMLDialogElement>("#linuxPicker");
if (typeof picker?.showModal === "function") {
    for (const button of [$<HTMLAnchorElement>("#dlLinux"), main]) {
        button?.addEventListener("click", (event) => {
            // главная кнопка ведёт на Linux только у гостей с Linux
            if (button.id === "mainDownload" && platform !== "linux") return;
            event.preventDefault();
            picker.showModal();
        });
    }
    $("#pickerClose")?.addEventListener("click", () => picker.close());
    // клик по затемнению: цель события — сам dialog, попадания в его
    // содержимое приходят от вложенных узлов
    picker.addEventListener("click", (event) => {
        if (event.target === picker) picker.close();
    });
    // выбрали сборку — окно закрывать, скачивание уже пошло
    for (const link of $$("[data-pick]", picker)) {
        link.addEventListener("click", () => picker.close());
    }
}

/**
 * Версии и размеры лежат в отдельном файле: обновить сборку — значит положить
 * новый файл и поправить одну строку в downloads.json. Файл кладут на сервер
 * руками при выкладке, и в сборку сайта он не попадает.
 */
interface Build {
    file?: string;
    size?: string;
}
interface Entry extends Build {
    version?: string;
    date?: string;
    builds?: Record<string, Build>;
}

try {
    const response = await fetch("/downloads.json", { cache: "no-cache" });
    if (response.ok) {
        const data: Record<string, Entry> = await response.json();
        const rows: [string, string, string][] = [
            ["android", "#verAndroid", "#dlAndroid"],
            ["windows", "#verWindows", "#dlWindows"],
            ["linux", "#verLinux", "#dlLinux"],
        ];

        for (const [key, verSel, linkSel] of rows) {
            const item = data[key];
            const node = $(verSel);
            const link = $<HTMLAnchorElement>(linkSel);
            if (!item || !node) continue;
            if (item.file && link) link.href = `/${item.file.replace(/^\//, "")}`;
            node.textContent = [
                item.version ? `версия ${item.version}` : null,
                item.size,
                item.date,
            ]
                .filter(Boolean)
                .join(" · ");
        }

        // у Linux один номер версии на три сборки, размер у каждой свой
        for (const [key, build] of Object.entries(data.linux?.builds ?? {})) {
            const link = $<HTMLAnchorElement>(`[data-pick="${key}"]`);
            if (!link) continue;
            if (build.file) link.href = `/${build.file.replace(/^\//, "")}`;
            if (build.size) link.textContent = `Скачать · ${build.size}`;
        }
    }
} catch {
    // файла нет — ссылки всё равно работают
}
