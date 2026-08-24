import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Справка: по странице на платформу.
 *
 * Тексты лежат в Markdown, а не в разметке: инструкции правят чаще всего, и
 * для этого не должно требоваться знание вёрстки. Схема ниже — не
 * формальность: без неё забытый заголовок или порядок вылезли бы кривой
 * страницей у людей, а так сборка просто не пройдёт.
 */
const help = defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/help" }),
    schema: z.object({
        title: z.string(),
        summary: z.string(),
        icon: z.string(),
        /** Порядок в списке: от самой ходовой платформы к редкой. */
        order: z.number(),
    }),
});

export const collections = { help };
