const PARTICLE_EDGE_PADDING = 24;

(() => {
  const loader = document.getElementById("cast-loading-screen");
  const brightnessOverlay = document.getElementById("cast-brightness-overlay");
  const vignetteOverlay = document.getElementById("cast-vignette-overlay");
  let canvas = document.getElementById("cast-loading-particles");
  let desktop = "particles";
  let settingsVersion = 0;
  let cachedBrightnessPct = 100;
  try {
    const cachedSettings = JSON.parse(
      localStorage.getItem("blue-house-cast-settings-v1") || "{}"
    );
    if (
      cachedSettings.desktop === "particles" ||
      cachedSettings.desktop === "black"
    ) {
      desktop = cachedSettings.desktop;
      settingsVersion = Number(cachedSettings.settingsVersion) || 0;
      if (
        Number.isInteger(cachedSettings.brightnessPct) &&
        cachedSettings.brightnessPct >= 0 &&
        cachedSettings.brightnessPct <= 100
      ) {
        cachedBrightnessPct = cachedSettings.brightnessPct;
      }
      if (canvas) canvas.hidden = desktop === "black";
      if (vignetteOverlay && Number.isFinite(cachedSettings.vignetteSize)) {
        vignetteOverlay.style.setProperty(
          "--vignette-size",
          Math.max(0, cachedSettings.vignetteSize) + "px"
        );
      }
    }
  } catch {
    // Invalid cache is ignored; Home Assistant remains the settings owner.
  }
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  if (!loader) {
    return;
  }

  const listeners = new Set();
  let revealTimer = 0;
  let transitionGeneration = 0;
  let transitionFrame = 0;
  let finishTransition;
  let openness = 0;
  let visible = true;
  let held = false;
  let particlePhase = "startup";
  let brightnessPct = cachedBrightnessPct;
  if (brightnessOverlay && brightnessPct !== 100) {
    brightnessOverlay.style.transitionDuration = "0ms";
    brightnessOverlay.style.opacity = String((100 - brightnessPct) / 100);
    window.requestAnimationFrame(() =>
      brightnessOverlay.style.removeProperty("transition-duration")
    );
  }
  let brightnessGeneration = 0;
  let finishBrightnessTransition;
  let brightnessTransitionPromise = Promise.resolve(true);
  let renderer;
  let worker;
  let particlePerformance = {
    renderer: "main",
    particleCount: 0,
    targetParticleCount: 0,
    phases: {},
  };
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const sendParticles = (method, value) => {
    if (worker) worker.postMessage({ method, value });
    else renderer?.[method](value);
  };
  const getPerformance = () =>
    renderer?.getPerformance() || particlePerformance;

  const setBrightness = (value) => {
    if (
      !brightnessOverlay ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      return Promise.resolve(false);
    }
    if (value === brightnessPct) {
      return brightnessTransitionPromise;
    }

    const generation = ++brightnessGeneration;
    finishBrightnessTransition?.(false);
    brightnessPct = value;

    brightnessTransitionPromise = new Promise((resolve) => {
      let timeout = 0;
      const finish = (completed) => {
        brightnessOverlay.removeEventListener("transitionend", onEnd);
        window.clearTimeout(timeout);
        if (generation === brightnessGeneration) {
          finishBrightnessTransition = undefined;
        }
        resolve(completed);
      };
      const onEnd = (event) => {
        if (
          event.target === brightnessOverlay &&
          event.propertyName === "opacity"
        ) {
          finish(true);
        }
      };
      brightnessOverlay.addEventListener("transitionend", onEnd);
      finishBrightnessTransition = finish;
      brightnessOverlay.style.opacity = String((100 - value) / 100);
      if (reducedMotion) {
        finish(true);
        return;
      }
      timeout = window.setTimeout(() => finish(true), 750);
    });
    return brightnessTransitionPromise;
  };

  const notifyVisibility = () => {
    listeners.forEach((listener) => listener(visible));
  };

  // Mask the whole layer so its particles leave with the black cover.
  const applyMask = () => {
    if (openness === 0) {
      loader.style.maskImage = "none";
      loader.style.webkitMaskImage = "none";
      return;
    }
    const feather = innerWidth * 0.75;
    const radius =
      openness * (Math.hypot(innerWidth / 2, innerHeight / 2) + feather);
    const inner = radius - feather;
    const start = Math.max(0, -inner / feather);
    const stops = Array.from({ length: 49 }, (_, index) => {
      const t = start + ((1 - start) * index) / 48;
      const alpha = t * t * t * (t * (t * 6 - 15) + 10);
      const px = Math.max(0, inner + t * feather);
      return "rgba(0,0,0," + alpha.toFixed(6) + ") " + px.toFixed(2) + "px";
    });
    const mask = "radial-gradient(circle at center, " + stops.join(",") + ")";
    loader.style.maskImage = mask;
    loader.style.webkitMaskImage = mask;
  };

  const transitionTo = (target, duration) => {
    if (openness === target && !finishTransition) {
      return Promise.resolve(true);
    }
    const generation = ++transitionGeneration;
    window.cancelAnimationFrame(transitionFrame);
    finishTransition?.(false);
    const from = openness;
    loader.hidden = false;
    visible = true;
    notifyVisibility();
    sendParticles(
      "setRunning",
      desktop === "particles" && document.visibilityState !== "hidden"
    );

    return new Promise((resolve) => {
      const finish = (completed) => {
        if (generation === transitionGeneration) {
          finishTransition = undefined;
        }
        resolve(completed);
      };
      finishTransition = finish;
      const started = performance.now();
      const frame = (now) => {
        if (generation !== transitionGeneration) return;
        const t = reducedMotion
          ? 1
          : Math.min((now - started) / Math.max(1, duration), 1);
        // Start both directions promptly, then ease into their final state.
        const progress = 1 - (1 - t) ** 3;
        openness = from + (target - from) * progress;
        applyMask();
        if (t < 1) {
          transitionFrame = window.requestAnimationFrame(frame);
          return;
        }
        visible = target === 0;
        loader.hidden = !visible;
        sendParticles(
          "setRunning",
          desktop === "particles" &&
            visible &&
            document.visibilityState !== "hidden"
        );
        notifyVisibility();
        finish(true);
      };
      if (reducedMotion || from === target) frame(started + duration);
      else transitionFrame = window.requestAnimationFrame(frame);
    });
  };

  const show = (hold = true) => {
    held = hold;
    window.clearTimeout(revealTimer);
    return transitionTo(0, 5000);
  };

  const hide = () => {
    held = false;
    window.clearTimeout(revealTimer);
    return transitionTo(1, 5000);
  };

  // A hidden Cast document may stop receiving animation frames. Cover it
  // synchronously before releasing dashboard resources in that case.
  const coverImmediately = () => {
    held = true;
    window.clearTimeout(revealTimer);
    const generation = ++transitionGeneration;
    window.cancelAnimationFrame(transitionFrame);
    finishTransition?.(false);
    finishTransition = undefined;
    openness = 0;
    loader.hidden = false;
    loader.style.maskImage = "none";
    loader.style.webkitMaskImage = "none";
    visible = true;
    sendParticles("setRunning", false);
    notifyVisibility();
  };

  const scheduleReveal = () => {
    if (held || !visible) {
      return;
    }
    window.clearTimeout(revealTimer);
    revealTimer = window.setTimeout(() => void hide(), 2000);
  };

  window.blueHouseCastLoadingScreen = {
    show,
    hide,
    coverImmediately,
    setDesktop(nextDesktop, nextSettingsVersion) {
      if (
        (nextDesktop !== "particles" && nextDesktop !== "black") ||
        !Number.isInteger(nextSettingsVersion) ||
        nextSettingsVersion < settingsVersion
      ) {
        return false;
      }
      desktop = nextDesktop;
      settingsVersion = nextSettingsVersion;
      if (canvas) canvas.hidden = desktop === "black";
      sendParticles(
        "setRunning",
        desktop === "particles" &&
          visible &&
          document.visibilityState !== "hidden"
      );
      return true;
    },
    getDesktop: () => desktop,
    getVignette: () => {
      const value = vignetteOverlay?.style.getPropertyValue("--vignette-size");
      return value ? Math.max(0, Number.parseFloat(value) || 0) : 0;
    },
    getSettingsVersion: () => settingsVersion,
    setVignette(size) {
      if (!Number.isInteger(size) || size < 0 || !vignetteOverlay) return false;
      vignetteOverlay.style.setProperty("--vignette-size", size + "px");
      return true;
    },
    scheduleReveal,
    ready,
    getPerformance,
    setBrightness,
    getBrightness: () => brightnessPct,
    setPhase(nextPhase) {
      particlePhase = nextPhase;
      sendParticles("setPhase", nextPhase);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(visible);
      return () => listeners.delete(listener);
    },
  };
  window.addEventListener("cast-loading-ready", scheduleReveal);
  window.addEventListener("cast-loading-error", () => void hide());

  if (!canvas) {
    resolveReady();
    return;
  }
  const dimensions = () => ({
    width: innerWidth,
    height: innerHeight,
    edgePadding: PARTICLE_EDGE_PADDING,
    scale: Math.min(window.devicePixelRatio || 1, 1.25),
    reducedMotion,
  });
  const bindPointer = () => {
    canvas.addEventListener("pointermove", (event) => {
      const bounds = canvas.getBoundingClientRect();
      sendParticles("setPointer", {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    });
    canvas.addEventListener("pointerleave", () =>
      sendParticles("setPointer", undefined)
    );
  };
  const startMainRenderer = () => {
    renderer = createCastParticleRenderer(
      canvas,
      { ...dimensions(), renderer: "main" },
      () => {},
      window
    );
    renderer?.setPhase(particlePhase);
    renderer?.setRunning(
      desktop === "particles" &&
        visible &&
        document.visibilityState !== "hidden"
    );
    bindPointer();
    resolveReady();
  };
  if (
    !reducedMotion &&
    typeof Worker === "function" &&
    typeof canvas.transferControlToOffscreen === "function"
  ) {
    let transferred = false;
    let workerUrl;
    let startupTimeout;
    const fallback = () => {
      if (!worker) return;
      worker.terminate();
      worker = undefined;
      window.clearTimeout(startupTimeout);
      URL.revokeObjectURL(workerUrl);
      if (transferred) {
        const replacement = canvas.cloneNode(false);
        canvas.replaceWith(replacement);
        canvas = replacement;
      }
      startMainRenderer();
    };
    try {
      const source =
        "(" +
        function (startRenderer) {
          let renderer;
          self.onmessage = ({ data }) => {
            if (data.method === "init") {
              if (typeof self.requestAnimationFrame !== "function") {
                self.postMessage({ error: true });
                return;
              }
              renderer = startRenderer(data.canvas, data.options, (profile) =>
                self.postMessage({ profile })
              );
              self.postMessage({ ready: !!renderer });
            } else renderer?.[data.method](data.value);
          };
        }.toString() +
        ")(" +
        createCastParticleRenderer.toString() +
        ");";
      workerUrl = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" })
      );
      worker = new Worker(workerUrl);
      worker.onerror = (event) => {
        event.preventDefault();
        fallback();
      };
      worker.onmessage = ({ data }) => {
        if (data.profile) particlePerformance = data.profile;
        if (data.error || data.ready === false) {
          fallback();
          return;
        }
        if (data.ready) {
          window.clearTimeout(startupTimeout);
          URL.revokeObjectURL(workerUrl);
          sendParticles(
            "setRunning",
            desktop === "particles" &&
              visible &&
              document.visibilityState !== "hidden"
          );
          resolveReady();
        }
      };
      const offscreen = canvas.transferControlToOffscreen();
      transferred = true;
      bindPointer();
      worker.postMessage(
        {
          method: "init",
          canvas: offscreen,
          options: { ...dimensions(), renderer: "worker" },
        },
        [offscreen]
      );
      startupTimeout = window.setTimeout(fallback, 1500);
    } catch {
      if (worker) fallback();
      else {
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        startMainRenderer();
      }
    }
  } else startMainRenderer();
  window.addEventListener(
    "resize",
    () => sendParticles("resize", dimensions()),
    { passive: true }
  );
  document.addEventListener("visibilitychange", () =>
    sendParticles(
      "setRunning",
      desktop === "particles" &&
        visible &&
        document.visibilityState !== "hidden"
    )
  );
  window.addEventListener("pagehide", () => {
    sendParticles("setRunning", false);
    worker?.terminate();
  });
})();
