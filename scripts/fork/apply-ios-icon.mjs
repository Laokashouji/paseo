#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const DEFAULT_IOS_ICON_SIZE = 1024;
const OPAQUE_ALPHA_THRESHOLD = 250;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  let crc = 0xffffffff;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i += 1) {
      crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32([typeBuf, data]), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function parsePngChunks(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Input file is not a valid PNG image.");
  }

  let ihdr = null;
  const idatChunks = [];
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`Truncated PNG chunk "${type}".`);
    }
    const chunkData = buffer.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === "IHDR") {
      if (chunkData.length !== 13) {
        throw new Error(`Invalid PNG IHDR length: ${chunkData.length}`);
      }
      ihdr = {
        width: chunkData.readUInt32BE(0),
        height: chunkData.readUInt32BE(4),
        bitDepth: chunkData[8],
        colorType: chunkData[9],
        interlace: chunkData[12],
      };
    } else if (type === "IDAT") {
      idatChunks.push(chunkData);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!ihdr || ihdr.width <= 0 || ihdr.height <= 0) {
    throw new Error("PNG is missing a valid IHDR chunk.");
  }
  return { ihdr, idatChunks };
}

function unfilterByte(filterType, rawByte, a, b, c) {
  switch (filterType) {
    case 0:
      return rawByte;
    case 1:
      return (rawByte + a) & 0xff;
    case 2:
      return (rawByte + b) & 0xff;
    case 3:
      return (rawByte + ((a + b) >> 1)) & 0xff;
    case 4:
      return (rawByte + paethPredictor(a, b, c)) & 0xff;
    default:
      throw new Error(`Unsupported PNG scanline filter type: ${filterType}`);
  }
}

export function decodePng(buffer) {
  const { ihdr, idatChunks } = parsePngChunks(buffer);
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}). Expected non-interlaced 8-bit RGB or RGBA.`,
    );
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedLength = height * (stride + 1);
  if (inflated.length !== expectedLength) {
    throw new Error(
      `Unexpected inflated PNG payload size (${inflated.length}, expected ${expectedLength}).`,
    );
  }

  const rgba = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filterType = inflated[rowStart];
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? currRow[i - channels] : 0;
      const c = i >= channels ? prevRow[i - channels] : 0;
      currRow[i] = unfilterByte(filterType, inflated[rowStart + 1 + i], a, prevRow[i], c);
    }

    for (let x = 0; x < width; x += 1) {
      const dstIdx = (y * width + x) * 4;
      const srcIdx = x * channels;
      rgba[dstIdx] = currRow[srcIdx];
      rgba[dstIdx + 1] = currRow[srcIdx + 1];
      rgba[dstIdx + 2] = currRow[srcIdx + 2];
      rgba[dstIdx + 3] = channels === 4 ? currRow[srcIdx + 3] : 255;
    }
    prevRow.set(currRow);
  }

  return { width, height, bitDepth, colorType, rgba };
}

export function encodeRgbPng({ width, height, rgb }) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`Invalid RGB buffer length: got ${rgb.length}, expected ${width * height * 3}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = Truecolor RGB (no alpha channel, required by App Store Connect)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const outOffset = y * (stride + 1);
    raw[outOffset] = 0; // filter type None
    const srcOffset = y * stride;
    raw.set(rgb.subarray(srcOffset, srcOffset + stride), outOffset + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function findOpaqueBounds(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = rgba[(y * width + x) * 4 + 3];
      if (a >= OPAQUE_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
  }
  return { minX, minY, maxX, maxY };
}

function median(values, fallback) {
  if (values.length === 0) return fallback;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function sampleBandBackground(rgba, width, bounds, yStart, yEnd, fallback) {
  const rs = [];
  const gs = [];
  const bs = [];
  const xStart = bounds.minX + Math.floor((bounds.maxX - bounds.minX) * 0.15);
  const xEnd = bounds.maxX - Math.floor((bounds.maxX - bounds.minX) * 0.15);

  for (let y = yStart; y <= yEnd; y += 1) {
    for (let x = xStart; x <= xEnd; x += 2) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const a = rgba[idx + 3];
      if (a < OPAQUE_ALPHA_THRESHOLD) continue;
      // Exclude bright white foreground emblem pixels when sampling the background gradient.
      if (r > 215 && g > 215 && b > 215) continue;
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }

  return [median(rs, fallback[0]), median(gs, fallback[1]), median(bs, fallback[2])];
}

export function renderFullBleedIosIcon(decoded, targetSize = DEFAULT_IOS_ICON_SIZE) {
  const { width, height, rgba } = decoded;
  const bounds = findOpaqueBounds(rgba, width, height);
  const bboxW = bounds.maxX - bounds.minX + 1;
  const bboxH = bounds.maxY - bounds.minY + 1;

  // Trim macOS outer transparent padding and subtle squircle rim (~1.5% inset) so the
  // blueprint icon fills iOS's full-bleed icon canvas cleanly without nested borders.
  const hasTransparentPadding =
    bounds.minX > 2 || bounds.minY > 2 || bounds.maxX < width - 3 || bounds.maxY < height - 3;
  const baseSide = Math.min(bboxW, bboxH);
  const inset = hasTransparentPadding ? Math.max(2, Math.round(baseSide * 0.015)) : 0;
  const cropSide = Math.max(1, baseSide - inset * 2);
  const centerX = (bounds.minX + bounds.maxX + 1) / 2;
  const centerY = (bounds.minY + bounds.maxY + 1) / 2;
  const cropX = Math.max(0, Math.min(width - cropSide, centerX - cropSide / 2));
  const cropY = Math.max(0, Math.min(height - cropSide, centerY - cropSide / 2));

  const topBandStart = Math.max(bounds.minY, Math.floor(cropY + cropSide * 0.04));
  const topBandEnd = Math.min(bounds.maxY, Math.floor(cropY + cropSide * 0.14));
  const bottomBandStart = Math.max(bounds.minY, Math.floor(cropY + cropSide * 0.86));
  const bottomBandEnd = Math.min(bounds.maxY, Math.floor(cropY + cropSide * 0.96));

  const topColor = sampleBandBackground(
    rgba,
    width,
    bounds,
    topBandStart,
    topBandEnd,
    [0, 174, 255],
  );
  const bottomColor = sampleBandBackground(
    rgba,
    width,
    bounds,
    bottomBandStart,
    bottomBandEnd,
    [0, 102, 255],
  );

  // Flatten source RGBA onto a vertical background gradient matching the icon's own palette.
  const flattened = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const t = Math.max(0, Math.min(1, (y - cropY) / Math.max(1, cropSide - 1)));
    const bgR = topColor[0] + (bottomColor[0] - topColor[0]) * t;
    const bgG = topColor[1] + (bottomColor[1] - topColor[1]) * t;
    const bgB = topColor[2] + (bottomColor[2] - topColor[2]) * t;

    for (let x = 0; x < width; x += 1) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (y * width + x) * 3;
      const alpha = rgba[srcIdx + 3] / 255;
      if (alpha >= 0.999) {
        flattened[dstIdx] = rgba[srcIdx];
        flattened[dstIdx + 1] = rgba[srcIdx + 1];
        flattened[dstIdx + 2] = rgba[srcIdx + 2];
      } else {
        flattened[dstIdx] = Math.round(rgba[srcIdx] * alpha + bgR * (1 - alpha));
        flattened[dstIdx + 1] = Math.round(rgba[srcIdx + 1] * alpha + bgG * (1 - alpha));
        flattened[dstIdx + 2] = Math.round(rgba[srcIdx + 2] * alpha + bgB * (1 - alpha));
      }
    }
  }

  // Bilinear resample the cropped full-bleed square to targetSize x targetSize RGB.
  const outRgb = new Uint8Array(targetSize * targetSize * 3);
  for (let dy = 0; dy < targetSize; dy += 1) {
    const sy = cropY + ((dy + 0.5) * cropSide) / targetSize - 0.5;
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sy - y0));

    for (let dx = 0; dx < targetSize; dx += 1) {
      const sx = cropX + ((dx + 0.5) * cropSide) / targetSize - 0.5;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(width - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sx - x0));

      const i00 = (y0 * width + x0) * 3;
      const i10 = (y0 * width + x1) * 3;
      const i01 = (y1 * width + x0) * 3;
      const i11 = (y1 * width + x1) * 3;
      const dst = (dy * targetSize + dx) * 3;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      outRgb[dst] = Math.round(
        flattened[i00] * w00 + flattened[i10] * w10 + flattened[i01] * w01 + flattened[i11] * w11,
      );
      outRgb[dst + 1] = Math.round(
        flattened[i00 + 1] * w00 +
          flattened[i10 + 1] * w10 +
          flattened[i01 + 1] * w01 +
          flattened[i11 + 1] * w11,
      );
      outRgb[dst + 2] = Math.round(
        flattened[i00 + 2] * w00 +
          flattened[i10 + 2] * w10 +
          flattened[i01 + 2] * w01 +
          flattened[i11 + 2] * w11,
      );
    }
  }

  return encodeRgbPng({ width: targetSize, height: targetSize, rgb: outRgb });
}

export function applyIosIcon({ sourcePath, outputPath, size = DEFAULT_IOS_ICON_SIZE }) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source icon not found: ${sourcePath}`);
  }
  const sourceBuf = fs.readFileSync(sourcePath);
  const decoded = decodePng(sourceBuf);
  const outputBuf = renderFullBleedIosIcon(decoded, size);

  // Verify the written buffer decodes back as an opaque RGB PNG at the requested dimensions.
  const verified = decodePng(outputBuf);
  if (verified.width !== size || verified.height !== size || verified.colorType !== 2) {
    throw new Error(
      `Generated iOS icon failed validation (${verified.width}x${verified.height}, colorType=${verified.colorType}).`,
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputBuf);

  return {
    sourcePath,
    outputPath,
    width: verified.width,
    height: verified.height,
    colorType: verified.colorType,
    sha256: createHash("sha256").update(outputBuf).digest("hex"),
  };
}

function parseCliArgs(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const options = {
    sourcePath: path.join(repoRoot, "packages/desktop/assets/icon-dev.png"),
    outputPath: path.join(repoRoot, "packages/app/assets/images/icon.png"),
    size: DEFAULT_IOS_ICON_SIZE,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      options.sourcePath = path.resolve(argv[++i] ?? "");
    } else if (arg === "--output") {
      options.outputPath = path.resolve(argv[++i] ?? "");
    } else if (arg === "--size") {
      const parsed = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --size value: ${argv[i]}`);
      }
      options.size = parsed;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/fork/apply-ios-icon.mjs [options]

Generate a 1024x1024 full-bleed, opaque (no alpha channel) iOS App Store icon
from the fork blueprint PNG so TestFlight builds stay visually distinct from
official Paseo and satisfy Apple's ITMS-90717 opaque icon requirement.

Options:
  --source <path>  Source PNG (default: packages/desktop/assets/icon-dev.png)
  --output <path>  Output iOS icon PNG (default: packages/app/assets/images/icon.png)
  --size <px>      Output square dimensions in pixels (default: 1024)
  -h, --help       Show this help message`);
    return;
  }

  const result = applyIosIcon(options);
  console.log(`Applied fork iOS icon from: ${result.sourcePath}`);
  console.log(`  output : ${result.outputPath} (${result.width}x${result.height}, RGB no-alpha)`);
  console.log(`  sha256 : ${result.sha256}`);
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isExecutedDirectly()) {
  main();
}
