# dsh-streamfold

> A better conversation window: **the newest thinking window opens automatically while a turn runs**, older windows fold themselves, and when the turn finishes the thinking and tool calls fold away — interleaved prose can stay unfolded. Water-like motion throughout.

> **Why this project exists**: the official Compact mode stops folding when a session still has unloaded history; dsh-streamfold folds on its own terms and does not depend on whether history has finished loading.

- **Peek at what dsh is thinking right now.** The newest thinking window opens automatically while it works, and the transcript still stays tidy.
- **Motion.** We wanted an interface that simply feels good to look at: window height, folding and scroll-follow all advance per frame, like water — no jumps.
- **Sparks.** Blue sparks rise from the bottom edge of the running thinking window, like a grinding wheel on metal: the faster the content scrolls, the denser they fly, and they stop when it stops. Colour and density are configurable; turning it off means it never runs.
- **Forging.** While the answer streams, every new chunk throws a small spray of sparks from the writing head (the end of the last line), drifting outwards like metal struck on an anvil. Written text only; pause and the hammer stops, and the sparks burn out on their own. Colour, density, speed and lifetime are configurable.

## Why it is light

- **No separate view.** It enhances the official transcript through semantic attributes instead of shipping its own conversation shell, taking over the render pipeline or depending on internal renderer contracts — a small upgrade surface.
- **No dependencies, no build.** Hand-written `lib/`; the host half does one thing — persist settings to `~/.dsh/streamfold.json`.
- **No changes to DSH source; clean uninstall.**

## Install

```bash
dsh plugin --profile web add https://github.com/rezon-aki/dsh-streamfold
```

Restart the profile, then **refresh the browser page** (client code is injected at page load).

Requires DSH **>= 0.1.5-rc.2** (depends on that version's transcript DOM contract).

Uninstall:

```bash
dsh plugin --profile web remove dsh-streamfold
```

## Usage

Settings → General → **Conversation display** → choose **Fold** (the third option, replacing the official row):

| Option | Behaviour |
| --- | --- |
| Standard | Official standard (all process rows visible) |
| Compact | Official compact |
| Fold | This plugin: one window for the running turn, the rest folds into one line |

Dedicated settings page: Settings → **Streamfold** (all switches below, applied immediately).

While running, only the newest thinking window opens automatically; **windows you opened yourself are never auto-collapsed**, and a superseded window folds back into a one-line summary after the "superseded grace" (2s by default). Scrolling up stops the follow, and a "↓ back to bottom" button appears once you are away from the bottom.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Fold history turns | on | Off: do not fold past turns on page load (only while a turn runs) |
| Keep interleaved prose | off | Keep prose rows while folding and give them a capped window (the final answer is never wrapped) |
| Window height | 260 | Max height of a thinking / interleaved-prose window (px) |
| Auto-expand thinking while running | on | Only the newest block of the running turn; superseded windows fold after the grace period |
| Superseded grace | 2 s | How long an older window waits before folding into a summary line (0–60, decimals allowed) |
| Auto-expand tools while running | off | Expand the newest tool card using the official card's own disclosure/scroll |
| Auto-follow the bottom | on | Stick to the bottom while content grows; scrolling up stops it |
| Smoothing factor | 0.15 | Share of the remaining gap consumed per frame (0.05–0.9) |
| Minimum step | 1 | Minimum pixels advanced per 16 ms (refresh-rate independent) |
| Show "back to bottom" | on | Shown when away from the bottom (hidden for follow lag, to avoid flicker) |
| Animated transitions | on | Off makes folding / expanding / jumping instant |
| Window sparks | on | Sparks along the bottom edge of the running thinking window (standalone module: off = no canvas, no frames) |
| Spark colour | #4fa8ff | Spark colour; the core is brightened towards white heat |
| Spark density | 1 | Spark count multiplier (0.2–3): denser costs more to draw (shared by both spark kinds) |
| Forging sparks | on | Sparks thrown from the writing head while the answer streams; nothing new written, no hammer |

Settings live in browser localStorage and in the host file `~/.dsh/streamfold.json` (route `/streamfold/api/settings`), so a remote Web UI can write them too.

## Diagnostics

Browser console:

```js
__dshStreamfold.stats()          // window / fold / chip counts (incl. animation state)
__dshStreamfold.probe()          // row state, still-visible thinking rows, window animation, jump button, spark cost (probe().sparks)
__dshStreamfold.state()          // current settings + official "conversation display" snapshot
__dshStreamfold.set({ smoothGrow: 0.1, supersedeDelay: 3 })
```

When reporting an issue, attach the `probe()` output and your DSH version.

## Safety

- Client-side presentation only: it reads the conversation DOM, makes no network requests, touches no credentials and never modifies DSH source.
- The host half only persists settings to `~/.dsh/streamfold.json` behind a same-origin route `/streamfold/api/settings` (cross-site requests get 403).
- Clean uninstall: the settings row, window markers and injected styles are all removed.

## Development

- Hand-written, no build: `lib/client.js` (browser half, wrapped in `window.__ModuleLoader__`) and `lib/index.js` (host half).
- After editing `lib/*.js`, reload the plugin and **refresh the page**.
- Row anchors use official semantic attributes only: `[data-chat-flow]`, `[data-chat-flow-kind]`, `[data-chat-turn]`, `[data-disclosure-row][aria-expanded]`, `[data-variant=think]`, `[data-tool]`, `[data-sample=bash]`, `[class*=_thinkBody]`, `[class*=_bodyWrap]`, `[data-context-injection-body]` — never CSS module hashes.
- Verified on DSH 0.1.5-rc.2.

## License

MIT
