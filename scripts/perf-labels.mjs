/**
 * scripts/perf-labels.mjs — Measure the real cost of the 100 HTML labels and
 * compare strategies that avoid the browser's style/layout work.
 *
 * Usage:  node scripts/perf-labels.mjs [url]
 *
 * Writing to the style of an element invalidates it, and the browser re-runs
 * style + layout lazily. That deferred work is invisible to
 * `performance.now()` around the update call, so this script forces a
 * synchronous layout (`document.body.offsetHeight`) right after the update in
 * order to measure the true cost.
 *
 * Strategies compared:
 *   shipped (current)     — как в приложении: писать только при изменении,
 *                            масштаб с шагом 0.05, ширина — по числу символов
 *   scale only            — обновляем только transform, ширину не трогаем
 *   width only            — обновляем только ширину, transform не трогаем
 *   max-width every frame — старая схема: обе величины пишутся каждый кадр
 *   no updates            — обновление вообще не вызывается
 */

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5199/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--window-size=1600,1000']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('canvas.mall-canvas', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  /**
   * Install an alternative `labels.update` implementation in the page.
   */
  async function patch(kind) {
    await page.evaluate((strategy) => {
      const labels = window.mallMap.labels;

      if (!labels.__originalUpdate) labels.__originalUpdate = labels.update.bind(labels);
      if (strategy === 'shipped') {
        labels.update = labels.__originalUpdate;
        return;
      }
      if (strategy === 'none') {
        labels.update = () => {};
        return;
      }

      // Общие заготовки для всех вариантов.
      const context = document.createElement('canvas').getContext('2d');
      context.font = '600 12px "Inter", "Segoe UI", system-ui, sans-serif';
      let charWidth = 0;
      let charCount = 0;
      for (const item of labels.items) {
        charWidth += context.measureText(item.shop.name).width;
        charCount += item.shop.name.length;
        item.__chars = -1;
        item.__scale = -1;
      }
      charWidth = charCount > 0 ? charWidth / charCount : 7;

      const geometry = (camera, viewportHeight) => {
        const isOrtho = camera.isOrthographicCamera;
        const unitSpan = isOrtho
          ? (camera.top - camera.bottom) / camera.zoom
          : 2 * Math.tan((camera.fov * Math.PI) / 360);
        const out = [];
        for (const item of labels.items) {
          const distance = camera.position.distanceTo(item.anchor);
          const unitsPerPixel = ((isOrtho ? unitSpan : unitSpan * distance)) / viewportHeight;
          const worldSize = (item.placement.width + item.placement.depth) / 2;
          const footprintPx = worldSize / Math.max(unitsPerPixel, 1e-6);
          const scale = Math.min(1.3, Math.max(0.75, footprintPx / 30));
          out.push({ item, footprintPx, scale, width: (footprintPx * 1.2) / scale });
        }
        return out;
      };

      if (strategy === 'scale-only') {
        labels.update = (camera, h) => {
          for (const g of geometry(camera, h)) {
            g.item.inner.style.setProperty('--label-scale', g.scale.toFixed(3));
          }
        };
        return;
      }

      if (strategy === 'width-only') {
        labels.update = (camera, h) => {
          for (const g of geometry(camera, h)) {
            g.item.inner.style.setProperty('--label-width', `${g.width.toFixed(1)}px`);
          }
        };
        return;
      }

      if (strategy === 'every-frame') {
        // Старая схема: обе величины перезаписываются каждый кадр.
        labels.update = (camera, h) => {
          for (const g of geometry(camera, h)) {
            g.item.inner.style.setProperty('--label-scale', g.scale.toFixed(3));
            g.item.inner.style.setProperty('--label-width', `${g.width.toFixed(1)}px`);
          }
        };
        return;
      }
    }, kind);
  }

  async function measure(label) {
    await new Promise((r) => setTimeout(r, 300));

    const result = await page.evaluate(async () => {
      const app = window.mallMap;
      const camera = app.cameraManager.perspectiveCamera;
      const controls = app.cameraManager.controls3D;

      let updateMs = 0;
      let layoutMs = 0;
      let frames = 0;
      const start = performance.now();

      await new Promise((resolve) => {
        function step() {
          const angle = (performance.now() - start) / 1400;
          camera.position.set(Math.sin(angle) * 90, 70, Math.cos(angle) * 90);
          camera.lookAt(controls.target);
          camera.updateMatrixWorld(true);
          controls.update();

          const t0 = performance.now();
          app.labels.update(camera, window.innerHeight);
          const t1 = performance.now();
          // Принудительно завершаем отложенные пересчёты стилей и вёрстки.
          void document.body.offsetHeight;
          const t2 = performance.now();

          updateMs += t1 - t0;
          layoutMs += t2 - t1;
          frames++;

          if (performance.now() - start < 2000) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });

      return { updateMs: updateMs / frames, layoutMs: layoutMs / frames };
    });

    console.log(
      `  ${label.padEnd(32)} update: ${result.updateMs.toFixed(2)} ms   ` +
        `style+layout: ${result.layoutMs.toFixed(2)} ms   total: ${(result.updateMs + result.layoutMs).toFixed(2)} ms`
    );
  }

  console.log('\n=== Cost of the 100 HTML labels (per frame, while orbiting) ===');

  await patch('shipped');
  await measure('shipped (current app)');

  await patch('scale-only');
  await measure('scale only (no width)');

  await patch('width-only');
  await measure('width only (no scale)');

  await patch('every-frame');
  await measure('max-width every frame (old)');

  await patch('none');
  await measure('no label updates');
} finally {
  await browser.close();
}
