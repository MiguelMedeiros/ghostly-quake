# Arena's frames

Arena talks to the same app on the contact's side in `apps/1` data frames (WISP 1200, "In a chat"): JSON values of at
most 32 KiB, at most 48 a second per app, live only. Every frame carries `t` (its kind) and `v` (the protocol, 1). A
receiver drops anything that is not exactly one of these shapes (`src/protocol.ts`, `readFrame`) and ignores keys it
does not know, so a later version may add some.

| Frame | Keys | Meaning |
|---|---|---|
| `hello` | `state`: `lobby`, `hosting` or `playing`; `match` when not in the lobby | This side's state. Sent when the peer opens the app and whenever the state changes |
| `host` | `match`, `terms`: `{map, fraglimit, timelimit}` | This side hosts that match; its server is already up. Sent again when the peer opens the app, and when the joiner leaves |
| `join` | `match` | This side's engine connects to that match now |
| `leave` | `match` | This side left that match |
| `net` | `match`, `p`: up to 64 strings, `part`: `[index, count]` when a packet is split | The engine's packets for that match, in order, each in base64. A packet larger than one frame travels in parts, one a frame, `p` holding one string |
| `ping` / `pong` | `n`, `at` | The app's own round trip over the chat: a `pong` echoes the `ping`'s `n` and `at` |

`match` is 16 base64url characters, random, made by the host. `map` is one of `lqdm1`, `lqdm2`, `lqdm4`, `lqdm6`,
`lqdm7`, `lqdm8`, `lqdm10`, `lqdm11`, `lqdm12`, `lqdm13`; `fraglimit` one of 5, 10, 20, 30; `timelimit` (minutes) one of
5, 10, 15, 20.

## A match

1. One side sends `host` and starts its server (FTEQW, deathmatch 3, two slots) listening on the chat pipe.
2. The other side shows the invitation. Join sends `join`, and its engine runs `connect ws://ghostly.invalid/host`:
   the QuakeWorld handshake (challenge, connect) and then the game travel in `net` frames.
3. If both sides send `host` before either sees the other's, the match with the lower `match` is kept: the side whose
   match lost stops its server and joins the other by itself.
4. `leave`, or the joiner's `hello` with `lobby`, sends the host back to waiting (`hosting`, `host` sent again); the
   host's `leave`, or its app closing, ends the joiner's match.

## The packets

They are the engine's own: QuakeWorld's netchan with FTE's extensions, unchanged. The chat is ordered and reliable, so
nothing is lost on the way, but the app drops packets before they leave when its queue passes 256 (a live game cannot
use them late) and the netchan resends what it must. The sender batches the packets of one engine frame into one
frame and sends at most 34 frames a second, with bursts of 4 (`src/link.ts`), leaving room under the broker's 50
requests a second for pings, storage and the other frames.

Both sides must run the same engine and data (the server checks the map). Versions that differ only in their patch
number play together; the lobby refuses another minor or major version (`src/version.ts`).
