// assets/js/tgv_background.js
// Procedural Tayler–Green–style vortex background for GPU Turbulence mode.

const TaylorGreenBackground = (function () {
    let canvas, gl;
    let program, buffer;
    let uResolution, uTime, uScroll;
    let startTime = performance.now();
    let active = false;
    let scrollFactor = 0.0;

    function createShader(type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("TGV shader compile error:", gl.getShaderInfoLog(sh));
            gl.deleteShader(sh);
            return null;
        }
        return sh;
    }

    function createProgram(vsSrc, fsSrc) {
        const vs = createShader(gl.VERTEX_SHADER, vsSrc);
        const fs = createShader(gl.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return null;

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, "a_position"); // attribute location 0
        gl.linkProgram(prog);

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error("TGV program link error:", gl.getProgramInfoLog(prog));
            gl.deleteProgram(prog);
            return null;
        }
        return prog;
    }

    function resize() {
        if (!canvas || !gl) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const displayWidth = Math.floor(canvas.clientWidth * dpr);
        const displayHeight = Math.floor(canvas.clientHeight * dpr);

        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }
    }

    const VERT_SRC = `
        attribute vec2 a_position;
        void main() {
            gl_Position = vec4(a_position, 0.0, 1.0);
        }
    `;

    // Dark golden turbulence Vorticity-style shader
    const FRAG_SRC = `
        precision highp float;

        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_scroll;

        // simple hash noise
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        void main() {
            vec2 uv = gl_FragCoord.xy / u_resolution.xy;
            // keep aspect ratio
            uv.x *= u_resolution.x / u_resolution.y;

            float t = u_time * 0.12 + u_scroll * 1.6;

            // map to [0, 2π]
            vec2 p = uv * 6.2831853;

            // Tayler–Green like superposition
            float w1 = sin(p.x + t) * sin(p.y - t);
            float w2 = 0.6 * sin(2.0 * p.x - 1.3 * t) * sin(2.0 * p.y + 0.7 * t);
            float w3 = 0.35 * sin(3.0 * p.x + 0.5 * t) * sin(3.0 * p.y - 0.9 * t);
            float w = w1 + w2 + w3;

            // mild decay with time for a "breathing" effect
            float decay = 0.85 + 0.15 * sin(0.2 * t);
            w *= decay;

            // emphasise filaments
            w = tanh(w * 1.4);

            // edge-wall interaction: damp near borders
            float ex = min(uv.x, 1.0 - uv.x);
            float ey = min(uv.y, 1.0 - uv.y);
            float edge = smoothstep(0.0, 0.20, ex) * smoothstep(0.0, 0.20, ey);
            w *= edge;

            // subtle noise to break banding
            float n = hash(uv * 512.0 + t);
            w += (n - 0.5) * 0.12;

            // map [-1,1] -> [0,1]
            float x = w * 0.5 + 0.5;

            // Dark golden turbulence palette
            vec3 deepTeal  = vec3(0.02, 0.10, 0.08);
            vec3 green     = vec3(0.05, 0.40, 0.22);
            vec3 gold      = vec3(0.85, 0.70, 0.20);
            vec3 orange    = vec3(0.90, 0.35, 0.05);

            vec3 col;
            if (x < 0.33) {
                float k = smoothstep(0.0, 0.33, x);
                col = mix(deepTeal, green, k);
            } else if (x < 0.66) {
                float k = smoothstep(0.33, 0.66, x);
                col = mix(green, gold, k);
            } else {
                float k = smoothstep(0.66, 1.0, x);
                col = mix(gold, orange, k);
            }

            // radial vignette to keep centre bright
            vec2 c = uv - 0.5;
            float r = dot(c, c);
            float vignette = 1.2 - 0.8 * r;
            col *= vignette;

            // slightly dim overall (background feel)
            col *= 0.9;

            gl_FragColor = vec4(col, 1.0);
        }
    `;

    function init(canvasEl) {
        canvas = canvasEl;
        if (!canvas) {
            console.warn("TaylorGreenBackground: canvas not found");
            return api;
        }

        // Ensure canvas has layout size
        if (!canvas.style.width) canvas.style.width = "100%";
        if (!canvas.style.height) canvas.style.height = "100%";

        gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) {
            console.warn("TaylorGreenBackground: WebGL not supported");
            return api;
        }

        program = createProgram(VERT_SRC, FRAG_SRC);
        if (!program) return api;

        gl.useProgram(program);

        // Fullscreen quad
        buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const quadVerts = new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
             1,  1
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        // uniforms
        uResolution = gl.getUniformLocation(program, "u_resolution");
        uTime = gl.getUniformLocation(program, "u_time");
        uScroll = gl.getUniformLocation(program, "u_scroll");

        resize();
        window.addEventListener("resize", resize);

        requestAnimationFrame(loop);

        return api;
    }

    function loop(now) {
        requestAnimationFrame(loop);
        if (!gl || !program) return;

        resize();

        const t = (now - startTime) * 0.001;

        gl.useProgram(program);
        gl.uniform2f(uResolution, canvas.width, canvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform1f(uScroll, scrollFactor);

        if (active) {
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    }

    const api = {
        init,
        enable() { active = true; },
        disable() { active = false; },
        setScrollFactor(v) { scrollFactor = v; }
    };

    return api;
})();
