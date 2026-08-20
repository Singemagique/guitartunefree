// Generates PNG app icons from public/icons/favicon.svg using sharp.
// Run: npm run icons   (requires: npm i -D sharp)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const iconsDir = path.join(root, 'public', 'icons');
const svg = await readFile(path.join(iconsDir, 'favicon.svg'));

const BG = '#0f1317';

await sharp(svg).resize(192, 192).png().toFile(path.join(iconsDir, 'icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(path.join(iconsDir, 'icon-512.png'));

// Maskable: glyph shrunk to the 80% safe zone, centered on a solid background.
const inner = await sharp(svg).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: BG },
})
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toFile(path.join(iconsDir, 'icon-maskable-512.png'));

console.log('icons written to public/icons/');
