// ==UserScript==
// @name         SnapEnhance Web
// @namespace    snapenhance-web
// @description  A userscript to Enhance the User experience on Snapchat Web
// @version      1.3.0
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
    const VERSION = "1.3.0";
    const STORAGE_KEY = "snapenhance-web:settings";
    const BLOCKLIST_KEY = "snapenhance-web:blocklist";

    // [label, description, default]
    const FEATURES = {
        uploadSizeBypass: ["Bypass upload size", "Send files bigger than Snapchat's limit", true],
        storyReadReceipts: ["Hide story views", "Watch stories without showing up in viewers", true],
        chatReadReceipts: ["Hide chat read receipts", "Read messages without marking them as seen", true],
        typingNotification: ["Hide typing indicator", "Friends don't see that you're typing", true],
        hideBitmoji: ["Hide bitmoji in chat", "Blocks all outgoing websocket messages (presence)", true],
        mediaDownload: ["Allow media download", "Download button on hover + right-click to save images, videos, voice notes", true],
        alwaysFocused: ["Stay focused", "No blur or away state when you switch windows", true],
        screenshotBypass: ["Bypass screenshot detection", "Ignores screenshot key combos (PrintScreen, Win/Cmd)", true],
        screenshotStrict: ["Strict screenshot mode", "Use if the above fails: blocks ALL page key listeners (Enter to send stops working)", false],
        debug: ["Debug logs", "Log blocked requests in the console", false],
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

    // ---- Story read receipts + custom blocklist (main thread)
    const mainBlocked = [...customBlocked];
    if (settings.storyReadReceipts) mainBlocked.push("readreceipt-indexer/batchuploadreadreceipts");
    if (mainBlocked.length) {
        const origFetch = window.fetch;
        window.fetch = function (...args: any[]) {
            const url = urlOf(args[0]);
            if (mainBlocked.some((b) => url.includes(b))) {
                log("blocked", url);
                return Promise.resolve(new Response(null, { status: 200 }));
            }
            return origFetch.apply(window, args as any);
        };
    }

    // ---- Worker hooks (chat read receipts, typing, bitmoji). Runs inside the worker: must be self-contained.
    function workerInjected(s: Settings, extra: string[]) {
        const wlog = (...a: any[]) => s.debug && console.log("[SnapEnhance worker]", ...a);
        const blocked = [...extra];
        if (s.typingNotification) blocked.push("messagingcoreservice.MessagingCoreService/SendTypingNotification");
        if (s.chatReadReceipts) blocked.push("messagingcoreservice.MessagingCoreService/UpdateConversation");

        if (s.hideBitmoji) {
            WebSocket.prototype.send = function () {
                wlog("blocked websocket send");
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
                parts[0] += `;\nconst urlOf=${urlOf};(${workerInjected})(${JSON.stringify(settings)},${JSON.stringify(customBlocked)});\n`;
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

    const isScreenshotKey = (e: KeyboardEvent) => e.key === "PrintScreen" || e.key === "Meta" || e.metaKey;
    const keyWrappers = new WeakMap<Function, Function>();
    const isKeyEvent = (type: string) => type === "keydown" || type === "keyup";

    EventTarget.prototype.addEventListener = function (type: string, listener: any, options?: any) {
        if (settings.alwaysFocused && (this === window || this === document)
            && (type === "blur" || type === "focus" || type === "visibilitychange")) return;
        if (isKeyEvent(type)) {
            if (settings.screenshotStrict) return;
            if (settings.screenshotBypass && typeof listener === "function") {
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
        }
        return origAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type: string, listener: any, options?: any) {
        return origRemove.call(this, type, keyWrappers.get(listener) ?? listener, options);
    };

    // ---- Settings GUI
    const CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
        .fab {
            position: fixed; left: 14px; bottom: 14px; z-index: 2147483647;
            width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
            background: #FFFC00; font-size: 20px; line-height: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,.35); opacity: .55; transition: opacity .15s, transform .15s;
        }
        .fab:hover, .fab:focus-visible, .fab[aria-expanded="true"] { opacity: 1; transform: scale(1.06); }
        .panel {
            position: fixed; left: 14px; bottom: 64px; z-index: 2147483647;
            width: 340px; max-height: calc(100vh - 90px); display: flex; flex-direction: column;
            background: #16171a; color: #eee; border: 1px solid #2c2e33; border-radius: 14px;
            box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 13px; overflow: hidden;
        }
        .panel[hidden] { display: none; }
        header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #2c2e33; }
        header b { font-size: 14px; }
        header .ver { color: #888; font-size: 11px; }
        header .close { margin-left: auto; background: none; border: none; color: #aaa; font-size: 20px; cursor: pointer; line-height: 1; }
        .list { overflow-y: auto; padding: 4px 0; }
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
            <button class="fab" aria-label="SnapEnhance settings" aria-expanded="false" title="SnapEnhance (Alt+Shift+S)">👻</button>
            <div class="panel" role="dialog" aria-label="SnapEnhance settings" hidden>
                <header><b>SnapEnhance Web</b><span class="ver">v${VERSION}</span>
                    <button class="close" aria-label="Close">×</button></header>
                <div class="list">${Object.entries(FEATURES).map(([k, [label, desc]]) => `
                    <label><span>${label}<small>${desc}</small></span>
                    <input type="checkbox" role="switch" data-key="${k}"></label>`).join("")}
                    <label class="custom" style="cursor:auto">Custom blocked requests
                        <small>One URL fragment per line, copied from DevTools → Network. Use it to fix a feature after a Snapchat update.</small>
                        <textarea spellcheck="false" placeholder="e.g. MessagingCoreService/UpdateConversation"></textarea></label>
                </div>
                <footer><span class="hint">Alt+Shift+S to toggle this panel</span>
                    <button class="reset">Reset</button><button class="reload" disabled>Reload</button></footer>
            </div>
            <button class="dl" aria-label="Download media" title="Download" hidden>
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
            hint.textContent = dirty ? "Reload to apply changes" : "Alt+Shift+S to toggle this panel";
            hint.classList.toggle("dirty", dirty);
        };
        const toggle = (open = panel.hidden) => {
            panel.hidden = !open;
            fab.setAttribute("aria-expanded", String(open));
            if (open) boxes[0].focus();
        };

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
            render();
        });
        origAdd.call(reload, "click", () => location.reload());
        origAdd.call(fab, "click", () => toggle());
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

        render();
        if (settings.mediaDownload) setupDownloadButton($(".dl") as HTMLButtonElement);
    }

    type Media = HTMLImageElement | HTMLMediaElement;
    const isMedia = (el: Element): el is Media => el instanceof HTMLImageElement || el instanceof HTMLMediaElement;

    async function downloadMedia(m: Media) {
        const src = m.currentSrc || m.src;
        if (!src) return;
        try {
            const blob = await (await fetch(src)).blob();
            const ext = (blob.type.split("/")[1] || "bin").split(";")[0].replace("jpeg", "jpg").replace("mpeg", "mp3");
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

    function setupDownloadButton(dl: HTMLButtonElement) {
        let target: Media | null = null;
        let queued = false;
        // elementsFromPoint sees media even under Snapchat's overlays; skip avatars/icons
        const findMedia = (x: number, y: number) => document.elementsFromPoint(x, y).find((el): el is Media => {
            if (!isMedia(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 80 && r.height >= 80;
        }) ?? null;

        origAdd.call(document, "pointermove", (e: any) => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                target = findMedia(e.clientX, e.clientY);
                dl.hidden = !target;
                if (!target) return;
                const r = target.getBoundingClientRect();
                dl.style.top = `${Math.max(r.top + 8, 8)}px`;
                dl.style.left = `${Math.min(r.right - 44, innerWidth - 44)}px`;
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
