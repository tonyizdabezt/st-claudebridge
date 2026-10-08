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
6. Click **Connect via Custom** or **Connect via Claude**, then pick a model. Custom keeps more of your prompt's structure; see [Recommended setup](#recommended-setup).

## Updating

- **Server plugin:** with `enableServerPluginsAutoUpdate: true` (the default), SillyTavern runs `git pull` on `plugins/claude-bridge` at startup. It doesn't run `npm install`, so run it yourself when `package.json` changes. To update by hand:

  ```sh
  cd SillyTavern/plugins/claude-bridge
  git pull
  npm install
  ```

- **UI panel:** update it from **Extensions → Manage extensions**.

Update both together so the panel and plugin stay in sync.

## Recommended setup

Connect through SillyTavern's Custom source so your prompt reaches Claude in the shape you built it:

1. In the ClaudeBridge drawer, click **Connect via Custom**.
2. In the API Connections panel, set **Prompt Post-Processing** to **None**.
3. Pick a model that takes mid-chat system messages: `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-fable-5-1`, `claude-fable-5`, `sonnet` (Sonnet 5.5) or `haiku` (Haiku 5.5).

The model list shows the same models as SillyTavern's Claude source, followed by Claude Code's own entries such as `opus` and `sonnet`.

### What the Custom source keeps

With this setup, ClaudeBridge sends your prompt with its structure intact:

- **System prompt**: each system message at the top of your prompt becomes its own system block. Turn on **Squash system messages** in SillyTavern if you want them combined into one.
- **System messages inside the chat**: Author's Notes, lorebook entries at a depth and post-history instructions reach the model as real `system` messages, which Claude treats as instructions from the app rather than from the user.
- **Group chats**: replies from different characters in a row stay separate messages.
- **Chat start**: the chat can open with the character's greeting. No placeholder message is added before it.

On models without mid-chat system message support, those messages go to the model as user text, the way they always have.

### Where a system message can go in the chat

Claude accepts a system message inside the chat only right after a user message, and only when an assistant message follows it or it's the last message. On the models listed above, ClaudeBridge rejects any other spot with a 400 error that names the message, so you can move it. It doesn't reorder your prompt for you.

In practice, depth 0 (after your last message) always works. Depth 1 puts the message between the character's last reply and your message, so it fails. Deeper positions work when they land right after one of your messages.

### Why not the Claude source

SillyTavern's Claude source converts the prompt to Anthropic's format before ClaudeBridge sees it. That step turns every system message inside the chat into a user message and merges it with your message. No setting turns it off, so ClaudeBridge can't tell which text started as a system message.

If your prompt has no system messages inside the chat, the Claude source loses little. Compared with Custom:

- **Kept**: each system message at the top still becomes its own system block, as long as **Use system prompt** is on. The chat can open with the greeting.
- **Lost**: Author's Notes, lorebook entries at a depth and post-history instructions reach the model as part of your message, not as system messages.
- **Changed**: replies from different characters in a row arrive as one assistant message, with each reply still in its own text block.
- **Better**: example dialogue shows your user and character names. On Custom, example messages have no name in front.

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
