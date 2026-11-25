import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyIosConfigOverlay,
  restoreIosConfigOverlay,
  transformExpoConfig,
} from "./prepare-ios-config.mjs";

const require = createRequire(import.meta.url);

describe("prepare-ios-config.mjs", () => {
  it("transforms upstream Expo config for personal TestFlight distribution and strips upstream EAS ownership", () => {
    const upstream = {
      expo: {
        name: "Paseo",
        scheme: "paseo",
        owner: "getpaseo",
        ios: {
          bundleIdentifier: "sh.paseo",
          buildNumber: "17531999",
          googleServicesFile: "./.secrets/GoogleService-Info.prod.plist",
          infoPlist: {
            NSMicrophoneUsageDescription: "Mic",
          },
        },
        extra: {
          router: {},
          eas: { projectId: "0e7f65ce-0367-46c8-a238-2b65963d235a" },
        },
        plugins: ["expo-router"],
      },
    };

    const result = transformExpoConfig(upstream, {
      bundleId: "com.laokashouji.paseo",
      apsEnvironment: "production",
    });

    assert.equal(result.expo.name, "Paseo Fork");
    assert.equal(result.expo.scheme, "paseo-fork");
    assert.equal(result.expo.ios.bundleIdentifier, "com.laokashouji.paseo");
    assert.equal(result.expo.ios.infoPlist.CFBundleDisplayName, "Paseo Fork");
    assert.equal(result.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
    assert.equal(result.expo.ios.infoPlist.NSMicrophoneUsageDescription, "Mic");
    assert.equal(result.expo.ios.googleServicesFile, undefined);
    assert.equal(result.expo.ios.entitlements["aps-environment"], "production");
    assert.equal(result.expo.ios.buildNumber, "17531999");
    assert.equal(result.expo.owner, undefined);
    assert.equal(result.expo.extra.eas, undefined);
  });

  it("injects personal Expo projectId/owner and custom buildNumber when provided", () => {
    const upstream = {
      expo: {
        name: "Paseo",
        ios: { bundleIdentifier: "sh.paseo", buildNumber: "17531999" },
        extra: {},
      },
    };

    const result = transformExpoConfig(upstream, {
      bundleId: "com.laokashouji.paseo",
      appName: "Paseo Personal",
      buildNumber: "17532000",
      expoProjectId: "11111111-2222-3333-4444-555555555555",
      expoOwner: "laokashouji",
    });

    assert.equal(result.expo.name, "Paseo Personal");
    assert.equal(result.expo.ios.buildNumber, "17532000");
    assert.equal(result.expo.owner, "laokashouji");
    assert.equal(result.expo.extra.eas.projectId, "11111111-2222-3333-4444-555555555555");
  });

  it("rejects upstream bundle IDs to prevent accidental collisions", () => {
    assert.throws(
      () => transformExpoConfig({ expo: {} }, { bundleId: "sh.paseo" }),
      /Refusing to use upstream bundleId/,
    );
    assert.throws(
      () => transformExpoConfig({ expo: {} }, { bundleId: "invalid" }),
      /Invalid iOS bundleId/,
    );
  });

  it("wraps and cleanly restores an upstream export-default app.config.js file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-ios-config-test-"));
    try {
      const originalContent = `const name = "Paseo";
export default {
  expo: {
    name,
    scheme: "paseo",
    owner: "getpaseo",
    ios: {
      bundleIdentifier: "sh.paseo",
      buildNumber: "17531999",
      infoPlist: { NSMicrophoneUsageDescription: "Mic" },
    },
    extra: { eas: { projectId: "upstream-id" } },
    plugins: ["expo-router"],
  },
};
`;
      const configPath = path.join(tempDir, "app.config.js");
      fs.writeFileSync(configPath, originalContent, "utf8");

      applyIosConfigOverlay({
        appDir: tempDir,
        bundleId: "com.laokashouji.paseo",
        apsEnvironment: "production",
      });

      delete require.cache[require.resolve(configPath)];
      const loaded = require(configPath);
      assert.equal(loaded.expo.ios.bundleIdentifier, "com.laokashouji.paseo");
      assert.equal(loaded.expo.name, "Paseo Fork");
      assert.equal(loaded.expo.scheme, "paseo-fork");
      assert.equal(loaded.expo.ios.entitlements["aps-environment"], "production");
      assert.equal(loaded.expo.owner, undefined);
      assert.equal(loaded.expo.extra.eas, undefined);

      // Applying twice stays idempotent against original backup.
      applyIosConfigOverlay({
        appDir: tempDir,
        bundleId: "com.laokashouji.paseo.alt",
        apsEnvironment: "production",
      });
      delete require.cache[require.resolve(configPath)];
      const reloaded = require(configPath);
      assert.equal(reloaded.expo.ios.bundleIdentifier, "com.laokashouji.paseo.alt");

      const restored = restoreIosConfigOverlay({ appDir: tempDir });
      assert.equal(restored.restored, true);
      assert.equal(fs.readFileSync(configPath, "utf8"), originalContent);
      assert.equal(fs.existsSync(path.join(tempDir, "app.config.upstream.cjs")), false);
      assert.equal(fs.existsSync(path.join(tempDir, "app.config.upstream.backup.js")), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
