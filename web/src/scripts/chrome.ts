/**
 * Поведение общей обвязки: шапка отделяется от страницы, только когда под
 * ней что-то проехало.
 *
 * Живёт в макете, а не на главной. Раньше это было частью скрипта главной, и
 * на остальных страницах шапка оставалась прозрачной навсегда — текст ехал
 * под неё и становился нечитаемым.
 */
const header = document.querySelector(".top");

if (header) {
    const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
}
