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
  // Gravity is tuned below real-world 9.81 AND below player accel (4.5), so
  // a > g: a player can climb back from any tilt < 90° (no slow death at the
  // edge). Gentler gravity also makes the bar feel calmer. The decaying bar
  // mass is the match terminator.
  const G = 4.0;                  // gravity m/s^2 (tuned; < accel 4.5, < real 9.81)
  const PIVOT = { x: 360, y: 260 }; // pivot in canvas px (set on resize)
  const PX_PER_M = 70;            // world->canvas scale
  const BALL_R = 0.42;            // ball radius (m)

  // Bar half-length depends on mode. Normal is +33% over v1.4 (3.0 -> 4.0) so
  // the increase is visible; skill stays at v1.4's 4.5 (5.0 clipped the frame
  // when tilted). 4.0 stays in-bounds to ~57° tilt, 4.5 to ~50°.
  function barHalf() { return skillMode ? 4.5 : 4.0; }

  // ---- tunable balance values ----
  const CFG = {
    barMassStart: 30.0,    // kg-equivalent; lighter than v1.4 so ball weight
                           // actually tips the bar (was 60 -> barely moved).
    barMassEnd: 2.5,       // final (light) inertia -> twitchy late game
    barMassHalfTime: 25.0, // seconds to reach midpoint of the decay (was 35)
    ballMass: 1.0,
    accel: 4.5,            // player-controlled tangential accel (m/s^2). Kept at
                           // the original value; gravity (G) is lowered instead
                           // so accel > g·sinθ up to ~55° — always recoverable.
    maxSpeed: 6.0,         // cap on ball speed along bar (m/s)
    maxAngVel: 2.6,        // rad/s cap (keeps sim sane as inertia drops)
    friction: 0.35,        // tangential drag on balls (1/s)
    invisDuration: 1.2,    // s
    invisCooldown: 6.0,    // s
    matchTime: 90.0,       // s — by here the bar is at minimum mass
    subSteps: 6,           // physics sub-steps per frame
    // ---- anti-stall explosion (with charge-up) ----
    // When two balls are close, closing, and slow, they enter a CHARGE phase
    // (a growing energy spark between them) so players see the stall building.
    // If they stay stalled through the charge, they explode apart. Separating
    // or speeding up bleeds the charge. Tuned to trigger readily so stalls
    // don't linger.
    explosionProx: 0.62,   // charge starts when gap below this (m) — ~1.5x ball diameter
    explosionRel: 1.2,     // "slow" if |relative v| below this (m/s)
    explosionCharge: 0.45, // s of sustained stall to detonate
    explosionBleed: 2.5,   // charge lost per second when not stalling
    explosionKick: 2.2,    // outward kick speed (m/s)
    explosionCd: 0.7,      // per-ball cooldown (s) to prevent machine-gunning
    explosionFlash: 0.20,  // s of visual flash
    // ---- skill-box mode tunables ----
    skill: {
      spawnDelay: 2.0,     // s after collect/despawn before next box
      despawn: 12.0,       // s a box lives uncollected
      boxR: 0.34,          // box pickup radius (m)
      buffDur: 6.0,        // s most buffs last
      massAdd: 1.6,        // extra mass from mass buff
      accelAdd: 0.7,       // accel multiplier addend (1+accelAdd)
      cdMult: 0.4,         // invis CD multiplier from cd buff
      cdDur: 8.0,          // s the shorter-CD buff lasts
    },
  };
  function barLen() { return 2 * barHalf(); }

  // ===========================================================================
  // i18n — English + Chinese, defaults to Chinese. Persisted in localStorage.
  // ===========================================================================
  const LANG_KEY = "balance:lang";
  let lang = (() => {
    const saved = localStorage.getItem(LANG_KEY);
    return saved === "en" ? "en" : "zh";   // default Chinese
  })();

  const L = {
    // header / static
    title:        { zh: "平衡",        en: "balance" },
    p1Label:      { zh: "玩家1",       en: "P1" },
    p2Label:      { zh: "玩家2",       en: "P2" },
    youLabel:     { zh: "你",          en: "You" },
    ready:        { zh: "就绪",        en: "ready" },
    ai:           { zh: "电脑",        en: "AI" },
    out:          { zh: "掉落",        en: "OUT" },
    invisible:    { zh: "隐身中",      en: "invisible" },
    cd:           { zh: "冷却 {n}s",   en: "cd {n}s" },
    newGame:      { zh: "新游戏",      en: "New Game" },
    tagline:      { zh: "留在杆上，把对手挤下去。剩下交给<b>重力</b>。",
                    en: "Stay on the bar. Push the other off. <b>Gravity</b> does the rest." },
    hintKb:       { zh: "<b>玩家1</b>: A/D 移动, W 隐身 &nbsp;·&nbsp; <b>玩家2</b>: &larr;/&rarr; 移动, &uarr; 隐身 &nbsp;·&nbsp; <b>R</b> 重开 &nbsp;·&nbsp; <b>空格</b> 暂停",
                    en: "<b>P1</b>: A/D move, W invisible &nbsp;·&nbsp; <b>P2</b>: &larr;/&rarr; move, &uarr; invisible &nbsp;·&nbsp; <b>R</b> restart &nbsp;·&nbsp; <b>Space</b> pause" },
    hintTouch:    { zh: "点 <b>&#9664;</b> / <b>&#9654;</b> 移动, <b>隐身</b> 穿透。点 <b>倾斜</b> 用重力感应操控。触屏仅支持 <b>对战电脑</b>。",
                    en: "Tap <b>&#9664;</b> / <b>&#9654;</b> to move, <b>INVIS</b> to phase through. Tap <b>TILT</b> to steer by tilting your phone. Touch supports <b>vs AI</b> only." },
    // touch buttons
    invis:        { zh: "隐身",        en: "INVIS" },
    invisOn:      { zh: "开启",        en: "ON" },
    tilt:         { zh: "倾斜",        en: "TILT" },
    // menu / overlay
    menuDesc:     { zh: "两颗球共享一根会倾斜的杆。杆会随时间变轻，平衡越来越难。把对手挤下去，或撑得更久。",
                    en: "Two balls share a tilting bar. The bar gets lighter over time, so balance gets harder. Push your opponent off — or just survive longer." },
    touchOnly:    { zh: "触屏操控仅支持对战电脑，双人模式需要键盘。",
                    en: "Touch controls support vs AI only. 2-player needs a keyboard." },
    twoPlayers:   { zh: "双人对战",     en: "2 Players" },
    vsAI:         { zh: "对战电脑",     en: "vs AI" },
    resume:       { zh: "继续",        en: "Resume" },
    restart:      { zh: "重开",        en: "Restart" },
    playAgain:    { zh: "再来一局",     en: "Play again" },
    menu:         { zh: "主菜单",      en: "Menu" },
    paused:       { zh: "已暂停",      en: "Paused" },
    draw:         { zh: "平局！",      en: "Draw!" },
    p1Wins:       { zh: "玩家1 获胜！🏆", en: "P1 wins! 🏆" },
    p2Wins:       { zh: "玩家2 获胜！🏆", en: "P2 wins! 🏆" },
    aiWins:       { zh: "电脑获胜",    en: "AI wins" },
    // canvas HUD
    hud:          { zh: "时间 {t}s   杆重 {m}kg", en: "time {t}s   bar mass {m}kg" },
    // tilt indicator
    tiltCenter:   { zh: "倾斜: 居中",  en: "tilt: center" },
    tiltRight:    { zh: "向右 {n}%",  en: "tilt right {n}%" },
    tiltLeft:     { zh: "向左 {n}%",  en: "tilt left {n}%" },
    tiltReq:      { zh: "请求中…",    en: "requesting…" },
    tiltDenied:   { zh: "权限被拒绝",  en: "permission denied" },
    tiltErr:      { zh: "权限错误",    en: "permission error" },
    tiltCalib:    { zh: "已校准",      en: "calibrated" },
    tiltNoSensor: { zh: "此设备无传感器", en: "no sensor on this device" },
    // lang button shows the OTHER language's name (what you'll switch to)
    langToEn:     { zh: "EN",         en: "EN" },
    langToZh:     { zh: "中文",       en: "中文" },
    // skill mode
    skillMode:    { zh: "技能道具",   en: "Skill boxes" },
    skillOn:      { zh: "开",         en: "On" },
    skillOff:     { zh: "关",         en: "Off" },
    skillMass:    { zh: "加重",       en: "Mass+" },
    skillAccel:   { zh: "加速",       en: "Accel+" },
    skillCd:      { zh: "冷却缩减",   en: "CD-" },
    skillInelastic:{ zh: "粘性碰撞",  en: "Sticky" },
    skillHint:    { zh: "收集道具获得限时增益。M 加重 · A 加速 · C 冷却缩减 · I 粘性碰撞",
                    en: "Collect boxes for timed buffs. M heavier · A faster · C shorter CD · I sticky collisions" },
  };

  function t(key, vars) {
    const entry = L[key];
    if (!entry) return key;
    let s = entry[lang] ?? entry.en ?? key;
    if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
    return s;
  }

  // Update static (HTML) strings to the current language. Dynamic/canvas text
  // reads t() directly at render time, so it always tracks lang.
  const langBtn = document.getElementById("lang-btn");
  // Label for a ball: in vs-AI mode P1 is "You" and P2 is "AI" (no numbering);
  // in 2-player mode both are numbered.
  function ballLabel(b) {
    if (vsAI) return b.idx === 0 ? t("youLabel") : t("ai");
    return b.idx === 0 ? t("p1Label") : t("p2Label");
  }

  function applyStaticText() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = t("title");
    document.querySelector("h1").textContent = t("title");
    document.querySelector(".score-box.p1 .label").textContent = vsAI ? t("youLabel") : t("p1Label");
    document.querySelector(".score-box.p2 .label").textContent = vsAI ? t("ai") : t("p2Label");
    document.getElementById("new-game").textContent = t("newGame");
    document.querySelector(".tagline").innerHTML = t("tagline");
    document.getElementById("hint-keyboard").innerHTML = t("hintKb");
    document.getElementById("hint-touch").innerHTML = t("hintTouch");
    document.getElementById("tc-invis").textContent = t("invis");
    document.getElementById("tc-tilt").textContent = t("tilt");
    if (langBtn) langBtn.textContent = lang === "zh" ? t("langToEn") : t("langToZh");
  }
  function setLang(next) {
    lang = next;
    localStorage.setItem(LANG_KEY, lang);
    applyStaticText();
    updateStatus();
    if (mode === "menu") showMenu();   // refresh overlay text
  }
  if (langBtn) langBtn.addEventListener("click", () => setLang(lang === "zh" ? "en" : "zh"));

  // Bar moment of inertia about center: I = (1/12) m L^2  (uniform rod).
  // We use barMass as the inertia driver; gravity torque = sum(m_i * g * x_i * cos(theta)).
  function barInertia(mass) {
    return (1 / 12) * mass * barLen() * barLen();
  }

  // ---- game state ----
  let mode = "menu";      // "menu" | "playing" | "paused" | "over"
  let vsAI = false;
  let skillMode = false;  // random skill-box pickups + longer bar
  let elapsed = 0;        // seconds since match start
  let bar;                 // { theta, omega, mass }
  let balls;               // [ball, ball]
  let lastTs = 0;
  let rafId = 0;
  let winner = null;       // 0 | 1 | null
  // skill box: { s, type, bornAt } or null. type in "mass"|"accel"|"cd"|"inelastic".
  let skillBox = null;
  let skillCooldown = 0;   // s until next box may spawn
  // buzz charge: builds while both balls are close+closing+slow; detonates at full.
  let buzz = 0;            // 0..1 charge fraction

  function makeBall(idx) {
    return {
      idx,                 // 0 = P1 (left), 1 = P2 (right)
      s: idx === 0 ? -1.4 : 1.4,  // position along bar (m, signed)
      v: 0,                // velocity along bar (m/s)
      mass: CFG.ballMass,
      invis: { active: false, left: 0, cd: 0 }, // cd = cooldown remaining
      out: false,
      aiThink: 0,
      expCd: 0,            // explosion cooldown remaining (s)
      expFlash: 0,         // explosion visual flash remaining (s)
      // skill-box buffs (timed). Defaults = no buff.
      buffs: {
        mass: 0,           // extra mass added for torque
        accel: 0,          // accel multiplier addend (effAccel = accel*(1+accel))
        cdMult: 1,         // invis cooldown multiplier
        inelastic: false,  // inelastic collision flag
        timers: { mass: 0, accel: 0, cd: 0, inelastic: 0 },
      },
    };
  }

  // ---- effective values (base + active buffs) ----
  function effMass(b)    { return CFG.ballMass + b.buffs.mass; }
  function effAccel(b)   { return CFG.accel * (1 + b.buffs.accel); }
  function effInvisCd(b) { return CFG.invisCooldown * b.buffs.cdMult; }

  // ---- skill boxes ----
  const SKILL_TYPES = ["mass", "accel", "cd", "inelastic"];
  // per-type render metadata + i18n label keys
  const SKILL_META = {
    mass:      { color: "#e8a33d", letter: "M", key: "skillMass" },
    accel:     { color: "#6fb36a", letter: "A", key: "skillAccel" },
    cd:        { color: "#5b9bd5", letter: "C", key: "skillCd" },
    inelastic: { color: "#b07cc6", letter: "I", key: "skillInelastic" },
  };
  function applyBuff(b, type) {
    const S = CFG.skill;
    const T = b.buffs.timers;
    if (type === "mass")      { b.buffs.mass = S.massAdd; T.mass = S.buffDur; }
    else if (type === "accel"){ b.buffs.accel = S.accelAdd; T.accel = S.buffDur; }
    else if (type === "cd")   { b.buffs.cdMult = S.cdMult; T.cd = S.cdDur; }
    else if (type === "inelastic") { b.buffs.inelastic = true; T.inelastic = S.buffDur; }
  }
  function tickBuffs(b, dt) {
    const T = b.buffs.timers;
    for (const k of ["mass", "accel", "cd", "inelastic"]) {
      if (T[k] > 0) {
        T[k] -= dt;
        if (T[k] <= 0) {
          T[k] = 0;
          if (k === "mass") b.buffs.mass = 0;
          else if (k === "accel") b.buffs.accel = 0;
          else if (k === "cd") b.buffs.cdMult = 1;
          else if (k === "inelastic") b.buffs.inelastic = false;
        }
      }
    }
  }
  // spawn a box at a random s, avoiding the balls' current positions
  function spawnSkillBox() {
    const half = barHalf();
    let s, ok = false, tries = 0;
    do {
      s = (Math.random() * 2 - 1) * (half - 0.4);
      ok = balls.every(b => b.out || Math.abs(b.s - s) > 0.8);
      tries++;
    } while (!ok && tries < 12);
    skillBox = { s, type: SKILL_TYPES[Math.floor(Math.random() * SKILL_TYPES.length)], bornAt: elapsed };
  }
  // drive box lifecycle; called from frame() once per frame (dt = frame dt)
  function updateSkillBox(dt) {
    if (!skillMode) return;
    if (skillCooldown > 0) skillCooldown = Math.max(0, skillCooldown - dt);
    if (!skillBox) {
      if (skillCooldown <= 0) spawnSkillBox();
      return;
    }
    // despawn if uncollected too long
    if (elapsed - skillBox.bornAt > CFG.skill.despawn) {
      skillBox = null;
      skillCooldown = CFG.skill.spawnDelay;
    }
  }
  // proximity collection; called from physicsStep after positions update
  function checkSkillPickup() {
    if (!skillMode || !skillBox) return;
    for (const b of balls) {
      if (b.out) continue;
      if (Math.abs(b.s - skillBox.s) < BALL_R + CFG.skill.boxR) {
        applyBuff(b, skillBox.type);
        skillBox = null;
        skillCooldown = CFG.skill.spawnDelay;
        break;
      }
    }
  }

  function reset() {
    elapsed = 0;
    bar = { theta: 0, omega: 0, mass: CFG.barMassStart };
    balls = [makeBall(0), makeBall(1)];
    winner = null;
    skillBox = null;
    skillCooldown = skillMode ? 1.0 : 0;   // first box appears shortly after start
    buzz = 0;
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
    //    Canvas convention: y points DOWN. With bar direction (cos θ, sin θ),
    //    theta > 0 => right tip is DOWN (clockwise). A ball on the low side (s>0
    //    when theta>0) must push its side further down, i.e. increase theta.
    //    So torque = +m·g·s·cos(theta): s>0 => tau>0 => theta grows. Correct.
    let torque = 0;
    for (const b of balls) {
      if (b.out) continue;
      torque += effMass(b) * G * b.s * Math.cos(bar.theta);
    }
    const I = barInertia(bar.mass);
    const alpha = torque / I;

    // semi-implicit Euler
    bar.omega += alpha * dt;
    bar.omega = clamp(bar.omega, -CFG.maxAngVel, CFG.maxAngVel);
    bar.omega *= 0.998; // tiny global damping to bleed runaway energy
    bar.theta += bar.omega * dt;

    // 3. Balls slide along the bar under gravity's tangential component.
    //    theta > 0 => right tip DOWN => bar slopes down to the right => a ball
    //    slides toward +s (downhill/right). Tangential accel a_t = +g·sin(theta).
    for (const b of balls) {
      if (b.out) continue;

      const gravTang = G * Math.sin(bar.theta);
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
      // explosion timers
      if (b.expCd > 0) b.expCd = Math.max(0, b.expCd - dt);
      if (b.expFlash > 0) b.expFlash = Math.max(0, b.expFlash - dt);
      // skill buff timers
      tickBuffs(b, dt);

      // off the end -> out
      if (Math.abs(b.s) > barHalf() + BALL_R * 0.5) {
        b.out = true;
        b.v = 0;
      }
    }

    // 4. Skill box pickup (proximity; boxes don't block or weigh the bar).
    checkSkillPickup();

    // 5. Buzz charge + ball-ball collision (1D along the bar).
    const [a, c] = balls;
    if (!a.out && !c.out && !(a.invis.active || c.invis.active)) {
      const gap = Math.abs(c.s - a.s);
      const rel = c.v - a.v;
      const sign = c.s >= a.s ? 1 : -1;
      const closing = (sign > 0 && rel < 0) || (sign < 0 && rel > 0);
      const slow = Math.abs(rel) < CFG.explosionRel;
      const near = gap < CFG.explosionProx;

      // Charge builds while close+closing+slow (a stall); bleeds otherwise.
      if (near && closing && slow) {
        buzz += dt / CFG.explosionCharge;
      } else {
        buzz = Math.max(0, buzz - CFG.explosionBleed * dt);
      }
      if (buzz > 1) buzz = 1;

      const minSep = 2 * BALL_R;
      if (gap < minSep) {
        // resolve overlap
        const overlap = minSep - gap;
        a.s -= sign * overlap / 2;
        c.s += sign * overlap / 2;

        if (buzz >= 1 && a.expCd <= 0 && c.expCd <= 0) {
          // detonate: stored-energy explosion breaks the stall
          a.v = -sign * CFG.explosionKick;
          c.v =  sign * CFG.explosionKick;
          a.expCd = c.expCd = CFG.explosionCd;
          a.expFlash = c.expFlash = CFG.explosionFlash;
          buzz = 0;
        } else if (a.buffs.inelastic || c.buffs.inelastic) {
          // inelastic: equal mass -> both take the average velocity (momentum
          // conserved, kinetic energy lost). The skilled ball drags the other.
          const avg = (a.v + c.v) / 2;
          a.v = avg;
          c.v = avg;
        } else {
          // elastic 1D collision, equal mass -> swap velocities
          const va = a.v, vc = c.v;
          a.v = vc;
          c.v = va;
        }
      }
    } else {
      // one ball out or invisible: charge dissipates
      buzz = Math.max(0, buzz - CFG.explosionBleed * dt);
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
      let dir = 0;
      if (keys["a"]) dir -= 1;
      if (keys["d"]) dir += 1;
      // tilt control: if enabled and no button held, steer by phone tilt
      if (tilt.enabled && dir === 0) dir = tilt.value;
      p1.inputAccel = dir * effAccel(p1);
      if (skillQueued[0]) { tryInvis(p1); skillQueued[0] = false; }
    }
    // P2: arrows move, Up invis
    const p2 = balls[1];
    if (!p2.out) {
      if (vsAI) {
        p2.inputAccel = aiDecide(p2, dt);
        if (aiWantsInvis(p2)) tryInvis(p2);
      } else {
        let dir = 0;
        if (keys["arrowleft"]) dir -= 1;
        if (keys["arrowright"]) dir += 1;
        p2.inputAccel = dir * effAccel(p2);
        if (skillQueued[1]) { tryInvis(p2); skillQueued[1] = false; }
      }
    }
  }

  function tryInvis(b) {
    if (b.invis.active || b.invis.cd > 0) return;
    b.invis.active = true;
    b.invis.left = CFG.invisDuration;
    b.invis.cd = effInvisCd(b);
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
      if (Math.abs(opp.s) > barHalf() * 0.6 && !opp.out) {
        // opponent near edge -> charge them to shove off
        target = opp.s + Math.sign(opp.s) * (2 * BALL_R + 0.1);
      } else {
        // otherwise sit slightly opposite the opponent to counter-balance
        target = -opp.s * 0.5;
      }
      target = clamp(target, -barHalf() * 0.85, barHalf() * 0.85);
      b._aiTarget = target;
    }
    const target = b._aiTarget ?? 0;
    const err = target - b.s;
    const acc = effAccel(b);
    // proportional control toward target
    if (Math.abs(err) < 0.1) return -acc * 0.2 * Math.sign(b.v); // brake
    return acc * Math.sign(err);
  }

  function aiWantsInvis(b) {
    // pop invisibility if heading off an edge, or about to be shoved
    if (b.invis.cd > 0 || b.invis.active) return false;
    const opp = balls[0];
    const aboutToCollide =
      !opp.out &&
      Math.abs(opp.s - b.s) < 2 * BALL_R + 0.3 &&
      Math.abs(opp.v) > 2.5;
    const nearEdge = Math.abs(b.s) > barHalf() * 0.7 && Math.sign(b.v) === Math.sign(b.s);
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
      winner === -1 ? t("draw") : (winner === 0 ? t("p1Wins") : (vsAI ? t("aiWins") : t("p2Wins"))),
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
    const barW = barLen() * PX_PER_M;
    const barH = 16;
    // mass -> color (heavier = darker brown, lighter = pale)
    const massT = clamp((bar.mass - CFG.barMassEnd) / (CFG.barMassStart - CFG.barMassEnd), 0, 1);
    const r = Math.round(143 + (187 - 143) * (1 - massT));
    const g = Math.round(122 + (173 - 122) * (1 - massT));
    const bl = Math.round(102 + (160 - 102) * (1 - massT));
    ctx.fillStyle = `rgb(${r},${g},${bl})`;
    ctx.fillRect(-barW / 2, -barH / 2, barW, barH);
    // end caps (danger zones)
    ctx.fillStyle = "rgba(246,124,95,0.65)";
    ctx.fillRect(-barW / 2, -barH / 2, 10, barH);
    ctx.fillRect(barW / 2 - 10, -barH / 2, 10, barH);
    ctx.restore();

    // skill box on the bar (skill mode only)
    if (skillMode && skillBox) {
      const p = worldToCanvas(skillBox.s, bar.theta);
      const boxPx = CFG.skill.boxR * 2 * PX_PER_M;
      const meta = SKILL_META[skillBox.type];
      // pulse
      const pulse = 1 + 0.08 * Math.sin(elapsed * 6);
      const sz = boxPx * pulse;
      ctx.save();
      ctx.translate(p.x, p.y - boxPx * 0.3); // hover just above bar surface
      ctx.fillStyle = meta.color;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 2;
      roundRect(ctx, -sz / 2, -sz / 2, sz, sz, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(meta.letter, 0, 1);
      ctx.restore();
    }

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

      // explosion flash: expanding ring fading out
      if (b.expFlash > 0) {
        const f = 1 - b.expFlash / CFG.explosionFlash;   // 0 -> 1
        const rr = rad + 6 + f * 22;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(237,194,46,${(1 - f) * 0.8})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      // outline + label
      ctx.lineWidth = 2;
      ctx.strokeStyle = b.invis.active ? "rgba(108,138,150,0.6)" : "rgba(255,255,255,0.5)";
      ctx.stroke();
      ctx.fillStyle = "#f9f6f2";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ballLabel(b), p.x, p.y);

      // invis cooldown ring
      if (!b.invis.active && b.invis.cd > 0) {
        const frac = 1 - b.invis.cd / effInvisCd(b);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = "rgba(143,122,102,0.5)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // active skill buff: colored halo + timer ring
      const T = b.buffs.timers;
      const activeType =
        T.mass > 0 ? "mass" :
        T.accel > 0 ? "accel" :
        T.cd > 0 ? "cd" :
        T.inelastic > 0 ? "inelastic" : null;
      if (activeType) {
        const meta = SKILL_META[activeType];
        const maxDur = activeType === "cd" ? CFG.skill.cdDur : CFG.skill.buffDur;
        const frac = Math.max(0, T[activeType] / maxDur);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 7, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 3;
        ctx.stroke();
        // short label above the ball
        ctx.fillStyle = meta.color;
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(meta.letter + "+", p.x, p.y - rad - 9);
      }
    }

    // buzz charge: growing energy spark between the two balls (stall warning)
    if (buzz > 0.02 && !balls[0].out && !balls[1].out &&
        !(balls[0].invis.active || balls[1].invis.active)) {
      const pa = worldToCanvas(balls[0].s, bar.theta);
      const pc = worldToCanvas(balls[1].s, bar.theta);
      const mx = (pa.x + pc.x) / 2, my = (pa.y + pc.y) / 2;
      const pulse = 0.7 + 0.3 * Math.sin(elapsed * 18);
      const r = (4 + buzz * 14) * pulse;
      const hot = buzz >= 1;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fillStyle = hot
        ? `rgba(246,94,59,${0.5 + 0.4 * pulse})`
        : `rgba(237,194,46,${0.25 + 0.45 * buzz})`;
      ctx.fill();
      ctx.strokeStyle = hot ? "rgba(246,94,59,0.9)" : "rgba(237,194,46,0.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // elapsed / mass HUD on canvas
    ctx.fillStyle = "rgba(119,110,101,0.7)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(t("hud", { t: elapsed.toFixed(1), m: bar.mass.toFixed(1) }), 10, 8);

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
      const pct = Math.round(Math.abs(tilt.value) * 100);
      const msg = tilt.status
        ? t(tilt.status)
        : (tilt.value === 0 ? t("tiltCenter") : t(tilt.value > 0 ? "tiltRight" : "tiltLeft", { n: pct }));
      ctx.fillText(msg, cx, cy + 10);
    }
  }

  function updateStatus() {
    const fmt = (b, label) => b.out ? t("out") :
      b.invis.active ? t("invisible") :
      b.invis.cd > 0 ? t("cd", { n: b.invis.cd.toFixed(1) }) : label;
    p1StatusEl.textContent = balls ? fmt(balls[0], t("ready")) : t("ready");
    p2StatusEl.textContent = balls ? fmt(balls[1], vsAI ? t("ai") : t("ready")) : t("ready");
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
    updateSkillBox(dt);
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
      p.textContent = t("menuDesc");
      o.appendChild(p);
      if (isTouch) {
        const note = document.createElement("p");
        note.textContent = t("touchOnly");
        note.style.fontStyle = "italic";
        o.appendChild(note);
      }
      // skill-box mode toggle
      const toggleRow = document.createElement("div");
      toggleRow.className = "actions";
      const skillBtn = mkBtn(
        t("skillMode") + ": " + (skillMode ? t("skillOn") : t("skillOff")),
        skillMode ? "btn" : "btn secondary",
        () => { skillMode = !skillMode; showMenu(); }
      );
      toggleRow.appendChild(skillBtn);
      o.appendChild(toggleRow);
      if (skillMode) {
        const sh = document.createElement("p");
        sh.textContent = t("skillHint");
        sh.style.fontSize = "12px";
        o.appendChild(sh);
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      const b2p = mkBtn(t("twoPlayers"), "btn", () => startGame(false));
      const bai = mkBtn(t("vsAI"), isTouch ? "btn" : "btn secondary", () => startGame(true));
      actions.appendChild(b2p);
      actions.appendChild(bai);
      o.appendChild(actions);
    } else if (mode === "paused") {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(mkBtn(t("resume"), "btn", () => togglePause()));
      actions.appendChild(mkBtn(t("restart"), "btn secondary", () => startGame(vsAI)));
      o.appendChild(actions);
    } else if (mode === "over") {
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.appendChild(mkBtn(t("playAgain"), "btn", () => startGame(vsAI)));
      actions.appendChild(mkBtn(t("menu"), "btn secondary", () => showMenu()));
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
    showOverlay(t("title"), "", false);
  }

  function startGame(ai) {
    vsAI = ai;
    reset();
    mode = "playing";
    lastTs = 0;
    clearOverlay();
    applyStaticText();   // refresh scoreboard labels (You/AI vs 玩家1/玩家2)
  }

  function togglePause() {
    if (mode === "playing") {
      mode = "paused";
      showOverlay(t("paused"), "", false);
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
    tcInvis.textContent = b.invis.active ? t("invisOn")
      : (cooling ? b.invis.cd.toFixed(1) + "s" : t("invis"));
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
    tilt.status = "tiltReq";
    // iOS permission gate (must be called from a user gesture)
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      try {
        const res = await D.requestPermission();
        if (res !== "granted") { tilt.status = "tiltDenied"; return; }
      } catch { tilt.status = "tiltErr"; return; }
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
        tilt.status = "tiltNoSensor";
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
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- boot ----
  applyStaticText();
  reset();
  resize();
  showMenu();
  rafId = requestAnimationFrame(frame);
})();
