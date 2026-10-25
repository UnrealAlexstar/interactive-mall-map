/**
 * scripts/perf-experiment.mjs — Compare the cost of different rendering options.
 *
 * Usage:  node scripts/perf-experiment.mjs [url]
 *
 * The prototype slows down while the camera moves. This script measures the
 * frame rate of the *same* scene with individual features switched off, so we
 * can see what actually costs what instead of guessing. The camera is moved with
 * a real mouse drag, exactly like a user would, so OrbitControls reports the
 * change through its normal path.
 *
 * Measured configurations (render scale fixed at 1x unless noted):
 *   baseline            — everything on (as shipped)
 *   no labels           — the WebGL label pass is disabled
 *   labels + ratio 2    — labels on, canvas rendered at 2x pixel ratio
 *   no shadows          — the shadow map is not rendered at all
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

  // Фиксируем масштаб рендеринга, чтобы динамическое разрешение не менялось
  // между прогонами и сравнение конфигураций было честным.
  await page.evaluate(() => {
    const app = window.mallMap;
    app.resolutionScaler.update = () => false;
    app.renderer.setPixelRatio(1);

    window.__x = { calls: 0, triangles: 0 };
    const render = app.renderer.render.bind(app.renderer);
    app.renderer.render = (...args) => {
      render(...args);
      // Подписи рисуются вторым проходом и сбрасывают info.render, поэтому
      // статистику снимаем после основного прохода сцены.
      if (args[0] === app.scene) {
        const info = app.renderer.info.render;
        window.__x.calls = info.calls;
        window.__x.triangles = info.triangles;
      }
    };
  });

  /**
   * Rotate the camera with a real drag for `duration` ms and report the
   * achieved frame rate plus the main-pass draw statistics.
   */
  async function measure(duration = 2500) {
    await page.evaluate(() => {
      window.__x.calls = 0;
      window.__x.triangles = 0;
      window.__rafTimes = [];
      window.__rafStop = false;
      requestAnimationFrame(function tick(t) {
        window.__rafTimes.push(t);
        if (!window.__rafStop) requestAnimationFrame(tick);
      });
    });

    await page.mouse.move(800, 500);
    await page.mouse.down();
    const start = Date.now();
    let step = 0;
    while (Date.now() - start < duration) {
      const angle = step / 14;
      await page.mouse.move(800 + Math.cos(angle) * 220, 500 + Math.sin(angle) * 80);
      step++;
      await new Promise((r) => setTimeout(r, 16));
    }
    await page.mouse.up();

    return page.evaluate(() => {
      window.__rafStop = true;
      const ts = window.__rafTimes;
      const intervals = [];
      for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
      intervals.sort((a, b) => a - b);
      const n = Math.max(intervals.length, 1);
      const elapsed = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0;
      return {
        fps: elapsed > 0 ? (1000 * (ts.length - 1)) / elapsed : 0,
        frames: n,
        ms: elapsed / n,
        calls: window.__x.calls,
        triangles: window.__x.triangles
      };
    });
  }

  const results = [];

  async function run(name, setup) {
    if (setup) await setup();
    await new Promise((r) => setTimeout(r, 400));
    const result = await measure();
    results.push({ name, ...result });
  }

  await run('warm-up');
  await run('baseline');
  await run('no labels', async () => {
    await page.evaluate(() => window.mallMap.labels.setVisible(false));
  });
  await run('labels + ratio 2', async () => {
    await page.evaluate(() => {
      window.mallMap.labels.setVisible(true);
      window.mallMap.renderer.setPixelRatio(2);
    });
  });
  await run('no shadows', async () => {
    await page.evaluate(() => {
      window.mallMap.renderer.setPixelRatio(1);
      window.mallMap.renderer.shadowMap.enabled = false;
      window.mallMap.scene.traverse((o) => {
        if (o.isMesh) o.material.needsUpdate = true;
      });
    });
  });

  // Warm-up is useful for the page but must not skew the comparison.
  results.shift();
  const baseline = results[0];

  console.log('\n=== Frame rate while orbiting (1600 x 1000, software renderer) ===');
  console.log('  configuration          FPS    ms/frame   draw calls   triangles   vs baseline');
  console.log('  ' + '-'.repeat(82));
  for (const r of results) {
    const delta = ((r.fps - baseline.fps) / Math.max(baseline.fps, 0.001)) * 100;
    const sign = delta >= 0 ? '+' : '';
    console.log(
      `  ${r.name.padEnd(22)}${r.fps.toFixed(1).padStart(5)}   ${r.ms.toFixed(1).padStart(8)}   ` +
        `${String(r.calls).padStart(10)}   ${String(r.triangles).padStart(9)}   ${sign}${delta.toFixed(0)}%`
    );
  }
} finally {
  await browser.close();
}
