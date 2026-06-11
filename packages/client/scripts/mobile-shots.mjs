// Mobile-layout screenshot harness. Boot `pnpm --filter @bolo/server dev`
// first, then run from repo root: node packages/client/scripts/mobile-shots.mjs
// Writes /tmp/m1-login.png m2-game.png m3-driving.png m4-map.png m5-tray.png m6-armed.png
import { chromium, devices } from 'playwright';

const browser = await chromium.launch();
const phone = devices['iPhone 13'];

let ctx = await browser.newContext({ ...phone });
let page = await ctx.newPage();
await page.goto('http://localhost:8787/');
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/m1-login.png' });

await ctx.close();
ctx = await browser.newContext({
  ...phone,
  viewport: { width: 844, height: 390 },
  screen: { width: 844, height: 390 },
});
page = await ctx.newPage();
await page.goto('http://localhost:8787/');
await page.waitForTimeout(800);
await page.fill('#login-handle', 'mobiletest');
await page.tap('#login-dev');
await page.waitForTimeout(8000); // let the welcome banner clear
await page.screenshot({ path: '/tmp/m2-game.png' });

// twin-stick: drive with left, fire with right
const joy = await page.locator('#joy-base').boundingBox();
  const aim = await page.locator('#aim-base').boundingBox();
if (joy) {
  const cx = joy.x + joy.width / 2, cy = joy.y + joy.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy - 20, { steps: 5 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/m3-driving.png' });
  await page.mouse.up();
}

// builder tray + armed state
await page.tap('#builder-btn');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/m5-tray.png' });
await page.tap('#builder-tray .tray-tool:nth-child(2)'); // road
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/m6-armed.png' });

await ctx.close();
ctx = await browser.newContext({ ...phone });
page = await ctx.newPage();
await page.goto('http://localhost:8787/map');
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/m4-map.png' });

await browser.close();
console.log('done');
