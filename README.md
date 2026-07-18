# balance

A 2D physics bar-balancing game for two players (or one vs. a simple AI). A bar
pivots about its center; two balls ride on it. Gravity tips the bar, the balls
slide, and the bar gets lighter over time — so staying on gets harder. Push your
opponent off the end, or just outlast them. No build step, no dependencies —
just open `index.html`.

**▶ Play online:** <https://game-balance.wanggaoyuan94.workers.dev/>

## How to play

1. Pick **2 Players** (shared keyboard) or **vs AI** from the start menu.
2. Move your ball along the bar to balance it — or charge the opponent to shove
   them off an end.
3. The bar's mass decays over time, so the same push tilts it more as the match
   goes on. Early game is forgiving; late game is twitchy.
4. **Invisibility** (W / ↑) lets your ball pass through the opponent for ~1.2s —
   dodge a shove, or phase through them. 6s cooldown.
5. Whoever falls off the bar loses. If both fall, it's a draw.

### Controls

|         | Move        | Invisibility |          |
|---------|-------------|--------------|----------|
| **P1**  | `A` / `D`   | `W`          | left side |
| **P2**  | `←` / `→`   | `↑`          | right side |

`R` restart · `Space` pause

> Note: you control **acceleration**, not speed directly — velocity obeys your
> input plus gravity along the tilted bar, capped by a max speed.

## Physics notes

- The bar is a uniform rod pivoting about its center. Its angular acceleration
  comes from the **torque** of each ball's weight:
  `τ = −m·g·s·cos(θ)` summed over balls, divided by the rod's moment of inertia
  `I = (1/12)·M·L²`.
- Bar mass `M` decays exponentially from `60 → 4` (half-life ~35s), so `I`
  shrinks and the same torque produces larger angular acceleration — the
  intended difficulty ramp.
- Balls slide along the bar under gravity's tangential component
  `aₜ = −g·sin(θ)` plus player input, with viscous friction and a speed cap.
- Ball-ball collisions are **elastic, equal-mass** (velocities swap along the
  bar), unless one ball is invisible, in which case they phase through.
- Integration is **semi-implicit Euler with sub-stepping** (6 sub-steps/frame)
  and a clamped angular velocity, which keeps the sim stable as inertia drops.

## Features

- Real torque/inertia bar physics with a time-decaying difficulty curve
- Two-player local **or** single-player vs a heuristic AI
- Invisibility active skill with cooldown ring
- Optional **skill-box mode**: a longer bar with random power-up boxes — first
  to touch one gets a timed buff (heavier mass, more accel, shorter invis CD,
  or sticky/inelastic collisions)
- Pause / restart, win/lose overlays, English + Chinese (defaults to Chinese)
- Self-contained: one HTML file plus `style.css` and `game.js`

## Run locally

Open `index.html` directly in any modern browser, or serve the folder:

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Files

- `index.html` — markup, HUD, controls hint
- `style.css` — layout and overlays (matches the 2048 aesthetic)
- `game.js` — physics simulation, rendering, input, and AI
- `design.md` — original design spec + followups
- `v1.0/` … `v1.4/` — read-only snapshots of each released version (see below)

## Versions

Each version is a self-contained snapshot you can play by opening that folder's
`index.html`. The repo root always holds the **latest** version.

- **v1.0** — initial release: core physics, 2-player + AI, invisibility
- **v1.1** — phone support: touch controls, optimized layout, tilt steering
- **v1.2** — language toggle (中文 / EN, defaults to Chinese)
- **v1.3** — physics fix: correct torque/signs, balls slide downhill
- **v1.4** — skill-box mode: optional power-up pickups + longer bar *(latest)*

## Future dev (not yet implemented)

From the design doc, the **collision-powered-up** rule remains unimplemented:
the faster ball in a collision gets a random buff from the skill set. The
on-bar pickups are now implemented as the optional skill-box mode above.

## License

Released into the public domain under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
