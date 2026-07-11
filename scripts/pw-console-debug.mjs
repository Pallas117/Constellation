import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => {
    console.log('[PAGE]', msg.type(), msg.text());
    for (const arg of msg.args()) {
      arg.jsonValue().then(v => console.log('[PAGE-ARG]', v)).catch(() => {});
    }
  });
  page.on('pageerror', err => console.log('[PAGE-ERROR]', err.message));
  page.on('requestfailed', req => console.log('[REQUEST-FAILED]', req.url(), req.failure()?.errorText));
  page.on('response', res => {
    if (res.status() >= 400) {
      console.log('[RESPONSE]', res.status(), res.url());
    }
  });
  await page.goto('http://127.0.0.1:4173/?e2e=true', { waitUntil: 'load', timeout: 30000 });
  console.log('TITLE', await page.title());
  console.log('HTML', (await page.content()).slice(0, 2000));
  await browser.close();
})();
