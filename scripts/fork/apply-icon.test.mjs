import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APPLY_ICON_SCRIPT = path.join(REPO_ROOT, "scripts/fork/apply-icon.sh");

function createMockBinDir(tempRoot) {
  const binDir = path.join(tempRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const mockSips = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-s" && "$2" == "format" && "$3" == "png" && "$4" == "-z" ]]
h="$5"; w="$6"; src="$7"; flag="$8"; dst="$9"
[[ "$h" == "$w" && "$flag" == "--out" && -f "$src" ]]
printf 'PNG-%sx%s-from-%s\\n' "$w" "$h" "$(basename "$src")" > "$dst"
`;

  const mockIconutil = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-c" && "$2" == "icns" && "$4" == "-o" ]]
iconset="$3"
out="$5"
[[ "$iconset" == *.iconset ]]
expected=(
  "icon_16x16.png:PNG-16x16-from-icon-dev.png"
  "icon_16x16@2x.png:PNG-32x32-from-icon-dev.png"
  "icon_32x32.png:PNG-32x32-from-icon-dev.png"
  "icon_32x32@2x.png:PNG-64x64-from-icon-dev.png"
  "icon_128x128.png:PNG-128x128-from-icon-dev.png"
  "icon_128x128@2x.png:PNG-256x256-from-icon-dev.png"
  "icon_256x256.png:PNG-256x256-from-icon-dev.png"
  "icon_256x256@2x.png:PNG-512x512-from-icon-dev.png"
  "icon_512x512.png:PNG-512x512-from-icon-dev.png"
  "icon_512x512@2x.png:PNG-1024x1024-from-icon-dev.png"
)
for item in "\${expected[@]}"; do
  f="\${item%%:*}"
  want="\${item#*:}"
  [[ -f "\${iconset}/\${f}" ]]
  got="$(cat "\${iconset}/\${f}")"
  [[ "$got" == "$want" ]]
done
if [[ "\${MOCK_BAD_ICNS:-0}" == "1" ]]; then
  printf 'BAD!' > "$out"
else
  printf 'icns\\x00\\x00\\x00\\x08' > "$out"
fi
`;

  fs.writeFileSync(path.join(binDir, "sips"), mockSips, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "iconutil"), mockIconutil, { mode: 0o755 });
  return binDir;
}

describe("apply-icon.sh", () => {
  it("generates all 10 Apple iconset slots and updates icon.icns and companion PNGs", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-apply-icon-test-"));
    try {
      const binDir = createMockBinDir(tempRoot);
      const assetsDir = path.join(tempRoot, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      for (const name of [
        "icon.icns",
        "icon.png",
        "32x32.png",
        "64x64.png",
        "128x128.png",
        "128x128@2x.png",
      ]) {
        fs.writeFileSync(path.join(assetsDir, name), "old");
      }

      const result = spawnSync(APPLY_ICON_SCRIPT, ["--assets-dir", assetsDir], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(assetsDir, "icon.icns")).subarray(0, 4).toString("ascii"), "icns");
      assert.equal(fs.readFileSync(path.join(assetsDir, "icon.png"), "utf8").trim(), "PNG-512x512-from-icon-dev.png");
      assert.equal(fs.readFileSync(path.join(assetsDir, "32x32.png"), "utf8").trim(), "PNG-32x32-from-icon-dev.png");
      assert.equal(fs.readFileSync(path.join(assetsDir, "64x64.png"), "utf8").trim(), "PNG-64x64-from-icon-dev.png");
      assert.equal(fs.readFileSync(path.join(assetsDir, "128x128.png"), "utf8").trim(), "PNG-128x128-from-icon-dev.png");
      assert.equal(fs.readFileSync(path.join(assetsDir, "128x128@2x.png"), "utf8").trim(), "PNG-256x256-from-icon-dev.png");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid ICNS output without overwriting existing assets", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-apply-icon-bad-"));
    try {
      const binDir = createMockBinDir(tempRoot);
      const assetsDir = path.join(tempRoot, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(path.join(assetsDir, "icon.icns"), "original-icns");

      const result = spawnSync(APPLY_ICON_SCRIPT, ["--assets-dir", assetsDir], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          MOCK_BAD_ICNS: "1",
        },
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /did not produce a valid ICNS file/);
      assert.equal(fs.readFileSync(path.join(assetsDir, "icon.icns"), "utf8"), "original-icns");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
