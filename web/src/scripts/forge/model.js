// Конструктор Xray-профилей для Remnawave: данные, сборка, случайные варианты
// и проверки. Здесь нет DOM — только объекты, поэтому всё это можно проверить
// отдельно от страницы.
//
// Что умеет панель (Remnawave 3.4): протоколы инбаундов vless, trojan,
// shadowsocks, hysteria; транспорты tcp/raw, xhttp, grpc, ws, httpupgrade,
// kcp, hysteria. Теги инбаундов уникальны во всей панели и без запятых.
// Для Shadowsocks 2022 ключ — base64 ровно от 32 байт.

import nacl from "tweetnacl";

// ---------------- случайности и ключи ----------------

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
export const pick = (list) => list[rnd(1)[0] % list.length];
export const chance = (p) => rnd(1)[0] / 256 < p;
export const randInt = (min, max) => {
    const v = new Uint32Array(1);
    crypto.getRandomValues(v);
    return min + (v[0] % (max - min + 1));
};

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
export const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function fromB64(text) {
    const t = String(text || "").trim().replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(t + "===".slice((t.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const hex = (len) => [...rnd(Math.ceil(len / 2))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
export const word = (len = 10) => {
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    return [...rnd(len)].map((b) => abc[b % abc.length]).join("");
};
export const uuid = () => crypto.randomUUID();

/** Пара ключей Reality, как у `xray x25519`. */
export function newX25519() {
    const priv = rnd(32);
    priv[0] &= 248;
    priv[31] &= 127;
    priv[31] |= 64;
    return { privateKey: b64url(priv), publicKey: b64url(nacl.scalarMult.base(priv)) };
}

export function keyBytes(text) {
    try {
        const k = fromB64(text);
        return k.length === 32 ? k : null;
    } catch {
        return null;
    }
}

export function publicOf(privateKey) {
    const k = keyBytes(privateKey);
    return k ? b64url(nacl.scalarMult.base(k)) : null;
}

export const newSsKey = () => b64(rnd(32));
export const newSeed = () => b64url(rnd(32));

// ---------------- каталоги ----------------

export const PROTOCOLS = {
    vless: "VLESS",
    trojan: "Trojan",
    shadowsocks: "Shadowsocks",
    hysteria: "Hysteria 2",
};

export const NETWORKS = {
    tcp: "TCP (raw)",
    xhttp: "XHTTP",
    grpc: "gRPC",
    ws: "WebSocket",
    httpupgrade: "HTTPUpgrade",
    kcp: "mKCP (UDP)",
    hysteria: "Hysteria (QUIC)",
};

export const SECURITIES = {
    reality: "Reality",
    tls: "TLS (свой сертификат)",
    none: "Без шифрования транспорта",
};

// Какие сочетания вообще имеют смысл. «none» у ws/httpupgrade/xhttp — для
// схемы, где TLS снимает CDN или nginx перед нодой.
export const COMPAT = {
    vless: { tcp: ["reality", "tls"], xhttp: ["reality", "tls", "none"], grpc: ["reality", "tls"], ws: ["tls", "none"], httpupgrade: ["tls", "none"], kcp: ["none"] },
    trojan: { tcp: ["tls"], xhttp: ["tls"], grpc: ["tls"], ws: ["tls"], httpupgrade: ["tls"] },
    shadowsocks: { tcp: ["none"] },
    hysteria: { hysteria: ["tls"] },
};

export const SS_METHODS = ["2022-blake3-aes-256-gcm", "aes-256-gcm", "aes-128-gcm", "chacha20-ietf-poly1305"];

// Сайты для маскировки Reality: TLS 1.3, HTTP/2, открываются из России.
// Перед боем проверить с ноды: `xray tls ping сайт`.
export const DESTS = [
    "cdnjs.cloudflare.com", "www.microsoft.com", "dl.google.com", "www.apple.com", "github.com",
    "www.samsung.com", "www.nvidia.com", "www.amd.com", "www.lovelive-anime.jp", "addons.mozilla.org",
];

export const SAFE_PORTS = [443, 8443, 2053, 2083, 2087, 2096];
export const FINGERPRINTS = ["chrome", "firefox", "safari", "edge", "ios", "android", "randomized"];
export const XHTTP_MODES = ["auto", "packet-up", "stream-up", "stream-one"];
export const DOMAIN_STRATEGIES = ["AsIs", "UseIP", "UseIPv4", "UseIPv6", "ForceIP", "ForceIPv4", "ForceIPv6"];
export const ROUTING_STRATEGIES = ["AsIs", "IPIfNonMatch", "IPOnDemand"];
export const BALANCER_STRATEGIES = {
    random: "Случайно",
    roundRobin: "По очереди",
    leastPing: "Наименьший пинг",
    leastLoad: "Наименьшая нагрузка",
};

export const WARP_PEER = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

export const DNS_SERVERS = {
    "https://1.1.1.1/dns-query": "Cloudflare DoH",
    "https://dns.google/dns-query": "Google DoH",
    "https://dns.quad9.net/dns-query": "Quad9 DoH",
    "https://dns.adguard-dns.com/dns-query": "AdGuard DoH (режет рекламу)",
    "1.1.1.1": "Cloudflare UDP",
    "8.8.8.8": "Google UDP",
    localhost: "Системный DNS ноды",
};

// ---------------- инбаунды ----------------

/** Черновик инбаунда: всё, что знает форма. Из него собирается JSON для Xray. */
export function blankSpec(protocol = "vless", network = "tcp", security = "reality") {
    const pair = newX25519();
    const host = DESTS[0];
    return {
        protocol, network, security,
        tag: "", port: 443, listen: "0.0.0.0",
        sniffing: true, routeOnly: true, sniffDest: ["http", "tls", "quic"],
        tfo: false, proxyProtocol: false,
        reality: { dest: `${host}:443`, serverNames: [host], privateKey: pair.privateKey, shortIds: ["", hex(8)], xver: 0, pq: false, seed: newSeed() },
        tls: { certFile: "/etc/letsencrypt/live/example.com/fullchain.pem", keyFile: "/etc/letsencrypt/live/example.com/privkey.pem", alpn: ["h2", "http/1.1"], minVersion: "1.3", rejectUnknownSni: false },
        xhttp: { path: "/" + word(), host: "", mode: "auto" },
        grpc: { serviceName: word() },
        ws: { path: "/" + word(), host: "" },
        httpupgrade: { path: "/" + word(), host: "" },
        kcp: { mtu: 1350, tti: 50, up: 5, down: 20, congestion: false },
        ss: { method: SS_METHODS[0], password: newSsKey() },
    };
}

export const defaultTag = (spec, suffix = "") => {
    const p = { vless: "VLESS", trojan: "TROJAN", shadowsocks: "SS", hysteria: "HY2" }[spec.protocol];
    if (spec.protocol === "shadowsocks") return `${p}${spec.ss.method.startsWith("2022") ? "2022" : ""}${suffix}`;
    if (spec.protocol === "hysteria") return `${p}${suffix}`;
    const n = { tcp: "", xhttp: "_XHTTP", grpc: "_GRPC", ws: "_WS", httpupgrade: "_HU", kcp: "_KCP" }[spec.network];
    const s = { reality: "_REALITY", tls: "_TLS", none: "" }[spec.security];
    return `${p}${n}${s}${suffix}`;
};

/** Поправить черновик после смены протокола/транспорта, чтобы сочетание было допустимым. */
export function normalizeSpec(spec) {
    const nets = Object.keys(COMPAT[spec.protocol]);
    if (!nets.includes(spec.network)) spec.network = nets[0];
    const secs = COMPAT[spec.protocol][spec.network];
    if (!secs.includes(spec.security)) spec.security = secs[0];
    return spec;
}

const splitList = (value) => (Array.isArray(value) ? value : String(value || "").split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);

export function inboundFromSpec(spec) {
    const ib = { tag: spec.tag.trim(), port: Number(spec.port), listen: spec.listen.trim() || "0.0.0.0", protocol: spec.protocol };

    if (spec.protocol === "vless") ib.settings = { clients: [], decryption: "none" };
    if (spec.protocol === "trojan") ib.settings = { clients: [] };
    if (spec.protocol === "hysteria") ib.settings = { version: 2, clients: [] };
    if (spec.protocol === "shadowsocks") {
        ib.settings = { clients: [], method: spec.ss.method, network: "tcp,udp" };
        if (spec.ss.method.startsWith("2022")) ib.settings.password = spec.ss.password.trim();
    }

    if (spec.sniffing) ib.sniffing = { enabled: true, routeOnly: !!spec.routeOnly, destOverride: [...spec.sniffDest] };
    if (spec.protocol === "shadowsocks") return ib;

    const ss = { network: spec.network, security: spec.security };
    if (spec.network === "tcp") ss.tcpSettings = { header: { type: "none" } };
    if (spec.network === "xhttp") ss.xhttpSettings = cleanObj({ path: spec.xhttp.path || "/", host: spec.xhttp.host, mode: spec.xhttp.mode });
    if (spec.network === "grpc") ss.grpcSettings = { serviceName: spec.grpc.serviceName };
    if (spec.network === "ws") ss.wsSettings = cleanObj({ path: spec.ws.path || "/", host: spec.ws.host });
    if (spec.network === "httpupgrade") ss.httpupgradeSettings = cleanObj({ path: spec.httpupgrade.path || "/", host: spec.httpupgrade.host });
    if (spec.network === "kcp") {
        ss.kcpSettings = {
            mtu: Number(spec.kcp.mtu), tti: Number(spec.kcp.tti),
            uplinkCapacity: Number(spec.kcp.up), downlinkCapacity: Number(spec.kcp.down),
            congestion: !!spec.kcp.congestion,
        };
    }
    if (spec.network === "hysteria") ss.hysteriaSettings = { version: 2 };

    if (spec.security === "reality") {
        const r = spec.reality;
        ss.realitySettings = {
            dest: r.dest.trim(),
            show: false,
            xver: Number(r.xver) || 0,
            shortIds: r.shortIds,
            privateKey: r.privateKey.trim(),
            serverNames: splitList(r.serverNames),
        };
        if (r.pq) ss.realitySettings.mldsa65Seed = r.seed;
    }
    if (spec.security === "tls") {
        const t = spec.tls;
        ss.tlsSettings = {
            certificates: [{ certificateFile: t.certFile.trim(), keyFile: t.keyFile.trim() }],
            alpn: spec.network === "hysteria" ? ["h3"] : t.alpn,
            minVersion: t.minVersion,
        };
        if (t.rejectUnknownSni) ss.tlsSettings.rejectUnknownSni = true;
    }
    if (spec.tfo || spec.proxyProtocol) {
        ss.sockopt = {};
        if (spec.tfo) ss.sockopt.tcpFastOpen = true;
        if (spec.proxyProtocol) ss.sockopt.acceptProxyProtocol = true;
    }
    ib.streamSettings = ss;
    return ib;
}

function cleanObj(obj) {
    for (const k of Object.keys(obj)) if (obj[k] === "" || obj[k] === undefined) delete obj[k];
    return obj;
}

/** Обратно: из готового JSON в черновик формы. Не наш формат — null, правится как JSON. */
export function specFromInbound(ib) {
    try {
        const protocol = ib.protocol;
        if (!COMPAT[protocol]) return null;
        const st = ib.streamSettings || {};
        let network = st.network === "raw" ? "tcp" : st.network || "tcp";
        const security = st.security || "none";
        if (!COMPAT[protocol][network]?.includes(security)) return null;
        const spec = blankSpec(protocol, network, security);
        spec.tag = ib.tag || "";
        spec.port = Number(String(ib.port).split(",")[0]) || 443;
        spec.listen = ib.listen || "0.0.0.0";
        spec.sniffing = !!ib.sniffing?.enabled;
        spec.routeOnly = !!ib.sniffing?.routeOnly;
        if (ib.sniffing?.destOverride) spec.sniffDest = [...ib.sniffing.destOverride];
        spec.tfo = !!st.sockopt?.tcpFastOpen;
        spec.proxyProtocol = !!st.sockopt?.acceptProxyProtocol;
        const r = st.realitySettings;
        if (r) {
            spec.reality = {
                dest: r.dest || r.target || "", serverNames: r.serverNames || [], privateKey: r.privateKey || "",
                shortIds: r.shortIds || [], xver: r.xver || 0, pq: !!r.mldsa65Seed, seed: r.mldsa65Seed || newSeed(),
            };
        }
        const t = st.tlsSettings;
        if (t) {
            const c = t.certificates?.[0] || {};
            spec.tls = { certFile: c.certificateFile || "", keyFile: c.keyFile || "", alpn: t.alpn || ["h2", "http/1.1"], minVersion: t.minVersion || "1.3", rejectUnknownSni: !!t.rejectUnknownSni };
        }
        if (st.xhttpSettings) spec.xhttp = { path: st.xhttpSettings.path || "/", host: st.xhttpSettings.host || "", mode: st.xhttpSettings.mode || "auto" };
        if (st.grpcSettings) spec.grpc = { serviceName: st.grpcSettings.serviceName || "" };
        if (st.wsSettings) spec.ws = { path: st.wsSettings.path || "/", host: st.wsSettings.host || st.wsSettings.headers?.Host || "" };
        if (st.httpupgradeSettings) spec.httpupgrade = { path: st.httpupgradeSettings.path || "/", host: st.httpupgradeSettings.host || "" };
        if (st.kcpSettings) {
            const k = st.kcpSettings;
            spec.kcp = { mtu: k.mtu || 1350, tti: k.tti || 50, up: k.uplinkCapacity ?? 5, down: k.downlinkCapacity ?? 20, congestion: !!k.congestion };
        }
        if (protocol === "shadowsocks") spec.ss = { method: ib.settings?.method || SS_METHODS[0], password: ib.settings?.password || newSsKey() };
        // если черновик не воспроизводит JSON точно — значит, в нём есть то, чего форма не знает
        if (JSON.stringify(inboundFromSpec(spec)) !== JSON.stringify(ib)) spec._lossy = true;
        return spec;
    } catch {
        return null;
    }
}

// ---------------- исходящие ----------------

export const OUTBOUND_KINDS = {
    direct: "Напрямую (freedom)",
    block: "Блок (blackhole)",
    fragment: "Напрямую с фрагментацией TLS",
    warp: "Cloudflare WARP (WireGuard)",
    chain: "Цепочка через другую ноду (VLESS Reality)",
    socks: "SOCKS5-прокси",
    http: "HTTP-прокси",
    dns: "DNS-перехват",
};

export function blankOutbound(kind, tag) {
    const o = { kind, tag: tag || "" };
    if (kind === "direct") o.domainStrategy = "ForceIPv4";
    if (kind === "fragment") Object.assign(o, { domainStrategy: "AsIs", packets: "tlshello", length: "100-200", interval: "10-20" });
    if (kind === "warp") Object.assign(o, { secretKey: "", v4: "172.16.0.2/32", v6: "", endpoint: "engage.cloudflareclient.com:2408", reserved: "", domainStrategy: "ForceIPv4" });
    if (kind === "chain") Object.assign(o, { address: "", port: 443, id: uuid(), flow: "xtls-rprx-vision", network: "tcp", sni: DESTS[0], publicKey: "", shortId: "", fingerprint: "chrome", path: "", serviceName: "" });
    if (kind === "socks" || kind === "http") Object.assign(o, { address: "", port: kind === "socks" ? 1080 : 8080, user: "", pass: "" });
    return o;
}

export function outboundFromSpec(o) {
    switch (o.kind) {
        case "direct":
            return { tag: o.tag, protocol: "freedom", settings: { domainStrategy: o.domainStrategy } };
        case "block":
            return { tag: o.tag, protocol: "blackhole" };
        case "fragment":
            return { tag: o.tag, protocol: "freedom", settings: { domainStrategy: o.domainStrategy, fragment: { packets: o.packets, length: o.length, interval: o.interval } } };
        case "warp": {
            const address = [o.v4, o.v6].map((s) => s.trim()).filter(Boolean);
            const peer = { publicKey: WARP_PEER, endpoint: o.endpoint.trim(), allowedIPs: ["0.0.0.0/0", "::/0"] };
            const settings = { secretKey: o.secretKey.trim(), address, peers: [peer], mtu: 1280, domainStrategy: o.domainStrategy };
            const reserved = splitList(o.reserved).map(Number).filter((n) => Number.isInteger(n));
            if (reserved.length === 3) settings.reserved = reserved;
            return { tag: o.tag, protocol: "wireguard", settings };
        }
        case "chain": {
            const user = { id: o.id.trim(), encryption: "none" };
            if (o.network === "tcp" && o.flow) user.flow = o.flow;
            const stream = {
                network: o.network, security: "reality",
                realitySettings: { serverName: o.sni.trim(), publicKey: o.publicKey.trim(), shortId: o.shortId.trim(), fingerprint: o.fingerprint, spiderX: "/" },
            };
            if (o.network === "xhttp") stream.xhttpSettings = { path: o.path || "/", mode: "auto" };
            if (o.network === "grpc") stream.grpcSettings = { serviceName: o.serviceName };
            return { tag: o.tag, protocol: "vless", settings: { vnext: [{ address: o.address.trim(), port: Number(o.port), users: [user] }] }, streamSettings: stream };
        }
        case "socks":
        case "http": {
            const server = { address: o.address.trim(), port: Number(o.port) };
            if (o.user) server.users = [{ user: o.user, pass: o.pass }];
            return { tag: o.tag, protocol: o.kind, settings: { servers: [server] } };
        }
        case "dns":
            return { tag: o.tag, protocol: "dns" };
        default:
            return o.raw;
    }
}

/** Из готового outbound — в черновик. Незнакомое хранится как есть (raw). */
export function outboundSpecFrom(ob) {
    const s = ob.settings || {};
    if (ob.protocol === "blackhole") return { kind: "block", tag: ob.tag };
    if (ob.protocol === "dns") return { kind: "dns", tag: ob.tag };
    if (ob.protocol === "freedom" && !s.fragment && Object.keys(s).every((k) => k === "domainStrategy")) {
        return { kind: "direct", tag: ob.tag, domainStrategy: s.domainStrategy || "AsIs" };
    }
    return { kind: "raw", tag: ob.tag, raw: ob };
}

// ---------------- маршруты ----------------

export const RULE_PRESETS = [
    { key: "torrent", title: "Торренты в блок", needs: "BLOCK", make: () => ({ type: "field", protocol: ["bittorrent"], outboundTag: "BLOCK" }) },
    { key: "private", title: "Частные и китайские IP в блок", needs: "BLOCK", make: () => ({ type: "field", ip: ["geoip:private", "geoip:cn"], outboundTag: "BLOCK" }) },
    { key: "ads", title: "Реклама в блок", needs: "BLOCK", make: () => ({ type: "field", domain: ["geosite:category-ads-all"], outboundTag: "BLOCK" }) },
    { key: "quic", title: "Заблокировать QUIC (UDP 443)", needs: "BLOCK", make: () => ({ type: "field", network: "udp", port: "443", outboundTag: "BLOCK" }) },
    { key: "v4", title: "Google, YouTube, Netflix, OpenAI, Claude — только IPv4", needs: "IPv4_ONLY", make: () => ({ type: "field", domain: ["geosite:google", "geosite:youtube", "geosite:netflix", "geosite:openai", "domain:chatgpt.com", "domain:claude.ai"], outboundTag: "IPv4_ONLY" }) },
    { key: "ai-warp", title: "Нейросети через WARP", needs: "WARP", make: () => ({ type: "field", domain: ["geosite:openai", "domain:chatgpt.com", "domain:claude.ai", "domain:anthropic.com", "domain:gemini.google.com", "domain:aistudio.google.com"], outboundTag: "WARP" }) },
    { key: "stream-warp", title: "Стриминг через WARP", needs: "WARP", make: () => ({ type: "field", domain: ["geosite:netflix", "geosite:disney", "geosite:spotify"], outboundTag: "WARP" }) },
];

/** «Только Telegram» для одного инбаунда — как у GRACE: Telegram пускаем, остальное в блок. */
export function telegramOnlyRules(inboundTag) {
    return [
        { type: "field", inboundTag: [inboundTag], domain: ["geosite:telegram"], outboundTag: "DIRECT" },
        { type: "field", inboundTag: [inboundTag], ip: ["geoip:telegram"], outboundTag: "DIRECT" },
        { type: "field", inboundTag: [inboundTag], network: "tcp,udp", outboundTag: "BLOCK" },
    ];
}

export const catchAll = (target, isBalancer = false) => isBalancer
    ? { type: "field", network: "tcp,udp", balancerTag: target }
    : { type: "field", network: "tcp,udp", outboundTag: target };

export function ruleSummary(rule) {
    const parts = [];
    if (rule.inboundTag) parts.push(`вход ${rule.inboundTag.join(", ")}`);
    if (rule.domain) parts.push(rule.domain.slice(0, 3).join(", ") + (rule.domain.length > 3 ? ` и ещё ${rule.domain.length - 3}` : ""));
    if (rule.ip) parts.push(rule.ip.slice(0, 3).join(", ") + (rule.ip.length > 3 ? ` и ещё ${rule.ip.length - 3}` : ""));
    if (rule.protocol) parts.push(rule.protocol.join(", "));
    if (rule.port) parts.push(`порт ${rule.port}`);
    if (rule.network && !rule.domain && !rule.ip && !rule.protocol && !rule.port && !rule.inboundTag) parts.push("всё остальное");
    else if (rule.network && rule.network !== "tcp,udp") parts.push(rule.network);
    return parts.join(" · ") || "любой трафик";
}

export const ruleTarget = (rule) => rule.balancerTag ? `⚖ ${rule.balancerTag}` : rule.outboundTag;

// ---------------- профиль целиком ----------------

/** Профиль в одном месте: черновики инбаундов/исходящих и сырые части. */
export function blankProfile() {
    return {
        inbounds: [],
        outbounds: [blankOutbound("direct", "DIRECT"), blankOutbound("block", "BLOCK")],
        rules: [],
        routingStrategy: "IPIfNonMatch",
        balancers: [],
        probeUrl: "https://www.gstatic.com/generate_204",
        dns: { enabled: false, servers: ["https://1.1.1.1/dns-query", "localhost"], queryStrategy: "UseIPv4" },
        extra: {},
    };
}

/** Профиль «как сейчас у DarkPrince»: Reality на 443, IPv4 для Google и нейросетей. */
export function myStandardProfile() {
    const p = blankProfile();
    const spec = blankSpec();
    spec.tag = "VLESS_REALITY";
    p.inbounds.push({ spec });
    const v4 = blankOutbound("direct", "IPv4_ONLY");
    v4.domainStrategy = "UseIPv4";
    p.outbounds.push(v4);
    for (const key of ["torrent", "private", "ads", "v4"]) p.rules.push(RULE_PRESETS.find((r) => r.key === key).make());
    p.rules.push(catchAll("DIRECT"));
    return p;
}

export function buildProfile(p) {
    const out = { log: { loglevel: "warning" } };
    if (p.dns.enabled) {
        out.dns = { servers: [...p.dns.servers], queryStrategy: p.dns.queryStrategy };
    }
    out.inbounds = p.inbounds.map((x) => (x.spec ? inboundFromSpec(x.spec) : x.raw));
    out.outbounds = p.outbounds.map(outboundFromSpec);
    out.routing = { domainStrategy: p.routingStrategy, rules: p.rules };
    if (p.balancers.length) {
        out.routing.balancers = p.balancers.map((b) => {
            const bal = { tag: b.tag, selector: [...b.selector], strategy: { type: b.strategy } };
            if (b.fallbackTag) bal.fallbackTag = b.fallbackTag;
            return bal;
        });
        const selectors = (type) => [...new Set(p.balancers.filter((b) => b.strategy === type).flatMap((b) => b.selector))];
        const ping = selectors("leastPing");
        if (ping.length) out.observatory = { subjectSelector: ping, probeUrl: p.probeUrl, probeInterval: "1m", enableConcurrency: true };
        const load = selectors("leastLoad");
        if (load.length) {
            out.burstObservatory = { subjectSelector: load, pingConfig: { destination: p.probeUrl, interval: "1m", sampling: 3, timeout: "5s" } };
        }
    }
    return { ...p.extra, ...out };
}

/** Чужой профиль (из панели) — в наш черновик. Незнакомое сохраняется как есть. */
export function importProfile(json) {
    const src = typeof json === "string" ? JSON.parse(json) : json;
    const p = blankProfile();
    p.inbounds = (src.inbounds || []).map((ib) => {
        const spec = specFromInbound(ib);
        return spec && !spec._lossy ? { spec } : { raw: ib };
    });
    p.outbounds = (src.outbounds || []).map(outboundSpecFrom);
    p.rules = src.routing?.rules || [];
    p.routingStrategy = src.routing?.domainStrategy || "AsIs";
    p.balancers = (src.routing?.balancers || []).map((b) => ({
        tag: b.tag, selector: b.selector || [], strategy: b.strategy?.type || "random", fallbackTag: b.fallbackTag || "",
    }));
    if (src.observatory?.probeUrl) p.probeUrl = src.observatory.probeUrl;
    if (src.dns) p.dns = { enabled: true, servers: src.dns.servers || [], queryStrategy: src.dns.queryStrategy || "UseIP" };
    const known = new Set(["log", "dns", "inbounds", "outbounds", "routing", "observatory", "burstObservatory"]);
    for (const [k, v] of Object.entries(src)) if (!known.has(k)) p.extra[k] = v;
    return p;
}

// ---------------- случайные варианты ----------------

// [вес, протокол, транспорт, защита, нужен ли свой сертификат, экзотика]
const RANDOM_COMBOS = [
    [5, "vless", "tcp", "reality", false, false],
    [4, "vless", "xhttp", "reality", false, false],
    [3, "vless", "grpc", "reality", false, false],
    [2, "shadowsocks", "tcp", "none", false, false],
    [2, "vless", "kcp", "none", false, true],
    [2, "vless", "xhttp", "none", false, true],
    [1, "vless", "httpupgrade", "none", false, true],
    [1, "vless", "ws", "none", false, true],
    [2, "trojan", "tcp", "tls", true, true],
    [2, "hysteria", "hysteria", "tls", true, true],
    [1, "vless", "ws", "tls", true, true],
    [1, "trojan", "grpc", "tls", true, true],
];

/**
 * Случайный, но рабочий инбаунд. exotic — брать и необычные сочетания;
 * hasCert — на ноде есть сертификат, можно TLS и Hysteria.
 */
export function randomSpec({ exotic = false, hasCert = false, certFile, keyFile, usedPorts = new Set(), usedTags = new Set() } = {}) {
    const pool = RANDOM_COMBOS.filter(([, , , , cert, ex]) => (exotic || !ex) && (hasCert || !cert));
    const total = pool.reduce((s, c) => s + c[0], 0);
    let roll = randInt(1, total);
    const combo = pool.find((c) => (roll -= c[0]) <= 0);
    const [, protocol, network, security] = combo;
    const spec = blankSpec(protocol, network, security);

    const host = pick(DESTS);
    spec.reality.dest = `${host}:443`;
    spec.reality.serverNames = chance(0.3) ? [host, `www.${host.replace(/^www\./, "")}`].filter((v, i, a) => a.indexOf(v) === i) : [host];
    const count = randInt(1, exotic ? 4 : 2);
    const len = pick([8, 8, 16, 4, 12]);
    spec.reality.shortIds = [...(chance(0.6) ? [""] : []), ...Array.from({ length: count }, () => hex(len))];
    spec.reality.pq = exotic && chance(0.35);
    spec.xhttp.mode = exotic ? pick(XHTTP_MODES) : "auto";
    spec.kcp = { mtu: pick([1350, 1350, 1280, 1400]), tti: pick([20, 30, 50]), up: pick([5, 10, 20]), down: pick([20, 50, 100]), congestion: chance(0.5) };
    if (protocol === "shadowsocks") spec.ss.method = exotic ? pick(SS_METHODS) : SS_METHODS[0];
    if (certFile) spec.tls.certFile = certFile;
    if (keyFile) spec.tls.keyFile = keyFile;
    spec.tfo = exotic && chance(0.3);
    if (exotic && network !== "kcp" && network !== "hysteria") spec.sniffDest = chance(0.5) ? ["http", "tls", "quic"] : ["http", "tls"];

    // порт: 443 и «облачные» для обычных, любой высокий — для экзотики
    const udp = network === "kcp" || network === "hysteria";
    const candidates = udp || exotic
        ? [...SAFE_PORTS, ...Array.from({ length: 8 }, () => randInt(20000, 60000))]
        : SAFE_PORTS;
    spec.port = candidates.find((port) => !usedPorts.has(port) && !(port === 443 && usedPorts.has(443))) ?? randInt(20000, 60000);
    if (protocol === "shadowsocks" && !exotic && !usedPorts.has(8388)) spec.port = 8388;

    let tag = defaultTag(spec);
    if (usedTags.has(tag) || chance(0.5)) tag = `${tag}_${hex(4).toUpperCase()}`;
    spec.tag = tag;
    return spec;
}

/** Случайный профиль: 1–3 инбаунда на разных портах, набор правил и, если есть кому, балансировщик. */
export function randomProfile({ exotic = false, hasCert = false, certFile, keyFile, panelTags = [] } = {}) {
    const p = blankProfile();
    const usedPorts = new Set();
    const usedTags = new Set(panelTags);
    const n = randInt(1, exotic ? 3 : 2);
    for (let i = 0; i < n; i += 1) {
        const spec = randomSpec({ exotic, hasCert, certFile, keyFile, usedPorts, usedTags });
        usedPorts.add(spec.port);
        usedTags.add(spec.tag);
        p.inbounds.push({ spec });
    }
    const v4 = blankOutbound("direct", "IPv4_ONLY");
    v4.domainStrategy = "UseIPv4";
    p.outbounds.push(v4);
    if (exotic && chance(0.4)) p.outbounds.push(blankOutbound("fragment", "FRAGMENT"));
    for (const key of ["torrent", "private"]) p.rules.push(RULE_PRESETS.find((r) => r.key === key).make());
    if (chance(0.7)) p.rules.push(RULE_PRESETS.find((r) => r.key === "ads").make());
    if (chance(0.6)) p.rules.push(RULE_PRESETS.find((r) => r.key === "v4").make());
    if (exotic && chance(0.3)) p.rules.push(RULE_PRESETS.find((r) => r.key === "quic").make());
    p.rules.push(catchAll("DIRECT"));
    p.routingStrategy = exotic ? pick(ROUTING_STRATEGIES) : "IPIfNonMatch";
    if (exotic && chance(0.3)) p.dns = { enabled: true, servers: [pick(Object.keys(DNS_SERVERS).slice(0, 4)), "localhost"], queryStrategy: "UseIPv4" };
    return p;
}

// ---------------- проверки ----------------

/**
 * Проверить профиль. panel — инбаунды, которые уже есть в панели
 * ([{tag, port}]), чтобы поймать повтор тега во всей панели.
 * Возвращает [[уровень, текст]], уровень — bad | warn | ok.
 */
export function validate(p, panel = null, importedTags = new Set()) {
    const notes = [];
    const bad = (t) => notes.push(["bad", t]);
    const warn = (t) => notes.push(["warn", t]);
    const json = buildProfile(p);
    const inbounds = json.inbounds || [];
    const outbounds = json.outbounds || [];

    if (!inbounds.length) bad("В профиле нет ни одного инбаунда — панель такой не сохранит.");

    const seen = new Set();
    const ports = new Map();
    for (const ib of inbounds) {
        if (!ib.tag) bad("У одного из инбаундов нет тега.");
        else if (ib.tag.includes(",")) bad(`В теге «${ib.tag}» запятая — панель это запрещает.`);
        else if (seen.has(ib.tag)) bad(`Тег «${ib.tag}» повторяется.`);
        seen.add(ib.tag);
        const port = Number(String(ib.port).split(",")[0]);
        if (!(port >= 1 && port <= 65535)) bad(`У «${ib.tag}» порт вне 1–65535.`);
        const key = `${ib.listen || "0.0.0.0"}:${port}`;
        if (ports.has(key)) bad(`Порт ${port} занят двумя инбаундами: «${ports.get(key)}» и «${ib.tag}».`);
        ports.set(key, ib.tag);

        const st = ib.streamSettings;
        const r = st?.realitySettings;
        if (r) {
            if (!keyBytes(r.privateKey)) bad(`«${ib.tag}»: приватный ключ Reality не похож на x25519.`);
            if (!r.serverNames?.length) bad(`«${ib.tag}»: нужен хотя бы один serverName.`);
            const host = String(r.dest || "").replace(/:\d+$/, "");
            if (!/:\d+$/.test(r.dest || "")) warn(`«${ib.tag}»: в dest обычно пишут порт — ${host || "сайт"}:443.`);
            if (host && r.serverNames?.length && !r.serverNames.includes(host)) warn(`«${ib.tag}»: serverNames не содержит сайт из dest.`);
            if (!r.shortIds?.length) bad(`«${ib.tag}»: нужен хотя бы один shortId (можно пустой).`);
            for (const sid of r.shortIds || []) if (!/^[0-9a-f]{0,16}$/.test(sid) || sid.length % 2) bad(`«${ib.tag}»: shortId «${sid}» — нужны hex-символы, чётное число, до 16.`);
        }
        const t = st?.tlsSettings;
        if (t && !(t.certificates?.[0]?.certificateFile && t.certificates?.[0]?.keyFile)) bad(`«${ib.tag}»: для TLS нужны пути к сертификату и ключу на ноде.`);
        if (t) warn(`«${ib.tag}»: TLS — файл сертификата должен лежать по этому пути в контейнере панели (она вставит его в конфиг сама) или в контейнере ноды.`);
        if (ib.protocol === "shadowsocks" && String(ib.settings?.method).startsWith("2022")) {
            const k = keyBytes(ib.settings.password);
            if (!k) bad(`«${ib.tag}»: ключ Shadowsocks 2022 должен быть base64 ровно от 32 байт.`);
        }
        if (st?.network === "grpc" && !st.grpcSettings?.serviceName) bad(`«${ib.tag}»: пустой serviceName у gRPC.`);
        if (st?.security === "none" && ["ws", "httpupgrade", "xhttp"].includes(st.network)) {
            warn(`«${ib.tag}»: без TLS — годится только за CDN или nginx, который сам держит HTTPS.`);
        }
        if (ib.protocol === "hysteria") warn(`«${ib.tag}»: Hysteria 2 в Xray — свежая возможность, проверьте инбаунд на одной ноде, прежде чем раскатывать.`);
        if (panel) {
            const twin = panel.find((x) => x.tag === ib.tag);
            if (twin && !importedTags.has(ib.tag)) bad(`Тег «${ib.tag}» уже есть в панели — теги уникальны во всех профилях.`);
        }
    }

    if (!outbounds.length) bad("Нет ни одного исходящего — панель такой профиль не примет.");
    const outTags = new Set();
    for (const ob of outbounds) {
        if (!ob?.tag) bad("У одного из исходящих нет тега.");
        else if (outTags.has(ob.tag)) bad(`Исходящий «${ob.tag}» повторяется.`);
        outTags.add(ob?.tag);
        if (ob?.protocol === "wireguard" && !keyBytes(ob.settings?.secretKey)) bad(`«${ob.tag}»: нужен secretKey WARP (из wgcf или warp-аккаунта).`);
        if (ob?.protocol === "vless" && ob.settings?.vnext) {
            const v = ob.settings.vnext[0];
            if (!v.address) bad(`«${ob.tag}»: укажите адрес ноды для цепочки.`);
            if (!keyBytes(ob.streamSettings?.realitySettings?.publicKey)) bad(`«${ob.tag}»: нужен публичный ключ Reality той ноды.`);
        }
        if ((ob?.protocol === "socks" || ob?.protocol === "http") && !ob.settings?.servers?.[0]?.address) bad(`«${ob.tag}»: укажите адрес прокси.`);
    }
    if (outbounds[0] && outbounds[0].protocol === "blackhole") warn("Первый исходящий — блок: трафик без подходящего правила будет теряться.");

    const balTags = new Set();
    for (const b of p.balancers) {
        if (!b.tag) bad("У балансировщика нет тега.");
        balTags.add(b.tag);
        const matched = [...outTags].filter((t) => t && b.selector.some((s) => t.startsWith(s)));
        if (!b.selector.length) bad(`Балансировщик «${b.tag}»: не выбрано ни одного исходящего.`);
        else if (!matched.length) bad(`Балансировщик «${b.tag}»: под «${b.selector.join(", ")}» не подходит ни один исходящий.`);
        else if (matched.length === 1) warn(`Балансировщик «${b.tag}» выбирает из одного исходящего — балансировать нечего.`);
        if (b.fallbackTag && !outTags.has(b.fallbackTag)) bad(`Балансировщик «${b.tag}»: запасной «${b.fallbackTag}» не найден.`);
    }

    for (const rule of p.rules) {
        if (rule.outboundTag && !outTags.has(rule.outboundTag)) bad(`Правило «${ruleSummary(rule)}» ведёт в «${rule.outboundTag}», а такого исходящего нет.`);
        if (rule.balancerTag && !balTags.has(rule.balancerTag)) bad(`Правило ведёт в балансировщик «${rule.balancerTag}», а его нет.`);
        for (const tag of rule.inboundTag || []) if (!seen.has(tag)) warn(`Правило про вход «${tag}», а такого инбаунда в профиле нет.`);
    }
    const last = p.rules[p.rules.length - 1];
    if (!last || last.domain || last.ip || last.protocol || last.port || last.inboundTag) {
        warn(`Нет правила «всё остальное» — такой трафик уйдёт в первый исходящий («${outbounds[0]?.tag || "—"}»).`);
    }

    if (p.dns.enabled && !p.dns.servers.length) bad("DNS включён, но не выбран ни один сервер.");

    if (!notes.some(([lvl]) => lvl === "bad")) notes.unshift(["ok", "Профиль собран без ошибок: панель должна его принять."]);
    return notes;
}
