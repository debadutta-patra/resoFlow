/**
 * Screenshot Methods-page UI in light and dark mode with Playwright.
 *
 *   NODE_PATH=frontend/node_modules node dev/screenshots/shoot.cjs <shots.json> <outDir>
 *
 * shots.json:
 * {
 *   "base": "http://localhost:5173",
 *   "page": "/projects/<p>/analysis/<a>",
 *   "login": { "email": "demo@resoflow.local", "password": "demo-password" },
 *   "shots": [
 *     { "name": "banner", "tab": "Methods", "selector": "section[aria-label='Method checks']",
 *       "before": [{ "click": "button:has-text('Show 1 note')" }], "fullPage": false }
 *   ]
 * }
 * Each shot is taken as <name>-light.png and <name>-dark.png.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const [cfgPath, outDir] = process.argv.slice(2);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const form = new URLSearchParams({ username: cfg.login.email, password: cfg.login.password });
  const res = await fetch(`${cfg.base}/auth/login`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { access_token: token } = await res.json();

  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
      await context.addInitScript(([t, th]) => {
        localStorage.setItem('token', t);
        localStorage.setItem('theme', th);
      }, [token, theme]);
      const page = await context.newPage();
      for (const shot of cfg.shots) {
        await page.goto(`${cfg.base}${shot.page || cfg.page}`, { waitUntil: 'networkidle' });
        if (shot.tab) {
          await page.locator(`button[title='${shot.tab}']`).first().click();
        }
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(shot.wait ?? 2500); // debounced ChemEx resolution
        for (const step of shot.before || []) {
          if (step.click) await page.locator(step.click).first().click();
          if (step.hover) await page.locator(step.hover).first().hover();
          if (step.fill) await page.locator(step.fill[0]).first().fill(step.fill[1]);
          if (step.scroll) await page.locator(step.scroll).first().scrollIntoViewIfNeeded();
          await page.waitForTimeout(step.wait ?? 600);
        }
        const file = path.join(outDir, `${shot.name}-${theme}.png`);
        if (shot.selector) {
          const loc = page.locator(shot.selector).first();
          await loc.scrollIntoViewIfNeeded();
          await loc.screenshot({ path: file });
        } else {
          await page.screenshot({ path: file, fullPage: !!shot.fullPage });
        }
        console.log(file);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
