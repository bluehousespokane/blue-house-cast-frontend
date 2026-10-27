// Shared by the worker and main-thread fallback. No DOM or external dependencies.
function createCastParticleRenderer(
  canvas,
  options,
  report,
  clock = globalThis
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const reducedMotion = options.reducedMotion;
  let width = 0;
  let height = 0;
  let edgePadding = 0;
  let particles = [];
  let groups = [];
  let targetParticleCount = 0;
  let lastFrame = 0;
  let lastAnimationFrame = 0;
  let healthyFrames = 0;
  let animationFrame = 0;
  let running = true;
  let pointer;
  let phase = "startup";
  let loadingMix = 0;
  let lastReport = 0;
  const measurements = {};
  const measurement = () =>
    (measurements[phase] ||= {
      frames: 0,
      frameMs: 0,
      maxFrameMs: 0,
      slowFrames: 0,
      draws: 0,
      drawMs: 0,
      maxDrawMs: 0,
      maxDrawGapMs: 0,
    });
  const rounded = (value) => Math.round(value * 100) / 100;
  const getPerformance = () => ({
    renderer: options.renderer,
    particleCount: particles.length,
    targetParticleCount,
    phases: Object.fromEntries(
      Object.entries(measurements).map(([name, value]) => [
        name,
        {
          frames: value.frames,
          averageFrameMs: rounded(value.frameMs / Math.max(1, value.frames)),
          maxFrameMs: rounded(value.maxFrameMs),
          slowFrames: value.slowFrames,
          draws: value.draws,
          averageDrawMs: rounded(value.drawMs / Math.max(1, value.draws)),
          maxDrawMs: rounded(value.maxDrawMs),
          maxDrawGapMs: rounded(value.maxDrawGapMs),
        },
      ])
    ),
  });
  const randomWithin = (extent, inset) => {
    const minimum = Math.min(inset, extent / 2);
    const maximum = Math.max(extent - inset, extent / 2);
    return minimum + Math.random() * (maximum - minimum);
  };
  const createParticle = (group) => {
    const radius = 0.1 + Math.random() * (group.settings.maxRadius - 0.1);
    const spawnInset = edgePadding + group.settings.maxRadius;
    return {
      x: randomWithin(width, spawnInset),
      y: randomWithin(height, spawnInset),
      vx: Math.random() - 0.5,
      vy: Math.random() - 0.5,
      color: group.color,
      loadingColor:
        group.color !== "#E8EEF4" ||
        group.added <= Math.round(targetParticleCount * 0.2)
          ? group.color
          : group.added <= Math.round(targetParticleCount * 0.5)
            ? "#005E88"
            : "#F58220",
      radius,
      alpha: group.settings.animateOpacity ? 0.5 : Math.random() * 0.5,
      sizeStep: Math.random() * 0.1,
      opacityStep: Math.random() * 0.01,
      sizeDirection: -1,
      opacityDirection: -1,
      settings: group.settings,
    };
  };
  const addParticle = () => {
    if (particles.length >= targetParticleCount) return;
    // Largest proportional deficit interleaves the palette while retaining exact final counts.
    const next = particles.length + 1;
    let selected;
    let deficit = -Infinity;
    for (const group of groups) {
      const candidate =
        (next * group.count) / targetParticleCount - group.added;
      if (group.added < group.count && candidate > deficit) {
        selected = group;
        deficit = candidate;
      }
    }
    selected.added += 1;
    particles.push(createParticle(selected));
  };
  const resize = (size) => {
    width = size.width;
    height = size.height;
    edgePadding = Number.isFinite(size.edgePadding)
      ? Math.max(0, size.edgePadding)
      : 0;
    const scale = size.scale;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const densityUnits = Math.max(
      10,
      Math.min(70, Math.round((width * height * 35) / 800000))
    );
    targetParticleCount = densityUnits * 10;
    const light = Math.round(targetParticleCount * 0.6);
    const blue = Math.round(targetParticleCount * 0.3);
    groups = [
      {
        color: "#E8EEF4",
        count: light,
        added: 0,
        settings: { maxRadius: 15, animateSize: true, attract: true },
      },
      {
        color: "#005E88",
        count: blue,
        added: 0,
        settings: { maxRadius: 10, animateOpacity: true, attract: false },
      },
      {
        color: "#F58220",
        count: targetParticleCount - light - blue,
        added: 0,
        settings: { maxRadius: 15, animateSize: true, attract: true },
      },
    ];
    particles = [];
    for (let i = 0; i < (reducedMotion ? targetParticleCount : 3); i += 1)
      addParticle();
    lastFrame = 0;
    healthyFrames = 0;
    drawParticles(performance.now());
    report(getPerformance());
  };
  const drawParticles = (timestamp) => {
    if (!lastFrame || timestamp - lastFrame >= 40) {
      const started = performance.now();
      if (!reducedMotion && healthyFrames >= 3) addParticle();
      const frameScale = lastFrame
        ? Math.min((timestamp - lastFrame) / (1000 / 60), 15)
        : 0;
      const drawGap = lastFrame ? timestamp - lastFrame : 0;
      lastFrame = timestamp;
      const targetMix = phase === "mounting" ? 1 : 0;
      const step = reducedMotion ? 1 : Math.min(1, drawGap / 800);
      loadingMix = Math.max(
        0,
        Math.min(
          1,
          loadingMix +
            Math.sign(targetMix - loadingMix) *
              Math.min(step, Math.abs(targetMix - loadingMix))
        )
      );

      if (!reducedMotion && frameScale) {
        particles.forEach((particle) => {
          particle.x +=
            particle.vx * 0.25 * frameScale * (1 + loadingMix * 0.2);
          particle.y +=
            particle.vy * 0.25 * frameScale * (1 + loadingMix * 0.2);
          if (particle.settings.animateSize) {
            particle.radius +=
              particle.sizeDirection * particle.sizeStep * frameScale;
            if (particle.radius >= particle.settings.maxRadius)
              particle.sizeDirection = -1;
            if (particle.radius <= 0.1) particle.sizeDirection = 1;
            particle.radius = Math.max(
              0.1,
              Math.min(particle.settings.maxRadius, particle.radius)
            );
          }
          if (particle.settings.animateOpacity) {
            particle.alpha +=
              particle.opacityDirection * particle.opacityStep * frameScale;
            if (particle.alpha >= 0.5) particle.opacityDirection = -1;
            if (particle.alpha <= 0.1) particle.opacityDirection = 1;
            particle.alpha = Math.max(0.1, Math.min(0.5, particle.alpha));
          }
          const padding = edgePadding + 4 * loadingMix;
          const visibleRadius = particle.radius * (1 + loadingMix * 0.2);
          const minX = Math.min(padding + visibleRadius, width / 2);
          const maxX = Math.max(width - padding - visibleRadius, width / 2);
          const minY = Math.min(padding + visibleRadius, height / 2);
          const maxY = Math.max(height - padding - visibleRadius, height / 2);
          if (particle.x < minX || particle.x > maxX) {
            particle.vx *= -1;
            particle.x = Math.max(minX, Math.min(maxX, particle.x));
          }
          if (particle.y < minY || particle.y > maxY) {
            particle.vy *= -1;
            particle.y = Math.max(minY, Math.min(maxY, particle.y));
          }
        });

        const attracting = particles.filter(
          (particle) => particle.settings.attract
        );
        for (let index = 0; index < attracting.length; index += 1) {
          const particle = attracting[index];
          for (
            let otherIndex = index + 1;
            otherIndex < attracting.length;
            otherIndex += 1
          ) {
            const other = attracting[otherIndex];
            if (other.color !== particle.color) continue;
            const dx = other.x - particle.x;
            const dy = other.y - particle.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > 0 && distanceSquared <= 22500) {
              const ax = (dx * frameScale) / (3946 * 1000);
              const ay = (dy * frameScale) / (158 * 1000);
              particle.vx += ax;
              particle.vy += ay;
              other.vx -= ax;
              other.vy -= ay;
            }
          }
        }
      }

      context.clearRect(0, 0, width, height);
      particles.forEach((particle) => {
        context.globalAlpha =
          particle.alpha *
          (particle.loadingColor === particle.color ? 1 : 1 - loadingMix);
        context.fillStyle = particle.color;
        context.beginPath();
        context.arc(
          particle.x,
          particle.y,
          particle.radius * (1 + loadingMix * 0.2),
          0,
          Math.PI * 2
        );
        context.fill();
        if (particle.loadingColor !== particle.color && loadingMix > 0) {
          context.globalAlpha = particle.alpha * loadingMix;
          context.fillStyle = particle.loadingColor;
          context.fill();
        }
      });

      context.globalAlpha = 1;
      if (pointer) {
        particles.forEach((particle) => {
          if (particle.color !== "#005E88") {
            return;
          }
          const dx = pointer.x - particle.x;
          const dy = pointer.y - particle.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 200) {
            context.strokeStyle =
              "rgba(255, 255, 255, " + 0.2 * (1 - distance / 200) + ")";
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(particle.x, particle.y);
            context.lineTo(pointer.x, pointer.y);
            context.stroke();
          }
        });
      }
      context.globalAlpha = 1;
      const elapsed = performance.now() - started;
      const stats = measurement();
      stats.draws += 1;
      stats.maxDrawGapMs = Math.max(stats.maxDrawGapMs, drawGap);
      stats.drawMs += elapsed;
      stats.maxDrawMs = Math.max(stats.maxDrawMs, elapsed);
    }
  };

  const animate = () => {
    // Some Cast worker RAF timestamps use a different origin from performance.now().
    // Use one execution clock for initial draws, callbacks, motion and diagnostics.
    const timestamp = performance.now();
    animationFrame = 0;
    if (!running) return;
    if (lastAnimationFrame) {
      const elapsed = timestamp - lastAnimationFrame;
      const stats = measurement();
      stats.frames += 1;
      stats.frameMs += elapsed;
      stats.maxFrameMs = Math.max(stats.maxFrameMs, elapsed);
      if (elapsed > 50) stats.slowFrames += 1;
      healthyFrames = elapsed <= 40 ? healthyFrames + 1 : 0;
    }
    lastAnimationFrame = timestamp;
    drawParticles(timestamp);
    if (timestamp - lastReport >= 1000) {
      lastReport = timestamp;
      report(getPerformance());
    }
    if (!reducedMotion) animationFrame = clock.requestAnimationFrame(animate);
  };
  const setRunning = (value) => {
    if (running === value) return;
    running = value;
    if (!running) {
      clock.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      report(getPerformance());
    } else if (!reducedMotion) {
      lastFrame = 0;
      lastAnimationFrame = 0;
      healthyFrames = 0;
      animationFrame = clock.requestAnimationFrame(animate);
    }
  };
  resize(options);
  if (!reducedMotion) animationFrame = clock.requestAnimationFrame(animate);
  return {
    getPerformance,
    resize,
    setRunning,
    setPointer(value) {
      pointer = value;
    },
    setPhase(value) {
      if (!["startup", "mounting", "mounted", "unloaded"].includes(value))
        return;
      phase = value;
      if (reducedMotion) {
        loadingMix = phase === "mounting" ? 1 : 0;
        lastFrame = 0;
        drawParticles(performance.now());
      }
      lastAnimationFrame = 0;
      healthyFrames = 0;
      report(getPerformance());
    },
  };
}
