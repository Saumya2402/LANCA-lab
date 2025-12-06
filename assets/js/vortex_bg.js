// assets/js/vortex_bg.js
// Simple fake vortex field for background, scroll-responsive

const VortexBG = (function () {
  let canvas, ctx;
  let vortices = [];
  let active = false;
  let scrollFactor = 0.0;      // 0–1 from scroll
  let lastTime = performance.now();
  let w = 0, h = 0;

  const NUM_VORTICES = 10;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cw = rect.width || window.innerWidth;
    const ch = rect.height || window.innerHeight;
    if (cw !== w || ch !== h) {
      w = canvas.width = cw * window.devicePixelRatio;
      h = canvas.height = ch * window.devicePixelRatio;
      canvas.style.width = cw + "px";
      canvas.style.height = ch + "px";
      if (ctx) ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    }
  }

  function makeVortex(i) {
    const hue = rand(30, 90) + i * 12;   // warm / greenish
    const inner = `hsla(${hue}, 80%, 60%, 0.9)`;
    const mid   = `hsla(${hue + 40}, 80%, 50%, 0.6)`;
    return {
      // normalized coordinates [0,1]
      x: rand(0.1, 0.9),
      y: rand(0.15, 0.85),
      baseRadius: rand(0.10, 0.22),
      radiusPulse: rand(0.02, 0.06),
      angle: rand(0, Math.PI * 2),
      baseSpeed: rand(0.2, 0.8),       // rad/s
      spinDir: Math.random() < 0.5 ? -1 : 1,
      innerColor: inner,
      midColor: mid,
      noisePhase: rand(0, Math.PI * 2)
    };
  }

  function initVortices() {
    vortices = [];
    for (let i = 0; i < NUM_VORTICES; i++) {
      vortices.push(makeVortex(i));
    }
  }

  function drawVortex(v, t) {
    const minDim = Math.min(w, h);
    const heartbeat = Math.sin(t * 0.6 + v.noisePhase) * 0.5 + 0.5; // 0–1
    const radius =
      (v.baseRadius + v.radiusPulse * heartbeat * (0.3 + scrollFactor)) * minDim;

    const cx = v.x * w;
    const cy = v.y * h;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(v.angle);

    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    grd.addColorStop(0.0, v.innerColor);
    grd.addColorStop(0.4, v.midColor);
    grd.addColorStop(0.9, "rgba(0,0,0,0)");
    grd.addColorStop(1.0, "rgba(0,0,0,0)");

    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grd;

    // Elongated “swirl” blob
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.6, radius, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function update(dt) {
    // Scroll increases overall motion
    const speedBoost = 0.3 + scrollFactor * 1.5;
    vortices.forEach(v => {
      v.angle += v.spinDir * v.baseSpeed * speedBoost * dt;
      // Small lazy drift
      v.x += 0.02 * dt * (Math.sin(v.angle * 0.5) * 0.2);
      v.y += 0.02 * dt * (Math.cos(v.angle * 0.6) * 0.2);

      // wrap around softly
      if (v.x < -0.2) v.x += 1.4;
      if (v.x > 1.2) v.x -= 1.4;
      if (v.y < -0.2) v.y += 1.4;
      if (v.y > 1.2) v.y -= 1.4;
    });
  }

  function render(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    requestAnimationFrame(render);
    if (!active || !ctx) return;

    resize();

    // Faint trail: not fully clearing, just dimming
    ctx.globalCompositeOperation = "source-over";
    const fade = 0.15; // lower = longer trails
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, w, h);

    const t = now * 0.001;
    vortices.forEach(v => drawVortex(v, t));
  }

  return {
    init(canvasEl) {
      canvas = canvasEl;
      if (!canvas) return;
      ctx = canvas.getContext("2d");
      if (!ctx) return;
      resize();
      initVortices();
      active = false;
      lastTime = performance.now();
      requestAnimationFrame(render);
      window.addEventListener("resize", resize);
    },
    enable() {
      active = true;
    },
    disable() {
      active = false;
    },
    setScrollFactor(f) {
      scrollFactor = Math.max(0, Math.min(1, f));
    }
  };
})();
