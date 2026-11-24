import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDaemonTargetFragment,
  buildForkRuntimeMetadata,
  DAEMON_WORKSPACE_PACKAGES,
  formatDaemonAssetName,
  renderLauncherScript,
} from "./package-daemon-release.mjs";

describe("package-daemon-release helpers", () => {
  it("formats deterministic asset names and release target fragments", () => {
    const asset = formatDaemonAssetName({
      version: "0.17.518",
      platform: "linux",
      arch: "x64",
    });
    assert.equal(asset, "paseo-daemon-0.17.518-linux-x64.tar.gz");

    const fragment = buildDaemonTargetFragment({
      repo: "Laokashouji/paseo",
      version: "0.17.518",
      tag: "fork-v0.17.518",
      platform: "linux",
      arch: "x64",
      sha256: "A".repeat(64),
      size: 9876543,
    });
    assert.deepEqual(fragment, {
      schemaVersion: 1,
      repo: "Laokashouji/paseo",
      tag: "fork-v0.17.518",
      version: "0.17.518",
      targetKey: "linux-x64",
      target: {
        asset: "paseo-daemon-0.17.518-linux-x64.tar.gz",
        url: "https://github.com/Laokashouji/paseo/releases/download/fork-v0.17.518/paseo-daemon-0.17.518-linux-x64.tar.gz",
        sha256: "a".repeat(64),
        size: 9876543,
      },
    });
  });

  it("produces schema v1 runtime metadata and symlink-resolving launcher script", () => {
    const metadata = buildForkRuntimeMetadata({
      repo: "Laokashouji/paseo",
      version: "0.17.518",
      tag: "fork-v0.17.518",
      platform: "linux",
      arch: "x64",
    });
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.tag, "fork-v0.17.518");

    const launcher = renderLauncherScript();
    assert.match(launcher, /node --disable-warning=DEP0040/);
    assert.match(launcher, /@getpaseo\/cli\/bin\/paseo/);

    const packageNames = new Set(DAEMON_WORKSPACE_PACKAGES.map((pkg) => pkg.name));
    assert.ok(packageNames.has("@getpaseo/cli"));
    assert.ok(packageNames.has("@getpaseo/server"));
    assert.ok(packageNames.has("@getpaseo/protocol"));
  });
});
