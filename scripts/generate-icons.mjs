/**
 * 生成扩展图标（16/32/48/128），不依赖任何图形库。
 *
 * 做法：用「几何图形 + 4×4 超采样」在内存里画图，再手写 PNG 编码
 * （IHDR/IDAT/IEND + zlib）。这样仓库里既没有二进制素材需要维护，
 * 也不用为了一个图标引入 canvas / sharp 之类的重依赖。
 *
 * 图形语义：白色 W（word）+ 底部青色横线（gloss，即「中文释义」）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'public', 'icons');
const SIZES = [16, 32, 48, 128];

/** 与 content.css 中的释义色一致，保持品牌统一。 */
const BG = [11, 114, 133];
const FG = [255, 255, 255];
const ACCENT = [99, 230, 190];

/** W 的骨架折线（归一化坐标，y 轴向下）。 */
const W_POINTS = [
  [0.17, 0.26],
  [0.3, 0.76],
  [0.42, 0.45],
  [0.54, 0.76],
  [0.67, 0.26],
];
const W_STROKE = 0.095;
/** 底部横线：象征「释义」。 */
const BAR = { x0: 0.17, y0: 0.815, x1: 0.67, y1: 0.875 };

/* ------------------------------ 几何 ------------------------------ */

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSq));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToPolyline(x, y) {
  let best = Infinity;
  for (let i = 0; i < W_POINTS.length - 1; i += 1) {
    const [ax, ay] = W_POINTS[i];
    const [bx, by] = W_POINTS[i + 1];
    best = Math.min(best, distanceToSegment(x, y, ax, ay, bx, by));
  }
  return best;
}

/** 返回该点的 [r,g,b,a]，a ∈ {0,1}。 */
function sample(x, y) {
  // 圆角方块底
  if (!insideRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return [0, 0, 0, 0];
  let color = BG;
  if (insideRoundedRect(x, y, BAR.x0, BAR.y0, BAR.x1, BAR.y1, (BAR.y1 - BAR.y0) / 2)) {
    color = ACCENT;
  }
  if (distanceToPolyline(x, y) <= W_STROKE / 2) color = FG;
  return [color[0], color[1], color[2], 1];
}

function render(size) {
  const SS = 4; // 每像素 4×4 超采样，得到平滑边缘
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SS * SS;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = sample(x, y);
          // 预乘 alpha 再累加，避免边缘出现黑边
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const alpha = a / samples;
      const offset = (py * size + px) * 4;
      rgba[offset] = alpha > 0 ? Math.round(r / a) : 0;
      rgba[offset + 1] = alpha > 0 ? Math.round(g / a) : 0;
      rgba[offset + 2] = alpha > 0 ? Math.round(b / a) : 0;
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* ------------------------------ PNG ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 主流程 ------------------------------ */

await mkdir(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  const png = encodePng(size, render(size));
  await writeFile(file, png);
  console.log(`✓ icon${size}.png (${png.byteLength} B)`);
}
console.log(`  输出目录：${path.relative(ROOT, OUT_DIR)}`);
