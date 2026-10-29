# dsh-streamfold

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![format](https://img.shields.io/badge/format-DSH%20bundle-blueviolet.svg)](cordis.patch.yml)
[![npm](https://img.shields.io/badge/npm-dsh--streamfold-CB3837.svg)](https://www.npmjs.com/package/dsh-streamfold)

> The newest thinking window stays open while the rest of the process folds into one summary; when a turn finishes, the view glides back to your prompt. Folding advances per frame, and folded content stays Ctrl+F searchable.

![Demo (20 s): only the newest thinking window stays open while the rest folds into one summary, and a finished turn glides back to your prompt](https://github.com/rezon-aki/dsh-streamfold/blob/main/screenshots/03-demo.gif?raw=true)

## Why it exists

In a long conversation, tool calls and reasoning drown out the prose. The official Compact mode also stops folding while a session still has unloaded history, so it cannot help until everything is loaded. This plugin enhances the official transcript and folds on its own terms, independent of whether history has finished loading:

- **Process stops drowning the prose**: past turns collapse into a single "N rows folded · click to expand" line.
- **What you want to watch stays visible**: while a turn runs, only the newest thinking window stays open — capped height, scrolling inside itself.
- **No scrolling back after a turn**: when it finishes, the view glides back to the message that started it.

**How it differs from the official modes and Friendly Steps**

| | Official "Work details" | This plugin's Fold |
| --- | --- | --- |
| When it folds | Only once history has loaded; folding stalls while history is still loading | Folds on its own terms, independent of history loading |
| Thinking while running | Process rows fold too — you see the summary | Only the running turn's newest thinking window stays open (capped, self-scrolling) |
| After a turn | Stops at the bottom; you scroll back yourself | Glides back to the message that started the turn |
| Finding folded content | Expand it again | `hidden=until-found`, so Ctrl+F still hits it |
| Reading a past turn | Scroll up to find its prompt | That turn's prompt stays pinned at the top |

It overlaps with **Friendly Steps** (`ui`/`chat`, also folds Think and tool rows), so pick one; the differences are mainly the last three rows above plus the per-frame, three-rows-per-group folding rhythm.

## What it looks like once installed

- **You can watch it think.** The newest thinking window of the running turn opens automatically (height configurable); older ones fold back into a one-line summary after a grace period. Superseded windows and past turns no longer fight for the scroll position.
- **Folding keeps a rhythm and does not flash.** Collapsing runs bottom-up, 3 rows per group with a 70 ms stagger; expanding runs top-down, 3 rows per group. Cross-turn batches (page load, session switch) complete instantly; even a very long single turn advances group by group (only a single turn over 84 rows takes the instant guard rail).
- **Settle on the prompt.** When a turn finishes, the view glides back to **the message that started it** — or, when "Keep LLM questions unfolded" is on and the turn contains an `ask_user_question` card, to the turn's **last question card**, auto-expanded (that is what needs your answer). Skipped if you scrolled away yourself. For 2 seconds after arrival it also corrects late layout shifts from images or code blocks.
- **Pin the prompt.** The prompt of the turn you are reading stays pinned to the top of the conversation, one line with an ellipsis; it steps aside while the real row is on screen, and clicking it glides back to that message.
- **Steady follow.** The bottom follow advances per frame; scrolling up stops it, and a "back to bottom" button appears once you are away. Scrolling inside a thinking window or a tool body no longer stops the follow by mistake.
- **Search is handled too.** Folded content is still findable with Ctrl+F; while searching the plugin releases the scroll and does not pin to the bottom, and returning to the window tail or pressing back-to-bottom resumes the follow.
- **Window sparks / forging.** Sparks along the bottom edge of the thinking window get brighter and denser with scroll speed; while the answer streams, each new chunk throws a spray of sparks from the writing head. Colour, density, speed and lifetime are configurable, and turning them off means they never run.

![A folded conversation: process rows collapsed into a summary, interleaved prose kept](https://github.com/rezon-aki/dsh-streamfold/blob/main/screenshots/01-fold.png?raw=true)

![A running thinking window with sparks along its bottom edge](https://github.com/rezon-aki/dsh-streamfold/blob/main/screenshots/02-sparks.png?raw=true)

## Install

**Option 1: the DSH plugin panel (recommended)** — sidebar → **Plugins** → **Add plugin**, paste the line below, then hit “Enable now”:

```
dsh-streamfold
```

> The panel installs this version (npm `latest` is this release, with provenance). Option 2 is for tracking the repository's latest code.

**Option 2: the command line** (three forms):

```bash
dsh plugin --profile web add dsh-streamfold                     # npm package (recommended)
dsh plugin --profile web add github:rezon-aki/dsh-streamfold    # track the repository
dsh plugin --profile web add https://github.com/rezon-aki/dsh-streamfold
```

Restart the profile, then **refresh the browser page** (client code is injected at page load).

Compatibility (`engines.dsh` in `package.json` is the single source of truth; the plugin panel and the market read it to judge compatibility):

| Plugin version | Supported DSH |
| --- | --- |
| 0.7.x (this release) | `>=0.2.1-rc.1 <0.3.0`; verified on **0.2.1-rc.2**, 0.2.0-rc.2 listed as compatible |
| 0.5.0 | the 0.1.7 series |
| 0.4.x | 0.1.5 and earlier |

The official transcript modes are owned by the `configForms` service; Node >= 20.

Uninstall: remove it in the plugin panel, or

```bash
dsh plugin --profile web remove dsh-streamfold
```

Restart the profile and the official behaviour is back.

## Usage

Settings → General → **Work details**: this row is provided by the plugin (the official row is hidden while ours is available; visibility only, reversible — on 0.2.1 the official "when to collapse work details" row is hidden too in Fold mode and restored in the official modes), with the official four modes plus **Fold**:

| Option | Behaviour |
| --- | --- |
| Compact / Standard / Detailed / Verbose | The official modes, with the official labels and behaviour |
| Fold | This plugin: one window for the running turn, everything else folds into one summary |

Choosing **Fold** parks the official mode on **Verbose**, so the official side neither folds nor groups anything and folding is done by this plugin alone (no double folding). The labels come from the official dictionary, so they follow the official wording.

Dedicated settings page: Settings → **Streamfold** (every switch below lives there and applies immediately).

While running, only the newest thinking window opens automatically; **windows you opened yourself are never auto-collapsed**, and a superseded window folds back into a one-line summary after the "superseded grace" (2 s by default). Scrolling up stops the follow, and a "back to bottom" button appears once you are away (the same button serves the thinking windows and the main view).

## Safety

- **Client-side presentation only**: it reads the conversation DOM, makes no network requests, touches no credentials and never modifies DSH source.
- **The host half writes nothing**: no file I/O, no routes, no exported Config; settings live in browser localStorage only (key `dsh-streamfold`, scoped to the page origin).
- **Official mode changes are reversible**: choosing Fold writes the official `ui-chat` `transcriptView` to Verbose (avoiding double folding) and hides the official settings rows (on 0.2.1 that includes the "when to collapse" row); switching back to an official mode writes the chosen mode back and restores that row, and uninstalling leaves the official value on Verbose until it is changed in the official settings.
- **Clean uninstall**: the settings row, window markers, back-to-bottom button and injected styles are all removed, with no leftover inline `max-height` or hidden attributes.

## Settings (22 items)

| Setting | Key | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| Work details | `mode` | Fold | Fold / official four modes | Choosing Fold parks the official mode on Verbose, avoiding double folding |
| Fold history turns | `foldHistory` | on | toggle | Off: do not fold past turns on page load (only while a turn runs) |
| Keep interleaved prose | `keepInterleavedText` | on | toggle | Keep prose rows while folding and separate them from the final answer with a rule (no capped window) |
| Keep LLM questions unfolded | `keepUserQuestions` | on | toggle | The `ask_user_question` card and its reply node never fold, and "Settle on the prompt" lands on the last question card instead; off folds them with everything else |
| Follow speed cap | `followMaxSpeed` | 240 | 60–2000 px/s | Cap on our own catch-up speed; lower is softer and lags more on fast output. Content growth is not capped |
| Follow acceleration cap | `followMaxAccel` | 10000 | 2000–120000 px/s² | Cap on speed change; lower is softer at start/stop, higher is more responsive |
| Window height | `windowHeight` | 360 | 80–1200 px | Max height of a thinking / interleaved-prose window |
| Auto-expand thinking while running | `autoExpandReasoning` | on | toggle | Only the newest block of the running turn; superseded windows fold after the grace period |
| Superseded grace | `supersedeDelay` | 2 | 0–60 s | How long an older window waits before folding into a summary line (decimals allowed) |
| Auto-expand tools while running | `autoExpandTools` | off | toggle | Expand the newest tool card using the official card's own disclosure/scroll |
| Return to tail on new message | `returnToTail` | on | toggle | While stopped mid-transcript, sending a new message glides back to the bottom; off keeps the view where it is until you scroll to the bottom or press back-to-bottom |
| Smoothing factor | `smoothGrow` | 0.15 | 0.05–0.9 | Share of the remaining gap consumed per frame |
| Show "back to bottom" | `showJumpButton` | on | toggle | Shown when away from the bottom (hidden for follow lag, to avoid flicker) |
| Settle on the prompt | `settleToPrompt` | on | toggle | When a turn finishes, glide back to your message that started it; with unfolded questions on and a question card in the turn, glide to that last card (and expand it) instead; if you scrolled away yourself, nothing moves |
| Pin the prompt | `pinPrompt` | on | toggle | Keep the prompt of the turn you are reading pinned to the top: one line with ellipsis, steps aside while the real row is in view, click to glide back |
| Animated transitions | `animations` | on | toggle | Off makes folding / expanding / jumping instant |
| Window sparks | `sparks` | on | toggle | Sparks along the bottom edge of the running thinking window (off = no canvas, no frames) |
| Spark colour | `sparkColor` | `#4fa8ff` | colour | Spark colour; the core is brightened towards white heat |
| Forging sparks | `forgeSparks` | on | toggle | Sparks thrown from the writing head while the answer streams; nothing new written, no hammer |
| Forging spark speed | `forgeSpeed` | 1 | 0.2–4 × | Drift speed multiplier |
| Forging spark life | `forgeLife` | 1.3 | 0.2–5 s | How long one spark lives (±30% random) |
| Spark density | `sparkDensity` | 1 | 0.2–3 × | Spark count multiplier, shared by both spark kinds |

Settings live in browser localStorage, scoped to the DSH page origin.

## Diagnostics

Browser console (`__dshStreamfold` is the only public debug surface):

```js
__dshStreamfold.state()          // current settings + official "Work details" snapshot
__dshStreamfold.set({ smoothGrow: 0.1, supersedeDelay: 3 })
__dshStreamfold.scan()           // rescan the current DOM immediately (settings unchanged)
__dshStreamfold.dispose()        // tear down all injections (idempotent; refresh restores native)
```

When reporting an issue, attach your DSH version and the `__dshStreamfold.state()` output. Frame tracing and cost aggregation live in the maintainer's local dev probe plugin, not in the published package.

## Development and verification

- Hand-written, no build: `lib/client.js` (browser half, wrapped in `window.__ModuleLoader__`) and `lib/index.js` (host half, 12 lines).
- After editing `lib/*.js`, reload the plugin and **refresh the page**.
- Row anchors use official semantic attributes only: `[data-chat-flow]`, `[data-chat-flow-kind]`, `[data-chat-turn]`, `[data-disclosure-row][aria-expanded]`, `[data-variant=think]`, `[data-tool]`, `[data-sample=bash]`, `[class*=_thinkBody]`, `[class*=_bodyWrap]`, `[data-context-injection-body]` — never CSS module hashes.
- Tests: `npm test` (`test/spark.mjs` 28 assertions + `test/contract.mjs` + `test/client-apply.mjs`), currently EXIT=0.

## License

MIT
