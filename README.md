# ClaudeBridge

A SillyTavern server plugin plus UI panel that sends chats through the Claude Agent SDK using your own Claude Code login (Pro/Max plan). It serves an Anthropic-style `/v1/messages` endpoint and an OpenAI-style `/v1/chat/completions` endpoint on `127.0.0.1`.

## Layout

The same repo is installed twice, once in each role:

| Role | Files | Installed to |
| --- | --- | --- |
| Server plugin | `index.js`, `lib/`, `package.json` | `SillyTavern/plugins/claude-bridge` |
| UI panel | `manifest.json`, `ui/` | `SillyTavern/data/<user>/extensions/st-claudebridge` |

## Install

1. In SillyTavern's `config.yaml`, set `enableServerPlugins: true`.
2. Install the server plugin:

   ```sh
   cd SillyTavern/plugins
   git clone https://github.com/tonyizdabezt/st-claudebridge claude-bridge
   cd claude-bridge
   npm install
   ```

3. Install the UI panel: in SillyTavern, open **Extensions → Install extension** and paste:

   ```
   https://github.com/tonyizdabezt/st-claudebridge
   ```

4. Restart SillyTavern. The console should print `[claude-bridge] Listening on http://127.0.0.1:7373/v1`.
5. Open the **ClaudeBridge** drawer in the Extensions panel. If it says "Not logged in", run the CLI path it shows and use `/login`.
6. Click **Connect (Claude source)** or **Connect (Custom)**, then pick a model.

## Updating

- **Server plugin:** with `enableServerPluginsAutoUpdate: true` (the default), SillyTavern runs `git pull` on `plugins/claude-bridge` at startup. It doesn't run `npm install`, so run it yourself when `package.json` changes. To update by hand:

  ```sh
  cd SillyTavern/plugins/claude-bridge
  git pull
  npm install
  ```

- **UI panel:** update it from **Extensions → Manage extensions**.

Update both together so the panel and plugin stay in sync.

## Configuration

`config.json` is created in the plugin folder on first run and is gitignored.

- `port` (default `7373`) and `secret` (the API key SillyTavern uses) can only be edited there.
- Effort, thinking, thinking budget, reasoning display and history mode can also be changed from the panel.

## Host metadata stripping

Claude Code adds your account email to the newest user message, and the working directory, OS and shell, the model's identity and today's date as a `system`-role message.

The plugin points the CLI (via `ANTHROPIC_BASE_URL`) at a local proxy on a random `127.0.0.1` port. The proxy drops those from `POST /v1/messages` bodies and forwards everything else unchanged to `api.anthropic.com`, including headers, auth and the system prompt.

Each chat session is created with a fixed title, so the CLI skips the extra model call it would otherwise make to name the session.

## Limitations

- Temperature, Top P/K and penalties are ignored.
- Prefill isn't supported: a request that ends with an assistant message gets a 400 error.
- Stop strings are emulated on the output stream.
- Tools, forced tool choice, structured JSON output and embeddings aren't supported.
- Usage counts against your plan limits, which are shared with Claude Code and claude.ai.

## License

MIT
