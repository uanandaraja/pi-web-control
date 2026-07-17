# Pi Control

A small Bun, Vite, and React control surface for Pi RPC. The Bun server launches `pi --mode rpc`, parses JSONL from stdout, and forwards events to the browser over WebSocket.

## Run locally

Requirements:

- Bun 1.3 or newer
- Pi installed and authenticated

Install dependencies:

```bash
bun install
```

Start the app:

```bash
bun run dev
```

Open `http://127.0.0.1:5173`.

Pi starts in the directory where you launch the app. Use the **Workspaces** section in the sidebar to add or switch to another directory on the host. You can still set an initial directory explicitly when useful:

```bash
PI_WORKSPACE=/absolute/path/to/your/project bun run dev
```

The Bun bridge listens on `127.0.0.1:8787`. Vite proxies `/ws` and `/api` to it during development.

## Production build

```bash
bun run build
bun run start
```

Open `http://127.0.0.1:8787`.

## Configuration

Copy values from `.env.example` into your shell or local environment.

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKSPACE` | Current directory | Directory Pi can read and modify |
| `PI_COMMAND` | `pi` | Pi executable path |
| `PI_WEB_HOST` | `127.0.0.1` | Bridge listen address |
| `PI_WEB_PORT` | `8787` | Bridge listen port |
| `PI_WEB_TOKEN` | Empty | Browser access token |
| `PI_AUTO_START` | `true` | Start Pi when the bridge starts |

The server refuses to bind to a non-loopback address without `PI_WEB_TOKEN`. For private remote access, keep the server on `127.0.0.1` and place it behind a private tunnel such as Tailscale Serve. Set `PI_WEB_ORIGIN` to the exact HTTPS origin used by the remote browser. Pi has the permissions of the account that launches it, so use a container or VM when the workspace or prompts are not fully trusted.

## Current scope

- Streaming user and assistant messages
- Markdown and code rendering
- Live tool execution cards
- Settled tool calls folded into a compact per-turn “Worked for …” disclosure
- Transient “Thinking...” state without exposing reasoning text
- Bottom-docked prompt composer with model search and thinking-level controls
- Prompt steering while Pi is running
- Abort, restart, and new session controls
- Search and resume previous sessions saved for the active workspace
- Add and switch host workspaces from the sidebar
- Session statistics and context usage
- Extension confirm, select, input, and editor dialogs
- Reconnect and session restoration
- Optional access token authentication

This is a single-operator MVP. Multiple browser tabs share the same Pi process and can all send commands.
