/**
 * scripts/runtime-check.mjs — Drive scripts/runtime-check.html in a real browser.
 *
 * Usage:  node scripts/runtime-check.mjs [url]
 *
 * `runtime-check.html` is a module page that imports the application's own
 * modules directly and asserts on the live objects (WebGL context, meshes,
 * camera framing, labels, raycasting, selection). This script serves it from
 * the running dev server, waits for the assertions to finish and prints the
 * result. The page sets `document.title` to CHECKS-PASSED / CHECKS-FAILED.
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

  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(`${url}scripts/runtime-check.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForFunction(
    () => document.title === 'CHECKS-PASSED' || document.title === 'CHECKS-FAILED',
    { timeout: 60000 }
  );

  const text = await page.$eval('#results', (el) => el.textContent);
  console.log(text);

  if (errors.length > 0) {
    console.log('\n--- console errors ---');
    for (const error of errors) console.log(error);
  }

  const failed = text.includes('FAILED');
  if (failed || errors.length > 0) {
    console.error('\nRuntime checks FAILED.');
    process.exitCode = 1;
  } else {
    console.log('\nRuntime checks passed.');
  }
} finally {
  await browser.close();
}
