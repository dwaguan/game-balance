(() => {
  "use strict";

  // ===========================================================================
  // balance — a 2D physics bar-balancing game
  //
  // Model: a rigid bar pivots about its fixed center. Two balls rest on the bar
  // and slide along its surface. Gravity pulls the balls down; the balls' weight
  // exerts torque on the bar; the bar tilts; the tilt makes the balls slide.
  //
  // Coordinates:
  //   - Bar-local coordinate s in [-1, 1] along the bar (-1 = left tip).
  //   - Bar angle theta (radians), positive = counterclockwise (left tip down).
  //   - World: x right, y down (canvas convention). Gravity acts in +y.
  //
  // Stability: semi-implicit Euler with sub-steps, clamped angular velocity, and
  // balls constrained to the bar surface (they never leave it except by falling
  // off the ends). The bar's moment of inertia decays over time -> harder.
  // ===========================================================================

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("stage");
  const newGameBtn = document.getElementById("new-game");
  const p1StatusEl = document.getElementById("p1-status");
  const p2StatusEl = document.getElementById("p2-status");

  // ---- world constants (SI-ish, tuned for fun) ----
  const G = 9.81;                 // gravity m/s^2
  const BAR_HALF = 3.0;           // bar half-length (m) -> s in [-3, 3]
  const PIVOT = { x: 360, y: 260 }; // pivot in canvas px (set on resize)
  const PX_PER_M = 70;            // world->canvas scale
  const BALL_R = 0.42;            // ball radius (m)

  // ---- tunable balance values ----
  const CFG = {
    barMassStart: 60.0,    // kg-equivalent; high inertia early -> slow tilt
    barMassEnd: 4.0,       // final (light) inertia -> twitchy
    barMassHalfTime: 35.0, // seconds to reach midpoint of the decay
    barLen: 2 * BAR_HALF,
    ballMass: 1.0,
    accel: 4.5,            // player-controlled tangential accel (m/s^2)
    maxSpeed: 6.0,         // cap on ball speed along bar (m/s)
    maxAngVel: 2.2,        // rad/s cap (keeps sim sane as inertia drops)
    friction: 0.35,        // tangential drag on balls (1/s)
    invisDuration: 1.2,    // s
    invisCooldown: 6.0,    // s
    matchTime: 90.0,       // s — by here the bar is at minimum mass
    subSteps: 6,           // physics sub-steps per frame
  };

  // Bar moment of inertia about center: I = (1/12) m L^2  (uniform rod).
  // We use barMass as the inertia driver; gravity torque = sum(m_i * g * x_i * cos(theta)).
  function barInertia(mass) {
    return (1 / 12) * mass * CFG.barLen * CFG.barLen;
  }

  // ---- game state ----
  let mode = "menu";      // "menu" | "playing" | "paused" | "over"
  let vsAI = false;
  let elapsed = 0;        // seconds since match start
  let bar;                 // { theta, omega, mass }
  let balls;               // [ball, ball]
  let lastTs = 0;
  let rafId = 0;
  let winner = null;       // 0 | 1 | null

  function makeBall(idx) {
    return {
      idx,                 // 0 = P1 (left), 1 = P2 (right)
      s: idx === 0 ? -1.4 : 1.4,  // position along bar (m, signed)
      v: 0,                // velocity along bar (m/s)
      mass: CFG.ballMass,
      invis: { active: false, left: 0, cd: 0 }, // cd = cooldown remaining
      out: false,
      aiThink: 0,
    };
  }

  function reset() {
    elapsed = 0;
    bar = { theta: 0, omega: 0, mass: CFG.barMassStart };
    balls = [makeBall(0), makeBall(1)];
    winner = null;
  }

  // ---- bar mass decay: exponential approach to barMassEnd ----
  function barMassAt(t) {
    const k = Math.log(2) / CFG.barMassHalfTime;
    return CFG.barMassEnd + (CFG.barMassStart - CFG.barMassEnd) * Math.exp(-k * t);
  }

  // ===========================================================================
  // Physics step (dt seconds). Sub-stepped internally by caller for stability.
  // ===========================================================================
  function physicsStep(dt) {
    // 1. Update bar mass from elapsed time.
    bar.mass = barMassAt(elapsed);

    // 2. Torque on bar from each ball's weight.
    //    Torque = r x F. Ball at signed position s along bar; weight = m g downward.
    //    Lever arm horizontal component = s * cos(theta). Torque magnitude (about pivot):
    //      tau = - m * g * s * cos(theta)   (sign: +s ball pushes its side down -> theta toward that side)
    //    theta+ = counterclockwise = left tip down. A ball on the LEFT (s<0) pushes left tip
    //    down => positive torque. So tau = -m g s cos(theta) gives: s<0 => tau>0. Correct.
    let torque = 0;
    for (const b of balls) {
      if (b.out) continue;
      torque += -b.mass * G * b.s * Math.cos(bar.theta);
    }
    const I = barInertia(bar.mass);
    const alpha = torque / I;

    // semi-implicit Euler
    bar.omega += alpha * dt;
    bar.omega = clamp(bar.omega, -CFG.maxAngVel, CFG.maxAngVel);
    bar.omega *= 0.998; // tiny global damping to bleed runaway energy
    bar.theta += bar.omega * dt;

    // 3. Balls slide along the bar under gravity's tangential component.
    //    Tangential accel along bar (positive s direction = toward right tip):
    //      a_t = g * sin(theta)   (when theta>0, left tip down, balls slide toward +s/right)
    //    Wait sign: theta>0 means left tip DOWN, so bar slopes down to the left => balls
    //    slide toward LEFT (negative s). So a_t = -g * sin(theta).
    for (const b of balls) {
      if (b.out) continue;

      const gravTang = -G * Math.sin(bar.theta);
      // player input adds tangential accel (handled in applyInput, merged here)
      b.v += (gravTang + b.inputAccel) * dt;
      // friction (viscous)
      b.v *= 1 - Math.min(1, CFG.friction * dt);
      b.v = clamp(b.v, -CFG.maxSpeed, CFG.maxSpeed);
      b.s += b.v * dt;

      // invisibility timers
      if (b.invis.active) {
        b.invis.left -= dt;
        if (b.invis.left <= 0) { b.invis.active = false; b.invis.left = 0; }
      }
      if (b.invis.cd > 0) b.invis.cd = Math.max(0, b.invis.cd - dt);

      // off the end -> out
      if (Math.abs(b.s) > BAR_HALF + BALL_R * 0.5) {
        b.out = true;
        b.v = 0;
      }
    }

    // 4. Ball-ball collision (1D along the bar).
    const [a, c] = balls;
    if (!a.out && !c.out) {
      const gap = Math.abs(c.s - a.s);
      const minSep = 2 * BALL_R;
      if (gap < minSep) {
        // if either is invisible, pass through (no collision)
        if (a.invis.active || c.invis.active) {
          // no-op: they overlap briefly; whichever is invisible phases through
        } else {
          // elastic 1D collision, equal mass -> swap velocities
          const sign = c.s >= a.s ? 1 : -1;
          // resolve overlap
          const overlap = minSep - gap;
          a.s -= sign * overlap / 2;
          c.s += sign * overlap / 2;
          // swap velocities along the collision normal
          const va = a.v, vc = c.v;
          a.v = vc;
          c.v = va;
        }
      }
    }

    elapsed += dt;
  }

  // ===========================================================================
  // Input application — turns held keys into per-ball inputAccel + skill use.
  // ===========================================================================
  const keys = Object.create(null);
  const skillQueued = { 0: false, 1: false };

  function applyInput(dt) {
    // P1: A/D move, W invis
    const p1 = balls[0];
    if (!p1.out) {
      let a = 0;
      if (keys["a"]) a -= CFG.accel;
      if (keys["d"]) a += CFG.accel;
      // tilt control: if enabled and no button held, steer by phone tilt
      if (tilt.enabled && a === 0) a = tilt.value * CFG.accel;
      p1.inputAccel = a;
      if (skillQueued[0]) { tryInvis(p1); skillQueued[0] = false; }
    }
    // P2: arrows move, Up invis
    const p2 = balls[1];
    if (!p2.out) {
      if (vsAI) {
        p2.inputAccel = aiDecide(p2, dt);
        if (aiWantsInvis(p2)) tryInvis(p2);
      } else {
        let a = 0;
        if (keys["arrowleft"]) a -= CFG.accel;
        if (keys["arrowright"]) a += CFG.accel;
        p2.inputAccel = a;
        if (skillQueued[1]) { tryInvis(p2); skillQueued[1] = false; }
      }
    }
  }

  function tryInvis(b) {
    if (b.invis.active || b.invis.cd > 0) return;
    b.invis.active = true;
    b.invis.left = CFG.invisDuration;
    b.invis.cd = CFG.invisCooldown;
  }

  // ---- simple AI heuristic for P2 ----
  function aiDecide(b, dt) {
    // Think every ~0.15s to avoid jitter.
    b.aiThink -= dt;
    if (b.aiThink <= 0) {
      b.aiThink = 0.15;
      const opp = balls[0];
      // Goal: stay near center of mass of the bar (balance), and nudge toward
      // the opponent to push them off when they're near an edge.
      let target;
      if (Math.abs(opp.s) > BAR_HALF * 0.6 && !opp.out) {
        // opponent near edge -> charge them to shove off
        target = opp.s + Math.sign(opp.s) * (2 * BALL_R + 0.1);
      } else {
        // otherwise sit slightly opposite the opponent to counter-balance
        target = -opp.s * 0.5;
      }
      target = clamp(target, -BAR_HALF * 0.85, BAR_HALF * 0.85);
      b._aiTarget = target;
    }
    const target = b._aiTarget ?? 0;
    const err = target - b.s;
    // proportional control toward target
    if (Math.abs(err) < 0.1) return -CFG.accel * 0.2 * Math.sign(b.v); // brake
    return CFG.accel * Math.sign(err);
  }

  function aiWantsInvis(b) {
    // pop invisibility if heading off an edge, or about to be shoved
    if (b.invis.cd > 0 || b.invis.active) return false;
    const opp = balls[0];
    const aboutToCollide =
      !opp.out &&
      Math.abs(opp.s - b.s) < 2 * BALL_R + 0.3 &&
      Math.abs(opp.v) > 2.5;
    const nearEdge = Math.abs(b.s) > BAR_HALF * 0.7 && Math.sign(b.v) === Math.sign(b.s);
    return aboutToCollide || nearEdge;
  }

  // ===========================================================================
  // Win/lose check
  // ===========================================================================
  function checkOutcome() {
    const a = balls[0], c = balls[1];
    if (a.out && c.out) { winner = -1; endMatch(); return; } // draw (rare)
    if (a.out) { winner = 1; endMatch(); return; }
    if (c.out) { winner = 0; endMatch(); return; }
    if (elapsed > CFG.matchTime + 60) { // hard cap ~150s
      // whoever is farther from center loses
      winner = Math.abs(a.s) < Math.abs(c.s) ? 0 : 1;
      endMatch();
    }
  }

  function endMatch() {
    mode = "over";
    showOverlay(
      winner === -1 ? "Draw!" : (winner === 0 ? "P1 wins! 🏆" : (vsAI ? "AI wins" : "P2 wins! 🏆")),
      winner === 0 ? "win" : "lose",
      true
    );
    updateStatus();
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================
  function worldToCanvas(s, theta) {
    // bar direction unit vector
    const cx = Math.cos(theta), sy = Math.sin(theta);
    // ball center sits on the bar surface; offset upward (perpendicular) by BALL_R
    const perpX = sy, perpY = -cx; // perpendicular pointing "up" off the bar
    const wx = s * cx + BALL_R * perpX;
    const wy = s * sy + BALL_R * perpY;
    return { x: PIVOT.x + wx * PX_PER_M, y: PIVOT.y + wy * PX_PER_M, cx, sy };
  }

  function render() {
    // clear the full device canvas (including letterbox), then draw in logical
    // 720x480 space — the transform set in resize() maps logical->device.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // play-field background (logical 720x480)
    ctx.fillStyle = "#eee4da";
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    // ground line / pivot pedestal
    ctx.strokeStyle = "#cdc1b4";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, PIVOT.y + 26);
    ctx.lineTo(LOGICAL_W, PIVOT.y + 26);
    ctx.stroke();
    ctx.fillStyle = "#bbada0";
    ctx.beginPath();
    ctx.moveTo(PIVOT.x, PIVOT.y + 4);
    ctx.lineTo(PIVOT.x - 18, PIVOT.y + 26);
    ctx.lineTo(PIVOT.x + 18, PIVOT.y + 26);
    ctx.closePath();
    ctx.fill();

    // bar
    ctx.save();
    ctx.translate(PIVOT.x, PIVOT.y);
    ctx.rotate(bar.theta);
    const barW = CFG.barLen * PX_PER_M;
    const barH = 16;
    // mass -> color (heavier = darker brown, lighter = pale)
    const t = clamp((bar.mass - CFG.barMassEnd) / (CFG.barMassStart - CFG.barMassEnd), 0, 1);
    const r = Math.round(143 + (187 - 143) * (1 - t));
    const g = Math.round(122 + (173 - 122) * (1 - t));
    const bl = Math.round(102 + (160 - 102) * (1 - t));
    ctx.fillStyle = `rgb(${r},${g},${bl})`;
    ctx.fillRect(-barW / 2, -barH / 2, barW, barH);
    // end caps (danger zones)
    ctx.fillStyle = "rgba(246,124,95,0.65)";
    ctx.fillRect(-barW / 2, -barH / 2, 10, barH);
    ctx.fillRect(barW / 2 - 10, -barH / 2, 10, barH);
    ctx.restore();

    // balls
    const colors = ["#8f7a66", "#6c8a96"];
    for (const b of balls) {
      if (b.out) continue;
      const p = worldToCanvas(b.s, bar.theta);
      const rad = BALL_R * PX_PER_M;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = b.invis.active ? "rgba(108,138,150,0.30)" : colors[b.idx];
      ctx.fill();
      // outline + label
      ctx.lineWidth = 2;
      ctx.strokeStyle = b.invis.active ? "rgba(108,138,150,0.6)" : "rgba(255,255,255,0.5)";
      ctx.stroke();
      ctx.fillStyle = "#f9f6f2";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("P" + (b.idx + 1), p.x, p.y);

      // invis cooldown ring
      if (!b.invis.active && b.invis.cd > 0) {
        const frac = 1 - b.invis.cd / CFG.invisCooldown;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = "rgba(143,122,102,0.5)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // elapsed / mass HUD on canvas
    ctx.fillStyle = "rgba(119,110,101,0.7)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`time ${elapsed.toFixed(1)}s   bar mass ${bar.mass.toFixed(1)}kg`, 10, 8);

    // live tilt indicator (only when tilt enabled)
    if (tilt.enabled) {
      const cx = LOGICAL_W / 2, cy = 22, bw = 120, bh = 8;
      // track
      ctx.fillStyle = "rgba(187,173,160,0.6)";
      ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
      // fill from center
      const fw = (bw / 2) * Math.abs(tilt.value);
      ctx.fillStyle = tilt.value === 0 ? "rgba(119,110,101,0.5)" : "#8f7a66";
      if (tilt.value >= 0) ctx.fillRect(cx, cy - bh / 2, fw, bh);
      else ctx.fillRect(cx - fw, cy - bh / 2, fw, bh);
      // center tick
      ctx.fillStyle = "rgba(119,110,101,0.8)";
      ctx.fillRect(cx - 1, cy - bh / 2 - 2, 2, bh + 4);
      // status / hint text
      ctx.fillStyle = "rgba(119,110,101,0.85)";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      const msg = tilt.status || (tilt.value === 0 ? "tilt: center" : `tilt ${tilt.value > 0 ? "right" : "left"} ${Math.round(Math.abs(tilt.value) * 100)}%`);
      ctx.fillText(msg, cx, cy + 10);
    }
  }

  function updateStatus() {
    const fmt = (b, label) => b.out ? "OUT" :
      b.invis.active ? "invisible" :
      b.invis.cd > 0 ? `cd ${b.invis.cd.toFixed(1)}s` : label;
    p1StatusEl.textContent = balls ? fmt(balls[0], "ready") : "ready";
    p2StatusEl.textContent = balls ? fmt(balls[1], vsAI ? "AI" : "ready") : "ready";
    const p1Box = document.querySelector(".score-box.p1");
    const p2Box = document.querySelector(".score-box.p2");
    if (p1Box) p1Box.classList.toggle("out", !!(balls && balls[0].out));
    if (p2Box) p2Box.classList.toggle("out", !!(balls && balls[1].out));
    syncInvisBtn();
  }

  // ===========================================================================
  // Main loop
  // ===========================================================================
  function frame(ts) {
    if (mode !== "playing") { rafId = requestAnimationFrame(frame); return; }
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    dt = Math.min(dt, 1 / 30); // clamp big gaps (tab switch)

    applyInput(dt);
    const sub = CFG.subSteps;
    const h = dt / sub;
    for (let i = 0; i < sub; i++) physicsStep(h);
    checkOutcome();
    render();
    updateStatus();
    rafId = requestAnimationFrame(frame);
  }

  // ===========================================================================
  // Overlay / menu
  // ===========================================================================
  function showOverlay(title, cls, withRestart) {
    clearOverlay();
    const o = document.createElement("div");
    o.className = "overlay " + (cls || "");
    const h = document.createElement("h2");
    h.textContent = title;
    o.appendChild(h);

    if (mode === "menu") {
      const p = document.createElement("p");
      p.textContent = "Two balls share a tilting bar. The bar gets lighter over time, so balance gets harder. Push your opponent off — or just survive longer.";
      o.appendChild(p);
      if (isTouch) {
        const note = document.createElement("p");
        note.textContent = "Touch controls support vs AI only. 2-player needs a keyboard.";
        note.style.fontStyle = "italic";
        o.appendChild(note);
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      const b2p = mkBtn("2 Players", "btn", () => startGame(false));
      const bai = mkBtn("vs AI", isTouch ? "btn" : "btn secondary", () => startGame(true));
      actions.appendChild(b2p);
      actions.appendChild(bai);
      o.appendChild(actions);
    } else if (mode === "paused") {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(mkBtn("Resume", "btn", () => togglePause()));
      actions.appendChild(mkBtn("Restart", "btn secondary", () => startGame(vsAI)));
      o.appendChild(actions);
    } else if (mode === "over") {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(mkBtn("Play again", "btn", () => startGame(vsAI)));
      actions.appendChild(mkBtn("Menu", "btn secondary", () => showMenu()));
      o.appendChild(actions);
    }
    stage.appendChild(o);
  }

  function mkBtn(text, cls, onClick) {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    return b;
  }

  function clearOverlay() {
    stage.querySelectorAll(".overlay").forEach((n) => n.remove());
  }

  function showMenu() {
    mode = "menu";
    reset();
    render();
    updateStatus();
    showOverlay("balance", "", false);
  }

  function startGame(ai) {
    vsAI = ai;
    reset();
    mode = "playing";
    lastTs = 0;
    clearOverlay();
  }

  function togglePause() {
    if (mode === "playing") {
      mode = "paused";
      showOverlay("Paused", "", false);
    } else if (mode === "paused") {
      mode = "playing";
      lastTs = 0;
      clearOverlay();
    }
  }

  // ===========================================================================
  // Input binding
  // ===========================================================================
  const MOVE_KEYS = new Set(["a", "d", "arrowleft", "arrowright", "w", "arrowup", "arrowdown"]);

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "r") { e.preventDefault(); startGame(vsAI); return; }
    if (k === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (mode === "playing" || mode === "paused") togglePause();
      return;
    }
    if (k === "w") { skillQueued[0] = true; e.preventDefault(); return; }
    if (k === "arrowup") { skillQueued[1] = true; e.preventDefault(); return; }
    if (MOVE_KEYS.has(k)) { keys[k] = true; e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.has(k)) { keys[k] = false; }
  });

  newGameBtn.addEventListener("click", () => {
    if (mode === "menu") startGame(vsAI);
    else startGame(vsAI);
  });

  // ---- touch controls (P1 only; vs-AI on phones) ----
  const isTouch = matchMedia("(hover: none), (pointer: coarse)").matches ||
    ("ontouchstart" in window);
  if (isTouch) {
    document.body.classList.add("is-touch");
    document.getElementById("hint-keyboard").hidden = true;
    document.getElementById("hint-touch").hidden = false;
  }

  const tcLeft = document.getElementById("tc-left");
  const tcRight = document.getElementById("tc-right");
  const tcInvis = document.getElementById("tc-invis");

  // press-and-hold via pointer events: set the same key flags the keyboard uses
  function bindHold(el, onDown, onUp) {
    const down = (e) => { e.preventDefault(); el.classList.add("pressed"); onDown(); };
    const up = (e) => { e.preventDefault(); el.classList.remove("pressed"); onUp(); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("pointercancel", up);
  }
  bindHold(tcLeft,  () => { keys["a"] = true; },  () => { keys["a"] = false; });
  bindHold(tcRight, () => { keys["d"] = true; },  () => { keys["d"] = false; });
  tcInvis.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    skillQueued[0] = true;
  });

  // reflect invis cooldown on the button
  function syncInvisBtn() {
    if (!isTouch || !balls) return;
    const b = balls[0];
    const cooling = !b.invis.active && b.invis.cd > 0;
    tcInvis.classList.toggle("cooling", cooling);
    tcInvis.textContent = b.invis.active ? "ON"
      : (cooling ? b.invis.cd.toFixed(1) + "s" : "INVIS");
  }

  // ---- tilt (gravity sensor) control, optional on touch devices ----
  // We use deviceorientation gamma (left/right tilt, -90..90), calibrated so the
  // phone's held angle on enable becomes the neutral center. Mapped to -1..1
  // with a dead zone. iOS 13+ requires a permission prompt from a user gesture.
  const tilt = { enabled: false, value: 0, status: "", baseline: 0, lastEvtAt: 0 };
  const TILT_DEAD = 10;    // degrees of neutral dead zone
  const TILT_MAX = 32;     // degrees from neutral for full accel
  function onDeviceOrient(e) {
    if (e.gamma == null) return;
    tilt.lastEvtAt = performance.now();
    tilt.status = "";                      // sensor is firing
    let g = e.gamma - tilt.baseline;       // relative to held-neutral
    // wrap-safe clamp into -90..90
    if (g > 180) g -= 360; else if (g < -180) g += 360;
    if (Math.abs(g) < TILT_DEAD) { tilt.value = 0; return; }
    g = g - Math.sign(g) * TILT_DEAD;      // apply dead zone
    tilt.value = clamp(g / (TILT_MAX - TILT_DEAD), -1, 1);
  }
  async function enableTilt() {
    if (tilt.enabled) { disableTilt(); return; }
    tilt.status = "requesting…";
    // iOS permission gate (must be called from a user gesture)
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      try {
        const res = await D.requestPermission();
        if (res !== "granted") { tilt.status = "permission denied"; return; }
      } catch { tilt.status = "permission error"; return; }
    }
    // Attach and take the first reading as the neutral baseline, then drop the
    // calibration listener so the baseline doesn't drift as the user tilts.
    const calibrate = (e) => {
      if (e.gamma == null) return;
      tilt.baseline = e.gamma;
      tilt.status = "";
      window.removeEventListener("deviceorientation", calibrate, true);
    };
    window.addEventListener("deviceorientation", calibrate, true);
    window.addEventListener("deviceorientation", onDeviceOrient, true);
    tilt.enabled = true;
    document.body.classList.add("tilt-on");
    if (tcTilt) tcTilt.classList.add("active");
    // If no event arrives, the device has no usable sensor.
    setTimeout(() => {
      if (tilt.enabled && tilt.lastEvtAt === 0) {
        tilt.status = "no sensor on this device";
      }
    }, 1500);
  }
  function disableTilt() {
    window.removeEventListener("deviceorientation", onDeviceOrient, true);
    tilt.enabled = false;
    tilt.value = 0;
    tilt.status = "";
    tilt.baseline = 0;
    tilt.lastEvtAt = 0;
    document.body.classList.remove("tilt-on");
    if (tcTilt) tcTilt.classList.remove("active");
  }
  const tcTilt = document.getElementById("tc-tilt");
  if (tcTilt) tcTilt.addEventListener("click", enableTilt);


  // ---- canvas sizing ----
  // The game is drawn in a fixed 720x480 logical space; resize() scales that
  // space to fit the canvas's actual CSS box (contain fit, letterboxed), so the
  // bar renders correctly at any aspect ratio. We observe the canvas element so
  // resize fires reliably once layout settles (and on orientation changes).
  const LOGICAL_W = 720, LOGICAL_H = 480;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;            // not laid out yet; observer will retry
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    // scale so the 720x480 space fits inside (contain), centered
    const scale = Math.min(canvas.width / LOGICAL_W, canvas.height / LOGICAL_H);
    const ox = (canvas.width - LOGICAL_W * scale) / 2;
    const oy = (canvas.height - LOGICAL_H * scale) / 2;
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    if (mode !== "playing") render();
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 150));
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  }

  // ---- utils ----
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---- boot ----
  reset();
  resize();
  showMenu();
  rafId = requestAnimationFrame(frame);
})();
