// Живые события кабинета — сокет /cabinet/ws.
//
// Пришли деньги, продлилась подписка, ответила поддержка — кабинет говорит
// сразу, без перезагрузки страницы. Не поднялся сокет — ничего страшного:
// всё по-прежнему обновляется при переходах и по кнопкам.

import { api, session } from "./api.js";

let socket = null;
let failures = 0;
let timer = null;
let stopped = false;

export function startEvents() {
    stopped = false;
    connect();
}

export function stopEvents() {
    stopped = true;
    clearTimeout(timer);
    socket?.close(1000);
    socket = null;
}

async function freshToken() {
    // токен мог истечь — обновит любой запрос кабинета; берём уже свежий
    if (session.expiresAt && Date.now() > session.expiresAt - 30000) {
        try {
            await api.balance();
        } catch {
            // не вышло — попробуем со старым
        }
    }
    return session.access;
}

async function connect() {
    if (stopped || socket) return;
    const token = await freshToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // токен в адресе — так его ждёт бот; по https он не виден по дороге
    const ws = new WebSocket(`${proto}//${location.host}/api/cabinet/ws?token=${encodeURIComponent(token)}`);
    socket = ws;
    let pingTimer = null;
    ws.onopen = () => {
        failures = 0;
        pingTimer = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 30000);
    };
    ws.onmessage = (message) => {
        let data;
        try {
            data = JSON.parse(message.data);
        } catch {
            return;
        }
        if (!data.type || data.type === "pong" || data.type === "connected") return;
        window.dispatchEvent(new CustomEvent("cabinet-event", { detail: data }));
    };
    ws.onclose = () => {
        clearInterval(pingTimer);
        if (socket === ws) socket = null;
        if (stopped) return;
        failures += 1;
        const delay = [1000, 3000, 10000, 30000, 60000][Math.min(failures - 1, 4)];
        timer = setTimeout(connect, delay);
    };
}

// вкладку снова открыли — переподключаемся сразу, если сокет упал
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !socket && !stopped && session.loggedIn) {
        clearTimeout(timer);
        connect();
    }
});
