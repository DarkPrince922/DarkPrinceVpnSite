// Конструктор Xray-профилей в админке сайта. Всё считается в браузере:
// ключи, профили и черновики никуда не отправляются. Из сети берётся только
// список инбаундов панели — чтобы поймать повтор тега во всей панели.

import { api } from "../api.js";
import { el, clear, copy } from "../ui.js";
import * as M from "./model.js";

// Черновик живёт, пока открыта страница: в хранилище браузера его не кладём —
// в нём приватные ключи нод.
let profile = M.myStandardProfile();
let view = "inbounds";
let editing = null; // { list: "inbounds" | "outbounds" | "balancers", index, draft }
let panelInbounds = null;
let importedTags = new Set();
// что вписать в хосты: адрес ноды и домен, если инбаунд за CDN
let hostInfo = { address: "", domain: "" };
let randomOpts = { exotic: false, hasCert: false, certFile: "/etc/letsencrypt/live/example.com/fullchain.pem", keyFile: "/etc/letsencrypt/live/example.com/privkey.pem" };
let root = null;

const VIEWS = [
    ["inbounds", "Инбаунды"],
    ["outbounds", "Исходящие"],
    ["routing", "Маршруты"],
    ["balancers", "Балансировщики"],
    ["dns", "DNS"],
    ["hosts", "Хосты"],
    ["result", "Готово"],
];

export function renderForge(body) {
    root = body;
    draw();
    // инбаунды панели — сразу, чтобы случайные теги не совпали с занятыми
    if (!panelInbounds) {
        api.adminInbounds()
            .then((data) => {
                panelInbounds = (data.items || []).map((x) => ({ tag: x.tag, port: x.port }));
                if (root?.isConnected) refreshStatus();
            })
            .catch(() => { });
    }
}

function draw() {
    clear(root);
    root.append(toolbar(), tabs(), statusLine());
    const box = el("div");
    root.append(box);
    ({ inbounds: inboundsView, outbounds: outboundsView, routing: routingView, balancers: balancersView, dns: dnsView, hosts: hostsView, result: resultView })[view](box);
}

// ---------------- общие кусочки ----------------

const card = (title, ...children) => el("div", { class: "card forge-card" }, [title ? el("h3", { text: title }) : null, ...children]);
const hint = (text) => el("p", { class: "small muted forge-hint", text });

function field(label, input, note) {
    return el("label", { class: "field" }, [el("span", {}, label), input, note ? el("small", { class: "muted tiny", text: note }) : null]);
}

function input(value, onInput, attrs = {}) {
    return el("input", { type: "text", value: value ?? "", ...attrs, oninput: (e) => onInput(e.target.value) });
}

function select(options, value, onChange) {
    const node = el("select", { onchange: (e) => onChange(e.target.value) });
    for (const [v, label] of Array.isArray(options) ? options.map((o) => [o, o]) : Object.entries(options)) {
        node.append(el("option", { value: v, selected: String(v) === String(value) }, label));
    }
    return node;
}

function checkbox(label, checked, onChange) {
    return el("label", { class: "forge-check" }, [
        el("input", { type: "checkbox", checked, onchange: (e) => onChange(e.target.checked) }),
        el("span", { text: label }),
    ]);
}

function withButton(inputNode, label, onClick) {
    return el("div", { class: "forge-with-btn" }, [inputNode, el("button", { type: "button", class: "btn-sm", onclick: onClick }, label)]);
}

const grid = (...children) => el("div", { class: "forge-grid" }, children);
const btn = (label, onClick, cls = "btn-sm") => el("button", { type: "button", class: cls, onclick: onClick }, label);

function codeBlock(text) {
    const pre = el("pre", { class: "forge-pre", text });
    return el("div", { class: "forge-code" }, [pre, el("button", { type: "button", class: "btn-sm forge-copy", onclick: (e) => copy(text, e.currentTarget) }, "Копировать")]);
}

function notesList(notes) {
    return el("div", { class: "forge-notes" }, notes.map(([level, text]) => el("div", { class: `forge-note ${level}`, text })));
}

// ---------------- верх: пресеты, случайность, импорт ----------------

function toolbar() {
    const importBox = el("textarea", { class: "mono", placeholder: "Вставьте JSON профиля из панели", rows: 6 });
    const importNote = el("p", { class: "small" });
    const importCard = el("div", { class: "hidden", style: "margin-top:12px" }, [
        importBox,
        el("div", { class: "row wrap-row", style: "margin-top:8px" }, [
            btn("Загрузить в конструктор", () => {
                try {
                    profile = M.importProfile(importBox.value);
                    importedTags = new Set(profile.inbounds.map((x) => (x.spec ? x.spec.tag : x.raw.tag)));
                    editing = null;
                    view = "inbounds";
                    draw();
                } catch (error) {
                    importNote.className = "small danger";
                    importNote.textContent = "Не читается как JSON: " + error.message;
                }
            }, "btn-sm primary"),
        ]),
        importNote,
    ]);

    const certFields = el("div", { class: randomOpts.hasCert ? "" : "hidden" }, [
        grid(
            field("Сертификат на ноде", input(randomOpts.certFile, (v) => (randomOpts.certFile = v), { class: "mono" })),
            field("Ключ сертификата", input(randomOpts.keyFile, (v) => (randomOpts.keyFile = v), { class: "mono" })),
        ),
    ]);

    return card("Конструктор профилей",
        hint("Профили, инбаунды, исходящие, маршруты и балансировщики для Remnawave. Ключи генерируются здесь же и никуда не уходят. Готовый JSON вставляется в панель: «Профили конфигурации» → профиль → редактировать."),
        el("div", { class: "row wrap-row" }, [
            btn("Мой стандарт", () => { profile = M.myStandardProfile(); importedTags = new Set(); editing = null; draw(); }),
            btn("Пустой", () => { profile = M.blankProfile(); importedTags = new Set(); editing = null; draw(); }),
            btn("Импорт из панели", () => importCard.classList.toggle("hidden")),
            btn("🎲 Случайный профиль", () => {
                profile = M.randomProfile({ ...randomOpts, panelTags: (panelInbounds || []).map((x) => x.tag) });
                importedTags = new Set();
                editing = null;
                view = "inbounds";
                draw();
            }, "btn-sm primary"),
        ]),
        el("div", { class: "row wrap-row", style: "margin-top:10px" }, [
            checkbox("Экзотика: mKCP, CDN-схемы, постквантовая подпись, необычные порты", randomOpts.exotic, (v) => (randomOpts.exotic = v)),
            checkbox("На ноде есть TLS-сертификат (Trojan, Hysteria 2, WS+TLS)", randomOpts.hasCert, (v) => { randomOpts.hasCert = v; certFields.classList.toggle("hidden", !v); }),
        ]),
        certFields,
        importCard,
    );
}

function tabs() {
    const counts = { inbounds: profile.inbounds.length, outbounds: profile.outbounds.length, routing: profile.rules.length, balancers: profile.balancers.length };
    const bar = el("div", { class: "periods" });
    for (const [key, title] of VIEWS) {
        bar.append(el("button", {
            class: "btn-sm",
            "aria-selected": String(key === view),
            onclick: () => { view = key; editing = null; draw(); },
        }, counts[key] != null ? `${title} · ${counts[key]}` : title));
    }
    return bar;
}

function statusLine() {
    const notes = M.validate(profile, panelInbounds, importedTags);
    const bad = notes.filter(([l]) => l === "bad").length;
    const warn = notes.filter(([l]) => l === "warn").length;
    const text = bad ? `Ошибок: ${bad}${warn ? `, предупреждений: ${warn}` : ""} — подробности во вкладке «Готово»`
        : warn ? `Ошибок нет, предупреждений: ${warn}` : "Ошибок нет";
    return el("p", { class: `small forge-status ${bad ? "danger" : "ok"}`, id: "forgeStatus", text });
}

/** Обновить строку статуса, не перерисовывая форму — чтобы ввод не терял фокус. */
function refreshStatus() {
    const old = root.querySelector("#forgeStatus");
    if (old) old.replaceWith(statusLine());
}

// ---------------- инбаунды ----------------

function inboundTitle(x) {
    if (!x.spec) return [x.raw.tag || "без тега", `${x.raw.protocol || "?"} · порт ${x.raw.port} · правится как JSON`];
    const s = x.spec;
    const parts = [M.PROTOCOLS[s.protocol]];
    if (s.protocol !== "shadowsocks" && s.protocol !== "hysteria") parts.push(M.NETWORKS[s.network]);
    if (s.security !== "none") parts.push(s.security === "reality" ? "Reality" + (s.reality.pq ? " + ML-DSA" : "") : "TLS");
    if (s.protocol === "shadowsocks") parts.push(s.ss.method);
    parts.push(`порт ${s.port}`);
    return [s.tag || "без тега", parts.join(" · ")];
}

function usedPorts(exceptIndex = -1) {
    return new Set(profile.inbounds.filter((_, i) => i !== exceptIndex).map((x) => Number(x.spec ? x.spec.port : x.raw.port)));
}

function usedTags(exceptIndex = -1) {
    return new Set([
        ...profile.inbounds.filter((_, i) => i !== exceptIndex).map((x) => (x.spec ? x.spec.tag : x.raw.tag)),
        ...(panelInbounds || []).map((x) => x.tag),
    ]);
}

function inboundsView(box) {
    const list = card(null);
    if (!profile.inbounds.length) list.append(hint("Инбаундов пока нет. Добавьте свой или попросите случайный."));
    profile.inbounds.forEach((x, i) => {
        const [title, sub] = inboundTitle(x);
        list.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [el("div", { class: "title", text: title }), el("div", { class: "small muted", text: sub })]),
            el("div", { class: "row forge-actions" }, [
                btn("Изменить", () => { editing = { list: "inbounds", index: i, draft: structuredClone(x) }; draw(); }),
                btn("Копия", () => {
                    const copyItem = structuredClone(x);
                    if (copyItem.spec) {
                        copyItem.spec.tag = `${copyItem.spec.tag}_COPY`;
                        copyItem.spec.port = M.randInt(20000, 60000);
                        copyItem.spec.reality.privateKey = M.newX25519().privateKey;
                    } else copyItem.raw.tag = `${copyItem.raw.tag}_COPY`;
                    profile.inbounds.splice(i + 1, 0, copyItem);
                    draw();
                }),
                btn("✕", () => { profile.inbounds.splice(i, 1); draw(); }),
            ]),
        ]));
    });
    list.append(el("div", { class: "row wrap-row", style: "margin-top:10px" }, [
        btn("Добавить инбаунд", () => {
            const spec = M.blankSpec();
            spec.tag = M.defaultTag(spec);
            spec.port = usedPorts().has(443) ? M.randInt(20000, 60000) : 443;
            editing = { list: "inbounds", index: -1, draft: { spec } };
            draw();
        }, "btn-sm primary"),
        btn("🎲 Случайный инбаунд", () => {
            const spec = M.randomSpec({ ...randomOpts, usedPorts: usedPorts(), usedTags: usedTags() });
            editing = { list: "inbounds", index: -1, draft: { spec } };
            draw();
        }),
    ]));
    box.append(list);
    if (editing?.list === "inbounds") box.append(editing.draft.spec ? inboundEditor() : rawEditor("inbounds"));
}

function saveEditing() {
    const arr = profile[editing.list];
    if (editing.index < 0) arr.push(editing.draft);
    else arr[editing.index] = editing.draft;
    editing = null;
    draw();
}

function editorButtons() {
    return el("div", { class: "row wrap-row", style: "margin-top:6px" }, [
        btn(editing.index < 0 ? "Добавить в профиль" : "Сохранить", saveEditing, "btn-sm primary"),
        btn("Отмена", () => { editing = null; draw(); }),
    ]);
}

function rawEditor(list) {
    const raw = editing.draft.raw;
    const area = el("textarea", { class: "mono", rows: 16 }, JSON.stringify(raw, null, 2));
    const note = el("p", { class: "small" });
    return card(`Правка как JSON: ${raw.tag || ""}`,
        hint("Этот элемент сложнее, чем умеет форма, поэтому правится напрямую."),
        area, note,
        el("div", { class: "row wrap-row" }, [
            btn("Сохранить", () => {
                try {
                    editing.draft.raw = JSON.parse(area.value);
                    if (list === "inbounds") {
                        const spec = M.specFromInbound(editing.draft.raw);
                        if (spec && !spec._lossy) editing.draft = { spec };
                    }
                    saveEditing();
                } catch (error) {
                    note.className = "small danger";
                    note.textContent = "Ошибка в JSON: " + error.message;
                }
            }, "btn-sm primary"),
            btn("Отмена", () => { editing = null; draw(); }),
        ]));
}

function inboundEditor() {
    const spec = editing.draft.spec;
    const preview = el("div");
    const redraw = () => draw();
    const live = () => {
        clear(preview).append(codeBlock(JSON.stringify(M.inboundFromSpec(spec), null, 2)));
        refreshStatusFor(spec);
    };
    const set = (obj, key, cast = (v) => v) => (v) => { obj[key] = cast(v); live(); };

    const nets = Object.keys(M.COMPAT[spec.protocol]);
    const secs = M.COMPAT[spec.protocol][spec.network];
    const tagInput = input(spec.tag, set(spec, "tag"), { class: "mono" });
    const portInput = el("input", { type: "number", min: 1, max: 65535, value: spec.port, oninput: (e) => { spec.port = Number(e.target.value); live(); } });

    const parts = [
        grid(
            field("Протокол", select(M.PROTOCOLS, spec.protocol, (v) => { spec.protocol = v; spec.security = null; M.normalizeSpec(spec); spec.tag = M.defaultTag(spec); redraw(); })),
            spec.protocol === "shadowsocks" || spec.protocol === "hysteria" ? null
                : field("Транспорт", select(Object.fromEntries(nets.map((n) => [n, M.NETWORKS[n]])), spec.network, (v) => { spec.network = v; M.normalizeSpec(spec); spec.tag = M.defaultTag(spec); redraw(); })),
            secs.length > 1 ? field("Защита", select(Object.fromEntries(secs.map((s) => [s, M.SECURITIES[s]])), spec.security, (v) => { spec.security = v; spec.tag = M.defaultTag(spec); redraw(); })) : null,
        ),
        grid(
            field("Тег", withButton(tagInput, "Авто", () => { spec.tag = M.defaultTag(spec); tagInput.value = spec.tag; live(); })),
            field("Порт", withButton(portInput, "🎲", () => {
                const used = usedPorts(editing.index);
                spec.port = [...M.SAFE_PORTS].find((p) => !used.has(p) && M.chance(0.5)) ?? M.randInt(20000, 60000);
                portInput.value = spec.port;
                live();
            })),
            field("Слушать адрес", input(spec.listen, set(spec, "listen"), { class: "mono" })),
        ),
    ];

    if (spec.security === "reality") parts.push(realityBlock(spec, live));
    if (spec.security === "tls") parts.push(tlsBlock(spec, live));
    parts.push(transportBlock(spec, live));
    if (spec.protocol === "shadowsocks") parts.push(ssBlock(spec, live, redraw));
    parts.push(extrasBlock(spec, live));
    parts.push(el("h4", { class: "section-title", style: "margin-top:12px", text: "Что получится" }), preview, editorButtons());
    live();
    return card(editing.index < 0 ? "Новый инбаунд" : `Инбаунд ${spec.tag}`, ...parts);
}

function refreshStatusFor() {
    // во время правки проверяем профиль так, будто черновик уже сохранён
    const backup = profile.inbounds;
    profile.inbounds = editing.index < 0 ? [...backup, editing.draft] : backup.map((x, i) => (i === editing.index ? editing.draft : x));
    refreshStatus();
    profile.inbounds = backup;
}

function realityBlock(spec, live) {
    const r = spec.reality;
    const pub = el("input", { type: "text", class: "mono", readonly: true, value: M.publicOf(r.privateKey) || "" });
    const priv = input(r.privateKey, (v) => { r.privateKey = v.trim(); pub.value = M.publicOf(r.privateKey) || ""; live(); }, { class: "mono", spellcheck: "false" });
    const dest = input(r.dest, (v) => { r.dest = v; live(); }, { class: "mono" });
    const sni = input(r.serverNames.join(", "), (v) => { r.serverNames = v.split(/[\s,]+/).filter(Boolean); live(); }, { class: "mono" });
    const sids = input(r.shortIds.map((s) => s || '""').join(", "), (v) => {
        r.shortIds = v.split(/[\s,]+/).filter((s) => s !== "").map((s) => (s === '""' ? "" : s.toLowerCase()));
        live();
    }, { class: "mono" });
    let sidCount = 2, sidLen = 8, sidEmpty = true;

    const chips = el("div", { class: "row wrap-row forge-chips" }, M.DESTS.map((d) => el("button", {
        type: "button", class: "chip",
        onclick: () => { r.dest = `${d}:443`; r.serverNames = [d]; dest.value = r.dest; sni.value = d; live(); },
    }, d)));

    const seedInput = input(r.seed, (v) => { r.seed = v.trim(); live(); }, { class: "mono" });
    const seedBox = el("div", { class: r.pq ? "" : "hidden" }, [
        field("Seed для ML-DSA-65", withButton(seedInput, "Новый", () => { r.seed = M.newSeed(); seedInput.value = r.seed; live(); }),
            "Клиент проверяет подпись постквантовым ключом. Нужны свежие Xray на нодах и у клиентов."),
    ]);

    return el("div", { class: "forge-block" }, [
        el("h4", { class: "section-title", text: "Reality" }),
        field("Под какой сайт маскироваться (dest)", dest, "TLS 1.3 + HTTP/2, открывается из России. Проверка с ноды: xray tls ping сайт"),
        chips,
        field("serverNames", sni),
        field("Приватный ключ", withButton(priv, "Новый", () => {
            const pair = M.newX25519();
            r.privateKey = pair.privateKey;
            priv.value = pair.privateKey;
            pub.value = pair.publicKey;
            live();
        })),
        field("Публичный ключ — панель посчитает его сама", pub),
        field("shortIds (через запятую, пустой — \"\")", sids),
        el("div", { class: "row wrap-row" }, [
            select({ 1: "1 shortId", 2: "2 shortId", 3: "3 shortId", 4: "4 shortId" }, sidCount, (v) => (sidCount = Number(v))),
            select({ 4: "4 символа", 8: "8 символов", 12: "12 символов", 16: "16 символов" }, sidLen, (v) => (sidLen = Number(v))),
            checkbox("+ пустой", sidEmpty, (v) => (sidEmpty = v)),
            btn("Сгенерировать", () => {
                r.shortIds = [...(sidEmpty ? [""] : []), ...Array.from({ length: sidCount }, () => M.hex(sidLen))];
                sids.value = r.shortIds.map((s) => s || '""').join(", ");
                live();
            }),
        ]),
        grid(
            field("xver (PROXY protocol к сайту)", select({ 0: "0 — выкл", 1: "1", 2: "2" }, r.xver, (v) => { r.xver = Number(v); live(); })),
        ),
        checkbox("Постквантовая подпись ML-DSA-65", r.pq, (v) => { r.pq = v; seedBox.classList.toggle("hidden", !v); live(); }),
        seedBox,
    ]);
}

function tlsBlock(spec, live) {
    const t = spec.tls;
    const alpnOptions = spec.network === "hysteria" ? [] : ["h2", "http/1.1", "h3"];
    return el("div", { class: "forge-block" }, [
        el("h4", { class: "section-title", text: "TLS" }),
        grid(
            field("Файл сертификата", input(t.certFile, (v) => { t.certFile = v; live(); }, { class: "mono" })),
            field("Файл ключа", input(t.keyFile, (v) => { t.keyFile = v; live(); }, { class: "mono" })),
        ),
        hint("Путь в контейнере панели (она вставит сертификат в конфиг сама) или в контейнере ноды."),
        alpnOptions.length ? el("div", { class: "row wrap-row" }, alpnOptions.map((a) => checkbox(`ALPN ${a}`, t.alpn.includes(a), (v) => {
            t.alpn = v ? [...new Set([...t.alpn, a])] : t.alpn.filter((x) => x !== a);
            live();
        }))) : hint("Hysteria 2 работает поверх QUIC — ALPN h3 ставится сам."),
        grid(
            field("Минимальная версия TLS", select({ "1.2": "1.2", "1.3": "1.3" }, t.minVersion, (v) => { t.minVersion = v; live(); })),
        ),
        checkbox("Отклонять неизвестный SNI (сканеры увидят обрыв, а не ваш сертификат)", t.rejectUnknownSni, (v) => { t.rejectUnknownSni = v; live(); }),
    ]);
}

function transportBlock(spec, live) {
    const pathField = (obj, label) => {
        const node = input(obj.path, (v) => { obj.path = v; live(); }, { class: "mono" });
        return field(label, withButton(node, "🎲", () => { obj.path = "/" + M.word(); node.value = obj.path; live(); }));
    };
    const hostField = (obj) => field("Host (для CDN — ваш домен)", input(obj.host, (v) => { obj.host = v; live(); }, { class: "mono" }));
    const n = spec.network;
    if (n === "xhttp") {
        return el("div", { class: "forge-block" }, [
            el("h4", { class: "section-title", text: "XHTTP" }),
            grid(pathField(spec.xhttp, "Путь"), hostField(spec.xhttp),
                field("Режим", select(M.XHTTP_MODES, spec.xhttp.mode, (v) => { spec.xhttp.mode = v; live(); }))),
            hint("auto — клиент выберет сам. packet-up проходит почти любые CDN, stream-one — быстрее напрямую."),
        ]);
    }
    if (n === "grpc") {
        const node = input(spec.grpc.serviceName, (v) => { spec.grpc.serviceName = v; live(); }, { class: "mono" });
        return el("div", { class: "forge-block" }, [
            el("h4", { class: "section-title", text: "gRPC" }),
            field("serviceName", withButton(node, "🎲", () => { spec.grpc.serviceName = M.word(); node.value = spec.grpc.serviceName; live(); })),
        ]);
    }
    if (n === "ws" || n === "httpupgrade") {
        return el("div", { class: "forge-block" }, [
            el("h4", { class: "section-title", text: n === "ws" ? "WebSocket" : "HTTPUpgrade" }),
            grid(pathField(spec[n], "Путь"), hostField(spec[n])),
        ]);
    }
    if (n === "kcp") {
        const num = (key, label) => field(label, el("input", { type: "number", value: spec.kcp[key], oninput: (e) => { spec.kcp[key] = Number(e.target.value); live(); } }));
        return el("div", { class: "forge-block" }, [
            el("h4", { class: "section-title", text: "mKCP" }),
            hint("UDP-транспорт: быстрее на плохих каналах, но заметнее для DPI и тратит больше трафика."),
            grid(num("mtu", "MTU"), num("tti", "TTI, мс"), num("up", "Отдача, МБ/с"), num("down", "Приём, МБ/с")),
            checkbox("Контроль перегрузки", spec.kcp.congestion, (v) => { spec.kcp.congestion = v; live(); }),
        ]);
    }
    if (n === "hysteria") return hint("Hysteria 2: UDP/QUIC с собственным контролем скорости. Пароли пользователей панель подставит сама.");
    return el("div");
}

function ssBlock(spec, live, redraw) {
    const pass = input(spec.ss.password, (v) => { spec.ss.password = v.trim(); live(); }, { class: "mono" });
    return el("div", { class: "forge-block" }, [
        el("h4", { class: "section-title", text: "Shadowsocks" }),
        field("Шифр", select(M.SS_METHODS, spec.ss.method, (v) => { spec.ss.method = v; spec.tag = M.defaultTag(spec); redraw(); })),
        spec.ss.method.startsWith("2022")
            ? field("Ключ сервера (32 байта, base64)", withButton(pass, "Новый", () => { spec.ss.password = M.newSsKey(); pass.value = spec.ss.password; live(); }))
            : hint("Для старых шифров ключ у каждого пользователя свой — панель подставит."),
    ]);
}

function extrasBlock(spec, live) {
    const dests = el("div", { class: `row wrap-row ${spec.sniffing ? "" : "hidden"}` }, ["http", "tls", "quic", "fakedns"].map((d) => checkbox(d, spec.sniffDest.includes(d), (v) => {
        spec.sniffDest = v ? [...new Set([...spec.sniffDest, d])] : spec.sniffDest.filter((x) => x !== d);
        live();
    })));
    return el("div", { class: "forge-block" }, [
        el("h4", { class: "section-title", text: "Дополнительно" }),
        checkbox("Sniffing — нужен для правил по доменам", spec.sniffing, (v) => { spec.sniffing = v; dests.classList.toggle("hidden", !v); live(); }),
        dests,
        checkbox("routeOnly — домен только для маршрутизации, соединяться по исходному IP", spec.routeOnly, (v) => { spec.routeOnly = v; live(); }),
        spec.protocol === "shadowsocks" ? null : checkbox("TCP Fast Open", spec.tfo, (v) => { spec.tfo = v; live(); }),
        spec.protocol === "shadowsocks" ? null : checkbox("Принимать PROXY protocol (если перед нодой HAProxy/nginx)", spec.proxyProtocol, (v) => { spec.proxyProtocol = v; live(); }),
    ]);
}

// ---------------- исходящие ----------------

function outboundsView(box) {
    const list = card(null);
    profile.outbounds.forEach((o, i) => {
        const sub = o.kind === "raw" ? `${o.raw.protocol} · правится как JSON` : M.OUTBOUND_KINDS[o.kind];
        list.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [el("div", { class: "title", text: o.tag || "без тега" }), el("div", { class: "small muted", text: sub })]),
            el("div", { class: "row forge-actions" }, [
                i > 0 ? btn("↑", () => { [profile.outbounds[i - 1], profile.outbounds[i]] = [profile.outbounds[i], profile.outbounds[i - 1]]; draw(); }) : null,
                btn("Изменить", () => { editing = { list: "outbounds", index: i, draft: structuredClone(o) }; draw(); }),
                btn("✕", () => { profile.outbounds.splice(i, 1); draw(); }),
            ]),
        ]));
    });
    let kind = "direct";
    list.append(hint("Первый в списке — куда уходит трафик, если ни одно правило не сработало."));
    list.append(el("div", { class: "row wrap-row", style: "margin-top:8px" }, [
        select(M.OUTBOUND_KINDS, kind, (v) => (kind = v)),
        btn("Добавить", () => {
            const tag = { direct: "DIRECT_2", block: "BLOCK_2", fragment: "FRAGMENT", warp: "WARP", chain: `CHAIN_${M.hex(4).toUpperCase()}`, socks: "SOCKS", http: "HTTP_PROXY", dns: "dns-out" }[kind];
            editing = { list: "outbounds", index: -1, draft: M.blankOutbound(kind, tag) };
            draw();
        }, "btn-sm primary"),
    ]));
    box.append(list);
    if (editing?.list === "outbounds") box.append(editing.draft.kind === "raw" ? outboundRaw() : outboundEditor());
}

function outboundRaw() {
    const o = editing.draft;
    const area = el("textarea", { class: "mono", rows: 14 }, JSON.stringify(o.raw, null, 2));
    const note = el("p", { class: "small" });
    return card(`Правка как JSON: ${o.tag}`, area, note, el("div", { class: "row wrap-row" }, [
        btn("Сохранить", () => {
            try {
                const raw = JSON.parse(area.value);
                editing.draft = M.outboundSpecFrom(raw);
                saveEditing();
            } catch (error) {
                note.className = "small danger";
                note.textContent = "Ошибка в JSON: " + error.message;
            }
        }, "btn-sm primary"),
        btn("Отмена", () => { editing = null; draw(); }),
    ]));
}

function outboundEditor() {
    const o = editing.draft;
    const preview = el("div");
    const live = () => clear(preview).append(codeBlock(JSON.stringify(M.outboundFromSpec(o), null, 2)));
    const text = (key, label, note, attrs = {}) => field(label, input(o[key], (v) => { o[key] = v; live(); }, { class: "mono", ...attrs }), note);
    const parts = [field("Тег", input(o.tag, (v) => { o.tag = v.trim(); live(); }, { class: "mono" }))];

    if (o.kind === "direct" || o.kind === "fragment" || o.kind === "warp") {
        parts.push(field("Стратегия доменов", select(M.DOMAIN_STRATEGIES, o.domainStrategy, (v) => { o.domainStrategy = v; live(); }),
            "ForceIPv4 — всегда через IPv4: часть сервисов режет IPv6 дата-центров."));
    }
    if (o.kind === "fragment") {
        parts.push(hint("Режет TLS ClientHello на куски — помогает ноде достучаться до сайтов за DPI (полезно для нод в России)."),
            grid(text("packets", "Что резать", "tlshello или 1-3"), text("length", "Длина кусков"), text("interval", "Пауза, мс")));
    }
    if (o.kind === "warp") {
        parts.push(hint("Ключ и адреса берутся из конфига WARP: wgcf register && wgcf generate, или из warp-plus."),
            text("secretKey", "PrivateKey из конфига WARP"),
            grid(text("v4", "Адрес IPv4"), text("v6", "Адрес IPv6 (необязательно)")),
            grid(text("endpoint", "Endpoint"), text("reserved", "reserved (три числа, необязательно)")));
    }
    if (o.kind === "chain") {
        const idInput = input(o.id, (v) => { o.id = v.trim(); live(); }, { class: "mono" });
        parts.push(hint("Трафик уходит дальше через другую ноду. На той ноде заведите пользователя с этим UUID, а данные Reality возьмите из её хоста."),
            grid(text("address", "Адрес ноды"), field("Порт", el("input", { type: "number", value: o.port, oninput: (e) => { o.port = Number(e.target.value); live(); } }))),
            field("UUID пользователя", withButton(idInput, "🎲", () => { o.id = M.uuid(); idInput.value = o.id; live(); })),
            grid(
                field("Транспорт", select({ tcp: "TCP", xhttp: "XHTTP", grpc: "gRPC" }, o.network, (v) => { o.network = v; draw(); })),
                field("Отпечаток", select(M.FINGERPRINTS, o.fingerprint, (v) => { o.fingerprint = v; live(); })),
            ),
            grid(text("sni", "SNI"), text("publicKey", "Публичный ключ Reality"), text("shortId", "shortId")));
        if (o.network === "xhttp") parts.push(text("path", "Путь XHTTP"));
        if (o.network === "grpc") parts.push(text("serviceName", "serviceName"));
    }
    if (o.kind === "socks" || o.kind === "http") {
        parts.push(grid(text("address", "Адрес"), field("Порт", el("input", { type: "number", value: o.port, oninput: (e) => { o.port = Number(e.target.value); live(); } }))),
            grid(text("user", "Логин (необязательно)"), text("pass", "Пароль")));
    }
    if (o.kind === "dns") parts.push(hint("Перехватывает DNS-запросы и отвечает через раздел DNS профиля. Направьте в него правило: порт 53."));

    parts.push(el("h4", { class: "section-title", style: "margin-top:12px", text: "Что получится" }), preview, editorButtons());
    live();
    return card(editing.index < 0 ? "Новый исходящий" : `Исходящий ${o.tag}`, ...parts);
}

// ---------------- маршруты ----------------

function targets() {
    return [
        ...profile.outbounds.map((o) => [o.tag, o.tag]),
        ...profile.balancers.map((b) => [`bal:${b.tag}`, `⚖ ${b.tag}`]),
    ];
}

function ensureOutbound(tag) {
    if (profile.outbounds.some((o) => o.tag === tag)) return;
    if (tag === "BLOCK") profile.outbounds.push(M.blankOutbound("block", "BLOCK"));
    if (tag === "IPv4_ONLY") profile.outbounds.push({ ...M.blankOutbound("direct", "IPv4_ONLY"), domainStrategy: "UseIPv4" });
    if (tag === "WARP") profile.outbounds.push(M.blankOutbound("warp", "WARP"));
    if (tag === "DIRECT") profile.outbounds.unshift(M.blankOutbound("direct", "DIRECT"));
}

/** Новое правило — перед финальным «всё остальное», иначе до него не дойдёт очередь. */
function addRule(rule) {
    const last = profile.rules[profile.rules.length - 1];
    const isCatchAll = last && last.network === "tcp,udp" && !last.domain && !last.ip && !last.protocol && !last.port && !last.inboundTag;
    if (isCatchAll) profile.rules.splice(profile.rules.length - 1, 0, rule);
    else profile.rules.push(rule);
}

function routingView(box) {
    const list = card(null,
        field("Стратегия доменов маршрутизации", select(M.ROUTING_STRATEGIES, profile.routingStrategy, (v) => { profile.routingStrategy = v; refreshStatus(); }),
            "IPIfNonMatch — сначала правила по доменам, потом по IP. Самый частый выбор."),
    );
    if (!profile.rules.length) list.append(hint("Правил нет: весь трафик пойдёт в первый исходящий."));
    profile.rules.forEach((rule, i) => {
        list.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [
                el("div", { class: "title", text: M.ruleSummary(rule) }),
                el("div", { class: "small muted", text: `→ ${M.ruleTarget(rule)}` }),
            ]),
            el("div", { class: "row forge-actions" }, [
                i > 0 ? btn("↑", () => { [profile.rules[i - 1], profile.rules[i]] = [profile.rules[i], profile.rules[i - 1]]; draw(); }) : null,
                i < profile.rules.length - 1 ? btn("↓", () => { [profile.rules[i + 1], profile.rules[i]] = [profile.rules[i], profile.rules[i + 1]]; draw(); }) : null,
                btn("✕", () => { profile.rules.splice(i, 1); draw(); }),
            ]),
        ]));
    });
    box.append(list);

    // готовые правила
    box.append(card("Готовые правила",
        el("div", { class: "row wrap-row" }, M.RULE_PRESETS.map((preset) => btn(preset.title, () => {
            ensureOutbound(preset.needs);
            addRule(preset.make());
            draw();
        }))),
        hint("Нужный исходящий (BLOCK, IPv4_ONLY, WARP) добавится сам. У WARP останется вписать ключ."),
        telegramOnly(),
        catchAllRow(),
    ));

    box.append(customRule());
}

function telegramOnly() {
    const tags = profile.inbounds.map((x) => (x.spec ? x.spec.tag : x.raw.tag)).filter(Boolean);
    if (!tags.length) return null;
    let tag = tags[0];
    return el("div", { class: "row wrap-row", style: "margin-top:10px" }, [
        el("span", { class: "small", text: "Только Telegram для входа" }),
        select(tags, tag, (v) => (tag = v)),
        btn("Добавить", () => {
            ensureOutbound("DIRECT");
            ensureOutbound("BLOCK");
            // эти правила должны стоять раньше общих
            profile.rules.unshift(...M.telegramOnlyRules(tag));
            draw();
        }),
    ]);
}

function catchAllRow() {
    const opts = targets();
    if (!opts.length) return null;
    let target = opts[0][0];
    return el("div", { class: "row wrap-row", style: "margin-top:10px" }, [
        el("span", { class: "small", text: "Всё остальное →" }),
        select(Object.fromEntries(opts), target, (v) => (target = v)),
        btn("Добавить в конец", () => {
            const bal = target.startsWith("bal:");
            profile.rules.push(M.catchAll(bal ? target.slice(4) : target, bal));
            draw();
        }),
    ]);
}

function customRule() {
    const draft = { domain: "", ip: "", port: "", network: "", protocol: [], inboundTag: [] };
    const opts = targets();
    let target = opts[0]?.[0] || "";
    const note = el("p", { class: "small" });
    const inTags = profile.inbounds.map((x) => (x.spec ? x.spec.tag : x.raw.tag)).filter(Boolean);
    return card("Своё правило",
        grid(
            field("Домены", el("textarea", { class: "mono", rows: 3, placeholder: "geosite:telegram\ndomain:example.com\nfull:api.site.ru", oninput: (e) => (draft.domain = e.target.value) })),
            field("IP и подсети", el("textarea", { class: "mono", rows: 3, placeholder: "geoip:ru\n1.1.1.0/24", oninput: (e) => (draft.ip = e.target.value) })),
        ),
        grid(
            field("Порт", input("", (v) => (draft.port = v), { class: "mono", placeholder: "53 или 1000-2000" })),
            field("Сеть", select({ "": "любая", tcp: "TCP", udp: "UDP", "tcp,udp": "TCP и UDP" }, "", (v) => (draft.network = v))),
        ),
        el("div", { class: "row wrap-row" }, ["bittorrent", "http", "tls", "quic"].map((p) => checkbox(p, false, (v) => {
            draft.protocol = v ? [...draft.protocol, p] : draft.protocol.filter((x) => x !== p);
        }))),
        inTags.length ? el("div", { class: "row wrap-row" }, [el("span", { class: "small muted", text: "Только для входов:" }), ...inTags.map((t) => checkbox(t, false, (v) => {
            draft.inboundTag = v ? [...draft.inboundTag, t] : draft.inboundTag.filter((x) => x !== t);
        }))]) : null,
        el("div", { class: "row wrap-row", style: "margin-top:10px" }, [
            el("span", { class: "small", text: "Куда:" }),
            select(Object.fromEntries(opts), target, (v) => (target = v)),
            btn("Добавить правило", () => {
                const list = (text) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
                const rule = { type: "field" };
                if (list(draft.domain).length) rule.domain = list(draft.domain);
                if (list(draft.ip).length) rule.ip = list(draft.ip);
                if (draft.port.trim()) rule.port = draft.port.trim();
                if (draft.network) rule.network = draft.network;
                if (draft.protocol.length) rule.protocol = draft.protocol;
                if (draft.inboundTag.length) rule.inboundTag = draft.inboundTag;
                if (Object.keys(rule).length === 1) {
                    note.className = "small danger";
                    note.textContent = "Укажите хотя бы одно условие.";
                    return;
                }
                if (target.startsWith("bal:")) rule.balancerTag = target.slice(4);
                else rule.outboundTag = target;
                addRule(rule);
                draw();
            }, "btn-sm primary"),
        ]),
        note,
    );
}

// ---------------- балансировщики ----------------

function balancersView(box) {
    const list = card(null,
        hint("Балансировщик распределяет трафик между несколькими исходящими: цепочками на разные ноды, WARP-аккаунтами, прокси. Для «пинга» и «нагрузки» наблюдатель добавится в профиль сам."),
        field("Адрес для проверки пинга", input(profile.probeUrl, (v) => { profile.probeUrl = v.trim(); refreshStatus(); }, { class: "mono" })),
    );
    profile.balancers.forEach((b, i) => {
        list.append(el("div", { class: "list-item" }, [
            el("div", { class: "grow" }, [
                el("div", { class: "title", text: `⚖ ${b.tag}` }),
                el("div", { class: "small muted", text: `${M.BALANCER_STRATEGIES[b.strategy] || b.strategy} · из ${b.selector.join(", ") || "—"}${b.fallbackTag ? ` · запасной ${b.fallbackTag}` : ""}` }),
            ]),
            el("div", { class: "row forge-actions" }, [
                btn("Изменить", () => { editing = { list: "balancers", index: i, draft: structuredClone(b) }; draw(); }),
                btn("✕", () => { profile.balancers.splice(i, 1); draw(); }),
            ]),
        ]));
    });
    list.append(el("div", { class: "row wrap-row", style: "margin-top:8px" }, [
        btn("Добавить балансировщик", () => {
            editing = { list: "balancers", index: -1, draft: { tag: `BALANCER${profile.balancers.length ? "_" + (profile.balancers.length + 1) : ""}`, selector: [], strategy: "leastPing", fallbackTag: "DIRECT" } };
            draw();
        }, "btn-sm primary"),
    ]));
    box.append(list);
    if (editing?.list === "balancers") box.append(balancerEditor());
}

function balancerEditor() {
    const b = editing.draft;
    const outTags = profile.outbounds.map((o) => o.tag).filter(Boolean);
    const prefix = input(b.selector.filter((s) => !outTags.includes(s)).join(", "), (v) => {
        b.selector = [...b.selector.filter((s) => outTags.includes(s)), ...v.split(/[\s,]+/).filter(Boolean)];
    }, { class: "mono", placeholder: "CHAIN_" });
    return card(editing.index < 0 ? "Новый балансировщик" : `Балансировщик ${b.tag}`,
        field("Тег", input(b.tag, (v) => (b.tag = v.trim()), { class: "mono" })),
        el("span", { class: "small muted", text: "Из каких исходящих выбирать" }),
        el("div", { class: "row wrap-row" }, outTags.map((t) => checkbox(t, b.selector.includes(t), (v) => {
            b.selector = v ? [...new Set([...b.selector, t])] : b.selector.filter((x) => x !== t);
        }))),
        field("Или по началу тега", prefix, "Например CHAIN_ — подойдут все исходящие, чей тег так начинается."),
        grid(
            field("Как выбирать", select(M.BALANCER_STRATEGIES, b.strategy, (v) => (b.strategy = v))),
            field("Если все недоступны", select({ "": "—", ...Object.fromEntries(outTags.map((t) => [t, t])) }, b.fallbackTag, (v) => (b.fallbackTag = v))),
        ),
        hint("Чтобы балансировщик заработал, направьте в него правило — например «Всё остальное → ⚖ тег» во вкладке «Маршруты»."),
        editorButtons(),
    );
}

// ---------------- DNS ----------------

function dnsView(box) {
    const d = profile.dns;
    const body = el("div", { class: d.enabled ? "" : "hidden" });
    const custom = input("", () => { }, { class: "mono", placeholder: "https://dns.example/dns-query" });
    const fill = () => {
        clear(body).append(
            el("span", { class: "small muted", text: "Серверы по порядку" }),
            el("div", { class: "row wrap-row" }, Object.entries(M.DNS_SERVERS).map(([addr, label]) => checkbox(label, d.servers.includes(addr), (v) => {
                d.servers = v ? [...d.servers, addr] : d.servers.filter((x) => x !== addr);
                fill();
                refreshStatus();
            }))),
            d.servers.length ? el("p", { class: "mono", text: d.servers.join("  →  ") }) : null,
            field("Свой сервер", withButton(custom, "Добавить", () => {
                if (custom.value.trim()) d.servers.push(custom.value.trim());
                custom.value = "";
                fill();
            })),
            field("Каких адресов просить", select({ UseIP: "IPv4 и IPv6", UseIPv4: "Только IPv4", UseIPv6: "Только IPv6" }, d.queryStrategy, (v) => (d.queryStrategy = v))),
        );
    };
    fill();
    box.append(card("DNS ноды",
        hint("По умолчанию нода спрашивает системный DNS. Свой DNS нужен, чтобы резать рекламу (AdGuard), обходить подмену ответов или получать только IPv4."),
        checkbox("Задать DNS в профиле", d.enabled, (v) => { d.enabled = v; body.classList.toggle("hidden", !v); refreshStatus(); }),
        body,
    ));
}

// ---------------- хосты ----------------

/**
 * Что вписать в хост панели для каждого инбаунда. Панель многое берёт из
 * инбаунда сама: публичный ключ Reality, первый shortId, SNI из serverNames,
 * путь и serviceName. Такие поля показаны для сверки, вписывать их не нужно.
 */
function hostsView(box) {
    const addr = input(hostInfo.address, (v) => { hostInfo.address = v.trim(); fill(); }, { class: "mono", placeholder: "IP или домен ноды" });
    const dom = input(hostInfo.domain, (v) => { hostInfo.domain = v.trim(); fill(); }, { class: "mono", placeholder: "vpn.example.com" });
    const cards = el("div");
    box.append(card("Хосты в панели",
        hint("Хост — это то, что увидит клиент в подписке. Создаётся в панели: «Хосты» → «Создать», выберите профиль и инбаунд и перенесите поля из карточки."),
        grid(
            field("Адрес ноды", addr),
            field("Ваш домен (для TLS и схем за CDN)", dom),
        ),
    ), cards);

    function fill() {
        clear(cards);
        const json = M.buildProfile(profile);
        if (!json.inbounds.length) {
            cards.append(card(null, hint("В профиле нет инбаундов.")));
            return;
        }
        for (const ib of json.inbounds) cards.append(hostCard(ib));
    }
    fill();
}

function hostCard(ib) {
    const st = ib.streamSettings || {};
    const net = st.network || "tcp";
    const sec = st.security || "none";
    const cdn = sec === "none" && ["ws", "httpupgrade", "xhttp"].includes(net);
    const nodeAddress = hostInfo.address || "IP или домен ноды";
    const domain = hostInfo.domain || "ваш домен";
    const rows = [];
    // [поле в панели, значение, пометка, копировать ли]
    const set = (label, value, note = "", copyable = true) => rows.push([label, String(value ?? ""), note, copyable]);
    const auto = (label, value, note = "панель возьмёт сама") => rows.push([label, String(value ?? "—"), note, false]);

    set("Название (Remark)", ib.tag.replace(/_/g, " "), "как хост увидят клиенты — можно с флагом страны");
    set("Инбаунд", ib.tag, "выберите профиль и этот инбаунд", false);

    if (cdn) {
        set("Адрес", domain, "домен, проксируемый через CDN (оранжевое облако в Cloudflare)");
        set("Порт", 443, "порт CDN, а не ноды");
        set("Безопасность (Security layer)", "TLS", "TLS до CDN, дальше CDN идёт к ноде без шифрования");
        set("SNI", domain);
        set("Host", domain);
        set("ALPN", net === "xhttp" ? "h2,http/1.1" : "http/1.1");
        set("Fingerprint", "chrome");
        rows.push(["Порт ноды за CDN", String(ib.port), "в CDN или nginx направьте домен на этот порт ноды", true]);
    } else {
        const tlsHost = sec === "tls" || ib.protocol === "hysteria";
        set("Адрес", tlsHost ? domain : nodeAddress, tlsHost ? "домен из сертификата, смотрящий на ноду" : "");
        set("Порт", ib.port);
        set("Безопасность (Security layer)", "По умолчанию", "взять из инбаунда", false);
        if (sec === "reality") {
            const r = st.realitySettings;
            auto("SNI", r.serverNames?.[0], "панель возьмёт первый serverName; вписывать, только если нужен другой из списка");
            set("Fingerprint", "chrome", "chrome подходит почти всем; можно firefox, safari, randomized");
            auto("Публичный ключ", M.publicOf(r.privateKey) || "—", "панель вычислит из приватного");
            auto("shortId", r.shortIds?.[0] === "" ? "пустой" : r.shortIds?.[0], "панель отдаёт клиентам первый shortId из списка");
            if (r.mldsa65Seed) auto("ML-DSA-65", "включено", "ключ проверки панель вычислит сама");
        }
        if (sec === "tls") {
            set("SNI", domain);
            auto("ALPN", (st.tlsSettings?.alpn || []).join(","), "из инбаунда");
            set("Fingerprint", "chrome");
        }
        if (ib.protocol === "hysteria") set("SNI", domain);
    }

    if (net === "xhttp") {
        auto("Путь", st.xhttpSettings?.path, "из инбаунда");
        auto("Режим XHTTP", st.xhttpSettings?.mode || "auto", "из инбаунда");
    }
    if (net === "ws") auto("Путь", st.wsSettings?.path, "из инбаунда");
    if (net === "httpupgrade") auto("Путь", st.httpupgradeSettings?.path, "из инбаунда");
    if (net === "grpc") auto("serviceName", st.grpcSettings?.serviceName, "из инбаунда");
    if (ib.protocol === "shadowsocks") auto("Шифр", ib.settings?.method, "из инбаунда; ключи пользователей — свои у каждого");
    set("Ноды", "те, на которых стоит этот профиль", "без выбранных нод хост не попадёт в подписку", false);

    const kind = ib.protocol === "shadowsocks" ? "Shadowsocks"
        : `${M.PROTOCOLS[ib.protocol]} · ${M.NETWORKS[net === "raw" ? "tcp" : net] || net}${sec !== "none" ? ` · ${sec === "reality" ? "Reality" : "TLS"}` : cdn ? " · за CDN" : ""}`;

    return card(ib.tag,
        el("p", { class: "small muted", style: "margin:-6px 0 8px", text: kind }),
        ...rows.map(([label, value, note, copyable]) => el("div", { class: "forge-host-row" }, [
            el("div", { class: "forge-host-k" }, [el("span", { text: label }), note ? el("small", { class: "muted tiny", text: note }) : null]),
            el("div", { class: `forge-host-v mono${copyable ? "" : " muted"}`, text: value }),
            copyable ? el("button", { type: "button", class: "btn-sm", onclick: (e) => copy(value, e.currentTarget) }, "Копировать") : el("span"),
        ])),
    );
}

// ---------------- готово ----------------

function resultView(box) {
    const notesBox = el("div");
    const panelNote = el("p", { class: "small muted" });
    const showNotes = () => clear(notesBox).append(notesList(M.validate(profile, panelInbounds, importedTags)));
    showNotes();
    const text = JSON.stringify(M.buildProfile(profile), null, 2);
    box.append(
        card("Проверка",
            notesBox,
            el("div", { class: "row wrap-row", style: "margin-top:10px" }, [
                btn(panelInbounds ? "Проверить по панели ещё раз" : "Проверить теги по панели", async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    try {
                        const data = await api.adminInbounds();
                        panelInbounds = (data.items || []).map((x) => ({ tag: x.tag, port: x.port }));
                        panelNote.textContent = `В панели сейчас ${panelInbounds.length} инбаундов — теги сверены.`;
                        showNotes();
                        refreshStatus();
                    } catch (error) {
                        panelNote.className = "small danger";
                        panelNote.textContent = error.status === 403 ? "Нет права смотреть панель (remnawave:read)." : error.message;
                    } finally {
                        button.disabled = false;
                    }
                }),
            ]),
            panelNote,
        ),
        card("JSON профиля",
            hint("Вставьте целиком в панель: «Профили конфигурации» → профиль → редактировать. Приватные ключи внутри — никому его не пересылайте."),
            codeBlock(text),
        ),
    );
}
