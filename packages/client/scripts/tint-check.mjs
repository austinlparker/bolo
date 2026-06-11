import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
globalThis.document = { createElement: () => createCanvas(300, 150) };
const { loadSprites, sprites } = await import('/home/user/bolo/packages/client/src/sprites.ts');
await loadSprites((url) => loadImage(url), '/home/user/bolo/packages/client/public/assets/');
const keys = ['towerDawn','towerDusk','towerNeutral','towerHusk','baseDawn','baseDusk','baseNeutral','builderMan','tankDawn','tankDusk','bulletDawn','crosshairDawn','waterDeep','waterRiver','craterBase','wallRock'];
const cell = 80;
const c = createCanvas(cell*10, cell*2 + 30);
const ctx = c.getContext('2d');
ctx.fillStyle = '#3a5c43'; ctx.fillRect(0,0,c.width,c.height);
ctx.font = '9px sans-serif';
keys.forEach((k, i) => {
  const img = sprites.images[k];
  const x = (i%10)*cell, y = Math.floor(i/10)*(cell+12);
  ctx.fillStyle='#fff'; ctx.fillText(k, x+2, y+10);
  if (img) ctx.drawImage(img, x+4, y+14, cell-8, cell-8);
});
writeFileSync('/tmp/tints.png', c.toBuffer('image/png'));
console.log('ok');
