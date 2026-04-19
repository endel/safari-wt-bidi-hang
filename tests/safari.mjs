// Automated Safari bidi hang reproducer.
//
// Spawns Safari via safaridriver, loads client/index.html, connects to the
// aioquic echo server at https://127.0.0.1:4436/wt with the computed cert
// SHA-256 pinned via serverCertificateHashes, and invokes sendBidi().
//
// Exit code:
//   0  bidi echo succeeded (bug not reproduced — check your Safari version)
//   1  bidi echo did NOT complete (bug reproduced)
//
// Prereq once per machine: `safaridriver --enable` (needs sudo).

import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, until } from 'selenium-webdriver';
import safari from 'selenium-webdriver/safari.js';
import { setTimeout as delay } from 'node:timers/promises';

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

// Copy page to a unique /tmp path so Safari's file:// cache can't serve stale JS.
const pageFile = `/tmp/safari-wt-bug-${Date.now()}.html`;
copyFileSync(PAGE_SRC, pageFile);
const pageUrl = 'file://' + pageFile;

const driver = await new Builder()
  .forBrowser('safari')
  .setSafariOptions(new safari.Options())
  .build();

let bugReproduced = true;
try {
  console.log(`loading ${pageUrl} in Safari...`);
  await driver.get(pageUrl);
  await driver.wait(until.elementLocated(By.id('hash')), 5000);
  await driver.wait(
    async () => (await driver.executeScript('return typeof doConnect')) === 'function',
    5000,
  );

  await driver.executeScript(
    `document.getElementById('url').value = arguments[0];
     document.getElementById('hash').value = arguments[1];`,
    WT_URL, hash,
  );
  // Safari's safaridriver sometimes no-ops onclick handlers triggered via element.click();
  // calling the handler directly sidesteps that.
  await driver.executeScript('doConnect();');

  await driver.wait(async () => {
    const s = await driver.findElement(By.id('status')).getText();
    return s.trim() === 'Connected';
  }, 15000, 'Safari did not reach Connected within 15s');
  console.log('Safari connected to aioquic.');

  await driver.executeScript('sendBidi();');
  console.log('sent; waiting up to 8s for bidi echo...');
  await delay(8000);

  const bidiResp = await driver.findElement(By.id('bidiResp')).getText();
  const logText = await driver.findElement(By.id('log')).getAttribute('innerText');
  console.log('\n=== bidiResp ===');
  console.log(JSON.stringify(bidiResp));
  console.log('\n=== browser event log ===');
  console.log(logText);

  if (bidiResp.trim().startsWith('Echo:') || bidiResp.trim() === 'hello') {
    console.log('\n✓ Safari bidi echo completed (bug NOT reproduced; check Safari version).');
    bugReproduced = false;
  } else {
    console.log('\n!!! Safari bidi echo did NOT complete — BUG REPRODUCED.');
  }
} catch (e) {
  console.error('harness error:', e.message || e);
  try {
    const logText = await driver.findElement(By.id('log')).getAttribute('innerText');
    console.log('\n=== browser event log (on error) ===');
    console.log(logText);
  } catch {}
} finally {
  try { await driver.quit(); } catch {}
}

process.exit(bugReproduced ? 1 : 0);
