// ==UserScript==
// @name         SnapEnhance Web
// @namespace    snapenhance-web
// @description  A userscript to Enhance the User experience on Snapchat Web
// @version      1.5.0
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
    const VERSION = "1.5.0";
    const STORAGE_KEY = "snapenhance-web:settings";
    const BLOCKLIST_KEY = "snapenhance-web:blocklist";
    const POSITION_KEY = "snapenhance-web:button-position";

    const FR = /^fr\b/i.test(navigator.language);
    const t = (en: string, fr: string) => (FR ? fr : en);

    // [label, description, default]
    const FEATURES = {
        uploadSizeBypass: [t("Bypass upload size", "Pas de limite de taille"), t("Send files bigger than Snapchat's limit", "Envoyer des fichiers plus gros que la limite de Snapchat"), true],
        storyReadReceipts: [t("Hide story views", "Vues de story invisibles"), t("Watch stories without showing up in viewers", "Regarder les stories sans apparaître dans les vues"), true],
        chatReadReceipts: [t("Hide chat read receipts", "Pas d'accusé de lecture"), t("Read messages without marking them as seen", "Lire les messages sans qu'ils passent en « Vu »"), true],
        snapReadReceipts: [t("Open snaps anonymously", "Ouvrir les snaps en anonyme"), t("Red/purple snaps stay unopened for the sender. Also blocks saving, reacting and deleting messages", "Les snaps rouges/violets restent « non ouverts » chez l'envoyeur. Bloque aussi enregistrer, réagir et supprimer un message"), true],
        hideBitmoji: [t("Hide bitmoji & typing", "Cacher bitmoji et « écrit… »"), t("Friends don't see you in the chat or typing (blocks presence messages)", "Tes amis ne te voient pas dans le chat ni en train d'écrire"), true],
        screenshotBypass: [t("Bypass screenshot detection", "Captures d'écran non détectées"), t("PrintScreen, Win/Cmd+Shift, Ctrl+Shift and right-click no longer trigger it", "Impr. écran, Win/Cmd+Maj, Ctrl+Maj et clic droit ne déclenchent plus rien"), true],
        alwaysFocused: [t("Stay focused", "Toujours actif"), t("No blur or away state when you switch windows", "Pas de flou ni d'état « absent » quand tu changes de fenêtre"), true],
        mediaDownload: [t("Media download", "Téléchargement des médias"), t("Download button on images, videos, stories and voice notes", "Bouton de téléchargement sur images, vidéos, stories et notes vocales"), true],
        blockTracking: [t("Block tracking", "Bloquer le pistage"), t("Blocks Snapchat analytics and error reports", "Bloque les statistiques et rapports d'erreurs envoyés à Snapchat"), true],
        debug: [t("Debug logs", "Logs de débogage"), t("Log blocked requests in the console", "Affiche les requêtes bloquées dans la console"), false],
    } as const;
    type Key = keyof typeof FEATURES;
    type Settings = Record<Key, boolean>;

    const DEFAULTS = Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, f[2]])) as Settings;
    function loadSettings(): Settings {
        try {
            return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
        } catch {
            return { ...DEFAULTS };
        }
    }
    const settings = loadSettings();
    // User-defined URL fragments to block (one per line), to repair features without recompiling
    const savedBlocklist = localStorage.getItem(BLOCKLIST_KEY) || "";
    const customBlocked = savedBlocklist.split("\n").map((s) => s.trim()).filter(Boolean);
    const log = (...a: any[]) => settings.debug && console.log("[SnapEnhance]", ...a);
    const urlOf = (input: any): string =>
        typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";

    // Keep originals before hooking so our own UI is never filtered by our hooks
    const origAdd = EventTarget.prototype.addEventListener;
    const origRemove = EventTarget.prototype.removeEventListener;

    // ---- Upload size
    if (settings.uploadSizeBypass) {
        Object.defineProperty(File.prototype, "size", { get: () => 500 });
    }

    // ---- Main thread requests: story views, tracking, custom blocklist
    const TRACKING = ["web-blizzard/web/send", "/graphene/web", "sentry.sc-prod.net", "/web/metrics"];
    const mainBlocked = [...customBlocked];
    if (settings.storyReadReceipts) mainBlocked.push("readreceipt-indexer/batchuploadreadreceipts");
    if (settings.blockTracking) mainBlocked.push(...TRACKING);
    const isBlocked = (url: string) => mainBlocked.some((b) => url.includes(b));
    if (mainBlocked.length) {
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
    }

    // ---- Worker hooks (chat read receipts, presence/typing). Runs inside the worker: must be self-contained.
    function workerInjected(s: Settings, extra: string[], tracking: string[]) {
        const wlog = (...a: any[]) => s.debug && console.log("[SnapEnhance worker]", ...a);
        const blocked = [...extra];
        if (s.chatReadReceipts) blocked.push("messagingcoreservice.MessagingCoreService/UpdateConversation");
        if (s.hideBitmoji) blocked.push("messagingcoreservice.MessagingCoreService/SendTypingNotification");
        // Per-message state (viewed, replayed, saved, reacted...): no way to tell actions apart without decoding protobuf
        if (s.snapReadReceipts) blocked.push("MessagingCoreService/UpdateContentMessage", "MessagingCoreService/BatchUpdateContentMessages");
        if (s.blockTracking) blocked.push(...tracking);

        if (s.hideBitmoji) {
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
                if (isPresence(data)) return wlog("blocked presence");
                return origSend.call(this, data);
            };
        }

        const origFetch = self.fetch;
        self.fetch = function (...args: any[]) {
            const url = urlOf(args[0]);
            if (blocked.some((b) => url.includes(b))) {
                wlog("blocked", url);
                return Promise.resolve(new Response(null, { status: 200 }));
            }
            return origFetch.apply(self, args as any);
        };
    }

    const OrigBlob = window.Blob;
    window.Blob = class extends OrigBlob {
        constructor(parts?: any[], options?: BlobPropertyBag) {
            if (typeof parts?.[0] === "string" && parts[0].startsWith("importScripts")) {
                parts = [...parts];
                const args = [settings, customBlocked, TRACKING].map((a) => JSON.stringify(a)).join(",");
                parts[0] += `;\nconst urlOf=${urlOf};(${workerInjected})(${args});\n`;
                window.Blob = OrigBlob;
            }
            super(parts, options);
        }
    } as typeof Blob;

    // ---- Media download
    if (settings.mediaDownload) {
        const origSetAttribute = Element.prototype.setAttribute;
        HTMLMediaElement.prototype.setAttribute = function (name: string, value: string) {
            if (name.toLowerCase() === "controlslist") return;
            return origSetAttribute.call(this, name, value);
        };
        // Capture on window runs before Snapchat's handlers; we stop them but keep the native menu
        origAdd.call(window, "contextmenu", (e: any) => {
            const hit = document.elementsFromPoint(e.clientX, e.clientY)
                .some((el) => el instanceof HTMLImageElement || el instanceof HTMLMediaElement);
            if (hit) e.stopImmediatePropagation();
        }, true);
    }

    // ---- Focus / screenshot
    if (settings.alwaysFocused) {
        document.hasFocus = () => true;
        Object.defineProperty(document, "hidden", { get: () => false });
        Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    }

    // Mirrors Snapchat's detector: PrintScreen, or Shift with Ctrl/Meta held (Win+Shift+S, Cmd+Shift+4...)
    const isScreenshotKey = (e: KeyboardEvent) => e.key === "PrintScreen" || (e.shiftKey && (e.metaKey || e.ctrlKey));
    const keyWrappers = new WeakMap<Function, Function>();

    EventTarget.prototype.addEventListener = function (type: string, listener: any, options?: any) {
        if (settings.alwaysFocused && (this === window || this === document)
            && (type === "blur" || type === "focus" || type === "visibilitychange")) return;
        // Snapchat flags any right-click on window as a screenshot attempt
        if (settings.screenshotBypass && this === window && type === "contextmenu") return;
        if (settings.screenshotBypass && (type === "keydown" || type === "keyup") && typeof listener === "function") {
            const original = listener;
            let wrapped = keyWrappers.get(original);
            if (!wrapped) {
                wrapped = function (this: any, e: KeyboardEvent) {
                    if (isScreenshotKey(e)) return log("blocked screenshot key", e.key);
                    return original.call(this, e);
                };
                keyWrappers.set(original, wrapped);
            }
            listener = wrapped;
        }
        return origAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type: string, listener: any, options?: any) {
        return origRemove.call(this, type, keyWrappers.get(listener) ?? listener, options);
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
        footer .hint.dirty { color: #FFFC00; }
        footer button { border: none; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12.5px; font-weight: 600; }
        .reset { background: #2c2e33; color: #ddd; }
        .reload { background: #FFFC00; color: #111; }
        .reload:disabled { opacity: .35; cursor: default; }
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
    const HINT = t("Alt+Shift+S · drag 👻 to move it", "Alt+Maj+S · fais glisser 👻 pour le déplacer");

    function mountGui() {
        if (settings.mediaDownload) {
            const style = document.createElement("style");
            style.textContent = "img, video, audio { pointer-events: auto !important; }";
            document.head.append(style);
        }

        const host = document.createElement("div");
        const root = host.attachShadow({ mode: "closed" });
        root.innerHTML = `
            <style>${CSS}</style>
            <button class="fab" aria-label="SnapEnhance" aria-expanded="false" title="SnapEnhance (Alt+Shift+S)">👻</button>
            <div class="panel" role="dialog" aria-label="SnapEnhance" hidden>
                <header><b>SnapEnhance Web</b><span class="ver">v${VERSION}</span>
                    <button class="close" aria-label="${t("Close", "Fermer")}">×</button></header>
                <div class="list">
                    ${settings.mediaDownload ? `<div class="tools"><button class="dlall">${t("⬇ Download all media in this chat", "⬇ Télécharger tous les médias du chat")}</button></div>` : ""}
                    ${Object.entries(FEATURES).map(([k, [label, desc]]) => `
                    <label><span>${label}<small>${desc}</small></span>
                    <input type="checkbox" role="switch" data-key="${k}"></label>`).join("")}
                    <label class="custom" style="cursor:auto">${t("Custom blocked requests", "Requêtes bloquées en plus")}
                        <small>${t("One URL fragment per line, copied from DevTools → Network. Use it to fix a feature after a Snapchat update.",
                                   "Un morceau d'URL par ligne, copié depuis F12 → Réseau. Sert à réparer une fonction après une mise à jour de Snapchat.")}</small>
                        <textarea spellcheck="false" placeholder="ex. MessagingCoreService/UpdateConversation"></textarea></label>
                </div>
                <footer><span class="hint"></span>
                    <button class="reset">${t("Reset", "Réinitialiser")}</button><button class="reload" disabled>${t("Reload", "Recharger")}</button></footer>
            </div>
            <button class="dl" aria-label="${t("Download media", "Télécharger le média")}" title="${t("Download", "Télécharger")}" hidden>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"
                    stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>`;
        document.body.append(host);

        const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
        const fab = $(".fab"), panel = $(".panel"), hint = $(".hint"), reload = $(".reload") as HTMLButtonElement;
        const boxes = [...root.querySelectorAll("input")] as HTMLInputElement[];
        const blocklist = root.querySelector("textarea")!;
        const saved = JSON.stringify(settings);
        const draft: Settings = { ...settings };
        blocklist.value = savedBlocklist;

        const render = () => {
            boxes.forEach((b) => (b.checked = draft[b.dataset.key as Key]));
            const dirty = JSON.stringify(draft) !== saved || blocklist.value !== savedBlocklist;
            reload.disabled = !dirty;
            hint.textContent = dirty ? t("Reload to apply changes", "Recharge pour appliquer") : HINT;
            hint.classList.toggle("dirty", dirty);
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

        boxes.forEach((b) => origAdd.call(b, "change", () => {
            draft[b.dataset.key as Key] = b.checked;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
            render();
        }));
        origAdd.call(blocklist, "input", () => {
            localStorage.setItem(BLOCKLIST_KEY, blocklist.value);
            render();
        });
        origAdd.call($(".reset"), "click", () => {
            Object.assign(draft, DEFAULTS);
            blocklist.value = "";
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(BLOCKLIST_KEY);
            localStorage.removeItem(POSITION_KEY);
            fab.removeAttribute("style");
            render();
        });
        origAdd.call(reload, "click", () => location.reload());
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

        const dlAll = root.querySelector(".dlall") as HTMLButtonElement | null;
        if (dlAll) origAdd.call(dlAll, "click", async () => {
            const label = dlAll.textContent;
            dlAll.disabled = true;
            dlAll.textContent = t("Downloading…", "Téléchargement…");
            const n = await downloadAll();
            dlAll.textContent = n ? t(`✓ ${n} file(s)`, `✓ ${n} fichier(s)`) : t("No media loaded — scroll up the chat", "Aucun média chargé — remonte dans le chat");
            setTimeout(() => { dlAll.textContent = label; dlAll.disabled = false; }, 2500);
        });

        render();
        if (settings.mediaDownload) setupDownloadButton(host, $(".dl") as HTMLButtonElement);
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
                target = findMedia(e.clientX, e.clientY);
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
