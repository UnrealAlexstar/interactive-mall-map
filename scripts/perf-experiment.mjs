/**
 * scripts/perf-experiment.mjs — Compare the cost of different rendering options.
 *
 * Usage:  node scripts/perf-experiment.mjs [url]
 *
 * The prototype slows down while the camera moves. This script measures the
 * frame rate of the *same* scene with individual features switched off, so we
 * can see what actually costs what instead of guessing.
 *
 * Measured configurations:
 *   baseline            — everything on (as shipped)
 *   no backdrop-filter  — the CSS blur behind the 100 labels is disabled
 *   no box-shadow       — the drop shadow of the 100 labels is disabled
 *   no labels           — the whole label layer is hidden
 *   pixelRatio 1        — the canvas is rendered at 1x instead of 2x
 *   no shadows          — the shadow map is not rendered at all
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

  /**
   * Rotate the camera for `duration` ms and report the achieved frame rate.
   */
  async function measure(duration = 2000) {
    return page.evaluate(async (ms) => {
      const app = window.mallMap;
      const camera = app.cameraManager.perspectiveCamera;
      const controls = app.cameraManager.controls3D;

      const start = performance.now();
      let frames = 0;

      await new Promise((resolve) => {
        function step() {
          const angle = (performance.now() - start) / 1400;
          camera.position.set(Math.sin(angle) * 90, 70, Math.cos(angle) * 90);
          camera.lookAt(controls.target);
          camera.updateMatrixWorld(true);
          controls.update();
          frames++;
          if (performance.now() - start < ms) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });

      const elapsed = performance.now() - start;
      return {
        fps: (frames / elapsed) * 1000,
        frames,
        ms: elapsed / frames,
        calls: app.renderer.info.render.calls
      };
    }, duration);
  }

  /**
   * Apply a CSS rule to the whole document.
   */
  async function css(rule) {
    await page.evaluate((text) => {
      let style = document.getElementById('__perf_css');
      if (!style) {
        style = document.createElement('style');
        style.id = '__perf_css';
        document.head.appendChild(style);
      }
      style.textContent = text;
    }, rule);
  }

  const results = [];

  async function run(name, setup) {
    if (setup) await setup();
    await new Promise((r) => setTimeout(r, 400));
    const result = await measure();
    results.push({ name, ...result });
  }

  await run('baseline');
  await run('no backdrop-filter', () => css('.shop-label__inner{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}'));
  await run('no box-shadow', () => css('.shop-label__inner{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;box-shadow:none !important}'));
  await run('no labels at all', () => css('.label-layer{display:none !important}'));
  await run('pixelRatio 1', async () => {
    await css('');
    await page.evaluate(() => window.mallMap.renderer.setPixelRatio(1));
  });
  await run('no shadows', async () => {
    await page.evaluate(() => {
      window.mallMap.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      window.mallMap.renderer.shadowMap.enabled = false;
      window.mallMap.scene.traverse((o) => {
        if (o.isMesh) o.material.needsUpdate = true;
      });
    });
  });

  const baseline = results[0];

  console.log('\n=== Frame rate while orbiting (1600 x 1000, software renderer) ===');
  console.log('  configuration          FPS    ms/frame   draw calls   vs baseline');
  console.log('  ' + '-'.repeat(70));
  for (const r of results) {
    const delta = ((r.fps - baseline.fps) / baseline.fps) * 100;
    const sign = delta >= 0 ? '+' : '';
    console.log(
      `  ${r.name.padEnd(22)}${r.fps.toFixed(1).padStart(5)}   ${r.ms.toFixed(1).padStart(8)}   ` +
        `${String(r.calls).padStart(10)}   ${sign}${delta.toFixed(0)}%`
    );
  }
} finally {
  await browser.close();
}
