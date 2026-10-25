import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const template = readFileSync(
  new URL("../cast/src/html/receiver.html.template", import.meta.url),
  "utf8"
);
const bootstrap = template.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

function receiver({
  reducedMotion = false,
  canvasAvailable = true,
  width = 1250,
  height = 1000,
} = {}) {
  let now = 0;
  let nextId = 0;
  let seed = 17;
  const frames = new Map();
  const timers = new Map();
  const draws = [];
  const cover = { style: {}, hidden: false };
  const context = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    arc(x, y, radius) {
      this.circle = { x, y, radius };
    },
    fill() {
      draws.push({
        ...this.circle,
        color: this.fillStyle,
        alpha: this.globalAlpha,
      });
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
      getElementById: (id) => (id === "cast-loading-screen" ? cover : canvas),
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
      for (const callback of pending) callback(now);
      await Promise.resolve();
    }
  };
  return {
    api: window.blueHouseCastLoadingScreen,
    cover,
    draws,
    frames,
    advance,
  };
}

test("draws the requested particle proportions before any asynchronous work", () => {
  const { draws, api } = receiver();
  assert.ok(api);
  assert.equal(draws.length, 350);
  assert.equal(draws.filter((dot) => dot.color === "#E8EEF4").length, 210);
  assert.equal(draws.filter((dot) => dot.color === "#005E88").length, 105);
  assert.equal(draws.filter((dot) => dot.color === "#F58220").length, 35);
  assert.ok(Math.max(...draws.map((dot) => dot.radius)) > 14);
  assert.ok(
    draws
      .filter((dot) => dot.color === "#005E88")
      .every((dot) => dot.alpha === 0.5)
  );
});

test("keeps the original slow motion and independent size and opacity animation", async () => {
  const { draws, advance } = receiver();
  const blueBefore = draws[210];
  const whiteBefore = draws[0];
  await advance(1000);
  const blueAfter = draws.at(-140);
  const whiteAfter = draws.at(-350);
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
  await advance(700);
  assert.equal(await show, true);
  assert.equal(cover.style.maskImage, "none");
  api.scheduleReveal();
  await advance(3000);
  assert.equal(cover.hidden, false);
  const interrupted = api.hide();
  await advance(1000);
  const coverAgain = api.show(true);
  await advance(700);
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

test("scales particle density while capping Google TV work and preserving the palette", () => {
  const { draws } = receiver({ width: 3840, height: 2160 });
  assert.equal(draws.length, 700);
  assert.equal(draws.filter((dot) => dot.color === "#E8EEF4").length, 420);
  assert.equal(draws.filter((dot) => dot.color === "#005E88").length, 210);
  assert.equal(draws.filter((dot) => dot.color === "#F58220").length, 70);
});
