import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assembleDaemonManifest } from "./prepare-daemon-manifest.mjs";

function writeFragment(filePath, overrides = {}) {
  const fragment = {
    schemaVersion: 1,
    repo: "Laokashouji/paseo",
    tag: "fork-v0.17.518",
    version: "0.17.518",
    targetKey: "linux-x64",
    target: {
      asset: "paseo-daemon-0.17.518-linux-x64.tar.gz",
      url: "https://github.com/Laokashouji/paseo/releases/download/fork-v0.17.518/paseo-daemon-0.17.518-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      size: 12345678,
    },
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify(fragment, null, 2));
}

describe("assembleDaemonManifest", () => {
  it("merges multiple target fragments into sorted latest-daemon.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-manifest-"));
    try {
      const linuxX64 = path.join(tmp, "linux-x64.json");
      const darwinArm64 = path.join(tmp, "darwin-arm64.json");
      const outPath = path.join(tmp, "final", "latest-daemon.json");

      writeFragment(linuxX64);
      writeFragment(darwinArm64, {
        targetKey: "darwin-arm64",
        target: {
          asset: "paseo-daemon-0.17.518-darwin-arm64.tar.gz",
          url: "https://github.com/Laokashouji/paseo/releases/download/fork-v0.17.518/paseo-daemon-0.17.518-darwin-arm64.tar.gz",
          sha256: "B".repeat(64),
          size: 23456789,
        },
      });

      const rendered = assembleDaemonManifest({
        inputPaths: [linuxX64, darwinArm64],
        outputPath: outPath,
        releaseDate: "2026-11-24T08:00:00.000Z",
        expectedVersion: "0.17.518",
        expectedTag: "fork-v0.17.518",
        expectedRepo: "Laokashouji/paseo",
      });

      const parsed = JSON.parse(rendered);
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.version, "0.17.518");
      assert.equal(parsed.tag, "fork-v0.17.518");
      assert.deepEqual(Object.keys(parsed.targets), ["darwin-arm64", "linux-x64"]);
      assert.equal(parsed.targets["darwin-arm64"].sha256, "b".repeat(64));
      assert.ok(fs.existsSync(outPath));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects mismatched versions across fragments", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-manifest-err-"));
    try {
      const first = path.join(tmp, "a.json");
      const second = path.join(tmp, "b.json");
      writeFragment(first, { version: "0.17.518" });
      writeFragment(second, { version: "0.17.519", targetKey: "linux-arm64" });

      assert.throws(
        () =>
          assembleDaemonManifest({
            inputPaths: [first, second],
            outputPath: path.join(tmp, "out.json"),
            releaseDate: "2026-11-24T08:00:00.000Z",
          }),
        /metadata mismatch/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects duplicate target keys and non-https URLs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-manifest-dup-"));
    try {
      const first = path.join(tmp, "a.json");
      const second = path.join(tmp, "b.json");
      writeFragment(first);
      writeFragment(second);

      assert.throws(
        () =>
          assembleDaemonManifest({
            inputPaths: [first, second],
            outputPath: path.join(tmp, "out.json"),
            releaseDate: "2026-11-24T08:00:00.000Z",
          }),
        /duplicate targetKey/,
      );

      const insecure = path.join(tmp, "insecure.json");
      writeFragment(insecure, {
        target: {
          asset: "paseo-daemon-0.17.518-linux-x64.tar.gz",
          url: "http://example.com/paseo.tar.gz",
          sha256: "a".repeat(64),
          size: 100,
        },
      });
      assert.throws(
        () =>
          assembleDaemonManifest({
            inputPaths: [insecure],
            outputPath: path.join(tmp, "out2.json"),
            releaseDate: "2026-11-24T08:00:00.000Z",
          }),
        /invalid target\.url/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
