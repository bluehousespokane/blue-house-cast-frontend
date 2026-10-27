import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const template = readFileSync(
  new URL("../cast/src/html/receiver.html.template", import.meta.url),
  "utf8"
);
const particleSource = readFileSync(
  new URL("../cast/src/html/_loading_particles.js", import.meta.url),
  "utf8"
);
const bootstrap = template
  .match(/<script>\s*([\s\S]*?)<\/script>/)[1]
  .replace('<%= renderTemplate("./_loading_particles.js") %>', particleSource)
  .replace(
    '<%= renderTemplate("./_loading_screen.js") %>',
    readFileSync(
      new URL("../cast/src/html/_loading_screen.js", import.meta.url),
      "utf8"
    )
  );

test("inline JavaScript cannot collide with Lodash HTML interpolation", () => {
  assert.doesNotMatch(
    bootstrap,
    /\$\{/,
    "Lodash interprets JavaScript template expressions while generating HTML"
  );
});

function receiver({
  reducedMotion = false,
  canvasAvailable = true,
  animationTimestampOffset = 0,
  width = 1250,
  height = 1000,
} = {}) {
  let now = 0;
  let nextId = 0;
  let seed = 17;
  const frames = new Map();
  const timers = new Map();
  const draws = [];
  let frameDraws = [];
  const cover = { style: {}, hidden: false };
  const brightnessOverlay = {
    style: { opacity: "0" },
    addEventListener() {},
    removeEventListener() {},
  };
  const context = {
    setTransform() {},
    clearRect() {
      frameDraws = [];
    },
    beginPath() {},
    arc(x, y, radius) {
      this.circle = { x, y, radius };
    },
    fill() {
      const dot = {
        ...this.circle,
        color: this.fillStyle,
        alpha: this.globalAlpha,
      };
      draws.push(dot);
      frameDraws.push(dot);
    },
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  const canvas = {
    getContext: () => (canvasAvailable ? context : null),
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const window = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback) {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout(callback, delay) {
      timers.set(++nextId, { callback, due: now + delay });
      return nextId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener() {},
  };
  const math = Object.create(Math);
  math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  runInNewContext(bootstrap, {
    window,
    innerWidth: width,
    innerHeight: height,
    document: {
      getElementById: (id) => {
        if (id === "cast-loading-screen") return cover;
        if (id === "cast-brightness-overlay") return brightnessOverlay;
        return canvas;
      },
      addEventListener() {},
    },
    performance: { now: () => now },
    Math: math,
  });

  const advance = async (milliseconds) => {
    const until = now + milliseconds;
    while (now < until) {
      now = Math.min(now + 16, until);
      for (const [id, timer] of timers) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now + animationTimestampOffset);
      await Promise.resolve();
    }
  };
  return {
    api: window.blueHouseCastLoadingScreen,
    cover,
    brightnessOverlay,
    draws,
    frames,
    advance,
    frame: () => frameDraws,
    stall: (milliseconds) => {
      now += milliseconds;
    },
  };
}

test("draws three initial particles synchronously instead of paying for the whole field", () => {
  const { draws, api } = receiver();
  assert.equal(draws.length, 3);
  assert.equal(api.getPerformance().targetParticleCount, 550);
  assert.equal(api.getPerformance().particleCount, 3);
});

test("adds particles gradually and reaches the requested final proportions", async () => {
  const { api, advance, frame } = receiver();
  await advance(1000);
  assert.ok(api.getPerformance().particleCount > 3);
  assert.ok(api.getPerformance().particleCount < 30);
  await advance(28000);
  const draws = frame();
  assert.equal(draws.length, 550);
  assert.equal(draws.filter((dot) => dot.color === "#E8EEF4").length, 330);
  assert.equal(draws.filter((dot) => dot.color === "#005E88").length, 165);
  assert.equal(draws.filter((dot) => dot.color === "#F58220").length, 55);
});

test("fills the viewport while keeping each particle and its radius inside the safe edge", async () => {
  const edgePadding = 24;
  const { api, advance, frame } = receiver({ width: 960, height: 540 });
  assert.equal(api.getPerformance().targetParticleCount, 230);
  await advance(4000);
  const draws = frame();
  assert.ok(draws.length > 3);
  for (const particle of draws) {
    assert.ok(particle.x - particle.radius >= edgePadding);
    assert.ok(particle.x + particle.radius <= 960 - edgePadding);
    assert.ok(particle.y - particle.radius >= edgePadding);
    assert.ok(particle.y + particle.radius <= 540 - edgePadding);
  }
});

test("does not catch up with a particle burst after a long frame", async () => {
  const { api, advance, stall } = receiver();
  await advance(200);
  const before = api.getPerformance().particleCount;
  stall(1500);
  await advance(16);
  assert.equal(api.getPerformance().particleCount, before);
  await advance(64);
  assert.ok(api.getPerformance().particleCount <= before + 1);
});

test("keeps the original slow motion and independent size and opacity animation", async () => {
  const { draws, advance, frame } = receiver();
  const blueBefore = draws[1];
  const whiteBefore = draws[0];
  await advance(1000);
  const blueAfter = frame()[1];
  const whiteAfter = frame()[0];
  assert.ok(Math.abs(blueAfter.x - blueBefore.x) < 8);
  assert.notEqual(blueAfter.x, blueBefore.x);
  assert.notEqual(blueAfter.alpha, blueBefore.alpha);
  assert.notEqual(whiteAfter.radius, whiteBefore.radius);
});

test("holds for two seconds then reveals through a feathered circle over five seconds", async () => {
  const { api, cover, advance } = receiver();
  api.scheduleReveal();
  await advance(1900);
  assert.equal(cover.hidden, false);
  assert.equal(cover.style.maskImage, undefined);
  await advance(1100);
  assert.match(cover.style.maskImage, /^radial-gradient\(circle at center,/);
  assert.equal(cover.hidden, false);
  await advance(4100);
  assert.equal(cover.hidden, true);
});

test("can cover, hold, and reveal repeatedly without a stale timer winning", async () => {
  const { api, cover, advance } = receiver();
  const firstReveal = api.hide();
  await advance(5100);
  assert.equal(await firstReveal, true);
  const show = api.show(true);
  await advance(5100);
  assert.equal(await show, true);
  assert.equal(cover.style.maskImage, "none");
  api.scheduleReveal();
  await advance(3000);
  assert.equal(cover.hidden, false);
  const interrupted = api.hide();
  await advance(1000);
  const coverAgain = api.show(true);
  await advance(5100);
  assert.equal(await interrupted, false);
  assert.equal(await coverAgain, true);
  await advance(6000);
  assert.equal(cover.hidden, false);
  assert.equal(cover.style.maskImage, "none");
});

test("reduced motion skips animation and canvas failure does not disable the cover", async () => {
  for (const canvasAvailable of [true, false]) {
    const { api, cover, frames } = receiver({
      reducedMotion: true,
      canvasAvailable,
    });
    assert.equal(frames.size, 0);
    assert.equal(await api.hide(), true);
    assert.equal(cover.hidden, true);
    assert.equal(await api.show(), true);
    assert.equal(cover.hidden, false);
    assert.equal(frames.size, 0);
  }
});

test("animates brightness, reports its target, and cancels an interrupted transition", async () => {
  const { api, advance, brightnessOverlay } = receiver();
  assert.equal(api.getBrightness(), 100);
  assert.equal(await api.setBrightness(101), false);
  assert.equal(brightnessOverlay.style.opacity, "0");

  const first = api.setBrightness(30);
  assert.equal(api.getBrightness(), 30);
  assert.equal(brightnessOverlay.style.opacity, "0.7");
  await advance(200);
  const second = api.setBrightness(60);
  assert.equal(await first, false);
  assert.equal(api.getBrightness(), 60);
  assert.equal(brightnessOverlay.style.opacity, "0.4");
  await advance(699);
  await advance(51);
  assert.equal(await second, true);
  assert.equal(await api.setBrightness(60), true);
});

test("applies brightness immediately when reduced motion is enabled", async () => {
  const { api, brightnessOverlay, frames } = receiver({ reducedMotion: true });
  assert.equal(await api.setBrightness(25), true);
  assert.equal(api.getBrightness(), 25);
  assert.equal(brightnessOverlay.style.opacity, "0.75");
  assert.equal(frames.size, 0);
});

test("scales particle density while capping Google TV work and preserving the palette", async () => {
  const { frame } = receiver({
    reducedMotion: true,
    width: 3840,
    height: 2160,
  });
  const draws = frame();
  assert.equal(draws.length, 700);
  assert.equal(draws.filter((dot) => dot.color === "#E8EEF4").length, 420);
  assert.equal(draws.filter((dot) => dot.color === "#005E88").length, 210);
  assert.equal(draws.filter((dot) => dot.color === "#F58220").length, 70);
});

test("loading morphs existing particles to the loading palette and back", () => {
  const { api, frame } = receiver({ reducedMotion: true });
  const initial = frame()
    .map(({ x, y }) => `${x},${y}`)
    .sort();
  api.setPhase("mounting");
  const loading = frame().filter((dot) => dot.alpha > 0);
  assert.equal(loading.length, 550);
  assert.equal(loading.filter((dot) => dot.color === "#E8EEF4").length, 110);
  assert.equal(loading.filter((dot) => dot.color === "#005E88").length, 330);
  assert.equal(loading.filter((dot) => dot.color === "#F58220").length, 110);
  assert.deepEqual(loading.map(({ x, y }) => `${x},${y}`).sort(), initial);
  api.setPhase("unloaded");
  assert.equal(frame().filter((dot) => dot.color === "#E8EEF4").length, 330);
});

test("loading palette fades in and out without replacing particles", async () => {
  const { api, advance, frame } = receiver();
  await advance(28000);
  const count = api.getPerformance().particleCount;
  api.setPhase("mounting");
  await advance(200);
  assert.ok(frame().length > count);
  await advance(900);
  assert.equal(api.getPerformance().particleCount, count);
  assert.equal(
    frame().filter((dot) => dot.color === "#005E88" && dot.alpha > 0).length,
    330
  );
  api.setPhase("unloaded");
  await advance(900);
  assert.equal(
    frame().filter((dot) => dot.color === "#E8EEF4" && dot.alpha > 0).length,
    330
  );
  assert.equal(api.getPerformance().particleCount, count);
});

test("loading state jumps in over 200ms and returns over 800ms", async () => {
  const { api, advance } = receiver();
  await advance(800);
  api.setPhase("mounting");
  await advance(112);
  assert.ok(api.getPerformance().loadingMix > 0.7);
  await advance(112);
  assert.equal(api.getPerformance().loadingMix, 1);
  api.setPhase("mounted");
  await advance(400);
  assert.ok(api.getPerformance().loadingMix > 0.45);
  assert.ok(api.getPerformance().loadingMix < 0.6);
  await advance(450);
  assert.equal(api.getPerformance().loadingMix, 0);
});

test("loading palette is visible before the particle field has filled", async () => {
  const { api, advance, frame } = receiver();
  await advance(800);
  assert.ok(api.getPerformance().particleCount < 50);
  api.setPhase("mounting");
  await advance(1000);
  const active = frame().filter((dot) => dot.alpha > 0);
  const white = active.filter((dot) => dot.color === "#E8EEF4").length;
  const blue = active.filter((dot) => dot.color === "#005E88").length;
  const orange = active.filter((dot) => dot.color === "#F58220").length;
  assert.ok(blue > white);
  assert.ok(orange >= 2);
});

test("loading palette remains through settling and fades when reveal begins", async () => {
  const { api, advance, frame } = receiver();
  await advance(800);
  api.setPhase("mounting");
  await advance(1000);
  api.scheduleReveal();
  await advance(1500);
  let active = frame().filter((dot) => dot.alpha > 0);
  assert.ok(
    active.filter((dot) => dot.color === "#005E88").length >
      active.filter((dot) => dot.color === "#E8EEF4").length
  );
  await advance(1500);
  active = frame().filter((dot) => dot.alpha > 0);
  assert.ok(
    active.filter((dot) => dot.color === "#E8EEF4").length >
      active.filter((dot) => dot.color === "#005E88").length
  );
});

test("covering starts promptly and still completes over five seconds", async () => {
  const { api, cover, advance } = receiver();
  const opening = api.hide();
  await advance(5000);
  assert.equal(await opening, true);
  const outerRadius = () =>
    Number(cover.style.maskImage.match(/([\d.]+)px\)$/)[1]);
  const initialRadius = outerRadius();
  const closing = api.show();
  await advance(500);
  assert.ok(outerRadius() < initialRadius * 0.8);
  assert.equal(cover.hidden, false);
  await advance(4500);
  assert.equal(await closing, true);
  assert.equal(cover.style.maskImage, "none");
});

test("profiles frame gaps by phase without counting hidden time as animation work", async () => {
  const { api, advance } = receiver();
  await advance(200);
  api.setPhase("mounting");
  await advance(200);
  const hide = api.hide();
  await advance(5000);
  await hide;
  const before = api.getPerformance();
  await advance(10000);
  assert.deepEqual(api.getPerformance(), before);
  const show = api.show();
  await advance(5000);
  await show;
  api.setPhase("unloaded");
  await advance(200);
  const profile = api.getPerformance();
  assert.equal(profile.targetParticleCount, 550);
  assert.ok(profile.particleCount > 3 && profile.particleCount <= 550);
  assert.ok(profile.phases.startup.frames > 0);
  assert.ok(profile.phases.mounting.draws > 0);
  assert.ok(profile.phases.unloaded.frames > 0);
  assert.ok(profile.phases.mounting.maxFrameMs <= 16);
});

test("starts SDK and app loading only after the loading screen can paint", async () => {
  const scripts = [...template.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)];
  const startup = scripts[1][1]
    .replace(/<% for[^%]*%>/g, "")
    .replace(/<% } %>/g, "")
    .replace(/<%= entry %>/g, "/app.js");
  const frames = [];
  const appended = [];
  runInNewContext(startup, {
    window: { blueHouseCastLoadingScreen: { ready: Promise.resolve() } },
    requestAnimationFrame: (callback) => frames.push(callback),
    document: {
      createElement: () => ({}),
      body: { appendChild: (element) => appended.push(element) },
    },
  });
  await Promise.resolve();
  assert.equal(appended.length, 0);
  frames.shift()();
  assert.equal(appended.length, 0);
  frames.shift()();
  assert.equal(appended.length, 1);
  assert.match(appended[0].src, /cast_receiver_framework.js$/);
  appended[0].onload();
  assert.equal(appended[1].type, "module");
  assert.equal(appended[1].src, "/app.js");
});

test("uses one execution clock when worker RAF timestamps have a different origin", async () => {
  const { api, advance } = receiver({ animationTimestampOffset: 28000000 });
  await advance(1000);
  const profile = api.getPerformance();
  assert.ok(profile.particleCount > 3 && profile.particleCount < 30);
  assert.ok(profile.phases.startup.maxDrawGapMs <= 50);
  assert.ok(profile.phases.startup.maxFrameMs <= 16);
});
