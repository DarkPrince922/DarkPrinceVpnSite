// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

/**
 * Сайт собирается в статику и раскладывается в `site/`, откуда его отдаёт
 * nginx. Ничего серверного: на машине с сайтом нет ни Node, ни сборки —
 * выкладка это по-прежнему `git pull`.
 *
 * Каталоги `downloads/` и `updates/` лежат в `public/`: сборка чистит папку
 * назначения, и без этого при первой же выкладке с сервера пропали бы
 * установщики и манифесты обновлений.
 */
export default defineConfig({
  site: "https://dprince.online",
  outDir: "../site",
  build: {
    // Страницы кладём файлами, а не папками: адреса /cabinet.html и
    // /verify-email.html уже разосланы в письмах и зашиты в приложения.
    // Формат по умолчанию превратил бы их в /cabinet/, и старые ссылки
    // перестали бы открываться.
    format: "file",
    // Стили можно вкладывать в разметку: CSP разрешает style-src 'unsafe-inline'.
    // Скрипты — нельзя, у них 'self', поэтому оставляем их отдельными файлами.
    inlineStylesheets: "auto",
    assets: "_astro",
  },
  integrations: [
    sitemap({
      // Кабинет и страницы по одноразовым ссылкам из писем в выдаче не нужны:
      // показывать там нечего, а адреса из писем живут считанные часы.
      filter: (page) => !/\/(cabinet|verify-email|reset-password)\/?$/.test(page),

      // Дополнение не знает про format: "file" и выдаёт адреса без .html —
      // то есть ведущие в 404. Скармливать поисковикам несуществующие
      // страницы — верный способ испортить себе выдачу, поэтому дописываем
      // расширение сами.
      serialize(item) {
        const path = new URL(item.url).pathname.replace(/\/$/, "");
        item.url = `https://dprince.online${path === "" ? "/" : `${path}.html`}`;
        return item;
      },
    }),
  ],
  devToolbar: { enabled: false },
  vite: {
    build: {
      // Ничего не встраивать в разметку. Astro по умолчанию вкладывает
      // маленькие скрипты прямо в страницу, а CSP разрешает только
      // script-src 'self' — встроенный код браузер молча не выполнит, и
      // страница приедет живой на вид, но мёртвой: без вкладок, без версий
      // под кнопками и без окна выбора сборки.
      assetsInlineLimit: 0,
    },
  },
});
