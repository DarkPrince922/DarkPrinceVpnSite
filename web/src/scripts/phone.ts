/**
 * Живой макет приложения на главной.
 *
 * Гость может нажать кнопку подключения, выбрать сервер, замерить пинг и
 * переключить вкладки — так понятнее, чем по картинке, как всё устроено.
 * Данные условные, в сеть ничего не уходит.
 */

const phone = document.querySelector<HTMLElement>("#demoPhone");

if (phone) {
    const $ = <T extends Element = HTMLElement>(sel: string) => phone.querySelector<T>(sel)!;
    const $$ = <T extends Element = HTMLElement>(sel: string) => Array.from(phone.querySelectorAll<T>(sel));
    const conn = $("#phConn");
    const title = $("#phTitle");
    const line = $("#phLine");
    const power = $<HTMLButtonElement>("#phPower");

    let on = true;
    let busy = false;
    let since = Date.now() - 2544 * 1000; // «00:42:24» при загрузке
    let down = 1.24 * 1024; // МБ
    let up = 86.3;
    let selected = $<HTMLElement>(".ph-row.sel");

    const pad = (n: number) => String(n).padStart(2, "0");
    const traffic = () => {
        const d = down >= 1024 ? `${(down / 1024).toFixed(2).replace(".", ",")} ГБ` : `${down.toFixed(1).replace(".", ",")} МБ`;
        return `↓ ${d} · ↑ ${up.toFixed(1).replace(".", ",")} МБ`;
    };
    const header = () => {
        if (!on || busy) {
            conn.textContent = busy ? "Подключение…" : "";
            return;
        }
        const s = Math.floor((Date.now() - since) / 1000);
        conn.textContent = `${selected.dataset.flag} ${selected.dataset.city} · ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    };
    const paint = () => {
        phone.dataset.on = on ? "1" : "0";
        phone.dataset.busy = busy ? "1" : "0";
        title.textContent = busy ? "Подключение…" : on ? "Защищено" : "Не защищено";
        line.textContent = busy ? `${selected.dataset.flag} ${selected.dataset.city}` : on ? traffic() : "Нажмите, чтобы подключиться";
        header();
    };

    // раз в секунду тикают часы и счётчики
    setInterval(() => {
        if (!on || busy) return;
        down += 0.4 + Math.random() * 1.6;
        up += 0.05 + Math.random() * 0.2;
        paint();
    }, 1000);

    const connect = () => {
        busy = true;
        paint();
        setTimeout(() => {
            busy = false;
            on = true;
            since = Date.now();
            down = 0;
            up = 0;
            paint();
        }, 1200);
    };

    power.addEventListener("click", () => {
        if (busy) return;
        if (on) {
            on = false;
            paint();
        } else connect();
    });

    for (const row of $$<HTMLButtonElement>("#phList .ph-row")) {
        row.addEventListener("click", () => {
            if (row === selected || busy) return;
            selected.classList.remove("sel");
            row.classList.add("sel");
            selected = row;
            if (on) connect(); // как в приложении: переключаемся на лету
            else paint();
        });
    }

    // пинг: точки на месте задержки, потом новые числа
    const ping = $<HTMLButtonElement>("#phPing");
    ping.addEventListener("click", () => {
        if (phone.dataset.pinging === "1") return;
        phone.dataset.pinging = "1";
        const cells = $$<HTMLElement>("#phList em");
        for (const cell of cells) cell.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        setTimeout(() => {
            for (const cell of cells) {
                const base = Number(cell.dataset.ping);
                const value = Math.max(18, Math.round(base * (0.8 + Math.random() * 0.4)));
                cell.innerHTML = `${value}<small>мс</small>`;
            }
            phone.dataset.pinging = "0";
        }, 1100);
    });

    const refresh = $<HTMLButtonElement>("#phRefresh");
    refresh.addEventListener("click", () => {
        refresh.classList.add("spin");
        setTimeout(() => refresh.classList.remove("spin"), 800);
    });

    // нижний остров
    for (const tab of $$<HTMLButtonElement>("#phDock button")) {
        tab.addEventListener("click", () => {
            for (const other of $$("#phDock button")) other.classList.toggle("on", other === tab);
            for (const screen of $$<HTMLElement>(".ph-screen")) {
                screen.classList.toggle("on", screen.dataset.screen === tab.dataset.go);
            }
        });
    }

    paint();
}
