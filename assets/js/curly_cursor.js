(function () {
    const canvas = document.getElementById('curly-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let mouseMoved = false;

    const pointer = {
        x: 0.5 * window.innerWidth,
        y: 0.5 * window.innerHeight,
    };

    const params = {
        pointsNumber: 40,
        widthFactor: 0.3,
        mouseThreshold: 0.6,
        spring: 0.4,
        friction: 0.5,
        strokeStyle: '#FFC627',
    };

    const trail = new Array(params.pointsNumber).fill(null).map(() => ({
        x: pointer.x,
        y: pointer.y,
        dx: 0,
        dy: 0,
    }));

    const updateMousePosition = (x, y) => {
        pointer.x = x;
        pointer.y = y;
    };

    const handlePointerMove = (x, y) => {
        mouseMoved = true;
        updateMousePosition(x, y);
    };

    const setupCanvas = () => {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const update = (t) => {
        if (!mouseMoved) {
            pointer.x =
                (0.5 + 0.3 * Math.cos(0.002 * t) * Math.sin(0.005 * t)) *
                window.innerWidth;
            pointer.y =
                (0.5 + 0.2 * Math.cos(0.005 * t) + 0.1 * Math.cos(0.01 * t)) *
                window.innerHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = params.strokeStyle;
        ctx.lineCap = 'round';

        trail.forEach((p, pIdx) => {
            const prev = pIdx === 0 ? pointer : trail[pIdx - 1];
            const spring = pIdx === 0 ? 0.4 * params.spring : params.spring;
            p.dx += (prev.x - p.x) * spring;
            p.dy += (prev.y - p.y) * spring;
            p.dx *= params.friction;
            p.dy *= params.friction;
            p.x += p.dx;
            p.y += p.dy;
        });

        ctx.beginPath();
        ctx.moveTo(trail[0].x, trail[0].y);

        for (let i = 1; i < trail.length - 1; i++) {
            const xc = 0.5 * (trail[i].x + trail[i + 1].x);
            const yc = 0.5 * (trail[i].y + trail[i + 1].y);
            ctx.quadraticCurveTo(trail[i].x, trail[i].y, xc, yc);
            ctx.lineWidth = params.widthFactor * (params.pointsNumber - i);
            ctx.stroke();
        }

        ctx.lineTo(trail[trail.length - 1].x, trail[trail.length - 1].y);
        ctx.stroke();

        window.requestAnimationFrame(update);
    };

    setupCanvas();
    update(0);

    window.addEventListener('resize', setupCanvas);
    window.addEventListener('click', (e) => updateMousePosition(e.pageX, e.pageY));
    window.addEventListener('mousemove', (e) => handlePointerMove(e.pageX, e.pageY));
    window.addEventListener('touchmove', (e) => {
        const touch = e.targetTouches[0];
        if (!touch) return;
        handlePointerMove(touch.pageX, touch.pageY);
    }, { passive: true });
})();
