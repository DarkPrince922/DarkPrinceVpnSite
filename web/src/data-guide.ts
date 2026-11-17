/**
 * Шаги подключения на главной: для каждой системы — список шагов, а к
 * каждому шагу картинка того, что человек увидит на экране. Картинки
 * нарисованы разметкой (см. .shot в app.css), а не снимками экрана: так они
 * чёткие на любом экране, весят ничего и переводятся вместе с текстом.
 *
 * В картинке обводкой (class="hl") показано, что нажать.
 */

export interface Step {
    title: string;
    sub: string;
    head: string;
    text: string;
    shot: string;
    /** Кнопка под картинкой — обычно «скачать». */
    action?: { text: string; href: string; id?: string; external?: boolean };
}

const app = (title: string, line: string, on: boolean) => `
<div class="shot app ${on ? "is-on" : ""}">
  <div class="sa-hero"><span class="sa-disc ${on ? "" : "hl"}">${on ? "✓" : "⏻"}</span><div><b>${title}</b><span>${line}</span></div></div>
  <div class="sa-card"><b>Премиум</b><span class="sa-chip">23 дня</span></div>
  <div class="sa-row sel">🇩🇪 Германия · Франкфурт<em>42 мс</em></div>
  <div class="sa-row">🇳🇱 Нидерланды · Лимбург<em>76 мс</em></div>
</div>`;

const login = (desktop: boolean) => `
<div class="shot login">
  <div class="sl-logo">DARKPRINCE <small>VPN</small></div>
  <div class="sl-field">E-mail</div><div class="sl-field">Пароль</div>
  <div class="sl-btn">Войти</div>
  <div class="sl-or">или</div>
  <div class="sl-tg hl">✈</div>
  ${desktop ? "" : '<div class="sl-note">Telegram откроется сам — нажмите там «Start»</div>'}
</div>`;

export const guide: Record<string, { name: string; steps: Step[] }> = {
    android: {
        name: "Android",
        steps: [
            {
                title: "Скачайте",
                sub: "Файл APK · 48 МБ",
                head: "Скачайте приложение",
                text: "Нажмите кнопку ниже — браузер скачает файл. Когда загрузится, нажмите «Открыть».",
                shot: `<div class="shot phone-dl"><div class="sd-bar"><span>📄</span><div><b>DarkPrinceVPN.apk</b><span>48 МБ · загружено</span></div><span class="sd-open hl">Открыть</span></div></div>`,
                action: { text: "Скачать для Android", href: "/downloads/DarkPrinceVPN.apk", id: "guideAndroid" },
            },
            {
                title: "Разрешите установку",
                sub: "Один раз",
                head: "Телефон спросит разрешение — это нормально",
                text: "Приложения нет в Google Play, поэтому Android переспрашивает. Нажмите «Настройки», включите переключатель и вернитесь назад.",
                shot: `<div class="shot dialog-a"><b>В целях безопасности установка неизвестных приложений из этого источника заблокирована</b><div class="dl-btns"><span>Отмена</span><span class="hl">Настройки</span></div></div>
<div class="shot toggle-a"><span>Разрешить установку из этого источника</span><i class="hl"></i></div>`,
            },
            {
                title: "Войдите",
                sub: "Telegram или почта",
                head: "Войдите тем же аккаунтом, что в боте",
                text: "Проще всего — круглой кнопкой Telegram: подписка и серверы подтянутся сами. Можно и по почте.",
                shot: login(false),
            },
            {
                title: "Нажмите кнопку",
                sub: "И вы защищены",
                head: "Нажмите большую кнопку",
                text: "Android один раз спросит разрешение на VPN — нажмите «ОК». Кнопка станет бирюзовой — вы защищены.",
                shot: `${app("Не защищено", "Нажмите, чтобы подключиться", false)}<div class="shot dialog-a small"><b>Запрос на подключение</b><span>DarkPrince VPN хочет создать VPN-подключение</span><div class="dl-btns"><span>Отмена</span><span class="hl">ОК</span></div></div>`,
            },
        ],
    },
    ios: {
        name: "iPhone",
        steps: [
            {
                title: "Установите INCY",
                sub: "Бесплатно в App Store",
                head: "Своего приложения для iPhone пока нет",
                text: "Подключаемся через INCY — бесплатный клиент из App Store. Работает так же: те же серверы и скорость.",
                shot: `<div class="shot store"><span class="ss-ico">IN</span><div><b>INCY</b><span>Утилиты · Бесплатно</span></div><span class="ss-get hl">Загрузить</span></div>`,
                action: { text: "Открыть App Store", href: "https://apps.apple.com/app/id6756943388", external: true },
            },
            {
                title: "Скопируйте ссылку",
                sub: "В личном кабинете",
                head: "Возьмите ссылку на подписку",
                text: "Откройте личный кабинет, раздел «Подписка», и нажмите «Скопировать ссылку».",
                shot: `<div class="shot cab"><b>Подключение</b><div class="sc-link">https://sub.dprince.online/…</div><span class="sc-btn hl">Скопировать ссылку</span></div>`,
                action: { text: "Открыть кабинет", href: "/cabinet.html" },
            },
            {
                title: "Добавьте в INCY",
                sub: "Из буфера обмена",
                head: "Вставьте ссылку в INCY",
                text: "В INCY нажмите «+» и выберите «Из буфера обмена» — список серверов появится сам.",
                shot: `<div class="shot sheet-i"><b>Добавить подписку</b><span class="hl">Из буфера обмена</span><span>Сканировать QR-код</span><span>Ввести вручную</span></div>`,
            },
            {
                title: "Разрешите VPN",
                sub: "И подключитесь",
                head: "iPhone спросит разрешение один раз",
                text: "Нажмите «Разрешить» и подтвердите код-паролем. Дальше включайте VPN кнопкой в INCY.",
                shot: `<div class="shot dialog-i"><b>«INCY» запрашивает разрешение на добавление конфигураций VPN</b><div class="di-btns"><span class="hl">Разрешить</span><span>Запретить</span></div></div>`,
            },
        ],
    },
    windows: {
        name: "Windows",
        steps: [
            {
                title: "Скачайте",
                sub: "Установщик · 17,5 МБ",
                head: "Скачайте установщик",
                text: "Windows 10 и 11. Всё нужное, включая ядро, уже внутри — доскачивать ничего не надо.",
                shot: `<div class="shot win-dl"><div class="wd-row"><span>📦</span><div><b>DarkPrinceVPN-setup.exe</b><span>17,5 МБ · Готово</span></div><span class="hl">Открыть файл</span></div></div>`,
                action: { text: "Скачать для Windows", href: "/downloads/DarkPrinceVPN-setup.exe", id: "guideWindows" },
            },
            {
                title: "Разрешите запуск",
                sub: "Окно SmartScreen",
                head: "Windows может предупредить — это нормально",
                text: "У программы нет платного сертификата, поэтому система спрашивает. Нажмите «Подробнее», затем «Выполнить в любом случае».",
                shot: `<div class="shot smartscreen"><b>Система Windows защитила ваш компьютер</b><p>Фильтр SmartScreen предотвратил запуск неопознанного приложения.</p><span class="ss-more hl">Подробнее</span><div class="ss-btns"><span class="hl">Выполнить в любом случае</span><span>Не выполнять</span></div></div>`,
            },
            {
                title: "Войдите",
                sub: "Telegram или почта",
                head: "Войдите тем же аккаунтом, что в боте",
                text: "Круглая кнопка Telegram откроет бота — нажмите там «Start». Подписка и серверы подтянутся сами.",
                shot: login(true),
            },
            {
                title: "Нажмите кнопку",
                sub: "И вы защищены",
                head: "Нажмите кнопку — и готово",
                text: "«Прокси» — для браузеров, без прав администратора. «Весь трафик» — для игр и всех программ. Крестик не выключает VPN: приложение уходит в трей у часов.",
                shot: app("Защищено", "↓ 1,24 ГБ · ↑ 86,3 МБ", true),
            },
        ],
    },
    linux: {
        name: "Linux",
        steps: [
            {
                title: "Выберите сборку",
                sub: "Под ваш дистрибутив",
                head: "Приложение одно — отличается упаковка",
                text: "Arch и Manjaro — пакет pacman, Ubuntu и Debian — .deb, всё остальное — AppImage.",
                shot: `<div class="shot pick"><div><b>Arch, Manjaro</b><span>.pkg.tar.zst</span></div><div class="hl"><b>Ubuntu, Debian, Mint</b><span>.deb</span></div><div><b>Любой другой</b><span>AppImage</span></div></div>`,
                action: { text: "Выбрать сборку", href: "/downloads/DarkPrinceVPN.AppImage", id: "guideLinux" },
            },
            {
                title: "Установите",
                sub: "Одна команда",
                head: "Поставьте пакет",
                text: "Зависимости подтянутся сами, ярлык появится в меню. AppImage ставить не нужно — сделайте файл исполняемым и запустите.",
                shot: `<div class="shot term"><span class="t-c"># Ubuntu, Debian</span><span>$ <b class="hl">sudo apt install ./DarkPrinceVPN.deb</b></span><span class="t-c"># Arch</span><span>$ sudo pacman -U DarkPrinceVPN.pkg.tar.zst</span><span class="t-c"># AppImage</span><span>$ chmod +x DarkPrinceVPN.AppImage</span></div>`,
            },
            {
                title: "Войдите",
                sub: "Telegram или почта",
                head: "Войдите тем же аккаунтом, что в боте",
                text: "Круглая кнопка Telegram откроет бота — нажмите там «Start». Подписка и серверы подтянутся сами.",
                shot: login(true),
            },
            {
                title: "Нажмите кнопку",
                sub: "И вы защищены",
                head: "Нажмите кнопку — и готово",
                text: "«Прокси» — без пароля, для браузеров. «Весь трафик» — для всех программ: система один раз спросит пароль.",
                shot: app("Защищено", "↓ 1,24 ГБ · ↑ 86,3 МБ", true),
            },
        ],
    },
};
