/**
 * scripts/perf-check.mjs — Measure the frame cost while the camera is moving.
 *
 * Usage:  node scripts/perf-check.mjs [url]
 *
 * The prototype is interactive, so the interesting number is not the idle frame
 * rate but the frame rate *while the camera moves*. The script therefore
 * orbits the camera continuously for a couple of seconds and reports:
 *
 *   - frames rendered and the resulting FPS
 *   - the average wall-clock time of one animation frame
 *   - how much of that time is spent in the label update (DOM work)
 *   - how much is spent inside the WebGL render call
 *   - the number of draw calls and triangles
 *
 * NOTE: a headless browser renders with SwiftShader (software rasterisation),
 * so the absolute FPS here is much lower than on a real GPU. The *relative*
 * effect of an optimisation and the CPU-side timings are still meaningful.
 */

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5199/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
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

  // Instrument the hot functions of the running application.
  await page.evaluate(() => {
    const app = window.mallMap;
    window.__perf = {
      labelMs: 0,
      renderMs: 0,
      frames: 0,
      calls: 0,
      triangles: 0
    };

    const originalUpdate = app.labels.update.bind(app.labels);
    app.labels.update = (...args) => {
      const t0 = performance.now();
      originalUpdate(...args);
      window.__perf.labelMs += performance.now() - t0;
    };

    const originalRender = app.renderer.render.bind(app.renderer);
    app.renderer.render = (...args) => {
      const t0 = performance.now();
      originalRender(...args);
      // `render()` only queues the commands; the GPU works asynchronously.
      // `gl.finish()` blocks until the frame is really done, so the timing
      // below contains the actual GPU cost (shadow pass + colour pass).
      app.renderer.getContext().finish();
      window.__perf.renderMs += performance.now() - t0;
      const info = app.renderer.info.render;
      window.__perf.calls = info.calls;
      window.__perf.triangles = info.triangles;
    };
  });

  // Orbit the camera for ~3 seconds: this is the situation the user reports
  // as slow, so it is exactly what we want to measure.
  const result = await page.evaluate(async () => {
    const app = window.mallMap;
    const camera = app.cameraManager.perspectiveCamera;
    const controls = app.cameraManager.controls3D;

    const start = performance.now();
    let frames = 0;

    await new Promise((resolve) => {
      function step() {
        // Rotate the camera a little around the target.
        const angle = (performance.now() - start) / 1400;
        camera.position.set(
          Math.sin(angle) * 90,
          70,
          Math.cos(angle) * 90
        );
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);
        controls.update();
        frames++;
        if (performance.now() - start < 3000) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });

    const elapsed = performance.now() - start;
    const perf = window.__perf;

    return {
      fps: (frames / elapsed) * 1000,
      frames,
      elapsed,
      labelMs: perf.labelMs,
      renderMs: perf.renderMs,
      otherMs: elapsed - perf.labelMs - perf.renderMs,
      calls: perf.calls,
      triangles: perf.triangles,
      shadowAutoUpdate: app.renderer.shadowMap.autoUpdate,
      shadowEnabled: app.renderer.shadowMap.enabled,
      renderScale: app.resolutionScaler.ratio,
      maxRenderScale: app.resolutionScaler.max
    };
  });

  const perFrame = (ms) => (ms / result.frames).toFixed(2);

  console.log('\n=== Frame cost while orbiting (1600 x 1000) ===');
  console.log(`  frames rendered      : ${result.frames}`);
  console.log(`  elapsed              : ${(result.elapsed / 1000).toFixed(2)} s`);
  console.log(`  FPS                  : ${result.fps.toFixed(1)}`);
  console.log(`  total frame time     : ${perFrame(result.elapsed)} ms/frame`);
  console.log(`    ... labels.update  : ${perFrame(result.labelMs)} ms/frame`);
  console.log(`    ... renderer.render: ${perFrame(result.renderMs)} ms/frame`);
  console.log(`    ... other (JS)     : ${perFrame(result.otherMs)} ms/frame`);
  console.log(`  draw calls / frame   : ${result.calls}`);
  console.log(`  triangles / frame    : ${result.triangles}`);
  console.log(`  shadows enabled      : ${result.shadowEnabled}`);
  console.log(`  shadow autoUpdate    : ${result.shadowAutoUpdate}`);
  console.log(
    `  render scale         : ${result.renderScale.toFixed(2)}x (max ${result.maxRenderScale.toFixed(2)}x)`
  );
} finally {
  await browser.close();
}
