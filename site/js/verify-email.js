// Страница по ссылке «подтвердите почту» из письма. Отдельным файлом, а не
// внутри html: политика безопасности сайта запрещает встроенные скрипты.

import { $, request } from "./verify.js";

const token = new URLSearchParams(location.search).get("token");

if (!token) {
    $("#title").textContent = "Ссылка неполная";
    $("#text").textContent =
        "В ссылке нет кода подтверждения. Откройте её из письма целиком — почтовые "
        + "программы иногда переносят длинные ссылки на новую строку и обрезают.";
} else {
    try {
        await request("cabinet/auth/email/verify", { token });
        $("#title").textContent = "Почта подтверждена";
        $("#text").textContent = "Теперь можно войти в кабинет и в приложение.";
        $("#actions").classList.remove("hidden");
    } catch (error) {
        $("#title").textContent = "Подтвердить не вышло";
        $("#text").textContent = error.message;
    }
}
