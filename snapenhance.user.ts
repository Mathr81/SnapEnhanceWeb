// ==UserScript==
// @name         SnapEnhance Web
// @namespace    snapenhance-web
// @description  A userscript to Enhance the User experience on Snapchat Web
// @version      1.7.0
// @author       SnapEnhance
// @source       https://github.com/Mathr81/SnapEnhanceWeb/
// @license      GPL-3.0-only
// @supportURL   https://github.com/Mathr81/SnapEnhanceWeb/issues
// @downloadURL  https://github.com/Mathr81/SnapEnhanceWeb/releases/latest/download/snapenhance.user.js
// @updateURL    https://github.com/Mathr81/SnapEnhanceWeb/releases/latest/download/snapenhance.user.js
// @match        *://*.snapchat.com/web*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=snapchat.com
// @grant        none
// @run-at       document-start
// ==/UserScript==
(function () {
    "use strict";
    const VERSION = "1.7.0";
    const STORAGE_KEY = "snapenhance-web:settings";
    const BLOCKLIST_KEY = "snapenhance-web:blocklist";
    const POSITION_KEY = "snapenhance-web:button-position";
    const CHANNEL = "snapenhance-web";

    const FR = /^fr\b/i.test(navigator.language);
    const t = (en: string, fr: string) => (FR ? fr : en);

    // [label, description, default]
    const FEATURES = {
        uploadSizeBypass: [t("Bypass upload size", "Pas de limite de taille"), t("Send files bigger than Snapchat's limit", "Envoyer des fichiers plus gros que la limite de Snapchat"), true],
        storyReadReceipts: [t("Hide story views", "Vues de story invisibles"), t("Watch stories without showing up in viewers", "Regarder les stories sans apparaître dans les vues"), true],
        chatReadReceipts: [t("Hide chat read receipts", "Pas d'accusé de lecture"), t("Read messages without marking them as seen", "Lire les messages sans qu'ils passent en « Vu »"), true],
        snapReadReceipts: [t("Open snaps anonymously", "Ouvrir les snaps en anonyme"), t("Red/purple snaps stay unopened for the sender. Also blocks saving, reacting and deleting messages", "Les snaps rouges/violets restent « non ouverts » chez l'envoyeur. Bloque aussi enregistrer, réagir et supprimer un message"), true],
        keepDeleted: [t("Keep deleted messages", "Garder les messages supprimés"), t("Messages deleted while the chat is open stay visible, greyed out", "Les messages supprimés pendant que le chat est ouvert restent affichés, grisés"), true],
        hideBitmoji: [t("Hide bitmoji & typing", "Cacher bitmoji et « écrit… »"), t("Friends don't see you in the chat or typing (blocks presence messages)", "Tes amis ne te voient pas dans le chat ni en train d'écrire"), true],
        screenshotBypass: [t("Bypass screenshot detection", "Captures d'écran non détectées"), t("PrintScreen, Win/Cmd+Shift, Ctrl+Shift and right-click no longer trigger it", "Impr. écran, Win/Cmd+Maj, Ctrl+Maj et clic droit ne déclenchent plus rien"), true],
        alwaysFocused: [t("Stay focused", "Toujours actif"), t("No blur or away state when you switch windows", "Pas de flou ni d'état « absent » quand tu changes de fenêtre"), true],
        mediaDownload: [t("Media download", "Téléchargement des médias"), t("Download button on images, videos, stories and voice notes", "Bouton de téléchargement sur images, vidéos, stories et notes vocales"), true],
        blockTracking: [t("Block tracking", "Bloquer le pistage"), t("Blocks Snapchat analytics and error reports", "Bloque les statistiques et rapports d'erreurs envoyés à Snapchat"), true],
        debug: [t("Debug logs", "Logs de débogage"), t("Log blocked requests in the console", "Affiche les requêtes bloquées dans la console"), false],
    } as const;
    type Key = keyof typeof FEATURES;
    type Settings = Record<Key, boolean>;
    type Shared = { settings: Settings; customBlocked: string[] };

    const DEFAULTS = Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, f[2]])) as Settings;
    function loadSettings(): Settings {
        try {
            return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
        } catch {
            return { ...DEFAULTS };
        }
    }
    const parseBlocklist = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);
    // Settings are read at call time everywhere, so changes apply without reloading
    const settings = loadSettings();
    let customBlocked = parseBlocklist(localStorage.getItem(BLOCKLIST_KEY) || "");
    const channel = new BroadcastChannel(CHANNEL); // reaches Snapchat's worker (same origin)
    function saveAndBroadcast(next: Settings, blocklistText: string) {
        Object.assign(settings, next);
        customBlocked = parseBlocklist(blocklistText);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        localStorage.setItem(BLOCKLIST_KEY, blocklistText);
        channel.postMessage({ settings, customBlocked } satisfies Shared);
    }

    const log = (...a: any[]) => settings.debug && console.log("[SnapEnhance]", ...a);
    const urlOf = (input: any): string =>
        typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";

    // Keep originals before hooking so our own UI is never filtered by our hooks
    const origAdd = EventTarget.prototype.addEventListener;
    const origRemove = EventTarget.prototype.removeEventListener;

    // ---- Upload size
    // Only files the user picks, drops or pastes get a fake size: Snapchat's own File objects (media cache,
    // storage) must keep their real size or reading them breaks.
    const userFiles = new WeakSet<File>();
    const markFiles = (proto: object, prop: string) => {
        const desc = Object.getOwnPropertyDescriptor(proto, prop)!;
        Object.defineProperty(proto, prop, {
            ...desc,
            get() {
                const list: FileList | null = desc.get!.call(this);
                if (list) for (const f of list) userFiles.add(f);
                return list;
            },
        });
    };
    markFiles(HTMLInputElement.prototype, "files");
    markFiles(DataTransfer.prototype, "files"); // drag and drop, paste
    const getAsFile = DataTransferItem.prototype.getAsFile;
    DataTransferItem.prototype.getAsFile = function () {
        const f = getAsFile.call(this);
        if (f) userFiles.add(f);
        return f;
    };
    const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!.get!;
    Object.defineProperty(File.prototype, "size", {
        configurable: true,
        get() { return settings.uploadSizeBypass && userFiles.has(this) ? 500 : blobSize.call(this); },
    });

    // ---- Main thread requests: story views, tracking, custom blocklist
    const TRACKING = ["web-blizzard/web/send", "/graphene/web", "sentry.sc-prod.net", "/web/metrics"];
    const isBlocked = (url: string) => [
        ...customBlocked,
        ...(settings.storyReadReceipts ? ["readreceipt-indexer/batchuploadreadreceipts"] : []),
        ...(settings.blockTracking ? TRACKING : []),
    ].some((b) => url.includes(b));
    const origFetch = window.fetch;
    window.fetch = function (...args: any[]) {
        const url = urlOf(args[0]);
        if (isBlocked(url)) {
            log("blocked", url);
            return Promise.resolve(new Response(null, { status: 200 }));
        }
        return origFetch.apply(window, args as any);
    };
    const origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url: any, data?: any) {
        if (isBlocked(urlOf(url))) return log("blocked beacon", url), true;
        return origBeacon.call(navigator, url, data);
    };

    // ---- Worker hooks (read receipts, snaps, presence/typing). Runs inside the worker: must be self-contained.
    function workerInjected(init: Shared, tracking: string[]) {
        let { settings: s, customBlocked: extra } = init;
        new BroadcastChannel("snapenhance-web").onmessage = (e: MessageEvent) => ({ settings: s, customBlocked: extra } = e.data);
        const wlog = (...a: any[]) => s.debug && console.log("[SnapEnhance worker]", ...a);
        // Per-message state (viewed, replayed, saved, reacted...). The action is encrypted, so all of it is blocked.
        const MESSAGE_UPDATES = ["MessagingCoreService/UpdateContentMessage", "MessagingCoreService/BatchUpdateContentMessages"];
        // Snapchat retries a failed update until it succeeds: once one is held back, keep holding them until reload
        // so turning the option off can't leak an "opened" retry.
        let heldUpdates = false;
        const blockedList = () => [
            ...extra,
            ...(s.chatReadReceipts ? ["messagingcoreservice.MessagingCoreService/UpdateConversation"] : []),
            ...(s.hideBitmoji ? ["messagingcoreservice.MessagingCoreService/SendTypingNotification"] : []),
            ...(s.snapReadReceipts || heldUpdates ? MESSAGE_UPDATES : []),
            ...(s.blockTracking ? tracking : []),
        ];

        // Presence ("in chat", typing, screenshot flag) travels over the websocket as "...presence..." messages
        const decoder = new TextDecoder("latin1");
        const isPresence = (d: any) => {
            try {
                return (typeof d === "string" ? d : decoder.decode(d)).includes("presence");
            } catch {
                return false;
            }
        };
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data: any) {
            if (s.hideBitmoji && isPresence(data)) return wlog("blocked presence");
            return origSend.call(this, data);
        };

        const origWorkerFetch = self.fetch;
        self.fetch = function (...args: any[]) {
            const url = urlOf(args[0]);
            if (blockedList().some((b) => url.includes(b))) {
                wlog("blocked", url);
                if (MESSAGE_UPDATES.some((b) => url.includes(b))) {
                    // A fake 200 stalls Snapchat's request queue (no conversation loads any more);
                    // a network error is retried in the background instead.
                    heldUpdates = true;
                    return Promise.reject(new TypeError("Failed to fetch"));
                }
                return Promise.resolve(new Response(null, { status: 200 }));
            }
            return origWorkerFetch.apply(self, args as any);
        };
    }

    const OrigBlob = window.Blob;
    window.Blob = class extends OrigBlob {
        constructor(parts?: any[], options?: BlobPropertyBag) {
            if (typeof parts?.[0] === "string" && parts[0].startsWith("importScripts")) {
                parts = [...parts];
                const args = [{ settings, customBlocked }, TRACKING].map((a) => JSON.stringify(a)).join(",");
                parts[0] += `;\nconst urlOf=${urlOf};(${workerInjected})(${args});\n`;
                window.Blob = OrigBlob;
            }
            super(parts, options);
        }
    } as typeof Blob;

    // ---- Media download
    const origSetAttribute = Element.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function (name: string, value: string) {
        if (settings.mediaDownload && name.toLowerCase() === "controlslist") return;
        return origSetAttribute.call(this, name, value);
    };
    // Capture on window runs before Snapchat's handlers; we stop them but keep the native menu
    origAdd.call(window, "contextmenu", (e: any) => {
        if (!settings.mediaDownload) return;
        const hit = document.elementsFromPoint(e.clientX, e.clientY)
            .some((el) => el instanceof HTMLImageElement || el instanceof HTMLMediaElement);
        if (hit) e.stopImmediatePropagation();
    }, true);

    // ---- Focus / screenshot
    const origHasFocus = Document.prototype.hasFocus;
    const docHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")!.get!;
    const docVisibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")!.get!;
    document.hasFocus = function () { return settings.alwaysFocused || origHasFocus.call(this); };
    Object.defineProperty(document, "hidden", { get() { return settings.alwaysFocused ? false : docHidden.call(this); } });
    Object.defineProperty(document, "visibilityState", { get() { return settings.alwaysFocused ? "visible" : docVisibility.call(this); } });

    // Mirrors Snapchat's detector: PrintScreen, or Shift with Ctrl/Meta held (Win+Shift+S, Cmd+Shift+4...)
    const isScreenshotKey = (e: KeyboardEvent) => e.key === "PrintScreen" || (e.shiftKey && (e.metaKey || e.ctrlKey));
    function suppressed(e: Event): boolean {
        const target = e.currentTarget;
        if (settings.screenshotBypass) {
            if ((e.type === "keydown" || e.type === "keyup") && isScreenshotKey(e as KeyboardEvent)) return true;
            // Snapchat flags any right-click on window as a screenshot attempt
            if (e.type === "contextmenu" && target === window) return true;
        }
        return settings.alwaysFocused && (target === window || target === document)
            && (e.type === "blur" || e.type === "focus" || e.type === "visibilitychange");
    }
    const WRAPPED_EVENTS = new Set(["keydown", "keyup", "contextmenu", "blur", "focus", "visibilitychange"]);
    const wrappers = new WeakMap<Function, Function>();
    EventTarget.prototype.addEventListener = function (type: string, listener: any, options?: any) {
        if (WRAPPED_EVENTS.has(type) && typeof listener === "function") {
            const original = listener;
            let wrapped = wrappers.get(original);
            if (!wrapped) {
                wrapped = function (this: any, e: Event) {
                    if (suppressed(e)) return log("suppressed", e.type);
                    return original.call(this, e);
                };
                wrappers.set(original, wrapped);
            }
            listener = wrapped;
        }
        return origAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type: string, listener: any, options?: any) {
        return origRemove.call(this, type, wrappers.get(listener) ?? listener, options);
    };

    // ---- MP4 concatenation (no re-encoding)
    // Long video snaps arrive as ~10 s MP4 parts (ftyp+moov+mdat, H.264 + AAC, same settings). We merge their sample
    // tables into one moov and copy every sample into one mdat. Audio is re-cut at each part boundary to the video
    // length, otherwise the AAC padding of each part (~40 ms) piles up into an audible A/V drift.
    // Returns null when the parts can't be merged losslessly (different codecs or settings).
    function concatMp4(files: Uint8Array[]): Uint8Array | null {
        type Box = { type: string; start: number; size: number; hdr: number };
        type Sample = { file: number; off: number; size: number; dur: number; cto: number; sync: boolean };
        type Track = { handler: string; ts: number; stsd: Uint8Array; samples: Sample[]; editStart: number; hasCtts: boolean; trak: Box };
        const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
        const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
        const children = (b: Uint8Array, start: number, end: number) => {
            const out: Box[] = [];
            for (let p = start; p + 8 <= end;) {
                let size = u32(b, p), hdr = 8;
                const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
                if (size === 1) { size = u64(b, p + 8); hdr = 16; } else if (size === 0) size = end - p;
                if (size < hdr || p + size > end) break;
                out.push({ type, start: p, size, hdr });
                p += size;
            }
            return out;
        };
        const find = (b: Uint8Array, box: Box | undefined, ...path: string[]) => path.reduce<Box | undefined>(
            (x, t) => x && children(b, x.start + x.hdr, x.start + x.size).find((c) => c.type === t), box);
        const body = (box: Box) => box.start + box.hdr; // first byte after the header (version/flags for full boxes)

        function parseTrack(b: Uint8Array, trak: Box, file: number): Track | null {
            const mdhd = find(b, trak, "mdia", "mdhd"), hdlr = find(b, trak, "mdia", "hdlr");
            const stbl = find(b, trak, "mdia", "minf", "stbl");
            if (!mdhd || !hdlr || !stbl) return null;
            const ts = b[body(mdhd)] ? u32(b, body(mdhd) + 20) : u32(b, body(mdhd) + 12);
            const handler = String.fromCharCode(...b.subarray(body(hdlr) + 8, body(hdlr) + 12));
            const get = (t: string) => find(b, stbl, t);
            const stsd = get("stsd"), stts = get("stts"), stsz = get("stsz"), stsc = get("stsc"), stco = get("stco") ?? get("co64");
            if (!stsd || !stts || !stsz || !stsc || !stco) return null;
            const n = u32(b, body(stsz) + 8), fixed = u32(b, body(stsz) + 4);
            const samples: Sample[] = [];
            for (let i = 0; i < n; i++) samples.push({ file, off: 0, size: fixed || u32(b, body(stsz) + 12 + i * 4), dur: 0, cto: 0, sync: true });
            // decoding durations
            let i = 0;
            for (let e = 0, c = u32(b, body(stts) + 4); e < c; e++)
                for (let k = u32(b, body(stts) + 8 + e * 8), d = u32(b, body(stts) + 12 + e * 8); k > 0 && i < n; k--) samples[i++].dur = d;
            // composition offsets (signed in version 1, treat v0 the same way: real files never exceed 2^31)
            const ctts = get("ctts");
            if (ctts) {
                i = 0;
                for (let e = 0, c = u32(b, body(ctts) + 4); e < c; e++)
                    for (let k = u32(b, body(ctts) + 8 + e * 8), o = u32(b, body(ctts) + 12 + e * 8) | 0; k > 0 && i < n; k--) samples[i++].cto = o;
            }
            const stss = get("stss");
            if (stss) {
                samples.forEach((s) => (s.sync = false));
                for (let e = 0, c = u32(b, body(stss) + 4); e < c; e++) { const s = samples[u32(b, body(stss) + 8 + e * 4) - 1]; if (s) s.sync = true; }
            }
            // file offsets: chunks from stco/co64, samples per chunk from stsc
            const is64 = stco.type === "co64", chunks = u32(b, body(stco) + 4);
            const runs = Array.from({ length: u32(b, body(stsc) + 4) }, (_, e) => [u32(b, body(stsc) + 8 + e * 12), u32(b, body(stsc) + 12 + e * 12)]);
            i = 0;
            for (let ch = 1, r = 0; ch <= chunks && i < n; ch++) {
                while (r + 1 < runs.length && runs[r + 1][0] <= ch) r++;
                let off = is64 ? u64(b, body(stco) + 8 + (ch - 1) * 8) : u32(b, body(stco) + 8 + (ch - 1) * 4);
                for (let k = 0; k < runs[r][1] && i < n; k++, i++) { samples[i].off = off; off += samples[i].size; }
            }
            // where presentation starts (edit list), in media timescale
            let editStart = 0;
            const elst = find(b, trak, "edts", "elst");
            if (elst) {
                const v = b[body(elst)], count = u32(b, body(elst) + 4), w = v ? 20 : 12;
                for (let e = 0; e < count; e++) {
                    const p = body(elst) + 8 + e * w, mediaTime = v ? u64(b, p + 8) : u32(b, p + 4) | 0;
                    if (mediaTime >= 0 && mediaTime < 2 ** 53 - 1 && mediaTime !== 0xffffffff) { editStart = mediaTime; break; }
                }
            }
            return { handler, ts, stsd: b.slice(stsd.start, stsd.start + stsd.size), samples, editStart, hasCtts: !!ctts, trak };
        }

        // Parse every part
        const parts = files.map((b, file) => {
            const top = children(b, 0, b.length), moov = top.find((x) => x.type === "moov");
            if (!moov) return null;
            const mvhd = find(b, moov, "mvhd")!;
            const movieTs = b[body(mvhd)] ? u32(b, body(mvhd) + 20) : u32(b, body(mvhd) + 12);
            const tracks = children(b, body(moov), moov.start + moov.size).filter((x) => x.type === "trak")
                .map((trak) => parseTrack(b, trak, file));
            const video = tracks.find((t) => t?.handler === "vide"), audio = tracks.find((t) => t?.handler === "soun");
            return video ? { moov, movieTs, video, audio, ftyp: top.find((x) => x.type === "ftyp") } : null;
        });
        if (parts.some((p) => !p)) return null;
        const first = parts[0]!;
        // Codec settings must match; bitrate fields legitimately differ per part, so they're blanked before comparing
        const codecKey = (stsd: Uint8Array) => {
            const k = stsd.slice(), text = new TextDecoder("latin1").decode(k);
            const btrt = text.indexOf("btrt");
            if (btrt > 0) k.fill(0, btrt + 4, btrt + 16);
            const esds = text.indexOf("esds");
            for (let i = esds; esds > 0 && i < k.length; i++) {
                if (k[i] !== 0x04) continue; // DecoderConfigDescriptor tag, then a 1-4 byte length
                let j = i + 1;
                while (j < i + 5 && k[j] & 0x80) j++;
                if (k[j + 1] === 0x40) { k.fill(0, j + 3, j + 14); break; } // AAC: blank buffer size, max and avg bitrate
            }
            return k;
        };
        const same = (a: Uint8Array, b: Uint8Array) => {
            const x = codecKey(a), y = codecKey(b);
            return x.length === y.length && x.every((v, i) => v === y[i]);
        };
        for (const p of parts) {
            if (p!.video.ts !== first.video.ts || !same(p!.video.stsd, first.video.stsd)) return null;
            if (!!p!.audio !== !!first.audio) return null;
            if (p!.audio && (p!.audio.ts !== first.audio!.ts || !same(p!.audio.stsd, first.audio!.stsd))) return null;
        }

        // Merge samples: all video; audio after its priming (edit start), cut to the cumulated video length
        const video: Sample[] = [], audio: Sample[] = [];
        let videoEnd = 0, audioEnd = 0; // seconds
        for (const p of parts as NonNullable<(typeof parts)[number]>[]) {
            video.push(...p.video.samples);
            videoEnd += p.video.samples.reduce((s, x) => s + x.dur, 0) / p.video.ts;
            if (!p.audio) continue;
            let t = 0;
            for (const s of p.audio.samples) {
                const start = t;
                t += s.dur;
                if (start + s.dur <= p.audio.editStart) continue; // encoder priming
                if (audioEnd + s.dur / p.audio.ts / 2 > videoEnd) break; // keep A/V aligned at the cut
                audio.push(s);
                audioEnd += s.dur / p.audio.ts;
            }
        }

        // Writers
        const cat = (...parts: Uint8Array[]) => {
            const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
            let o = 0;
            for (const p of parts) { out.set(p, o); o += p.length; }
            return out;
        };
        const be = (...ns: number[]) => {
            const out = new Uint8Array(ns.length * 4);
            ns.forEach((n, i) => new DataView(out.buffer).setUint32(i * 4, n >>> 0));
            return out;
        };
        const box = (type: string, ...parts: Uint8Array[]) => {
            const content = cat(...parts);
            return cat(be(content.length + 8), new TextEncoder().encode(type), content);
        };
        const full = (type: string, version: number, ...parts: Uint8Array[]) => box(type, be(version << 24), ...parts);
        const rle = (values: number[]) => {
            const out: number[][] = [];
            for (const v of values) { const last = out[out.length - 1]; if (last && last[1] === v) last[0]++; else out.push([1, v]); }
            return out;
        };
        const firstBuf = files[0];
        const copy = (b: Box) => firstBuf.slice(b.start, b.start + b.size);

        // Sample tables: one sample per chunk keeps stco trivial; offsets are patched once mdat's position is known
        const stbl = (t: Track, samples: Sample[], offsets: number[]) => {
            const durations = rle(samples.map((s) => s.dur));
            const parts = [t.stsd, full("stts", 0, be(durations.length, ...durations.flat()))];
            if (t.hasCtts) {
                const r = rle(samples.map((s) => s.cto));
                parts.push(full("ctts", r.some(([, v]) => v < 0) ? 1 : 0, be(r.length, ...r.flat())));
            }
            if (samples.some((s) => !s.sync)) {
                const sync = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
                parts.push(full("stss", 0, be(sync.length, ...sync)));
            }
            parts.push(full("stsz", 0, be(0, samples.length, ...samples.map((s) => s.size))));
            parts.push(full("stsc", 0, be(1, 1, 1, 1)));
            parts.push(full("stco", 0, be(samples.length, ...offsets)));
            return box("stbl", ...parts);
        };
        const mediaDur = (samples: Sample[]) => samples.reduce((s, x) => s + x.dur, 0);
        // Copy a mvhd/mdhd/tkhd box with a new duration. Field position after the header, version 0 / 1:
        // mvhd, mdhd: flags, 2 dates, timescale → 16 / 24. tkhd: flags, 2 dates, track id, reserved → 20 / 28.
        const withDuration = (b: Box, dur: number) => {
            const out = copy(b), v = out[b.hdr];
            const p = b.hdr + (b.type === "tkhd" ? (v ? 28 : 20) : (v ? 24 : 16));
            const dv = new DataView(out.buffer);
            if (v) { dv.setUint32(p, Math.floor(dur / 2 ** 32)); dv.setUint32(p + 4, dur >>> 0); } else dv.setUint32(p, dur);
            return out;
        };

        function trak(t: Track, samples: Sample[], offsets: number[], movieTs: number) {
            const b = firstBuf, dur = mediaDur(samples), movieDur = Math.round((dur * movieTs) / t.ts);
            const kids = children(b, body(t.trak), t.trak.start + t.trak.size);
            return box("trak", ...kids.flatMap((k) => {
                if (k.type === "tkhd") return [withDuration(k, movieDur)];
                if (k.type === "edts") {
                    if (t.handler !== "vide" || !t.editStart) return []; // audio priming already cut out
                    const shown = Math.max(0, movieDur - Math.round((t.editStart * movieTs) / t.ts));
                    return [box("edts", full("elst", 0, be(1, shown, t.editStart, 0x10000)))];
                }
                if (k.type !== "mdia") return [copy(k)];
                return [box("mdia", ...children(b, body(k), k.start + k.size).map((m) => {
                    if (m.type === "mdhd") return withDuration(m, dur);
                    if (m.type !== "minf") return copy(m);
                    return box("minf", ...children(b, body(m), m.start + m.size).map((s) => (s.type === "stbl" ? stbl(t, samples, offsets) : copy(s))));
                }))];
            }));
        }

        function moov(offsets: { v: number[]; a: number[] }) {
            const b = firstBuf, movieTs = first.movieTs;
            const vDur = Math.round((mediaDur(video) * movieTs) / first.video.ts);
            const aDur = first.audio ? Math.round((mediaDur(audio) * movieTs) / first.audio.ts) : 0;
            return box("moov", ...children(b, body(first.moov), first.moov.start + first.moov.size).flatMap((k) => {
                if (k.type === "mvhd") return [withDuration(k, Math.max(vDur, aDur))];
                if (k.type !== "trak") return [copy(k)];
                if (k.start === first.video.trak.start) return [trak(first.video, video, offsets.v, movieTs)];
                if (first.audio && k.start === first.audio.trak.start) return [trak(first.audio, audio, offsets.a, movieTs)];
                return [];
            }));
        }

        // Layout: ftyp, moov, mdat(video then audio). moov's size doesn't depend on offset values.
        const ftyp = first.ftyp ? copy(first.ftyp) : new Uint8Array();
        const zeros = { v: video.map(() => 0), a: audio.map(() => 0) };
        let pos = ftyp.length + moov(zeros).length + 8;
        const place = (list: Sample[]) => list.map((s) => { const o = pos; pos += s.size; return o; });
        const offsets = { v: place(video), a: place(audio) };
        if (pos > 0xffffffff) return null; // would need co64 / 64-bit mdat; not happening for snaps
        const payload = cat(...[...video, ...audio].map((s) => files[s.file].subarray(s.off, s.off + s.size)));
        return cat(ftyp, moov(offsets), be(payload.length + 8), new TextEncoder().encode("mdat"), payload);
    }

    // ---- Media helpers
    type Media = HTMLImageElement | HTMLMediaElement;
    const BITMOJI = /bitmoji\.com|sc-cdn\.net\/3d\//;
    const mediaSrc = (m: Media) => m.currentSrc || m.src || m.querySelector("source")?.src || "";
    // Chat thumbnails are a [role=button] box whose <video> stays 0 px wide until played: measure the box
    const boxOf = (m: Element) => (m.closest("[role=button]") ?? m).getBoundingClientRect();
    function isDownloadable(el: Element): el is Media {
        if (!(el instanceof HTMLImageElement || el instanceof HTMLMediaElement)) return false;
        const src = mediaSrc(el);
        if (!src || BITMOJI.test(src)) return false;
        const r = boxOf(el);
        return el instanceof HTMLAudioElement ? r.width > 0 : r.width >= 80 && r.height >= 80;
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Snapchat revokes a snap's blob: URL once it's closed: keep the blobs it creates so they stay downloadable
    const knownBlobs = new Map<string, Blob>();
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj: any) {
        const url = origCreateObjectURL.call(URL, obj);
        if (obj instanceof Blob && /^(video|audio|image)\//.test(obj.type)) {
            knownBlobs.set(url, obj);
            if (knownBlobs.size > 300) knownBlobs.delete(knownBlobs.keys().next().value!);
        }
        return url;
    };
    const blobOf = async (src: string) => knownBlobs.get(src) ?? (await (await fetch(src)).blob());

    function saveBlob(blob: Blob, ext: string, suffix = "") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `snapchat-${new Date().toISOString().replace(/[:.]/g, "-")}${suffix}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
    const extOf = (blob: Blob, m?: Media) => {
        const ext = (blob.type.split("/")[1] || "bin").split(";")[0].replace("jpeg", "jpg").replace("mpeg", "mp3");
        return m instanceof HTMLAudioElement && ext === "mp4" ? "m4a" : ext; // voice notes are AAC in an mp4 container
    };

    async function downloadMedia(m: Media) {
        const src = mediaSrc(m);
        if (!src) return;
        try {
            const blob = await blobOf(src);
            saveBlob(blob, extOf(blob, m));
        } catch (err) {
            // Cross-origin CDN without CORS: let the browser handle it
            log("download failed, opening in a new tab", err);
            window.open(src, "_blank");
        }
    }

    // ---- Long video snaps (several ~10 s parts) → one file
    // In a conversation, parts are consecutive media items of one message group; off-screen ones are empty
    // 9:16 boxes until scrolled into view. In the snap viewer, parts play one after another outside the list.
    const isSlot = (el: Element | null): el is HTMLLIElement => el instanceof HTMLLIElement && !!el.querySelector('[style*="aspect-ratio"]');
    const slotVideo = (li: Element) => li.querySelector<HTMLVideoElement>("[role=button] video");
    const slotLoaded = (li: Element) => !!li.querySelector("[role=button] img, [role=button] video");
    const adjacentSlots = (li: HTMLLIElement) => {
        const run = [li];
        for (let p = li.previousElementSibling; isSlot(p); p = p.previousElementSibling) run.unshift(p);
        for (let n = li.nextElementSibling; isSlot(n); n = n.nextElementSibling) run.push(n);
        return run;
    };
    const scrollParent = (el: Element) => {
        for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
        return null;
    };
    // Rough count shown on the button, before anything is loaded
    const partCount = (li: HTMLLIElement) => adjacentSlots(li).filter((s) => slotVideo(s) || !slotLoaded(s)).length;

    // Thumbnail blob: URLs come from Snapchat's worker and are revoked once scrolled away, so each part's
    // content is read as soon as it's loaded.
    async function chatVideoParts(li: HTMLLIElement): Promise<Blob[]> {
        const slots = adjacentSlots(li), scroller = scrollParent(li), top = scroller?.scrollTop ?? 0;
        const ready = (s: Element) => slotLoaded(s) && (!slotVideo(s) || !!mediaSrc(slotVideo(s)!));
        const found: (Blob | null)[] = [];
        for (const s of slots) {
            if (!ready(s)) {
                s.scrollIntoView({ block: "center" });
                for (let i = 0; i < 40 && !ready(s); i++) await sleep(100);
            }
            const v = slotVideo(s);
            found.push(v ? await blobOf(mediaSrc(v)).catch(() => null) : null);
        }
        if (scroller) scroller.scrollTop = top;
        // the run of videos around the hovered one (a photo sent in between ends it)
        let a = slots.indexOf(li), b = a;
        while (a > 0 && found[a - 1]) a--;
        while (b < found.length - 1 && found[b + 1]) b++;
        return found.slice(a, b + 1).filter((x): x is Blob => !!x);
    }

    // Snap viewer: remember the parts it plays (read right away, before Snapchat revokes them),
    // and which chat thumbnail opened it (saved snaps play one part on loop)
    let viewerParts: { src: string; blob: Promise<Blob | null> }[] = [], viewerSeen = 0;
    let lastThumb: { li: HTMLLIElement; at: number } | null = null, viewerThumb: HTMLLIElement | null = null;
    origAdd.call(document, "click", (e: Event) => {
        const li = (e.target as Element).closest?.("li");
        if (isSlot(li) && slotVideo(li)) lastThumb = { li, at: Date.now() };
    }, true);
    const trackViewer = (e: Event) => {
        const v = e.target;
        if (!(v instanceof HTMLVideoElement) || v.closest("li")) return;
        if (Date.now() - viewerSeen > 15_000) { // a new viewer session
            viewerParts = [];
            viewerThumb = lastThumb && Date.now() - lastThumb.at < 5000 ? lastThumb.li : null;
        }
        viewerSeen = Date.now();
        const src = mediaSrc(v);
        if (e.type === "loadeddata" && src && !viewerParts.some((p) => p.src === src))
            viewerParts.push({ src, blob: blobOf(src).catch(() => null) });
    };
    origAdd.call(document, "loadeddata", trackViewer, true); // media events don't bubble: capture
    origAdd.call(document, "timeupdate", trackViewer, true);

    const videoPartCount = (v: HTMLVideoElement) => {
        const li = v.closest("li");
        if (isSlot(li)) return partCount(li);
        return viewerThumb?.isConnected ? partCount(viewerThumb) : viewerParts.length;
    };
    async function downloadVideo(v: HTMLVideoElement) {
        const li = v.closest("li");
        const blobs = isSlot(li) ? await chatVideoParts(li)
            : viewerThumb?.isConnected ? await chatVideoParts(viewerThumb)
            : (await Promise.all(viewerParts.map((p) => p.blob))).filter((x): x is Blob => !!x);
        if (blobs.length < 2) return downloadMedia(v);
        const merged = concatMp4(await Promise.all(blobs.map(async (b) => new Uint8Array(await b.arrayBuffer()))));
        if (merged) return saveBlob(new Blob([merged as BlobPart], { type: "video/mp4" }), "mp4");
        log("video parts use different settings, saving them separately");
        for (const [i, b] of blobs.entries()) {
            saveBlob(b, extOf(b), `-part${i + 1}`);
            await sleep(300);
        }
    }

    async function downloadAll(): Promise<number> {
        const seen = new Set<string>();
        const media = [...document.querySelectorAll("img, video, audio")].filter(isDownloadable)
            .filter((m) => !seen.has(mediaSrc(m)) && !!seen.add(mediaSrc(m)));
        for (const m of media) {
            await downloadMedia(m);
            await new Promise((r) => setTimeout(r, 300)); // browsers drop bursts of downloads
        }
        return media.length;
    }

    // ---- Keep deleted messages
    // Snapchat's message list isn't virtualized: an <li> leaving an open conversation means the message was removed.
    // We put a greyed copy back where it was. Moves/re-renders are filtered by checking the content is still on screen.
    function setupDeletedKeeper() {
        type Removed = { node: HTMLLIElement; parent: Node; next: Node | null; path: string };
        const pending: Removed[] = [];
        const added = new WeakSet<Node>();
        let timer = 0;
        const fingerprint = (n: Element) => (n.textContent || "").trim()
            + [...n.querySelectorAll("img, video, audio, source")].map((m: any) => m.currentSrc || m.src || "").join("|");
        const isConversation = () => /^\/web\/[0-9a-f-]{36}/.test(location.pathname);

        new MutationObserver((records) => {
            if (!settings.keepDeleted || !isConversation()) return;
            for (const r of records) {
                r.addedNodes.forEach((n) => n instanceof HTMLLIElement && added.add(n));
                for (const n of r.removedNodes) {
                    if (!(n instanceof HTMLLIElement) || "seGhost" in n.dataset) continue;
                    const parent = r.target as Element;
                    if (parent.closest("nav") || !fingerprint(n)) continue; // friend feed / story row reorder
                    pending.push({ node: n, parent, next: r.nextSibling, path: location.pathname });
                }
            }
            if (pending.length) {
                clearTimeout(timer);
                timer = window.setTimeout(flush, 400);
            }
        }).observe(document.body, { childList: true, subtree: true });

        function flush() {
            const removed = pending.splice(0);
            // A conversation switch tears down the whole list at once: nothing to keep
            if (removed.length > 15) return;
            const onScreen = new Set([...document.querySelectorAll("li")].map(fingerprint));
            for (const p of removed) {
                if (location.pathname !== p.path || !p.parent.isConnected) continue;
                // A new <li> in the same slot is a re-render (e.g. "Loading media…" placeholder → thumbnail)
                const next = p.next && p.next.parentNode === p.parent ? p.next : null;
                const inSlot = next ? next.previousSibling : p.parent.lastChild;
                if (inSlot && added.has(inSlot)) continue;
                const fp = fingerprint(p.node);
                if (onScreen.has(fp) || [...onScreen].some((s) => s.includes(fp))) continue; // moved, not deleted
                const ghost = p.node.cloneNode(true) as HTMLLIElement;
                ghost.dataset.seGhost = "";
                ghost.style.cssText += ";opacity:.6;";
                const badge = document.createElement("div");
                badge.textContent = t("🗑 Deleted", "🗑 Supprimé");
                badge.style.cssText = "color:#e5484d;font:600 11px system-ui,sans-serif;margin:2px 0 0 8px";
                ghost.prepend(badge);
                p.parent.insertBefore(ghost, next);
                log("kept deleted message", fp.slice(0, 60));
            }
        }
    }

    // ---- Settings GUI
    const CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
        .fab {
            position: fixed; left: 14px; bottom: 14px; z-index: 2147483647; touch-action: none;
            width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
            background: #FFFC00; font-size: 20px; line-height: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,.35); opacity: .55; transition: opacity .15s, transform .15s;
        }
        .fab:hover, .fab:focus-visible, .fab[aria-expanded="true"] { opacity: 1; transform: scale(1.06); }
        .fab.dragging { cursor: grabbing; transition: none; }
        .panel {
            position: fixed; z-index: 2147483647;
            width: 340px; display: flex; flex-direction: column;
            background: #16171a; color: #eee; border: 1px solid #2c2e33; border-radius: 14px;
            box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 13px; overflow: hidden;
        }
        .panel[hidden] { display: none; }
        header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #2c2e33; }
        header b { font-size: 14px; }
        header .ver { color: #888; font-size: 11px; }
        header .close { margin-left: auto; background: none; border: none; color: #aaa; font-size: 20px; cursor: pointer; line-height: 1; }
        .list { overflow-y: auto; padding: 4px 0; }
        /* Chrome ignores ::-webkit-scrollbar (and shows arrows) once scrollbar-color is set: Firefox only */
        @supports not selector(::-webkit-scrollbar) { .list, textarea { scrollbar-width: thin; scrollbar-color: #3a3c42 transparent; } }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #3a3c42; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #55575e; }
        ::-webkit-scrollbar-button { display: none; }
        label { display: flex; align-items: center; gap: 12px; padding: 9px 14px; cursor: pointer; }
        label:hover { background: #1f2125; }
        label span { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        label small { color: #999; font-size: 11.5px; line-height: 1.3; }
        input[type=checkbox] {
            appearance: none; flex: none; width: 34px; height: 20px; margin: 0; border-radius: 10px;
            background: #3a3c42; position: relative; cursor: pointer; transition: background .15s;
        }
        input[type=checkbox]::after {
            content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
            border-radius: 50%; background: #fff; transition: transform .15s;
        }
        input[type=checkbox]:checked { background: #e6e200; }
        input[type=checkbox]:checked::after { transform: translateX(14px); background: #111; }
        :focus-visible { outline: 2px solid #FFFC00; outline-offset: 2px; }
        .tools { padding: 10px 14px; border-bottom: 1px solid #2c2e33; }
        .dlall {
            width: 100%; padding: 8px 12px; border: 1px solid #3a3c42; border-radius: 8px; cursor: pointer;
            background: #1f2125; color: #eee; font-size: 12.5px; font-weight: 600;
        }
        .dlall:hover { border-color: #FFFC00; }
        .dlall:disabled { opacity: .5; cursor: default; }
        footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #2c2e33; }
        footer .hint { flex: 1; color: #888; font-size: 11.5px; }
        footer button { border: none; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12.5px; font-weight: 600; }
        .reset { background: #2c2e33; color: #ddd; }
        .custom { display: flex; flex-direction: column; align-items: stretch; gap: 3px; padding: 10px 14px 12px; border-top: 1px solid #2c2e33; }
        .custom small { color: #999; font-size: 11.5px; line-height: 1.3; }
        textarea {
            margin-top: 5px; width: 100%; min-height: 64px; resize: vertical; padding: 6px 8px;
            background: #0f1012; color: #eee; border: 1px solid #2c2e33; border-radius: 8px;
            font: 12px ui-monospace, Consolas, monospace;
        }
        .dl {
            position: fixed; z-index: 2147483646; width: 36px; height: 36px; padding: 0;
            display: grid; place-items: center; border: none; border-radius: 50%; cursor: pointer;
            background: rgba(0,0,0,.65); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4);
        }
        .dl:hover { background: #FFFC00; color: #111; }
        .dl[data-count]::after {
            content: attr(data-count); position: absolute; top: -6px; right: -8px; padding: 1px 5px; border-radius: 8px;
            background: #FFFC00; color: #111; font: 700 10px system-ui, sans-serif;
        }
        .dl.busy { opacity: .6; cursor: progress; animation: se-pulse 1s ease-in-out infinite; }
        @keyframes se-pulse { 50% { transform: scale(.9); } }
        .dl[hidden] { display: none; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
    `;

    function mountGui() {
        const mediaStyle = document.createElement("style");
        mediaStyle.textContent = "img, video, audio { pointer-events: auto !important; }";
        document.head.append(mediaStyle);

        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "closed" });
        root.innerHTML = `
            <style>${CSS}</style>
            <button class="fab" aria-label="SnapEnhance" aria-expanded="false" title="SnapEnhance (Alt+Shift+S)">👻</button>
            <div class="panel" role="dialog" aria-label="SnapEnhance" hidden>
                <header><b>SnapEnhance Web</b><span class="ver">v${VERSION}</span>
                    <button class="close" aria-label="${t("Close", "Fermer")}">×</button></header>
                <div class="list">
                    <div class="tools"><button class="dlall">${t("⬇ Download all media in this chat", "⬇ Télécharger tous les médias du chat")}</button></div>
                    ${Object.entries(FEATURES).map(([k, [label, desc]]) => `
                    <label><span>${label}<small>${desc}</small></span>
                    <input type="checkbox" role="switch" data-key="${k}"></label>`).join("")}
                    <label class="custom" style="cursor:auto">${t("Custom blocked requests", "Requêtes bloquées en plus")}
                        <small>${t("One URL fragment per line, copied from DevTools → Network. Use it to fix a feature after a Snapchat update.",
                                   "Un morceau d'URL par ligne, copié depuis F12 → Réseau. Sert à réparer une fonction après une mise à jour de Snapchat.")}</small>
                        <textarea spellcheck="false" placeholder="ex. MessagingCoreService/UpdateConversation"></textarea></label>
                </div>
                <footer><span class="hint">${t("Changes apply instantly · Alt+Shift+S · drag 👻 to move it", "Appliqué tout de suite · Alt+Maj+S · fais glisser 👻 pour le déplacer")}</span>
                    <button class="reset">${t("Reset", "Réinitialiser")}</button></footer>
            </div>
            <button class="dl" aria-label="${t("Download media", "Télécharger le média")}" title="${t("Download", "Télécharger")}" hidden>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"
                    stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>`;
        document.body.append(host);

        const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
        const fab = $(".fab"), panel = $(".panel"), tools = $(".tools");
        const boxes = [...root.querySelectorAll("input")] as HTMLInputElement[];
        const blocklist = root.querySelector("textarea")!;
        blocklist.value = localStorage.getItem(BLOCKLIST_KEY) || "";

        const render = () => {
            boxes.forEach((b) => (b.checked = settings[b.dataset.key as Key]));
            tools.hidden = !settings.mediaDownload;
            mediaStyle.disabled = !settings.mediaDownload;
        };
        const apply = (next: Settings) => {
            saveAndBroadcast(next, blocklist.value);
            render();
        };
        const placePanel = () => {
            const r = fab.getBoundingClientRect();
            panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 348))}px`;
            const below = r.top < innerHeight / 2;
            panel.style.top = below ? `${r.bottom + 10}px` : "auto";
            panel.style.bottom = below ? "auto" : `${innerHeight - r.top + 10}px`;
            panel.style.maxHeight = `${(below ? innerHeight - r.bottom : r.top) - 20}px`;
        };
        const toggle = (open = panel.hidden) => {
            if (open) placePanel();
            panel.hidden = !open;
            fab.setAttribute("aria-expanded", String(open));
            if (open) boxes[0].focus();
        };

        // Draggable button, position remembered
        const placeFab = (x: number, y: number) => {
            fab.style.left = `${Math.max(4, Math.min(x, innerWidth - 44))}px`;
            fab.style.top = `${Math.max(4, Math.min(y, innerHeight - 44))}px`;
            fab.style.bottom = "auto";
        };
        try {
            const p = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
            if (p) placeFab(p.x, p.y);
        } catch { /* ignore bad saved position */ }
        let drag: { dx: number; dy: number; x0: number; y0: number } | null = null;
        let dragged = false;
        origAdd.call(fab, "pointerdown", (e: any) => {
            const r = fab.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY };
            dragged = false;
            fab.setPointerCapture(e.pointerId);
        });
        origAdd.call(fab, "pointermove", (e: any) => {
            if (!drag) return;
            if (!dragged && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
            dragged = true;
            fab.classList.add("dragging");
            placeFab(e.clientX - drag.dx, e.clientY - drag.dy);
            if (!panel.hidden) placePanel();
        });
        origAdd.call(fab, "pointerup", () => {
            if (dragged) {
                const r = fab.getBoundingClientRect();
                localStorage.setItem(POSITION_KEY, JSON.stringify({ x: r.left, y: r.top }));
            }
            fab.classList.remove("dragging");
            drag = null;
        });
        origAdd.call(fab, "click", () => {
            if (!dragged) toggle();
            dragged = false;
        });

        boxes.forEach((b) => origAdd.call(b, "change", () => apply({ ...settings, [b.dataset.key as Key]: b.checked })));
        origAdd.call(blocklist, "input", () => apply(settings));
        origAdd.call($(".reset"), "click", () => {
            blocklist.value = "";
            localStorage.removeItem(POSITION_KEY);
            fab.removeAttribute("style");
            apply({ ...DEFAULTS });
        });
        origAdd.call($(".close"), "click", () => toggle(false));
        origAdd.call(window, "keydown", (e: any) => {
            if (e.altKey && e.shiftKey && e.code === "KeyS") {
                e.preventDefault();
                e.stopImmediatePropagation();
                toggle();
            } else if (e.key === "Escape" && !panel.hidden) {
                toggle(false);
                fab.focus();
            }
        }, true);
        origAdd.call(window, "pointerdown", (e: Event) => {
            if (!panel.hidden && !e.composedPath().includes(host)) toggle(false);
        }, true);

        const dlAll = $(".dlall") as HTMLButtonElement;
        origAdd.call(dlAll, "click", async () => {
            const label = dlAll.textContent;
            dlAll.disabled = true;
            dlAll.textContent = t("Downloading…", "Téléchargement…");
            const n = await downloadAll();
            dlAll.textContent = n ? t(`✓ ${n} file(s)`, `✓ ${n} fichier(s)`) : t("No media loaded — scroll up the chat", "Aucun média chargé — remonte dans le chat");
            setTimeout(() => { dlAll.textContent = label; dlAll.disabled = false; }, 2500);
        });

        render();
        setupDownloadButton(host, $(".dl") as HTMLButtonElement);
        setupDeletedKeeper();
    }

    function setupDownloadButton(host: HTMLElement, dl: HTMLButtonElement) {
        let target: Media | null = null;
        let queued = false;
        // elementsFromPoint sees media even under Snapchat's overlays
        const findMedia = (x: number, y: number) => {
            for (const el of document.elementsFromPoint(x, y)) {
                const m = el.matches("[role=button]") ? el.querySelector("video, img") : el;
                if (m && isDownloadable(m)) return m;
            }
            return null;
        };

        origAdd.call(document, "pointermove", (e: any) => {
            if (e.composedPath().includes(host)) return; // keep the button while hovering it
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                target = settings.mediaDownload ? findMedia(e.clientX, e.clientY) : null;
                dl.hidden = !target;
                if (!target) return;
                const parts = target instanceof HTMLVideoElement ? videoPartCount(target) : 1;
                if (parts > 1) dl.dataset.count = `×${parts}`;
                else delete dl.dataset.count;
                dl.title = parts > 1 ? t(`Download the full video (${parts} parts)`, `Télécharger la vidéo entière (${parts} parties)`) : t("Download", "Télécharger");
                const r = boxOf(target);
                if (target instanceof HTMLAudioElement) {
                    // Overlapping the player would hide its controls: sit at its right edge instead
                    dl.style.top = `${r.top + (r.height - 36) / 2}px`;
                    dl.style.left = `${Math.min(r.right - 6, innerWidth - 44)}px`;
                } else {
                    dl.style.top = `${Math.max(r.top + 8, 8)}px`;
                    dl.style.left = `${Math.min(r.right - 44, innerWidth - 44)}px`;
                }
            });
        }, { capture: true, passive: true });
        origAdd.call(dl, "click", async (e: Event) => {
            e.stopPropagation();
            if (!target || dl.classList.contains("busy")) return;
            dl.classList.add("busy");
            try {
                await (target instanceof HTMLVideoElement ? downloadVideo(target) : downloadMedia(target));
            } finally {
                dl.classList.remove("busy");
            }
        });
    }

    if (document.readyState === "loading") origAdd.call(document, "DOMContentLoaded", mountGui);
    else mountGui();
})();
