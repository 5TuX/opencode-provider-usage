# opencode-codex-usage

Minimal `opencode` TUI plugin that shows live ChatGPT Codex usage in the prompt area.

It reads your existing local `opencode` OpenAI auth and fetches usage from the same backend Codex uses.

## What it shows

- 5h usage
- weekly usage
- time until the 5h window resets
- time until the weekly window resets

Example:

```text
Plus 5h 81% (54m) | wk 13% (3d)
```

## Install

1. Clone this repo anywhere stable.

```bash
git clone https://github.com/5TuX/opencode-codex-usage.git ~/Documents/gdrive-shared/opencode/opencode-codex-usage
```

2. Install dependencies.

```bash
cd ~/Documents/gdrive-shared/opencode/opencode-codex-usage
npm install
```

3. Point `opencode` TUI config at the plugin.

Create or update `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/YOUR_USER/Documents/gdrive-shared/opencode/opencode-codex-usage/plugins/codex-usage.tsx"
  ]
}
```

4. Quit and restart `opencode`.

## Notes

- Requires an existing `opencode` OpenAI login.
- Reads auth from `~/.local/share/opencode/auth.json`.
- Refreshes every 60 seconds.
- Registers a command: `Refresh Codex usage`.
- Badge is shown only when provider/model looks OpenAI/Codex-related (hidden for providers like Copilot), using current configured model first then session history as fallback.

## Minimal Roadmap

- show remaining instead of used
- add a footer/sidebar variant
