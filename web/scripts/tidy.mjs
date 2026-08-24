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
const strays = ["content-assets.mjs", "content-modules.mjs"];

for (const name of strays) {
    await rm(new URL(name, out), { force: true });
}

console.log(`убрано лишнего: ${strays.length} файла из ${fileURLToPath(out)}`);
