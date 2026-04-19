// Chrome control. Same page, same server, same cert pin — Chrome should
// round-trip the bidi echo cleanly. Exit 0 on success, 1 on failure.

import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_PATH = path.join(ROOT, 'certs/server.crt');
const PAGE_SRC = path.join(ROOT, 'client/index.html');
const WT_URL = process.env.WT_URL || 'https://127.0.0.1:4436/wt';

const pem = readFileSync(CERT_PATH, 'utf8');
const derB64 = pem
  .split('-----BEGIN CERTIFICATE-----')[1]
  .split('-----END CERTIFICATE-----')[0]
  .replace(/\s+/g, '');
const hash = createHash('sha256').update(Buffer.from(derB64, 'base64')).digest('hex');
console.log('cert hash:', hash);

const pageFile = `/tmp/chrome-wt-bug-${Date.now()}.html`;
copyFileSync(PAGE_SRC, pageFile);
const pageUrl = 'file://' + pageFile;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--ignore-certificate-errors'],
  protocolTimeout: 60000,
});

let ok = false;
try {
  const page = await browser.newPage();
  await page.goto(pageUrl, { timeout: 30000 });
  await page.waitForFunction(() => typeof doConnect === 'function', { timeout: 10000 });
  await page.evaluate(
    (url, h) => {
      document.getElementById('url').value = url;
      document.getElementById('hash').value = h;
    },
    WT_URL, hash,
  );
  // Fire-and-forget — evaluate returns synchronously, and we observe state
  // via waitForFunction instead of awaiting the async handler.
  await page.evaluate(() => { doConnect(); });
  await page.waitForFunction(
    () => document.getElementById('status').textContent.trim() === 'Connected',
    { timeout: 15000 },
  );
  console.log('Chrome connected.');

  await page.evaluate(() => { sendBidi(); });
  ok = await page
    .waitForFunction(
      () =>
        (document.getElementById('bidiResp').textContent || '').startsWith('Echo:') ||
        (document.getElementById('bidiResp').textContent || '') === 'hello',
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);

  const resp = await page.$eval('#bidiResp', (el) => el.textContent);
  const logText = await page.$eval('#log', (el) => el.innerText);
  console.log('\n=== bidiResp ===');
  console.log(JSON.stringify(resp));
  console.log('\n=== browser event log ===');
  console.log(logText);
  console.log(ok ? '\n✓ Chrome bidi echo OK' : '\n✗ Chrome bidi echo FAILED (unexpected)');
} finally {
  await browser.close();
}

process.exit(ok ? 0 : 1);
