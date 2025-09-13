# Local Smart Autocomplete (Chrome Extension)

On-device text autocomplete using Chrome’s Built-in AI (LanguageModel, Summarizer, LanguageDetector). Privacy-first and fast — works in any text field across the web.

## Highlights
- 100% on-device. No cloud calls, no data leaves your browser
- Streaming completions with early stop and ghost-text UI (Tab to accept)
- Multilingual continuation with language detection
- Smart context (cursor-aware + optional summarization for long text)
- Configurable triggers and per‑site preferences

## Install
1. Go to `chrome://extensions/`
2. Enable Developer mode
3. Click “Load unpacked” and select this folder

Requirement: Chrome with Built-in AI components installed (LanguageModel). If needed, open `chrome://components/` and update “Optimization Guide On Device Model”.

## Use
- Focus any text field (textarea, input, or contenteditable)
- Trigger completion: `Ctrl+Shift+Space` (default)
- Accept: `Tab`; Dismiss: `Esc` or keep typing

Optional triggers (configure in Options):
- Ctrl+Enter
- Double‑space
- Auto‑suggest after punctuation

## Settings
Open the extension’s Options page:
- Triggers: Ctrl+Enter, double‑space, auto‑after‑punctuation
- Per‑site enable/disable (with configurable shortcut, default `Ctrl+Shift+S`)
- Cache size (entries, not MB)
- Min/Max sentences (affects streaming early stop and final truncation)

## How it works
- Detects the active input and extracts a small window of text around the cursor
- Summarizes earlier context when text is long (on-device Summarizer)
- Infers the likely tone and uses website context for better suggestions
- Calls the on-device LanguageModel with structured prompts (or streaming)
- Renders non-intrusive ghost text; Tab inserts at the exact cursor position

## Troubleshooting
- First use may need an on-device model download (one‑time). Check `chrome://on-device-internals`
- If streaming doesn’t start, completions fall back to non‑streaming automatically
- You can disable per site via the shortcut (default `Ctrl+Shift+S`)

## Privacy
- No data is sent anywhere; everything runs locally in your browser
- No persistence of user text; only in‑memory caches are used for speed

## Files
- `manifest.json` — MV3 manifest
- `src/content.js` — core logic: triggers, AI integration, ghost text
- `src/ui.css` — ghost text styles
- `options.html`, `src/options.js` — extension settings UI