# ClaudeBridge

A SillyTavern server plugin plus UI panel that sends chats through the Claude Agent SDK using your own Claude Code login (Pro/Max plan). It serves an Anthropic-style `/v1/messages` endpoint and an OpenAI-style `/v1/chat/completions` endpoint on `127.0.0.1`.

> [!WARNING]
> ClaudeBridge is an unofficial community project. Anthropic doesn't make, endorse or support it. "Claude" is a trademark of Anthropic, PBC, and this project uses the name only to say what it connects to.
>
> Anthropic's terms may not cover using a Pro/Max subscription through third-party tools like this one, and Anthropic can limit or suspend accounts that don't follow them. Read the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Usage Policy](https://www.anthropic.com/legal/aup) before you install it. Use it at your own risk.

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
6. Click **Connect (Claude)** or **Connect (Custom)**, then pick a model.

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
- `idleTimeoutSeconds` (default `300`) can only be edited there. If Claude Code sends nothing for that long, the request stops with a 504 error. `0` turns this off.
- Effort, thinking, thinking budget, SDK identity stripping and model swaps can also be changed from the panel.

## Usage Insights

Open **Usage Insights** from the ClaudeBridge drawer or the wand menu. It shows messages, tokens, cache hits and misses, and what the same usage would cost on the API, broken down by day, model and chat.

Stats live in `usage.jsonl` in the plugin folder, so deleting chats doesn't remove them. Costs are Claude Code's own estimates. When a stop string or the Stop button cuts a reply short, the plugin counts the received text with Anthropic's free `count_tokens` endpoint.

## Prompt cleanup

Claude Code adds coding-session details to each request: your account email on the newest user message, and the working directory, OS, shell, model identity and date in a `system`-role message. None of that helps a roleplay chat, and it takes up context.

The plugin points the CLI (via `ANTHROPIC_BASE_URL`) at a local proxy on a random `127.0.0.1` port. The proxy removes those details from `POST /v1/messages` bodies and forwards the rest to `api.anthropic.com` as is, including headers, auth and the system prompt.

The Agent SDK also opens the system prompt with `You are a Claude agent, built on Anthropic's Claude Agent SDK.` The proxy leaves that line in by default. You can remove it with `stripSdkIdentity` (**Remove the Agent SDK identity line** in the panel). This is optional and Anthropic may reject requests that lack the line.

## Model swaps

Claude Code sometimes answers with a model other than the one you picked: when your model isn't available on your plan, or when its safeguards refuse a message and Claude Code retries on a fallback model. By default the plugin lets the reply through and logs a warning in the console.

Turn on `refuseModelSwap` (**Stop the reply if another model answers** in the panel) to stop those replies instead. The request then fails with a 409 error before any text from the other model is sent.

## Limitations

- Temperature, Top P/K and penalties are ignored.
- Prefill isn't supported: a request that ends with an assistant message gets a 400 error.
- Stop strings are emulated on the output stream.
- Tools, forced tool choice, structured JSON output and embeddings aren't supported.
- Usage counts against your plan limits, which are shared with Claude Code, Claude.ai chat and Claude Cowork.

## License

MIT
