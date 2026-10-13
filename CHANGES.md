# Changes

## 1.0.1

- Mouse look as in any shooter: a click in the game asks for the pointer lock, the mouse turns the view freely, and Esc
  gives it back (and opens the engine's menu). It needs a Ghostly whose runner lets apps hold the pointer (2026-10-13);
  in an older one the lock is refused and the edge turning of 1.0.0 stays. Plays with 1.0.0: the engine's packets and
  the game data did not change.

## 1.0.0 (sequence 1, 2026-10-13)

The first version.

- Deathmatch for two in a 1:1 chat: one side hosts on one of ten LibreQuake maps (frag limit 5 to 30, time limit 5 to
  20 minutes), the other joins from the invitation. If both host at once, one match is kept and the other side joins it.
- FTEQW (commit f937b9d) compiled to WebAssembly, client and server, its packets carried over `apps/1` frames: batched
  per engine frame, at most 34 frames a second.
- Mouse look without a pointer lock (the runner's sandbox refuses it): the mouse's movement aims, the edge of the frame
  keeps turning, the arrow keys turn.
- Settings kept per chat: mouse sensitivity, inverted mouse, volume, edge turning. The player's name is the chat's
  (the `name` permission), in the engine's ASCII.
- Ghostly's 8 languages.
