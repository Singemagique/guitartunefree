// Replaces the default Capacitor launcher icons and splash screens in the
// android/ project with TrueString branding, keeping each file's dimensions.
// Run after `npx cap add android`: node scripts/make-android-assets.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'node:fs/promises';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
const svg = await readFile(path.join(root, 'public', 'icons', 'favicon.svg'));
const BG = '#0f1317';

async function centeredOn(size, glyphRatio, w = size, h = size) {
  const glyph = Math.round(Math.min(w, h) * glyphRatio);
  const inner = await sharp(svg).resize(glyph, glyph).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: BG } })
    .composite([{ input: inner, gravity: 'center' }])
    .png();
}

for await (const entry of glob('mipmap-*/ic_launcher*.png', { cwd: res })) {
  const file = path.join(res, entry);
  const { width, height } = await sharp(await readFile(file)).metadata();
  // Adaptive foreground layers only show their center ~2/3 (safe zone); shrink further.
  const ratio = entry.includes('foreground') ? 0.42 : 0.62;
  await (await centeredOn(width, ratio, width, height)).toFile(file);
  console.log('icon ', entry, `${width}x${height}`);
}

for await (const entry of glob('drawable*/splash.png', { cwd: res })) {
  const file = path.join(res, entry);
  const { width, height } = await sharp(await readFile(file)).metadata();
  await (await centeredOn(0, 0.18, width, height)).toFile(file);
  console.log('splash', entry, `${width}x${height}`);
}

console.log('android assets branded');
