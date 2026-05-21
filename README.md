# Token Overlay

Real-time Claude token usage overlay for your desktop — always on top, always watching.

![Token Overlay screenshot](https://github.com/MycelialROM/token-overlay/raw/master/assets/screenshot.png)

## Download

Go to [**Releases**](https://github.com/MycelialROM/token-overlay/releases) and download the installer for your platform:

| Platform | File |
|----------|------|
| Windows  | `Token-Overlay-Setup-x.x.x.exe` (installer) or `Token-Overlay-x.x.x.exe` (portable) |
| macOS    | `Token-Overlay-x.x.x.dmg` |
| Linux    | `Token-Overlay-x.x.x.AppImage` or `.deb` |

## Features

- **Water-fill tank** — visualizes context window consumption in real time
- **Per-token cost tracking** — Opus, Sonnet, and Haiku pricing built in
- **Always on top** — transparent frameless overlay, draggable, collapsible
- **Auto-update** — silently downloads new releases in the background
- **Claude Code integration** — hook script feeds live usage automatically
- **Secure local API** — bearer-token auth, hash rate limiting, parameterized SQLite queries

## Claude Code Integration

Add this to `~/.claude/settings.json` to feed live token data automatically:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/token-overlay/claude-hook.js"
          }
        ]
      }
    ]
  }
}
```

## Manual Updates

You can also push token data manually:

```bash
node update-tokens.js --input 5000 --output 1200 --model claude-sonnet-4-6
node update-tokens.js --add --input 800 --output 200   # accumulate
node update-tokens.js --status                          # show current
node update-tokens.js --reset                           # clear session
```

The bearer token is auto-generated on first run at `~/.claude/token-overlay-config.json`.

## HTTP API

The overlay exposes a local API on `http://127.0.0.1:51234`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/status` | None | Current usage |
| `POST` | `/update` | Bearer | Push new usage |
| `POST` | `/reset`  | Bearer | Clear session |

## Building from Source

```bash
git clone https://github.com/MycelialROM/token-overlay.git
cd token-overlay
npm install
npm start
```

To build distributables:

```bash
npm run dist
```

## Releasing a New Version

```bash
npm version patch   # or minor / major
git push && git push --tags
```

GitHub Actions will automatically build all three platforms and publish to Releases.
