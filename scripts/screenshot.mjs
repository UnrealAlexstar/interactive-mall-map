/**
 * scripts/screenshot.mjs — Drive the running dev server with a real browser.
 *
 * Usage:  node scripts/screenshot.mjs [url] [outDir]
 *
 * It captures the 3D view, the 2D plan view and the hover/selection states,
 * and reports every console message and page error, so the prototype can be
 * verified without opening a browser manually.
 */

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5199/';
const outDir = process.argv[3] ?? 'shots';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,1000'
  ]
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const messages = [];
page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => messages.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => messages.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));

// `networkidle` never settles because the Vite dev server keeps an HMR
// websocket open, so wait for the DOM and then for the canvas instead.
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('canvas.mall-canvas', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

await page.screenshot({ path: join(outDir, '01-3d-default.png') });

// Switch to the 2D plan view with the space bar.
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: join(outDir, '02-2d-plan.png') });

// Hover a unit in the middle of the plan.
const hoverTarget = await page.evaluate(() => {
  const app = window.mallMap;
  if (!app) return null;
  const list = [...app.placements.values()];
  const pick = list[Math.floor(list.length / 2)];
  const mesh = app.interaction.meshById.get(pick.id);
  const v = mesh.getWorldPosition(new app.THREE.Vector3()).project(app.cameraManager.activeCamera);
  return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight, id: pick.id };
});

if (hoverTarget) {
  await page.mouse.move(hoverTarget.x, hoverTarget.y);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: join(outDir, '03-2d-hover.png') });

  await page.mouse.click(hoverTarget.x, hoverTarget.y);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: join(outDir, '04-2d-selected.png') });
}

// Back to 3D with the selection still active.
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: join(outDir, '05-3d-selected.png') });

// Zoom in a bit to check the label scaling.
await page.mouse.move(800, 500);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel({ deltaY: -220 });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: join(outDir, '06-3d-zoomed.png') });

const diagnostics = await page.evaluate(() => {
  const app = window.mallMap;
  if (!app) return { error: 'window.mallMap missing' };
  const cam = app.cameraManager;
  const labels = app.labels.items;
  return {
    mode: cam.mode,
    blend: cam.blend,
    activeCamera: cam.activeCamera?.type,
    meshCount: app.placements.size,
    labelSprites: labels.length,
    visibleLabels: labels.filter((item) => item.sprite.visible).length,
    labelScales: labels.slice(0, 6).map((item) => Number(item.scale.toFixed(2))),
    selectedId: app.interaction.selectedId,
    hoveredId: app.interaction.hoveredId,
    fps: document.getElementById('stat-fps')?.textContent,
    footprint: document.getElementById('stat-footprint')?.textContent,
    shelves: document.getElementById('stat-shelves')?.textContent
  };
});

console.log('--- diagnostics ---');
console.log(JSON.stringify(diagnostics, null, 2));
console.log('--- console output ---');
for (const m of messages) console.log(m);

await browser.close();
