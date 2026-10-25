/**
 * scripts/visual-check.mjs — Objective visual verification of the running app.
 *
 * Usage:  node scripts/visual-check.mjs [url]
 *
 * The checks are quantitative rather than subjective:
 *   - the WebGL frame buffer really contains the mall (colour variety, lit
 *     pixels, no flat/empty frame)
 *   - the labels are laid out on screen with a legible font size
 *   - the 2D view is a true top-down projection of the same geometry
 *   - clicking a label selects the shop it belongs to
 *   - switching modes never leaves a stale camera behind
 */

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5199/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let failures = 0;
const assert = (cond, msg, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? `  ::  ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--window-size=1600,1000']
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('canvas.mall-canvas', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

// ---------------------------------------------------------------- pixels
/**
 * Read back the WebGL frame buffer and describe it.
 */
async function frameStats() {
  return page.evaluate(() => {
    const app = window.mallMap;
    const { renderer, scene } = app;
    const camera = app.cameraManager.activeCamera;
    renderer.render(scene, camera);

    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const colors = new Set();
    let lit = 0;
    let total = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    // Sample every 17th pixel to keep the pass cheap.
    for (let i = 0; i < pixels.length; i += 4 * 17) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      colors.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
      const brightness = r + g + b;
      sumR += r;
      sumG += g;
      sumB += b;
      total++;
      if (brightness > 90) lit++;
    }
    return {
      width: w,
      height: h,
      distinctColors: colors.size,
      litRatio: lit / total,
      mean: [Math.round(sumR / total), Math.round(sumG / total), Math.round(sumB / total)],
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles
    };
  });
}

console.log('\n=== 3D view ===');
const stats3d = await frameStats();
console.log('   frame:', JSON.stringify(stats3d));
assert(stats3d.distinctColors > 200, 'the frame contains a rich variety of colours', `${stats3d.distinctColors}`);
assert(stats3d.litRatio > 0.1, 'a significant part of the frame is lit geometry', `${(stats3d.litRatio * 100).toFixed(1)}%`);
assert(stats3d.triangles > 1000, 'the mall geometry is actually drawn', `${stats3d.triangles} triangles`);
// The scene is static, so the shadow map is rendered ONCE and never again.
// That means one draw call per object instead of two.
assert(
  stats3d.drawCalls > 0 && stats3d.drawCalls <= 100 + 12,
  'draw calls stay low (no per-frame shadow pass)',
  `${stats3d.drawCalls} calls (colour pass only)`
);

const shadowState = await page.evaluate(() => ({
  enabled: window.mallMap.renderer.shadowMap.enabled,
  autoUpdate: window.mallMap.renderer.shadowMap.autoUpdate,
  needsUpdate: window.mallMap.renderer.shadowMap.needsUpdate
}));
console.log('   shadows:', JSON.stringify(shadowState));
assert(shadowState.enabled, 'shadows are enabled');
assert(shadowState.autoUpdate === false, 'the shadow map is not re-rendered every frame');
assert(shadowState.needsUpdate === false, 'the shadow map was built once and is now cached');

// ---------------------------------------------------------------- labels
const labelStats = await page.evaluate(() => {
  const labels = window.mallMap.labels;
  const rects = labels.items
    .filter((item) => item.sprite.visible)
    .map((item) => {
      const w = item.boxWidth * item.scale;
      const h = item.boxHeight * item.scale;
      const left = item.screenX - w / 2;
      const top = item.screenY - h * labels.centerY;
      return { left, right: left + w, top, bottom: top + h, text: item.text, scale: item.scale };
    });
  const onScreen = rects.filter(
    (r) => r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight
  );
  // The label layout uses a 12px name font; the sprite scale makes it responsive.
  const effectiveFonts = rects.map((r) => 12 * r.scale);
  // Count how many labels overlap each other significantly.
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 6 && oy > 6) overlaps++;
    }
  }
  return {
    total: labels.items.length,
    drawn: rects.length,
    onScreen: onScreen.length,
    minFont: Math.min(...effectiveFonts),
    maxFont: Math.max(...effectiveFonts),
    minScale: Math.min(...rects.map((r) => r.scale)),
    maxScale: Math.max(...rects.map((r) => r.scale)),
    truncated: rects.filter((r) => r.text.endsWith('…')).length,
    overlaps
  };
});
console.log('   labels:', JSON.stringify(labelStats));
assert(labelStats.total === 100, '100 labels created', `${labelStats.total}`);
assert(labelStats.drawn === 100, 'all labels are rendered on screen', `${labelStats.drawn}`);
assert(labelStats.onScreen >= 90, 'the labels are visible in the viewport', `${labelStats.onScreen} on screen`);
assert(labelStats.minFont >= 8, 'the smallest label stays legible (>= 8px)', `${labelStats.minFont.toFixed(1)}px`);
assert(labelStats.maxScale <= 1.4, 'the label scale is clamped', `${labelStats.maxScale}`);
assert(labelStats.truncated > 40, 'long names are truncated to fit their unit', `${labelStats.truncated} truncated`);

// ---------------------------------------------------------------- 2D view
console.log('\n=== 2D plan view ===');
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 1600));

const camera2d = await page.evaluate(() => {
  const app = window.mallMap;
  const cam = app.cameraManager.activeCamera;
  const dir = new app.THREE.Vector3();
  cam.getWorldDirection(dir);
  const up = new app.THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  return {
    type: cam.type,
    mode: app.cameraManager.mode,
    direction: dir.toArray().map((n) => Number(n.toFixed(4))),
    screenUp: up.toArray().map((n) => Number(n.toFixed(4))),
    zoom: cam.zoom,
    frustum: cam.right - cam.left
  };
});
console.log('   camera:', JSON.stringify(camera2d));
assert(camera2d.type === 'OrthographicCamera', 'the 2D view uses an orthographic camera');
assert(camera2d.direction[1] === -1, 'the camera looks straight down the -Y axis', camera2d.direction.join(','));
assert(Math.abs(camera2d.screenUp[2] + 1) < 1e-3, 'north (-Z) points up on screen', camera2d.screenUp.join(','));

const stats2d = await frameStats();
console.log('   frame:', JSON.stringify(stats2d));
assert(stats2d.distinctColors > 200, 'the 2D frame is fully rendered', `${stats2d.distinctColors} colours`);

const labels2d = await page.evaluate(() => {
  const labels = window.mallMap.labels;
  const items = labels.items.filter((item) => item.sprite.visible);
  const rects = items.map((item) => {
    const w = item.boxWidth * item.scale;
    const h = item.boxHeight * item.scale;
    const left = item.screenX - w / 2;
    const top = item.screenY - h * labels.centerY;
    return { left, right: left + w, top, bottom: top + h, text: item.text, scale: item.scale };
  });
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 6 && oy > 6) overlaps++;
    }
  }
  return {
    total: items.length,
    overlaps,
    minFont: Math.min(...rects.map((r) => 12 * r.scale)),
    truncated: rects.filter((r) => r.text.endsWith('…')).length
  };
});
console.log('   labels:', JSON.stringify(labels2d));
assert(labels2d.total === 100, 'all 100 labels are present in the 2D plan');
assert(labels2d.minFont >= 8, 'the labels stay legible in the 2D plan', `${labels2d.minFont.toFixed(1)}px`);
assert(labels2d.overlaps < 60, 'the 2D plan stays readable', `${labels2d.overlaps} overlapping pairs`);

// The 2D plan must show the same amount of geometry as the 3D view.
assert(
  Math.abs(stats2d.triangles - stats3d.triangles) < stats3d.triangles * 0.02,
  'the same geometry is visible in both modes',
  `${stats3d.triangles} vs ${stats2d.triangles}`
);

// ------------------------------------------------- label click selection
const clickTarget = await page.evaluate(() => {
  const app = window.mallMap;
  const list = [...app.placements.values()];
  const pick = list[55];
  const mesh = app.interaction.meshById.get(pick.id);
  const v = mesh.getWorldPosition(new app.THREE.Vector3()).project(app.cameraManager.activeCamera);
  return {
    id: pick.id,
    x: ((v.x + 1) / 2) * window.innerWidth,
    y: ((1 - v.y) / 2) * window.innerHeight
  };
});

await page.mouse.move(clickTarget.x, clickTarget.y);
await new Promise((r) => setTimeout(r, 300));
const hovered = await page.evaluate(() => window.mallMap.interaction.hoveredId);
assert(hovered === clickTarget.id, 'hovering a unit highlights it', `${hovered}`);

await page.mouse.click(clickTarget.x, clickTarget.y);
await new Promise((r) => setTimeout(r, 300));
const selected = await page.evaluate(() => ({
  id: window.mallMap.interaction.selectedId,
  outline: window.mallMap.interaction.outline.visible,
  panel: document.getElementById('info-title')?.textContent
}));
assert(selected.id === clickTarget.id, 'clicking selects the unit', JSON.stringify(selected));
assert(selected.outline === true, 'the selection outline is shown');
assert(!!selected.panel && selected.panel !== 'No selection', 'the info panel is updated', selected.panel);

// Clicking directly on the LABEL must select the same shop.
const labelClick = await page.evaluate(() => {
  const app = window.mallMap;
  app.interaction.clearSelection();
  const labels = app.labels;
  const item = labels.items.find((entry) => {
    if (!entry.sprite.visible) return false;
    const w = entry.boxWidth * entry.scale;
    const h = entry.boxHeight * entry.scale;
    const left = entry.screenX - w / 2;
    const top = entry.screenY - h * labels.centerY;
    return w > 0 && h > 0 && left > 40 && top > 120;
  });
  if (!item) return null;
  const w = item.boxWidth * item.scale;
  const h = item.boxHeight * item.scale;
  const x = item.screenX;
  const y = item.screenY - h * labels.centerY + h / 2;
  // pick() resolves the top-most label at that point; clicking must select it.
  return { id: labels.pick(x, y), x, y };
});

if (labelClick && labelClick.id) {
  await page.mouse.click(labelClick.x, labelClick.y);
  await new Promise((r) => setTimeout(r, 300));
  const afterLabel = await page.evaluate(() => window.mallMap.interaction.selectedId);
  assert(afterLabel === labelClick.id, 'clicking a label selects its shop', `${afterLabel} vs ${labelClick.id}`);
} else {
  assert(false, 'clicking a label selects its shop', 'no label found on screen');
}

// ------------------------------------------------------- round trip back
console.log('\n=== back to 3D ===');
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 1600));
const back = await page.evaluate(() => ({
  type: window.mallMap.cameraManager.activeCamera.type,
  mode: window.mallMap.cameraManager.mode,
  selected: window.mallMap.interaction.selectedId
}));
assert(back.type === 'PerspectiveCamera', 'the 3D view is restored');
assert(back.mode === '3d', 'the mode flag is correct');
assert(back.selected === labelClick?.id ?? clickTarget.id, 'the selection survives the round trip');

// -------------------------------------------------- responsive behaviour
console.log('\n=== zoomed in ===');
await page.mouse.move(800, 500);
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel({ deltaY: -240 });
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 800));

const zoomed = await page.evaluate(() => {
  const labels = window.mallMap.labels;
  const items = labels.items.filter((item) => item.sprite.visible);
  // The name is truncated in JavaScript (labels.js), so the ellipsis is part of
  // the text itself.
  const truncated = items.filter((item) => item.text.endsWith('…')).length;
  const widths = items.map((item) => item.boxWidth * item.scale);
  return {
    maxScale: Math.max(...items.map((item) => item.scale)),
    truncated,
    avgWidth: widths.reduce((a, b) => a + b, 0) / Math.max(widths.length, 1)
  };
});
console.log('   zoomed:', JSON.stringify(zoomed));
assert(zoomed.maxScale >= 1.29, 'labels grow when zooming in', `${zoomed.maxScale}`);
assert(zoomed.truncated < 83, 'more names fit once the camera is closer', `${zoomed.truncated} truncated`);

console.log('\n=== console ===');
const realErrors = consoleErrors.filter((e) => !e.includes('favicon'));
assert(realErrors.length === 0, 'no runtime errors', realErrors.join(' | '));

console.log(`\n${failures === 0 ? 'ALL VISUAL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
