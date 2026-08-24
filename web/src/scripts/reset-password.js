// Страница по ссылке «сброс пароля» из письма. Отдельным файлом, а не внутри
// html: политика безопасности сайта запрещает встроенные скрипты.

import { $, request } from "./verify.js";

const token = new URLSearchParams(location.search).get("token");

const message = (text, type = "err") => {
    const node = $("#message");
    node.className = `msg ${type}`;
    node.textContent = text;
    node.classList.toggle("hidden", !text);
};

if (!token) {
    $("#form").classList.add("hidden");
    $("#title").textContent = "Ссылка неполная";
    message(
        "В ссылке нет кода. Откройте её из письма целиком — почтовые программы "
        + "иногда переносят длинные ссылки на новую строку и обрезают.",
        "err"
    );
}

$("#form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("#password").value;
    if (password !== $("#repeat").value) {
        message("Пароли не совпадают.");
        return;
    }
    message("");
    $("#submit").disabled = true;
    try {
        await request("cabinet/auth/password/reset", { token, password });
        $("#form").classList.add("hidden");
        $("#title").textContent = "Пароль изменён";
        message("Теперь войдите с новым паролем — в кабинете и в приложении.", "info");
        $("#done").classList.remove("hidden");
    } catch (error) {
        message(error.message);
    } finally {
        $("#submit").disabled = false;
    }
});
