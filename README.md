# SnapEnhance Web

[![Latest release](https://img.shields.io/github/v/release/Mathr81/SnapEnhanceWeb)](https://github.com/Mathr81/SnapEnhanceWeb/releases/latest)
[![License: GPL-3.0](https://img.shields.io/github/license/Mathr81/SnapEnhanceWeb)](LICENSE)

A userscript that adds privacy and media features to [Snapchat Web](https://www.snapchat.com/web): read messages, stories and snaps without leaving a trace, save any media, and keep messages your friends delete.

**[⬇ Install](https://github.com/Mathr81/SnapEnhanceWeb/releases/latest/download/snapenhance.user.js)** · works in Chrome, Edge, Brave and other Chromium browsers.

## Features

### Privacy
| Feature | What it does |
|---|---|
| Hide chat read receipts | Read messages without them switching to "Opened" for the sender. |
| Hide story views | Watch stories without appearing in the viewer list. |
| Open snaps anonymously | Red and purple snaps stay "New" for the sender, even after you watched them. |
| Hide Bitmoji & typing | Friends don't see you in the chat or typing. |
| Bypass screenshot detection | PrintScreen, Win/Cmd+Shift, Ctrl+Shift and right-click no longer trigger Snapchat's screenshot detection. |
| Stay focused | No blur and no "away" state when you switch to another window. |
| Block tracking | Stops Snapchat's analytics and error reports. |

### Media & messages
| Feature | What it does |
|---|---|
| Download button | Hover an image, video, story, snap or voice note and click ⬇ to save it. |
| Full-length videos | Long videos arrive as 10-second snaps: the ⬇ button (shown with ×N) joins all the parts into one MP4, in the original quality and without re-encoding. |
| Download all | Saves every media file loaded in the open conversation in one click. |
| Keep deleted messages | A message deleted while the conversation is open stays visible, faded, with a 🗑 label. |
| Bypass upload size | Send files bigger than Snapchat's limit. |

### Settings
- Settings panel in English or French (follows your browser language).
- Every option can be turned on or off and **applies instantly**, no reload needed.
- **Custom blocked requests**: block any request yourself, to fix a feature after a Snapchat update without waiting for a new version.

## Installation

1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/) (recommended) or [Tampermonkey](https://www.tampermonkey.net/).
2. On Chrome, Edge or Brave, open `chrome://extensions`, then in the extension's **Details** turn on **Allow user scripts** (or turn on **Developer mode** at the top right).
3. Click **[Install](https://github.com/Mathr81/SnapEnhanceWeb/releases/latest/download/snapenhance.user.js)** and confirm.
4. Open [snapchat.com/web](https://www.snapchat.com/web). A 👻 button appears in the bottom-left corner.

Updates are installed automatically by your userscript manager.

## Usage

- Click 👻 or press **Alt+Shift+S** to open the settings panel. **Esc** closes it.
- Drag 👻 anywhere on the screen; its position is remembered.
- Settings are stored in your browser only, nothing is sent anywhere.

## Good to know

- **Open snaps anonymously** also blocks saving, reacting to and deleting messages from Snapchat Web: Snapchat sends all of these through the same encrypted request, so they can't be told apart. Turn the option off when you need them. If you already opened a snap in the current session, these actions stay blocked until you reload the page, so the "Opened" status can never leak.
- **Keep deleted messages** only works for messages that were displayed while the conversation was open. Messages deleted before you open the chat can't be recovered.
- A snap you watched anonymously may look opened on Snapchat Web until you reload the page. It stays "New" for the sender, and you can still open it normally on your phone later.

## Troubleshooting

If a feature stops working after a Snapchat update:

1. Turn on **Debug logs** in the panel and open the browser console (F12): every blocked request is logged with `[SnapEnhance]`.
2. Open DevTools → **Network**, do the action that leaks (open a chat, watch a story…) and find the request it sends.
3. Paste part of its URL in **Custom blocked requests**. It applies immediately.

Please [open an issue](https://github.com/Mathr81/SnapEnhanceWeb/issues) with what you found so it can be fixed for everyone.

## Development

The script is written in TypeScript in [`snapenhance.user.ts`](snapenhance.user.ts).

```sh
npx -p typescript@5 tsc    # builds snapenhance.user.js
```

TypeScript 5 is required: version 6 and later put `"use strict"` above the userscript header, which breaks it.

With Violentmonkey, open the built `snapenhance.user.js` from your disk and tick **Track local file**: the script reloads on every build.

### Releasing

1. Bump `@version` and `VERSION` in `snapenhance.user.ts` and commit.
2. Tag and push:
   ```sh
   git tag v1.7.0 && git push origin v1.7.0
   ```
3. GitHub Actions builds the script, checks that the tag matches `@version` and publishes the release that installed copies update from.

## Credits

Fork of [SnapEnhance/web](https://github.com/SnapEnhance/web).

## License

[GPL-3.0](LICENSE)

## Disclaimer

This project is not affiliated with, endorsed by or associated with Snap Inc. Modifying the Snapchat client may go against Snapchat's Terms of Service: use it at your own risk.
