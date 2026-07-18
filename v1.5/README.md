# v1.5 — anti-stall + recovery

Fixes the central-stall problem (two balls buzzing in place, slow death at the
edge) so experienced players can't just camp the center.
- Longer bar in both modes (normal 3.0->4.5, skill 4.5->5.0) for positional play
- Reduced gravity (g 9.81 -> 4.0, below player accel) so a > g: you can always
  climb back from any tilt < 90° — the decaying bar mass still ends the match
- Anti-stall explosion: two slow-closing balls get kicked apart (stored-energy
  burst, 2 m/s) with a per-ball cooldown, breaking the center-buzz

This is the latest version (matches the repo root).
Open `index.html` to play this version.
