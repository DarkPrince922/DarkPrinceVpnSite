/**
 * Уборка после сборки.
 *
 * Astro кладёт рядом с готовыми страницами пару служебных модулей своего
 * слоя контента. Работать сайту они не мешают, но лежат в корне сайта и
 * отдаются наружу вместе со страницами — а к сайту отношения не имеют.
 */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const out = new URL("../../site/", import.meta.url);
// Служебные модули слоя контента и схема коллекций справки. Работать сайту
// они не мешают, но отдаются наружу вместе со страницами, а к сайту
// отношения не имеют.
const strays = ["content-assets.mjs", "content-modules.mjs", "collections"];

for (const name of strays) {
    await rm(new URL(name, out), { force: true, recursive: true });
}

console.log(`прибрано в ${fileURLToPath(out)}: ${strays.join(", ")}`);
