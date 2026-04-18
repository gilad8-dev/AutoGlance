/**
 * Generates AutoGlance icon PNGs without any npm dependencies.
 * Uses Node.js built-ins: zlib (compression) + Buffer (binary).
 *
 * Run: node scripts/generate-icons.js
 *
 * Output: extension/icons/icon{16,32,48,128}.png
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── AutoGlance brand colors ────────────────────────────────────────────────
const PRIMARY = [99, 102, 241];    // #6366f1 indigo
const DARK    = [79, 70, 229];     // #4f46e5 indigo-dark
const WHITE   = [255, 255, 255];

// ── CRC32 (required by PNG spec) ──────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Simple icon renderer ──────────────────────────────────────────────────
/**
 * Draws a rounded-rect background with a simple "diamond" (◈) shape inside.
 * Pure raster rendering via pixel math - no canvas required.
 */
function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 3);

  const cx = size / 2;
  const cy = size / 2;
  const r  = size * 0.42;   // background circle radius

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 3;
      const dx  = x - cx + 0.5;
      const dy  = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Background circle (indigo)
      if (dist <= r) {
        // Slight vertical gradient from PRIMARY to DARK
        const t = (y / size);
        pixels[idx]   = Math.round(PRIMARY[0] * (1 - t) + DARK[0] * t);
        pixels[idx+1] = Math.round(PRIMARY[1] * (1 - t) + DARK[1] * t);
        pixels[idx+2] = Math.round(PRIMARY[2] * (1 - t) + DARK[2] * t);

        // Inner diamond shape ◈ - rotated square with a circle cutout
        const ir    = r * 0.52;   // diamond half-width
        const adx   = Math.abs(dx);
        const ady   = Math.abs(dy);
        const inner = ir * 0.38;  // inner circle of the ◈

        const inDiamond = (adx + ady) <= ir;
        const inCircle  = dist <= inner;
        const onEdge    = inDiamond && !inCircle;

        if (onEdge) {
          pixels[idx]   = WHITE[0];
          pixels[idx+1] = WHITE[1];
          pixels[idx+2] = WHITE[2];
        }
      } else {
        // Transparent area - render as white (PNG background)
        pixels[idx]   = 248;
        pixels[idx+1] = 250;
        pixels[idx+2] = 252;
      }
    }
  }
  return pixels;
}

function makePNG(size) {
  const pixels = renderIcon(size);

  // Build raw image data: one filter byte (0) per row + RGB rows
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter type: None
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 3;
      const dst = y * rowBytes + 1 + x * 3;
      raw[dst]   = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
    }
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 2; // RGB
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const IHDR = chunk('IHDR', ihdrData);
  const IDAT = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  const IEND = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, IHDR, IDAT, IEND]);
}

// ── Write files ───────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const buf = makePNG(size);
  const out = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(out, buf);
  console.log(`✓ icon${size}.png  (${buf.length} bytes)`);
}

console.log('\nIcons written to extension/icons/');
