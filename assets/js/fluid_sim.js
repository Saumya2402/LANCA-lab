// ============================================================================
//  FLUIDSIM.JS  —  Minimal WebGL Navier–Stokes Solver (Pavel Dobryakov core)
//  Stripped for LANCA Lab – No UI, no controls, fixed parameters.
// ============================================================================

const FluidSim = (function () {
    let canvas, gl, active = false;

    // ---------------------------------------
    // Solver configuration
    // ---------------------------------------
    const config = {
        DENSITY_DISSIPATION: 0.98,
        VELOCITY_DISSIPATION: 0.99,
        PRESSURE_ITERATIONS: 20,
        CURL: 30,
        SPLAT_RADIUS: 0.004
    };

    // ---------------------------------------
    // Pointer interaction
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
        const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

        for (let i = 0; i < n; i++) {
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
    // Fragment shaders (minimal)
    // ---------------------------------------
    const displayShader = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTexture;
        void main() {
            gl_FragColor = texture2D(uTexture, vUv);
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
            float d = dot(p,p);
            vec3 base = texture2D(uTarget, vUv).rgb;
            vec3 added = color * exp(-d / radius);
            gl_FragColor = vec4(base + added, 1.0);
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
            float L = texture2D(uVelocity, vUv - vec2(texelSize.x,0)).x;
            float R = texture2D(uVelocity, vUv + vec2(texelSize.x,0)).x;
            float T = texture2D(uVelocity, vUv + vec2(0,texelSize.y)).y;
            float B = texture2D(uVelocity, vUv - vec2(0,texelSize.y)).y;
            gl_FragColor = vec4(0.5*(R-L+T-B),0,0,1);
        }
    `;

    const pressureShader = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uDivergence;
        uniform vec2 texelSize;
        void main() {
            float L = texture2D(uPressure, vUv - vec2(texelSize.x,0)).x;
            float R = texture2D(uPressure, vUv + vec2(texelSize.x,0)).x;
            float T = texture2D(uPressure, vUv + vec2(0,texelSize.y)).x;
            float B = texture2D(uPressure, vUv - vec2(0,texelSize.y)).x;
            float div = texture2D(uDivergence, vUv).x;
            gl_FragColor = vec4((L+R+T+B - div)*0.25,0,0,1);
        }
    `;

    const gradientSubtractShader = `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uPressure;
        uniform sampler2D uVelocity;
        uniform vec2 texelSize;
        void main() {
            float L = texture2D(uPressure, vUv - vec2(texelSize.x,0)).x;
            float R = texture2D(uPressure, vUv + vec2(texelSize.x,0)).x;
            float T = texture2D(uPressure, vUv + vec2(0,texelSize.y)).x;
            float B = texture2D(uPressure, vUv - vec2(0,texelSize.y)).x;
            vec2 vel = texture2D(uVelocity, vUv).xy;
            vel -= vec2(R-L, T-B);
            gl_FragColor = vec4(vel,0,1);
        }
    `;

    // ---------------------------------------
    // Framebuffers
    // ---------------------------------------
    let velocity, density, pressure, divergence;

    // ---------------------------------------
    // Programs
    // ---------------------------------------
    let pDisplay, pSplat, pAdvection, pPressure, pDivergence, pGradient;

    // ---------------------------------------
    // Draw helper
    // ---------------------------------------
    function blit(dest) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dest);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ---------------------------------------
    // Rebuild FBOs on resize
    // ---------------------------------------
    function rebuildFBOs() {
        const w = canvas.width;
        const h = canvas.height;
        const type = gl.HALF_FLOAT;

        velocity = createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, type, gl.LINEAR);
        density  = createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, type, gl.LINEAR);
        pressure = createDoubleFBO(w, h, gl.R16F,    gl.RED,  type, gl.NEAREST);
        divergence = createFBO(w, h, gl.R16F, gl.RED, type, gl.NEAREST);
    }

    // ---------------------------------------
    // Initialize simulation
    // ---------------------------------------
    function init(targetCanvas) {
        canvas = targetCanvas;

        // REQUIRED FIX: set proper size
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        gl = canvas.getContext("webgl2", { premultipliedAlpha:false });
        if (!gl) {
            alert("WebGL2 not supported");
            return;
        }

        // Fullscreen quad
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),
            gl.STATIC_DRAW
        );

        // Build programs
        pDisplay   = createProgram(baseVertexShader, displayShader);
        pSplat     = createProgram(baseVertexShader, splatShader);
        pAdvection = createProgram(baseVertexShader, advectionShader);
        pDivergence= createProgram(baseVertexShader, divergenceShader);
        pPressure  = createProgram(baseVertexShader, pressureShader);
        pGradient  = createProgram(baseVertexShader, gradientSubtractShader);

        rebuildFBOs();

        // Pointer events
        canvas.onmousedown = e => {
            pointer.down = true;
            pointer.x = e.offsetX;
            pointer.y = e.offsetY;
        };
        canvas.onmousemove = e => {
            pointer.moved = true;
            pointer.dx = e.offsetX - pointer.x;
            pointer.dy = e.offsetY - pointer.y;
            pointer.x = e.offsetX;
            pointer.y = e.offsetY;
        };
        window.onmouseup = () => (pointer.down = false);

        window.onresize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            rebuildFBOs();
        };

        animate();
    }

    // ---------------------------------------
    // Splat
    // ---------------------------------------
    function applySplat() {
        const x = pointer.x / canvas.width;
        const y = 1.0 - pointer.y / canvas.height;

        gl.useProgram(pSplat.program);
        gl.uniform2f(pSplat.uniforms.point, x, y);
        gl.uniform3f(
            pSplat.uniforms.color,
            pointer.dx * 5.0,
            -pointer.dy * 5.0,
            1.0
        );
        gl.uniform1f(pSplat.uniforms.radius, config.SPLAT_RADIUS);

        // Velocity
        gl.uniform1i(pSplat.uniforms.uTarget, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
        blit(velocity.write.fbo);
        velocity.swap();

        // Density
        gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
        blit(density.write.fbo);
        density.swap();
    }

    // ---------------------------------------
    // Step
    // ---------------------------------------
    function step(dt) {
        const texelX = 1 / canvas.width;
        const texelY = 1 / canvas.height;

        // Divergence
        gl.useProgram(pDivergence.program);
        gl.uniform2f(pDivergence.uniforms.texelSize, texelX, texelY);
        gl.uniform1i(pDivergence.uniforms.uVelocity, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
        blit(divergence.fbo);

        // Pressure solve
        gl.useProgram(pPressure.program);
        gl.uniform2f(pPressure.uniforms.texelSize, texelX, texelY);
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

        // Gradient subtract
        gl.useProgram(pGradient.program);
        gl.uniform2f(pGradient.uniforms.texelSize, texelX, texelY);

        gl.uniform1i(pGradient.uniforms.uPressure, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);

        gl.uniform1i(pGradient.uniforms.uVelocity, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);

        blit(velocity.write.fbo);
        velocity.swap();

        // Advection (velocity)
        gl.useProgram(pAdvection.program);
        gl.uniform2f(pAdvection.uniforms.texelSize, texelX, texelY);
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

        // Advection (density)
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
    let last = performance.now();

    function animate(t) {
        requestAnimationFrame(animate);

        if (!active) return;

        const dt = (t - last) * 0.001;
        last = t;

        if (pointer.down && pointer.moved) applySplat();
        pointer.moved = false;

        step(dt);
        render();
    }

    // ---------------------------------------
    // Public API
    // ---------------------------------------
    return {
        init(canvasElement) { init(canvasElement); },
        enable() { active = true; },
        disable() { active = false; }
    };
})();
