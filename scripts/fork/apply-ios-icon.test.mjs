import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyIosIcon, decodePng, encodeRgbPng } from "./apply-ios-icon.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REAL_SOURCE_ICON = path.join(REPO_ROOT, "packages/desktop/assets/icon-dev.png");

describe("apply-ios-icon.mjs", () => {
  it("converts the fork blueprint icon-dev.png into an opaque 1024x1024 RGB PNG", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-ios-icon-test-"));
    try {
      const outputPath = path.join(tempDir, "icon.png");
      const result = applyIosIcon({
        sourcePath: REAL_SOURCE_ICON,
        outputPath,
        size: 1024,
      });

      assert.equal(result.width, 1024);
      assert.equal(result.height, 1024);
      assert.equal(result.colorType, 2);

      const decoded = decodePng(fs.readFileSync(outputPath));
      assert.equal(decoded.width, 1024);
      assert.equal(decoded.height, 1024);
      assert.equal(decoded.colorType, 2);

      // Corner pixel must be blue blueprint fill (not black/white artifact from transparent padding).
      const topLeftR = decoded.rgba[0];
      const topLeftG = decoded.rgba[1];
      const topLeftB = decoded.rgba[2];
      assert.ok(
        topLeftB > 180 && topLeftB > topLeftR + 80,
        `expected blueprint blue corner, got rgb(${topLeftR},${topLeftG},${topLeftB})`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles opaque RGB PNG sources without transparent padding", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-ios-icon-rgb-"));
    try {
      const srcPath = path.join(tempDir, "src.png");
      const dstPath = path.join(tempDir, "dst.png");
      const rgb = new Uint8Array(16 * 16 * 3);
      for (let i = 0; i < 16 * 16; i += 1) {
        rgb[i * 3] = 10;
        rgb[i * 3 + 1] = 120;
        rgb[i * 3 + 2] = 240;
      }
      fs.writeFileSync(srcPath, encodeRgbPng({ width: 16, height: 16, rgb }));

      const result = applyIosIcon({ sourcePath: srcPath, outputPath: dstPath, size: 64 });
      assert.equal(result.width, 64);
      assert.equal(result.height, 64);
      assert.equal(result.colorType, 2);

      const decoded = decodePng(fs.readFileSync(dstPath));
      assert.equal(decoded.rgba[0], 10);
      assert.equal(decoded.rgba[1], 120);
      assert.equal(decoded.rgba[2], 240);
      assert.equal(decoded.rgba[3], 255);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
