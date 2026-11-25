// ==UserScript==
// @name         SnapEnhance Web
// @namespace    snapenhance-web
// @description  A userscript to Enhance the User experience on Snapchat Web
// @version      1.6.0
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
    const VERSION = "1.6.0";
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
    const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!.get!;
    Object.defineProperty(File.prototype, "size", {
        configurable: true,
        get() { return settings.uploadSizeBypass ? 500 : blobSize.call(this); },
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

    // ---- Media helpers
    type Media = HTMLImageElement | HTMLMediaElement;
    const BITMOJI = /bitmoji\.com|sc-cdn\.net\/3d\//;
    const mediaSrc = (m: Media) => m.currentSrc || m.src || m.querySelector("source")?.src || "";
    function isDownloadable(el: Element): el is Media {
        if (!(el instanceof HTMLImageElement || el instanceof HTMLMediaElement)) return false;
        const src = mediaSrc(el);
        if (!src || BITMOJI.test(src)) return false;
        const r = el.getBoundingClientRect();
        return el instanceof HTMLAudioElement ? r.width > 0 : r.width >= 80 && r.height >= 80;
    }

    async function downloadMedia(m: Media) {
        const src = mediaSrc(m);
        if (!src) return;
        try {
            const blob = await (await fetch(src)).blob();
            let ext = (blob.type.split("/")[1] || "bin").split(";")[0].replace("jpeg", "jpg").replace("mpeg", "mp3");
            if (m instanceof HTMLAudioElement && ext === "mp4") ext = "m4a"; // voice notes are AAC in an mp4 container
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `snapchat-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } catch (err) {
            // Cross-origin CDN without CORS: let the browser handle it
            log("download failed, opening in a new tab", err);
            window.open(src, "_blank");
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
        let timer = 0;
        const fingerprint = (n: Element) => (n.textContent || "").trim()
            + [...n.querySelectorAll("img, video, audio, source")].map((m: any) => m.currentSrc || m.src || "").join("|");
        const isConversation = () => /^\/web\/[0-9a-f-]{36}/.test(location.pathname);

        new MutationObserver((records) => {
            if (!settings.keepDeleted || !isConversation()) return;
            for (const r of records) {
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
                const fp = fingerprint(p.node);
                if (onScreen.has(fp) || [...onScreen].some((s) => s.includes(fp))) continue; // moved, not deleted
                const ghost = p.node.cloneNode(true) as HTMLLIElement;
                ghost.dataset.seGhost = "";
                ghost.style.cssText += ";opacity:.6;";
                const badge = document.createElement("div");
                badge.textContent = t("🗑 Deleted", "🗑 Supprimé");
                badge.style.cssText = "color:#e5484d;font:600 11px system-ui,sans-serif;margin:2px 0 0 8px";
                ghost.prepend(badge);
                p.parent.insertBefore(ghost, p.next && p.next.parentNode === p.parent ? p.next : null);
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
        const findMedia = (x: number, y: number) => document.elementsFromPoint(x, y).find(isDownloadable) ?? null;

        origAdd.call(document, "pointermove", (e: any) => {
            if (e.composedPath().includes(host)) return; // keep the button while hovering it
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                target = settings.mediaDownload ? findMedia(e.clientX, e.clientY) : null;
                dl.hidden = !target;
                if (!target) return;
                const r = target.getBoundingClientRect();
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
        origAdd.call(dl, "click", (e: Event) => {
            e.stopPropagation();
            if (target) downloadMedia(target);
        });
    }

    if (document.readyState === "loading") origAdd.call(document, "DOMContentLoaded", mountGui);
    else mountGui();
})();
