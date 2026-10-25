/**
 * scripts/perf-labels.mjs — Measure the cost of the WebGL label pass and prove
 * that nothing is redrawn while the scene is idle.
 *
 * Usage:  node scripts/perf-labels.mjs [url]
 *
 * Labels are sprites with cached `CanvasTexture`; the CPU work per frame is just
 * projecting anchors and moving quads. The interesting question is therefore how
 * much the extra WebGL pass and the label textures cost while the camera moves,
 * and whether the render-on-demand loop really stops drawing when nothing
 * changes.
 *
 * Measured:
 *   labels on   — normal application
 *   labels off  — same camera motion, `labels.setVisible(false)`
 *   idle        — camera untouched, count renderer.render() calls for 1.5 s
 */

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5199/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 300000,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,1000'
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('canvas.mall-canvas', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  await page.evaluate(() => {
    const app = window.mallMap;

    // Фиксируем разрешение: иначе динамический масштаб меняется между прогонами
    // и сравнение «подписи вкл/выкл» перестаёт быть честным.
    app.resolutionScaler.update = () => false;
    app.renderer.setPixelRatio(1);

    window.__p = { labelMs: 0, renderMs: 0, renderCalls: 0 };
    const labelRender = app.labels.render.bind(app.labels);
    app.labels.render = (...args) => {
      const t0 = performance.now();
      const result = labelRender(...args);
      window.__p.labelMs += performance.now() - t0;
      return result;
    };
    const render = app.renderer.render.bind(app.renderer);
    app.renderer.render = (...args) => {
      const t0 = performance.now();
      render(...args);
      app.renderer.getContext().finish();
      window.__p.renderMs += performance.now() - t0;
      window.__p.renderCalls++;
    };
  });

  async function measure(name, labelsVisible) {
    // Готовим состояние и счётчики, затем крутим камеру настоящим
    // перетаскиванием мышью: так OrbitControls сам сообщает об изменениях,
    // и оба режима (подписи вкл/выкл) проходят через один и тот же путь.
    await page.evaluate((visible) => {
      window.mallMap.labels.setVisible(visible);
      window.__p.labelMs = 0;
      window.__p.renderMs = 0;
      window.__p.renderCalls = 0;
      window.__rafTimes = [];
      window.__rafStop = false;
      requestAnimationFrame(function tick(t) {
        window.__rafTimes.push(t);
        if (!window.__rafStop) requestAnimationFrame(tick);
      });
    }, labelsVisible);

    await page.mouse.move(800, 500);
    await page.mouse.down();
    const start = Date.now();
    let step = 0;
    while (Date.now() - start < 3000) {
      const angle = step / 14;
      await page.mouse.move(800 + Math.cos(angle) * 220, 500 + Math.sin(angle) * 80);
      step++;
      await new Promise((r) => setTimeout(r, 16));
    }
    await page.mouse.up();

    const result = await page.evaluate(() => {
      window.__rafStop = true;
      const ts = window.__rafTimes;
      const intervals = [];
      for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
      intervals.sort((a, b) => a - b);
      const n = Math.max(intervals.length, 1);
      const elapsed = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0;
      return {
        fps: elapsed > 0 ? (1000 * (ts.length - 1)) / elapsed : 0,
        msPerFrame: elapsed / n,
        p95: intervals[Math.floor(n * 0.95)] ?? 0,
        labelMs: window.__p.labelMs / n,
        renderMs: window.__p.renderMs / n,
        renderCalls: window.__p.renderCalls,
        frames: n
      };
    });

    console.log(
      `  ${name.padEnd(12)} FPS: ${result.fps.toFixed(1).padStart(5)}   ` +
        `ms/frame: ${result.msPerFrame.toFixed(1).padStart(6)}   ` +
        `p95: ${result.p95.toFixed(1).padStart(6)}   ` +
        `labels CPU: ${result.labelMs.toFixed(2)}   ` +
        `render: ${result.renderMs.toFixed(2)} ms`
    );
    return result;
  }

  console.log('\n=== Labels while the camera orbits (1600 x 1000, software renderer) ===');
  const on = await measure('labels on', true);
  const off = await measure('labels off', false);
  const onAgain = await measure('labels on', true);

  const onMs = (on.msPerFrame + onAgain.msPerFrame) / 2;
  const onRender = (on.renderMs + onAgain.renderMs) / 2;
  console.log(
    `\n  orbit average (two runs): labels on ${onMs.toFixed(1)} ms/frame, ` +
      `labels off ${off.msPerFrame.toFixed(1)} ms/frame → ` +
      `${(((onMs - off.msPerFrame) / Math.max(off.msPerFrame, 1)) * 100).toFixed(0)}% overhead`
  );
  console.log(
    `  renderer.render cost: ${onRender.toFixed(2)} ms/frame with labels, ` +
      `${off.renderMs.toFixed(2)} ms/frame without`
  );

  const idle = await page.evaluate(async () => {
    const app = window.mallMap;
    app.labels.setVisible(true);

    // После перетаскивания OrbitControls ещё некоторое время гасит инерцию —
    // ждём, пока камера окончательно успокоится, и только потом считаем.
    let last = window.__p.renderCalls;
    const settleStart = performance.now();
    while (performance.now() - settleStart < 5000) {
      await new Promise((r) => setTimeout(r, 200));
      if (window.__p.renderCalls === last) break;
      last = window.__p.renderCalls;
    }

    window.__p.renderCalls = 0;
    const start = performance.now();
    await new Promise((r) => setTimeout(r, 1500));
    return { calls: window.__p.renderCalls, ms: performance.now() - start };
  });

  console.log(
    `\n=== Idle ===\n  renderer.render calls in ${(idle.ms / 1000).toFixed(1)} s: ${idle.calls}` +
      (idle.calls === 0 ? '  (no repaints — no flicker)' : '')
  );
} finally {
  await browser.close();
}
