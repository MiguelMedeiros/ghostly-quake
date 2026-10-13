# Changes

## 1.0.0 (not published yet)

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
