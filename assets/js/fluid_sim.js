// ============================================================================
//  FLUIDSIM.JS  —  Minimal WebGL Navier–Stokes Solver (Pavel Dobryakov core)
//  Stripped for LANCA Lab – No UI, no controls, fixed parameters.
// ============================================================================

const FluidSim = (function () {
    let canvas, gl, active = false;

    // ---------------------------------------
    // Solver configuration (fixed)
    // ---------------------------------------
    const config = {
        DENSITY_DISSIPATION: 0.98,
        VELOCITY_DISSIPATION: 0.99,
        PRESSURE_ITERATIONS: 20,
        CURL: 30,
        SPLAT_RADIUS: 0.004
    };

    // ---------------------------------------
    // Pointer for simple mouse splats
    // ---------------------------------------
    const pointer = {
        down: false,
        moved: false,
        x: 0, y: 0,
        dx: 0, dy: 0,
        color: [1.0, 0.3, 0.1]
    };

    // ---------------------------------------
    // FBO utility
    // ---------------------------------------
    function createFBO(w, h, internalFormat, format, type, filter) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

        return { texture: tex, fbo, w, h };
    }

    function createDoubleFBO(w, h, internalFormat, format, type, filter) {
        let fbo1 = createFBO(w, h, internalFormat, format, type, filter);
        let fbo2 = createFBO(w, h, internalFormat, format, type, filter);

        return {
            read: fbo1,
            write: fbo2,
            swap() {
                let temp = this.read;
                this.read = this.write;
                this.write = temp;
            }
        };
    }

    // ---------------------------------------
    // Shader utilities
    // ---------------------------------------
    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }

    function createProgram(vsSource, fsSource) {
        const vs = compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        const uniforms = {};
        const nUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

        for (let i = 0; i < nUniforms; i++) {
            const name = gl.getActiveUniform(program, i).name;
            uniforms[name] = gl.getUniformLocation(program, name);
        }

        return { program, uniforms };
    }

    // ---------------------------------------
    // Fullscreen quad
    // ---------------------------------------
    const baseVertexShader = `
        attribute vec2 aPosition;
        varying vec2 vUv;
        void main() {
            vUv = aPosition * 0.5 + 0.5;
            gl_Position = vec4(aPosition, 0.0, 1.0);
        }
    `;

    // ---------------------------------------
    // Fragment shaders (minimal set)
    // ---------------------------------------

    const displayShader = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main() {
            vec3 c = texture2D(uTexture, vUv).rgb;
            gl_FragColor = vec4(c, 1.0);
        }
    `;

    const splatShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uTarget;
        uniform vec2 point;
        uniform vec3 color;
        uniform float radius;

        void main() {
            vec2 p = vUv - point;
            float d = dot(p, p);
            vec3 splat = color * exp(-d / radius);
            vec3 base = texture2D(uTarget, vUv).rgb;
            gl_FragColor = vec4(base + splat, 1.0);
        }
    `;

    const advectionShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uVelocity;
        uniform sampler2D uSource;
        uniform float dt;
        uniform float dissipation;
        uniform vec2 texelSize;

        void main() {
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            gl_FragColor = dissipation * texture2D(uSource, coord);
        }
    `;

    const divergenceShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uVelocity;
        uniform vec2 texelSize;

        void main() {
            float L = texture2D(uVelocity, vUv - vec2(texelSize.x, 0.0)).x;
            float R = texture2D(uVelocity, vUv + vec2(texelSize.x, 0.0)).x;
            float T = texture2D(uVelocity, vUv + vec2(0.0, texelSize.y)).y;
            float B = texture2D(uVelocity, vUv - vec2(0.0, texelSize.y)).y;

            float div = 0.5 * (R - L + T - B);
            gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
        }
    `;

    const pressureShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        uniform vec2 texelSize;

        void main() {
            float L = texture2D(uPressure, vUv - vec2(texelSize.x, 0.0)).x;
            float R = texture2D(uPressure, vUv + vec2(texelSize.x, 0.0)).x;
            float T = texture2D(uPressure, vUv + vec2(0.0, texelSize.y)).x;
            float B = texture2D(uPressure, vUv - vec2(0.0, texelSize.y)).x;

            float div = texture2D(uDivergence, vUv).x;
            float p = (L + R + T + B - div) * 0.25;

            gl_FragColor = vec4(p, 0, 0, 1);
        }
    `;

    const gradientSubtractShader = `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;
        uniform vec2 texelSize;

        void main() {
            float L = texture2D(uPressure, vUv - vec2(texelSize.x, 0.0)).x;
            float R = texture2D(uPressure, vUv + vec2(texelSize.x, 0.0)).x;
            float T = texture2D(uPressure, vUv + vec2(0.0, texelSize.y)).x;
            float B = texture2D(uPressure, vUv - vec2(0.0, texelSize.y)).x;

            vec2 vel = texture2D(uVelocity, vUv).xy;
            vel -= vec2(R - L, T - B);

            gl_FragColor = vec4(vel, 0.0, 1.0);
        }
    `;

    // ---------------------------------------
    // Framebuffers
    // ---------------------------------------
    let velocity, density, pressure, divergence;

    // ---------------------------------------
    // GL programs
    // ---------------------------------------
    let pDisplay, pSplat, pAdvection, pPressure, pDivergence, pGradient;

    // ---------------------------------------
    // Main draw helper
    // ---------------------------------------
    function blit(destFBO) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ---------------------------------------
    // Initialize everything
    // ---------------------------------------
    function init(targetCanvas) {
        canvas = targetCanvas;
        gl = canvas.getContext("webgl2", { premultipliedAlpha: false });

        if (!gl) {
            alert("WebGL2 not supported.");
            return;
        }

        // Create quad
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        // Create shader programs
        pDisplay = createProgram(baseVertexShader, displayShader);
        pSplat = createProgram(baseVertexShader, splatShader);
        pAdvection = createProgram(baseVertexShader, advectionShader);
        pDivergence = createProgram(baseVertexShader, divergenceShader);
        pPressure = createProgram(baseVertexShader, pressureShader);
        pGradient = createProgram(baseVertexShader, gradientSubtractShader);

        // Create simulation textures
        const w = canvas.width, h = canvas.height;
        const type = gl.HALF_FLOAT;

        velocity = createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, type, gl.LINEAR);
        density  = createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, type, gl.LINEAR);
        pressure = createDoubleFBO(w, h, gl.R16F,    gl.RED,  type, gl.NEAREST);
        divergence = createFBO(w, h, gl.R16F, gl.RED, type, gl.NEAREST);

        // Pointer interaction
        canvas.addEventListener("mousedown", e => {
            pointer.down = true;
            pointer.color = [Math.random(), Math.random(), Math.random()];
        });

        canvas.addEventListener("mousemove", e => {
            pointer.moved = true;
            pointer.dx = e.offsetX - pointer.x;
            pointer.dy = e.offsetY - pointer.y;
            pointer.x = e.offsetX;
            pointer.y = e.offsetY;
        });

        window.addEventListener("mouseup", () => { pointer.down = false; });

        animate();
    }

    // ---------------------------------------
    // Apply splat
    // ---------------------------------------
    function applySplat() {
        const x = pointer.x / canvas.width;
        const y = 1.0 - pointer.y / canvas.height;

        gl.useProgram(pSplat.program);
        gl.uniform2f(pSplat.uniforms.point, x, y);
        gl.uniform3f(pSplat.uniforms.color, pointer.dx * 5.0, -pointer.dy * 5.0, 1.0);
        gl.uniform1f(pSplat.uniforms.radius, config.SPLAT_RADIUS);

        // Velocity splat
        gl.uniform1i(pSplat.uniforms.uTarget, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
        blit(velocity.write.fbo);
        velocity.swap();

        // Density splat
        gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
        blit(density.write.fbo);
        density.swap();
    }

    // ---------------------------------------
    // Simulation step
    // ---------------------------------------
    function step(dt) {

        // ---------------- divergence ----------------
        gl.useProgram(pDivergence.program);
        gl.uniform2f(pDivergence.uniforms.texelSize, 1 / canvas.width, 1 / canvas.height);
        gl.uniform1i(pDivergence.uniforms.uVelocity, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
        blit(divergence.fbo);

        // ---------------- pressure solve ----------------
        gl.useProgram(pPressure.program);
        gl.uniform2f(pPressure.uniforms.texelSize, 1 / canvas.width, 1 / canvas.height);
        gl.uniform1i(pPressure.uniforms.uDivergence, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, divergence.texture);

        for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(pPressure.uniforms.uPressure, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);
            blit(pressure.write.fbo);
            pressure.swap();
        }

        // ---------------- subtract gradient ----------------
        gl.useProgram(pGradient.program);
        gl.uniform2f(pGradient.uniforms.texelSize, 1 / canvas.width, 1 / canvas.height);

        gl.uniform1i(pGradient.uniforms.uPressure, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);

        gl.uniform1i(pGradient.uniforms.uVelocity, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);

        blit(velocity.write.fbo);
        velocity.swap();

        // ---------------- advection (velocity) ----------------
        gl.useProgram(pAdvection.program);
        gl.uniform2f(pAdvection.uniforms.texelSize, 1 / canvas.width, 1 / canvas.height);
        gl.uniform1f(pAdvection.uniforms.dt, dt);
        gl.uniform1f(pAdvection.uniforms.dissipation, config.VELOCITY_DISSIPATION);

        gl.uniform1i(pAdvection.uniforms.uVelocity, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);

        gl.uniform1i(pAdvection.uniforms.uSource, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);

        blit(velocity.write.fbo);
        velocity.swap();

        // ---------------- advection (density) ----------------
        gl.uniform1f(pAdvection.uniforms.dissipation, config.DENSITY_DISSIPATION);

        gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
        blit(density.write.fbo);
        density.swap();
    }

    // ---------------------------------------
    // Render
    // ---------------------------------------
    function render() {
        gl.useProgram(pDisplay.program);
        gl.uniform1i(pDisplay.uniforms.uTexture, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
        blit(null);
    }

    // ---------------------------------------
    // Main loop
    // ---------------------------------------
    let lastT = performance.now();

    function animate(t) {
        requestAnimationFrame(animate);

        if (!active) return;

        const dt = (t - lastT) * 0.001;
        lastT = t;

        if (pointer.down && pointer.moved) applySplat();
        pointer.moved = false;

        step(dt);
        render();
    }

    // ---------------------------------------
    // Public API
    // ---------------------------------------
    return {
        init(canvasElement) {
            init(canvasElement);
        },
        enable() { active = true; },
        disable() { active = false; }
    };
})();
