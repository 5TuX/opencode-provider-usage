# opencode-provider-usage

Minimal `opencode` TUI plugin that shows live provider usage in the prompt area.

It reads your existing local `opencode` auth and shows a provider-aware badge for supported providers.

## Supported Providers

- OpenAI: 5h and 7d ChatGPT usage windows, with reset timers
- GitHub Copilot: monthly premium interaction usage, with reset timer
- Anthropic: request and token rate-limit headroom, with request reset countdown when available
- Other providers: badge hidden

## What It Shows

- provider-aware badge shown only for supported providers
- OpenAI 5h usage
- OpenAI 7d usage
- time until the OpenAI 5h window resets
- time until the OpenAI 7d window resets
- Copilot monthly usage
- time until the Copilot monthly reset
- Anthropic remaining requests
- Anthropic remaining input tokens
- Anthropic remaining output tokens
- percent values colored with a readable pastel Jet colormap, from blue at low usage to red near the limit

Example:

```text
[Plus] 5h: 81% (-54m) | 7d: 13% (-3d)
[Pro] mo: 22% (-19d)
[API] 49 req | 50k in | 10k out (-12s)
```

## Install

1. Clone this repo anywhere stable.

```bash
git clone https://github.com/5TuX/opencode-provider-usage.git ~/opencode-provider-usage
```

2. Install dependencies.

```bash
cd ~/opencode-provider-usage
npm install
```

3. Point `opencode` TUI config at the plugin.

Create or update `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/absolute/path/to/opencode-provider-usage/plugins/provider-usage.tsx"
  ]
}
```

4. Quit and restart `opencode`.

## Notes

- Requires an existing `opencode` login for whichever supported provider you want to display.
- Reads auth from `~/.local/share/opencode/auth.json`.
- Reads current model selection from `~/.local/state/opencode/model.json` when available.
- Refreshes every 60 seconds.
- Hidden for unsupported providers.
- In chat, the badge follows the active session's own model history; switching to another session does not reuse the most recently selected model from a different session.
- An explicit model switch inside the current session takes precedence immediately.
- Visibility is refreshed every second and on TUI command/session changes so switching provider/model updates the badge without sending a message.

## Synced Device Workflow

For the shared multi-device setup, edit this repo copy of the plugin:

```text
~/Documents/gdrive-shared/opencode/opencode-provider-usage/plugins/provider-usage.tsx
```

Each device should keep `~/.config/opencode/plugins/` as a real local directory and link or copy the plugin file into it. The local `tui.json` should load the local file, not the synced repo path directly:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/YOU/.config/opencode/plugins/provider-usage.tsx"
  ]
}
```

After editing the repo file:

1. Let the synced folder update on each device.
2. Recreate the local link if the sync tool replaced the file.
3. Restart `opencode` on each device.

Linux symlink example:

```bash
ln -sfn ~/Documents/gdrive-shared/opencode/opencode-provider-usage/plugins/provider-usage.tsx ~/.config/opencode/plugins/provider-usage.tsx
```
