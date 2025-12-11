// VORTICITY FLUID — lightweight adaptation of Pavel Dobryakov's WebGL fluid
// simulation. Fixed configuration and no UI: just pointer-driven vorticity
// and a gentle ambient swirl.
(function () {
  const config = {
    SIM_RESOLUTION: 240,
    DYE_RESOLUTION: 1080,
    VELOCITY_DISSIPATION: 0.994,
    DYE_DISSIPATION: 0.9992,
    PRESSURE_ITERATIONS: 30,
    CURL: 6.5,
    SPLAT_RADIUS: 0.03,
    SPLAT_FORCE: 26,
    AMBIENT_SPLATS: 1,
    AMBIENT_RATE: 1400,
    TIME_STEP: 0.01
  };

  const pointers = [{
    id: -1,
    down: false,
    moved: false,
    texcoordX: 0.5,
    texcoordY: 0.5,
    prevTexcoordX: 0.5,
    prevTexcoordY: 0.5,
    deltaX: 0,
    deltaY: 0,
    color: [1, 0.3, 0.8]
  }];

  let gl, canvas;
  let velocity, dye, pressure, divergence, curl;
  let advectProgram, curlProgram, vorticityProgram, divergenceProgram,
      pressureProgram, gradientSubtractProgram, splatProgram, displayProgram;
  let lastTime = performance.now();
  let ambientTimer;
  let ribbonProgress = 0;
  const ribbonColor = [0.88, 0.09, 0.56];

  window.initFluidBackground = function initFluidBackground() {
    if (window.fluidInitialized) return;
    window.fluidInitialized = true;

    canvas = document.getElementById('fluid-canvas');
    gl = canvas.getContext('webgl2', { alpha: false });
    if (!gl) {
      console.warn('WebGL2 not supported for fluid background.');
      return;
    }

    gl.getExtension('EXT_color_buffer_float');
    initPrograms();
    resizeCanvas();
    initPointers();
    addRandomSplats(5);
    requestAnimationFrame(update);
    startAmbientSplats();
  };

  function initPrograms() {
    const baseVertexShader = `
      attribute vec2 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    function createProgram(vertexSrc, fragmentSrc) {
      const vs = compileShader(gl.VERTEX_SHADER, vertexSrc);
      const fs = compileShader(gl.FRAGMENT_SHADER, fragmentSrc);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'aPosition');
      gl.linkProgram(prog);
      return { program: prog, uniforms: getUniforms(prog) };
    }

    const baseVertex = baseVertexShader;

    advectProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform vec2 texelSize;
        uniform float dt;
        uniform float dissipation;

        vec2 decode(vec2 v) { return v * 2.0 - 1.0; }
        void main() {
          vec2 vel = decode(texture2D(uVelocity, vUv).xy);
          vec2 coord = vUv - dt * vel * texelSize;
          vec4 result = texture2D(uSource, coord) * dissipation;
          gl_FragColor = result;
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    curlProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform vec2 texelSize;

        vec2 decode(vec2 v) { return v * 2.0 - 1.0; }
        void main() {
          vec2 L = decode(texture2D(uVelocity, vUv - vec2(texelSize.x, 0.0)).xy);
          vec2 R = decode(texture2D(uVelocity, vUv + vec2(texelSize.x, 0.0)).xy);
          vec2 B = decode(texture2D(uVelocity, vUv - vec2(0.0, texelSize.y)).xy);
          vec2 T = decode(texture2D(uVelocity, vUv + vec2(0.0, texelSize.y)).xy);
          float curl = (R.y - L.y - T.x + B.x) * 0.5;
          float c = curl * 0.5 + 0.5;
          gl_FragColor = vec4(c, 0.0, 0.0, 1.0);
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    vorticityProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uCurl;
        uniform vec2 texelSize;
        uniform float curlStrength;
        uniform float dt;

        vec2 decode(vec2 v) { return v * 2.0 - 1.0; }
        vec2 encode(vec2 v) { return v * 0.5 + 0.5; }
        float decodeScalar(vec4 c) { return (c.r - 0.5) * 2.0; }

        void main() {
          float L = decodeScalar(texture2D(uCurl, vUv - vec2(texelSize.x, 0.0)));
          float R = decodeScalar(texture2D(uCurl, vUv + vec2(texelSize.x, 0.0)));
          float B = decodeScalar(texture2D(uCurl, vUv - vec2(0.0, texelSize.y)));
          float T = decodeScalar(texture2D(uCurl, vUv + vec2(0.0, texelSize.y)));
          float C = decodeScalar(texture2D(uCurl, vUv));

          vec2 grad = vec2(abs(R) - abs(L), abs(T) - abs(B)) * 0.5;
          grad /= length(grad) + 1e-5;
          vec2 force = vec2(grad.y, -grad.x) * C * curlStrength;

          vec2 vel = decode(texture2D(uVelocity, vUv).xy);
          vel += dt * force;
          gl_FragColor = vec4(encode(vel), 0.0, 1.0);
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    divergenceProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform vec2 texelSize;

        vec2 decode(vec2 v) { return v * 2.0 - 1.0; }
        void main() {
          vec2 L = decode(texture2D(uVelocity, vUv - vec2(texelSize.x, 0.0)).xy);
          vec2 R = decode(texture2D(uVelocity, vUv + vec2(texelSize.x, 0.0)).xy);
          vec2 B = decode(texture2D(uVelocity, vUv - vec2(0.0, texelSize.y)).xy);
          vec2 T = decode(texture2D(uVelocity, vUv + vec2(0.0, texelSize.y)).xy);
          float div = (R.x - L.x + T.y - B.y) * 0.5;
          gl_FragColor = vec4(div * 0.5 + 0.5, 0.0, 0.0, 1.0);
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    pressureProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        uniform vec2 texelSize;

        float decodeScalar(vec4 c) { return (c.r - 0.5) * 2.0; }
        vec4 encodeScalar(float v) { return vec4(v * 0.5 + 0.5, 0.0, 0.0, 1.0); }

        void main() {
          float L = decodeScalar(texture2D(uPressure, vUv - vec2(texelSize.x, 0.0)));
          float R = decodeScalar(texture2D(uPressure, vUv + vec2(texelSize.x, 0.0)));
          float B = decodeScalar(texture2D(uPressure, vUv - vec2(0.0, texelSize.y)));
          float T = decodeScalar(texture2D(uPressure, vUv + vec2(0.0, texelSize.y)));
          float div = decodeScalar(texture2D(uDivergence, vUv));
          float pressure = (L + R + B + T - div) * 0.25;
          gl_FragColor = encodeScalar(pressure);
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    gradientSubtractProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uVelocity;
        uniform sampler2D uPressure;
        uniform vec2 texelSize;

        vec2 decode(vec2 v) { return v * 2.0 - 1.0; }
        vec2 encode(vec2 v) { return v * 0.5 + 0.5; }
        float decodeScalar(vec4 c) { return (c.r - 0.5) * 2.0; }

        void main() {
          float L = decodeScalar(texture2D(uPressure, vUv - vec2(texelSize.x, 0.0)));
          float R = decodeScalar(texture2D(uPressure, vUv + vec2(texelSize.x, 0.0)));
          float B = decodeScalar(texture2D(uPressure, vUv - vec2(0.0, texelSize.y)));
          float T = decodeScalar(texture2D(uPressure, vUv + vec2(0.0, texelSize.y)));
          vec2 grad = vec2(R - L, T - B) * 0.5;
          vec2 vel = decode(texture2D(uVelocity, vUv).xy) - grad;
          gl_FragColor = vec4(encode(vel), 0.0, 1.0);
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    splatProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTarget;
        uniform vec2 point;
        uniform float radius;
        uniform vec3 color;
        uniform vec2 force;
        uniform bool isVelocity;

        vec2 decode(vec2 v) { return v * 2.0 - 1.0; }
        vec2 encode(vec2 v) { return v * 0.5 + 0.5; }

        void main() {
          vec2 p = vUv - point;
          float dist = dot(p, p);
          float influence = exp(-dist / radius);
          vec4 base = texture2D(uTarget, vUv);

          if (isVelocity) {
            vec2 v = decode(base.xy);
            v += force * influence;
            gl_FragColor = vec4(encode(v), 0.0, 1.0);
          } else {
            vec3 dye = base.rgb + color * influence;
            gl_FragColor = vec4(dye, 1.0);
          }
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    displayProgram = (() => {
      const fs = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main() {
          vec3 col = texture2D(uTexture, vUv).rgb;
          gl_FragColor = vec4(col, 1.0);
        }
      `;
      return createProgram(baseVertex, fs);
    })();

    const quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
      -1,  1,
       1,  1,
      -1, -1,
       1,  1,
       1, -1
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  function getUniforms(program) {
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return uniforms;
  }

  function createFBO(width, height) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, texture: tex, width, height };
  }

  function createDoubleFBO(width, height) {
    return {
      read: createFBO(width, height),
      write: createFBO(width, height),
      swap() { const t = this.read; this.read = this.write; this.write = t; }
    };
  }

  function blit(target) {
    if (!target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.floor(canvas.clientWidth * ratio);
    const height = Math.floor(canvas.clientHeight * ratio);
    canvas.width = width;
    canvas.height = height;

    const simWidth = config.SIM_RESOLUTION;
    const simHeight = Math.floor(simWidth * height / width);
    const dyeWidth = config.DYE_RESOLUTION;
    const dyeHeight = Math.floor(dyeWidth * height / width);

    velocity = createDoubleFBO(simWidth, simHeight);
    pressure = createDoubleFBO(simWidth, simHeight);
    dye = createDoubleFBO(dyeWidth, dyeHeight);
    divergence = createFBO(simWidth, simHeight);
    curl = createFBO(simWidth, simHeight);
  }

  function initPointers() {
    canvas.addEventListener('pointerdown', e => {
      setPointer(pointers[0], e, true);
      randomizeColor(pointers[0]);
    });

    canvas.addEventListener('pointermove', e => {
      setPointer(pointers[0], e, pointers[0].down);
    });

    window.addEventListener('pointerup', () => { pointers[0].down = false; });
    window.addEventListener('resize', resizeCanvas);
  }

  function setPointer(p, e, down) {
    const rect = canvas.getBoundingClientRect();
    p.prevTexcoordX = p.texcoordX;
    p.prevTexcoordY = p.texcoordY;
    p.texcoordX = (e.clientX - rect.left) / rect.width;
    p.texcoordY = 1.0 - (e.clientY - rect.top) / rect.height;
    p.deltaX = (p.texcoordX - p.prevTexcoordX) * canvas.width;
    p.deltaY = (p.texcoordY - p.prevTexcoordY) * canvas.height;
    p.down = down;
    p.moved = true;
  }

  function randomizeColor(p) {
    const hue = Math.random();
    p.color = hsvToRGB(hue, 0.7, 1.0);
  }

  function hsvToRGB(h, s, v) {
    const k = (n) => (n + h * 6) % 6;
    const f = (n) => v - v * s * Math.max(Math.min(k(n), 4 - k(n), 1), 0);
    return [f(5), f(3), f(1)];
  }

  function splat(pointer) {
    const aspect = canvas.width / canvas.height;
    const dx = pointer.deltaX * config.SPLAT_FORCE;
    const dy = pointer.deltaY * config.SPLAT_FORCE;
    const force = [dx, dy];
    const point = [pointer.texcoordX, pointer.texcoordY];

    splatVelocity(point, [force[0] / aspect, force[1]]);
    splatDye(point, pointer.color);
  }

  function splatVelocity(point, force) {
    splatFBO(velocity, point, config.SPLAT_RADIUS, [0, 0, 0], force, true);
  }

  function splatDye(point, color) {
    splatFBO(dye, point, config.SPLAT_RADIUS * 1.5, color, [0, 0], false);
  }

  function splatFBO(target, point, radius, color, force, isVelocity) {
    gl.useProgram(splatProgram.program);
    gl.uniform2f(splatProgram.uniforms.point, point[0], point[1]);
    gl.uniform1f(splatProgram.uniforms.radius, radius);
    gl.uniform3f(splatProgram.uniforms.color, color[0], color[1], color[2]);
    gl.uniform2f(splatProgram.uniforms.force, force[0], force[1]);
    gl.uniform1i(splatProgram.uniforms.isVelocity, isVelocity ? 1 : 0);

    gl.uniform1i(splatProgram.uniforms.uTarget, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.read.texture);
    blit(target.write);
    target.swap();
  }

  function addRandomSplats(count) {
    for (let i = 0; i < count; i++) {
      const x = Math.random();
      const y = Math.random();
      const color = hsvToRGB(Math.random(), 0.45, 0.7);
      const angle = Math.random() * Math.PI * 2;
      const speed = 12 + Math.random() * 30;
      const force = [Math.cos(angle) * speed, Math.sin(angle) * speed];
      splatVelocity([x, y], force);
      splatDye([x, y], color.map(c => c * 0.7));
    }
  }

  function emitRibbon(dt) {
    ribbonProgress = (ribbonProgress + dt * 0.16) % 1;

    const x = 0.05 + ribbonProgress * 0.8;
    const y = 0.24 + Math.sin(ribbonProgress * 2.9) * 0.1;

    const angle = 0.35 + Math.sin(ribbonProgress * 3.4) * 0.25;
    const speed = 16 + Math.sin(ribbonProgress * 1.7) * 4;
    const force = [Math.cos(angle) * speed, Math.sin(angle) * speed];

    splatVelocity([x, y], force);
    splatDye([x, y], ribbonColor);
  }

  function startAmbientSplats() {
    ambientTimer = setInterval(() => {
      if (!window.fluidActive) return;
      addRandomSplats(config.AMBIENT_SPLATS);
    }, config.AMBIENT_RATE);
  }

  function step(dt) {
    const w = velocity.read.width;
    const h = velocity.read.height;
    const texelSize = [1 / w, 1 / h];

    gl.useProgram(advectProgram.program);
    gl.uniform2f(advectProgram.uniforms.texelSize, texelSize[0], texelSize[1]);
    gl.uniform1f(advectProgram.uniforms.dt, dt);

    // velocity
    gl.uniform1f(advectProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    gl.uniform1i(advectProgram.uniforms.uVelocity, 0);
    gl.uniform1i(advectProgram.uniforms.uSource, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(velocity.write);
    velocity.swap();

    // dye
    gl.uniform1f(advectProgram.uniforms.dissipation, config.DYE_DISSIPATION);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dye.read.texture);
    blit(dye.write);
    dye.swap();

    // curl
    gl.useProgram(curlProgram.program);
    gl.uniform1i(curlProgram.uniforms.uVelocity, 0);
    gl.uniform2f(curlProgram.uniforms.texelSize, texelSize[0], texelSize[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(curl);

    // vorticity
    gl.useProgram(vorticityProgram.program);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, 0);
    gl.uniform1i(vorticityProgram.uniforms.uCurl, 1);
    gl.uniform2f(vorticityProgram.uniforms.texelSize, texelSize[0], texelSize[1]);
    gl.uniform1f(vorticityProgram.uniforms.curlStrength, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, curl.texture);
    blit(velocity.write);
    velocity.swap();

    // divergence
    gl.useProgram(divergenceProgram.program);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, 0);
    gl.uniform2f(divergenceProgram.uniforms.texelSize, texelSize[0], texelSize[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(divergence);

    // pressure
    gl.useProgram(pressureProgram.program);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, 0);
    gl.uniform2f(pressureProgram.uniforms.texelSize, texelSize[0], texelSize[1]);
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, divergence.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);
      blit(pressure.write);
      pressure.swap();
    }

    // gradient subtract
    gl.useProgram(gradientSubtractProgram.program);
    gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, 0);
    gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, 1);
    gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, texelSize[0], texelSize[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);
    blit(velocity.write);
    velocity.swap();
  }

  function render() {
    gl.useProgram(displayProgram.program);
    gl.uniform1i(displayProgram.uniforms.uTexture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dye.read.texture);
    blit(null);
  }

  function update() {
    requestAnimationFrame(update);
    if (!window.fluidActive) return;

    const now = performance.now();
    const dt = Math.min(0.033, (now - lastTime) / 1000) * (config.TIME_STEP / 0.016);
    lastTime = now;

    pointers.forEach(p => {
      if (!p.moved) return;
      p.moved = false;
      splat(p);
    });

    emitRibbon(dt);

    step(dt);
    render();
  }
})();
