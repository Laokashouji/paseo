import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assembleMacManifest, MACOS_MINIMUM_DARWIN_VERSION } from "./prepare-mac-manifest.mjs";

describe("assembleMacManifest", () => {
  it("assembles and stamps a single arm64 manifest with instant rollout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-fork-manifest-"));
    try {
      const arm64Path = path.join(tmp, "arm64-mac.yml");
      const outPath = path.join(tmp, "final", "latest-mac.yml");
      fs.writeFileSync(
        arm64Path,
        [
          "version: 0.17.10001",
          "files:",
          "  - url: Paseo-0.17.10001-arm64.zip",
          "    sha512: aaa111==",
          "    size: 12345678",
          "  - url: Paseo-0.17.10001-arm64.dmg",
          "    sha512: bbb222==",
          "    size: 23456789",
          "path: Paseo-0.17.10001-arm64.zip",
          "sha512: aaa111==",
          "releaseDate: '2026-11-20T00:00:00.000Z'",
          "",
        ].join("\n"),
      );

      const output = assembleMacManifest({
        inputPaths: [arm64Path],
        outputPath: outPath,
        releaseDate: "2026-11-20T08:30:00.000Z",
        rolloutHours: 0,
        expectedVersion: "0.17.10001",
      });

      assert.match(output, /version: 0\.17\.10001/);
      assert.match(output, new RegExp(`minimumSystemVersion: ${MACOS_MINIMUM_DARWIN_VERSION}`));
      assert.match(output, /rolloutHours: 0/);
      assert.match(output, /releaseDate: ['"]?2026-11-20T08:30:00\.000Z['"]?/);
      assert.ok(fs.existsSync(outPath));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("merges arm64 and x64 manifests and deduplicates files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-fork-manifest-"));
    try {
      const arm64Path = path.join(tmp, "arm64-mac.yml");
      const x64Path = path.join(tmp, "x64-mac.yml");
      const outPath = path.join(tmp, "latest-mac.yml");
      fs.writeFileSync(
        arm64Path,
        [
          "version: 0.17.10001",
          "files:",
          "  - url: Paseo-0.17.10001-arm64.zip",
          "    sha512: aaa111==",
          "    size: 100",
          "path: Paseo-0.17.10001-arm64.zip",
          "sha512: aaa111==",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        x64Path,
        [
          "version: 0.17.10001",
          "files:",
          "  - url: Paseo-0.17.10001-arm64.zip",
          "    sha512: aaa111==",
          "    size: 100",
          "  - url: Paseo-0.17.10001-x64.zip",
          "    sha512: ccc333==",
          "    size: 200",
          "path: Paseo-0.17.10001-x64.zip",
          "sha512: ccc333==",
          "",
        ].join("\n"),
      );

      const output = assembleMacManifest({
        inputPaths: [arm64Path, x64Path],
        outputPath: outPath,
        releaseDate: "2026-11-20T09:00:00.000Z",
        rolloutHours: 0,
        expectedVersion: "0.17.10001",
      });

      const armMatches = output.match(/Paseo-0\.17\.10001-arm64\.zip/g) ?? [];
      // Appears once in files[] and once in top-level path
      assert.equal(armMatches.length, 2);
      assert.match(output, /Paseo-0\.17\.10001-x64\.zip/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails on version mismatch", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-fork-manifest-"));
    try {
      const arm64Path = path.join(tmp, "arm64-mac.yml");
      fs.writeFileSync(
        arm64Path,
        [
          "version: 0.17.10001",
          "files:",
          "  - url: Paseo-0.17.10001-arm64.zip",
          "    sha512: aaa111==",
          "    size: 100",
          "path: Paseo-0.17.10001-arm64.zip",
          "sha512: aaa111==",
          "",
        ].join("\n"),
      );

      assert.throws(
        () =>
          assembleMacManifest({
            inputPaths: [arm64Path],
            outputPath: path.join(tmp, "out.yml"),
            releaseDate: "2026-11-20T09:00:00.000Z",
            expectedVersion: "0.17.10002",
          }),
        /version=0\.17\.10001, expected 0\.17\.10002/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
