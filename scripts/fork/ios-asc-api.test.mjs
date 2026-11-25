import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  computeNextBuildNumber,
  createAscClient,
  createAscJwt,
  decodePrivateKeyPem,
  normalizeCertSerial,
  parseProvisioningProfile,
} from "./ios-asc-api.mjs";

function makeTestEcKeyPair() {
  return crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

function makeFakeProfileBuffer({
  uuid = "11111111-2222-3333-4444-555555555555",
  name = "Paseo Fork AppStore (com.laokashouji.paseo)",
  teamId = "ABCDE12345",
  bundleId = "com.laokashouji.paseo",
  apsEnvironment = "production",
  expirationDate = "2027-11-25T00:00:00Z",
} = {}) {
  const apsBlock = apsEnvironment
    ? `\n    <key>aps-environment</key>\n    <string>${apsEnvironment}</string>`
    : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExpirationDate</key>
  <date>${expirationDate}</date>
  <key>Name</key>
  <string>${name}</string>
  <key>TeamIdentifier</key>
  <array>
    <string>${teamId}</string>
  </array>
  <key>UUID</key>
  <string>${uuid}</string>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key>
    <string>${teamId}.${bundleId}</string>${apsBlock}
  </dict>
</dict>
</plist>`;
  // Simulate CMS binary prefix/suffix around the embedded XML plist.
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x01, 0x00]),
    Buffer.from(xml, "utf8"),
    Buffer.from([0x00, 0xff]),
  ]);
}

describe("ios-asc-api.mjs", () => {
  it("signs verifiable ES256 JWT tokens from raw or base64-encoded PEM private keys", () => {
    const { privateKey, publicKey } = makeTestEcKeyPair();
    const base64Pem = Buffer.from(privateKey, "utf8").toString("base64");
    assert.equal(decodePrivateKeyPem(base64Pem), privateKey.trim());

    const token = createAscJwt({
      keyId: "KEY1234567",
      issuerId: "11111111-2222-3333-4444-555555555555",
      privateKeyPem: base64Pem,
      nowSeconds: 1_700_000_000,
    });
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));

    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, "KEY1234567");
    assert.equal(payload.iss, "11111111-2222-3333-4444-555555555555");
    assert.equal(payload.aud, "appstoreconnect-v1");
    assert.equal(payload.exp - payload.iat, 900);

    const verified = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    assert.equal(verified, true);
  });

  it("parses embedded XML plist from .mobileprovision with and without aps-environment", () => {
    const withPush = parseProvisioningProfile(
      makeFakeProfileBuffer({ apsEnvironment: "production" }),
    );
    assert.equal(withPush.uuid, "11111111-2222-3333-4444-555555555555");
    assert.equal(withPush.teamId, "ABCDE12345");
    assert.equal(withPush.bundleId, "com.laokashouji.paseo");
    assert.equal(withPush.apsEnvironment, "production");

    const withoutPush = parseProvisioningProfile(makeFakeProfileBuffer({ apsEnvironment: null }));
    assert.equal(withoutPush.apsEnvironment, "none");
  });

  it("computes collision-free monotonically increasing build numbers", () => {
    assert.equal(
      computeNextBuildNumber({ baseBuildNumber: "17531999", existingBuildNumbers: [] }),
      "17531999",
    );
    assert.equal(
      computeNextBuildNumber({
        baseBuildNumber: "17531999",
        existingBuildNumbers: ["17531999", "17532000"],
      }),
      "17532001",
    );
    assert.equal(normalizeCertSerial("serial=00A1:B2:c3"), "A1B2C3");
  });

  it("creates a fresh IOS_APP_STORE profile when none matches and syncs TestFlight notes", async () => {
    const { privateKey } = makeTestEcKeyPair();
    const profileBuf = makeFakeProfileBuffer();
    const requests = [];

    const respond = (status, data) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (data === null ? "" : JSON.stringify(data)),
    });

    const routeTable = {
      "GET /v1/bundleIds": () =>
        respond(200, {
          data: [
            { id: "bid_other", attributes: { identifier: "com.laokashouji.paseo.extra" } },
            { id: "bid_exact", attributes: { identifier: "com.laokashouji.paseo" } },
          ],
        }),
      "GET /v1/bundleIds/bid_exact/bundleIdCapabilities": (_body, query) => {
        assert.equal(
          query,
          "",
          "bundleIdCapabilities endpoint does not allow query params like limit",
        );
        return respond(200, { data: [] });
      },
      "POST /v1/bundleIdCapabilities": () => respond(201, { data: { id: "cap_push" } }),
      "GET /v1/certificates": () =>
        respond(200, {
          data: [
            {
              id: "cert_dist_1",
              attributes: {
                serialNumber: "00ABCDEF12",
                expirationDate: "2028-01-01T00:00:00Z",
              },
            },
          ],
        }),
      "GET /v1/profiles": () => respond(200, { data: [] }),
      "POST /v1/profiles": (body) =>
        respond(201, {
          data: {
            id: "prof_new_1",
            attributes: {
              name: body.data.attributes.name,
              profileState: "ACTIVE",
              profileContent: profileBuf.toString("base64"),
            },
          },
        }),
      "GET /v1/apps": () =>
        respond(200, {
          data: [{ id: "6799999999", attributes: { bundleId: "com.laokashouji.paseo" } }],
        }),
      "GET /v1/builds": () =>
        respond(200, {
          data: [{ id: "build_42", attributes: { version: "17531999", processingState: "VALID" } }],
        }),
      "GET /v1/builds/build_42/betaBuildLocalizations": () => respond(200, { data: [] }),
      "POST /v1/betaBuildLocalizations": () => respond(201, { data: { id: "loc_1" } }),
      "GET /v1/apps/6799999999/betaGroups": () =>
        respond(200, {
          data: [{ id: "grp_internal", attributes: { name: "Personal" } }],
        }),
      "POST /v1/betaGroups/grp_internal/relationships/builds": () => respond(204, null),
    };

    const mockFetch = async (urlStr, init) => {
      const url = new URL(urlStr);
      const method = init.method;
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ method, path: url.pathname, query: url.searchParams.toString(), body });

      const handler = routeTable[`${method} ${url.pathname}`];
      if (handler) {
        return handler(body, url.searchParams.toString());
      }
      return respond(404, {
        errors: [{ detail: `Unhandled mock route ${method} ${url.pathname}` }],
      });
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-asc-test-"));
    try {
      const client = createAscClient({
        keyId: "KEY1234567",
        issuerId: "11111111-2222-3333-4444-555555555555",
        privateKeyPem: privateKey,
        fetchImpl: mockFetch,
      });

      const outFile = path.join(tempDir, "out.mobileprovision");
      const installDir = path.join(tempDir, "profiles");
      const profile = await client.ensureAppStoreProfile({
        bundleId: "com.laokashouji.paseo",
        certSerialHex: "ab:cd:ef:12",
        outputPath: outFile,
        installDir,
      });

      assert.equal(profile.createdNew, true);
      assert.equal(profile.appAppleId, "6799999999");
      assert.equal(profile.apsEnvironment, "production");
      assert.equal(fs.existsSync(outFile), true);
      assert.equal(
        fs.existsSync(
          path.join(installDir, "11111111-2222-3333-4444-555555555555.mobileprovision"),
        ),
        true,
      );
      assert.ok(
        requests.some((r) => r.method === "POST" && r.path === "/v1/bundleIdCapabilities"),
        "should enable PUSH_NOTIFICATIONS capability when missing",
      );

      const sync = await client.syncTestFlightBuild({
        bundleId: "com.laokashouji.paseo",
        appVersion: "0.17.531",
        buildNumber: "17531999",
        whatsNew: "新增飞书卡片审批与私有 TestFlight 构建",
        groups: ["Personal"],
        timeoutSec: 5,
        pollIntervalSec: 1,
      });
      assert.equal(sync.status, "synced");
      assert.deepEqual(sync.updatedLocales, ["en-US"]);
      assert.deepEqual(sync.attachedGroups, ["Personal"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
