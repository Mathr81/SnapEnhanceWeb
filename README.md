# SnapEnhance Web
The web version of SnapEnhance

## Features
- [x] Bypass upload size
- [x] Download any media (images, videos, stories, voice notes): button on hover, or "download all" for the open chat
- [x] Bypass screenshot detection (PrintScreen, Win/Cmd+Shift, Ctrl+Shift, right-click)
- [x] Remove blur / away state when unfocused
- [x] Disable conversation read receipts
- [x] Disable story read receipts
- [x] Hide bitmoji and typing indicator (blocks presence messages only)
- [x] Block Snapchat tracking (analytics, error reports)
- [x] Settings panel in English or French, draggable button
- [x] Custom blocked requests, to fix a feature after a Snapchat update without recompiling

## Install
1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
   On Chrome/Edge, enable "Allow user scripts" (or developer mode) for it in `chrome://extensions`.
2. Open [snapenhance.user.js](https://github.com/Mathr81/SnapEnhanceWeb/releases/latest/download/snapenhance.user.js) and click Install.
   Updates are then automatic.

## Settings
Click the 👻 button in the bottom-left corner of Snapchat Web, or press **Alt+Shift+S**.
Settings are saved in your browser; reload the page to apply them.

If screenshot detection still triggers, enable **Strict screenshot mode** (it also blocks Snapchat's keyboard shortcuts, such as Enter to send).

If a feature stops working after a Snapchat update, open DevTools → Network, find the request that leaks it,
and paste part of its URL in **Custom blocked requests**.

## Development
```
npx -p typescript@5 tsc    # builds snapenhance.user.js (TypeScript 6+ puts "use strict" above the userscript header)
```
With Violentmonkey, open the local `snapenhance.user.js` and tick "Track local file" to reload it on every build.

## Release
Bump `@version` and `VERSION` in `snapenhance.user.ts`, commit, then:
```
git tag v1.3.0 && git push origin v1.3.0
```
GitHub Actions builds the script and publishes the release that installed copies update from.
