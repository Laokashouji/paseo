#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ASC_API_BASE = "https://api.appstoreconnect.apple.com/v1";
const MIN_PROFILE_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;

export function decodePrivateKeyPem(rawKey) {
  const trimmed = String(rawKey ?? "").trim();
  if (!trimmed) {
    throw new Error("App Store Connect API private key (.p8) is empty.");
  }
  if (trimmed.includes("BEGIN PRIVATE KEY") || trimmed.includes("BEGIN EC PRIVATE KEY")) {
    return trimmed;
  }
  const decoded = Buffer.from(trimmed.replace(/\s+/g, ""), "base64").toString("utf8").trim();
  if (decoded.includes("BEGIN PRIVATE KEY") || decoded.includes("BEGIN EC PRIVATE KEY")) {
    return decoded;
  }
  throw new Error(
    "Invalid APPLE_API_KEY format: expected PEM text or base64-encoded App Store Connect .p8 private key.",
  );
}

export function createAscJwt({
  keyId,
  issuerId,
  privateKeyPem,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = 900,
}) {
  if (!keyId || !issuerId) {
    throw new Error("createAscJwt requires keyId and issuerId.");
  }
  const pem = decodePrivateKeyPem(privateKeyPem);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuerId,
      iat: nowSeconds,
      exp: nowSeconds + Math.min(ttlSeconds, 1200),
      aud: "appstoreconnect-v1",
    }),
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .sign("sha256", Buffer.from(signingInput, "utf8"), {
      key: pem,
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");

  return `${signingInput}.${signature}`;
}

export function normalizeCertSerial(serial) {
  const cleaned = String(serial ?? "")
    .trim()
    .replace(/^serial=/i, "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase()
    .replace(/^0+/, "");
  return cleaned || "0";
}

function unescapeXml(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractPlistTag(plistXml, keyName, tagName) {
  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<key>${escapedKey}</key>\\s*<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = plistXml.match(re);
  return match ? unescapeXml(match[1].trim()) : null;
}

function extractPlistFirstArrayString(plistXml, keyName) {
  const escapedKey = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<key>${escapedKey}</key>\\s*<array>\\s*<string>([\\s\\S]*?)</string>`);
  const match = plistXml.match(re);
  return match ? unescapeXml(match[1].trim()) : null;
}

function extractEntitlementsDict(plistXml) {
  const match = plistXml.match(/<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  return match ? match[1] : "";
}

export function parseProvisioningProfile(rawBuffer) {
  const text = rawBuffer.toString("latin1");
  const plistStart = text.indexOf("<?xml");
  const fallbackStart = text.indexOf("<plist");
  const start = plistStart !== -1 ? plistStart : fallbackStart;
  const endTag = "</plist>";
  const end = text.indexOf(endTag, Math.max(0, start));
  if (start === -1 || end === -1) {
    throw new Error("Unable to locate embedded XML plist inside provisioning profile.");
  }

  const plistXml = Buffer.from(text.slice(start, end + endTag.length), "latin1").toString("utf8");
  const uuid = extractPlistTag(plistXml, "UUID", "string");
  const name = extractPlistTag(plistXml, "Name", "string");
  const teamId = extractPlistFirstArrayString(plistXml, "TeamIdentifier");
  const expirationDate = extractPlistTag(plistXml, "ExpirationDate", "date");
  const entitlementsXml = extractEntitlementsDict(plistXml);
  const appIdentifier = extractPlistTag(entitlementsXml, "application-identifier", "string");
  const apsRaw = extractPlistTag(entitlementsXml, "aps-environment", "string");

  if (!uuid || !name || !teamId) {
    throw new Error(
      `Provisioning profile plist is missing required metadata (uuid=${uuid}, name=${name}, teamId=${teamId}).`,
    );
  }

  let bundleId = null;
  if (appIdentifier) {
    const dotIdx = appIdentifier.indexOf(".");
    bundleId = dotIdx !== -1 ? appIdentifier.slice(dotIdx + 1) : appIdentifier;
  }

  return {
    uuid,
    name,
    teamId,
    bundleId,
    applicationIdentifier: appIdentifier,
    apsEnvironment: apsRaw === "production" || apsRaw === "development" ? apsRaw : "none",
    expirationDate,
  };
}

export function computeNextBuildNumber({ baseBuildNumber, existingBuildNumbers = [] }) {
  const baseStr = String(baseBuildNumber ?? "").trim();
  if (!/^\d+$/.test(baseStr)) {
    throw new Error(`Invalid baseBuildNumber "${baseBuildNumber}": expected integer string.`);
  }
  let candidate = BigInt(baseStr);
  for (const raw of existingBuildNumbers) {
    const cleaned = String(raw ?? "").trim();
    if (!/^\d+$/.test(cleaned)) continue;
    const existing = BigInt(cleaned);
    if (existing >= candidate) {
      candidate = existing + 1n;
    }
  }
  return candidate.toString();
}

export function createAscClient({
  keyId,
  issuerId,
  privateKeyPem,
  apiBase = DEFAULT_ASC_API_BASE,
  fetchImpl = globalThis.fetch,
}) {
  const base = apiBase.replace(/\/+$/, "");

  async function request(method, pathname, { query = null, body = null } = {}) {
    const token = createAscJwt({ keyId, issuerId, privateKeyPem });
    const url = new URL(`${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const init = { method, headers };
    if (body !== null && body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(url.toString(), init);
    const text = await response.text();
    const json = text
      ? (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })()
      : null;

    if (!response.ok) {
      const detail = Array.isArray(json?.errors)
        ? json.errors
            .map(
              (e) => `${e.status ?? response.status} ${e.code ?? ""}: ${e.detail ?? e.title ?? ""}`,
            )
            .join("; ")
        : text.slice(0, 400);
      const err = new Error(
        `App Store Connect API ${method} ${pathname} failed (${response.status}): ${detail}`,
      );
      err.status = response.status;
      err.body = json;
      throw err;
    }

    return json;
  }

  return {
    request,

    async findAppByBundleId(bundleId) {
      const res = await request("GET", "/apps", {
        query: { "filter[bundleId]": bundleId, limit: 50 },
      });
      return (res?.data ?? []).find((item) => item?.attributes?.bundleId === bundleId) ?? null;
    },

    async listBuildsForVersion({ appId, appVersion }) {
      const res = await request("GET", "/builds", {
        query: {
          "filter[app]": appId,
          "filter[preReleaseVersion.version]": appVersion,
          limit: 50,
        },
      });
      return res?.data ?? [];
    },

    async findDistributionCertificate(certSerialHex = null) {
      const res = await request("GET", "/certificates", {
        query: {
          "filter[certificateType]": "IOS_DISTRIBUTION,DISTRIBUTION",
          limit: 200,
        },
      });
      const certs = res?.data ?? [];
      if (certSerialHex) {
        const target = normalizeCertSerial(certSerialHex);
        const exact = certs.find(
          (item) => normalizeCertSerial(item?.attributes?.serialNumber) === target,
        );
        if (exact) return exact;
        throw new Error(
          `No Apple Distribution certificate matching serial ${target} found in App Store Connect (found ${certs.length} distribution cert(s)).`,
        );
      }

      const now = Date.now();
      const valid = certs
        .filter((item) => {
          const exp = Date.parse(item?.attributes?.expirationDate ?? "");
          return !Number.isNaN(exp) && exp > now;
        })
        .sort(
          (a, b) =>
            Date.parse(b.attributes.expirationDate) - Date.parse(a.attributes.expirationDate),
        );
      if (valid.length === 0) {
        throw new Error("No active Apple Distribution certificate found in App Store Connect.");
      }
      return valid[0];
    },

    async ensureBundleId({ bundleId, appName = "Paseo Fork", autoRegister = false }) {
      const res = await request("GET", "/bundleIds", {
        query: { "filter[identifier]": bundleId, limit: 100 },
      });
      const existing = (res?.data ?? []).find((item) => item?.attributes?.identifier === bundleId);
      if (existing) return existing;

      if (!autoRegister) {
        throw new Error(
          `Bundle ID "${bundleId}" is not registered in Apple Developer / App Store Connect. Register it at https://developer.apple.com/account/resources/identifiers/list (or pass --auto-register-bundle-id).`,
        );
      }

      const created = await request("POST", "/bundleIds", {
        body: {
          data: {
            type: "bundleIds",
            attributes: {
              identifier: bundleId,
              name: appName.replace(/[^A-Za-z0-9 ]/g, " ").trim() || "Paseo Fork",
              platform: "IOS",
            },
          },
        },
      });
      return created.data;
    },

    async ensurePushCapability(bundleIdResourceId) {
      // Apple's bundleIdCapabilities relationship rejects the `limit` query parameter (400 PARAMETER_ERROR.ILLEGAL).
      const res = await request("GET", `/bundleIds/${bundleIdResourceId}/bundleIdCapabilities`);
      const hasPush = (res?.data ?? []).some(
        (item) => item?.attributes?.capabilityType === "PUSH_NOTIFICATIONS",
      );
      if (hasPush) return { alreadyEnabled: true };

      await request("POST", "/bundleIdCapabilities", {
        body: {
          data: {
            type: "bundleIdCapabilities",
            attributes: {
              capabilityType: "PUSH_NOTIFICATIONS",
            },
            relationships: {
              bundleId: {
                data: { type: "bundleIds", id: bundleIdResourceId },
              },
            },
          },
        },
      });
      return { alreadyEnabled: false };
    },

    async findReusableProfile({ bundleResourceId, certificateId }) {
      const profilesRes = await request("GET", "/profiles", {
        query: {
          "filter[profileType]": "IOS_APP_STORE",
          include: "bundleId,certificates",
          limit: 200,
        },
      });
      const matchingProfiles = (profilesRes?.data ?? []).filter(
        (profile) => profile?.relationships?.bundleId?.data?.id === bundleResourceId,
      );
      const now = Date.now();
      const reusable = matchingProfiles.find((profile) => {
        if (profile?.attributes?.profileState !== "ACTIVE") return false;
        const expMs = Date.parse(profile?.attributes?.expirationDate ?? "");
        if (Number.isNaN(expMs) || expMs - now < MIN_PROFILE_VALIDITY_MS) return false;
        const certRefs = profile?.relationships?.certificates?.data ?? [];
        return certRefs.some((ref) => ref.id === certificateId);
      });
      return { matchingProfiles, reusable: reusable ?? null };
    },

    async recreateAppStoreProfile({
      matchingProfiles,
      managedName,
      bundleResourceId,
      certificateId,
    }) {
      for (const stale of matchingProfiles) {
        const shouldRemove =
          stale?.attributes?.name === managedName || stale?.attributes?.profileState === "INVALID";
        if (!shouldRemove) continue;
        try {
          await request("DELETE", `/profiles/${stale.id}`);
        } catch {
          // Ignore cleanup errors for unrelated profiles.
        }
      }

      const created = await request("POST", "/profiles", {
        body: {
          data: {
            type: "profiles",
            attributes: {
              name: managedName,
              profileType: "IOS_APP_STORE",
            },
            relationships: {
              bundleId: { data: { type: "bundleIds", id: bundleResourceId } },
              certificates: { data: [{ type: "certificates", id: certificateId }] },
            },
          },
        },
      });
      return created.data;
    },

    async tryEnsurePushCapability(bundleId, bundleResourceId) {
      try {
        await this.ensurePushCapability(bundleResourceId);
      } catch (error) {
        console.error(
          `Warning: unable to verify/enable PUSH_NOTIFICATIONS capability on ${bundleId}: ${error.message}`,
        );
      }
    },

    async ensureAppStoreProfile(options) {
      const {
        bundleId,
        certSerialHex = null,
        profileName = null,
        autoRegisterBundleId = false,
        ensurePush = true,
        outputPath = null,
        installDir = null,
      } = options;
      const bundleResource = await this.ensureBundleId({
        bundleId,
        autoRegister: autoRegisterBundleId,
      });
      if (ensurePush) {
        await this.tryEnsurePushCapability(bundleId, bundleResource.id);
      }

      const certificate = await this.findDistributionCertificate(certSerialHex);
      const managedName = profileName || `Paseo Fork AppStore (${bundleId})`;
      const { matchingProfiles, reusable } = await this.findReusableProfile({
        bundleResourceId: bundleResource.id,
        certificateId: certificate.id,
      });

      const chosen =
        reusable ??
        (await this.recreateAppStoreProfile({
          matchingProfiles,
          managedName,
          bundleResourceId: bundleResource.id,
          certificateId: certificate.id,
        }));

      const rawBase64 = chosen?.attributes?.profileContent;
      if (!rawBase64) {
        throw new Error(
          `Provisioning profile "${chosen?.attributes?.name}" has empty profileContent.`,
        );
      }
      const profileBuffer = Buffer.from(rawBase64, "base64");
      const parsed = parseProvisioningProfile(profileBuffer);
      const writtenPath = writeProfileFile(outputPath, profileBuffer);
      const installedPath = installDir
        ? writeProfileFile(path.join(installDir, `${parsed.uuid}.mobileprovision`), profileBuffer)
        : null;
      const appRecord = await this.findAppByBundleId(bundleId);

      return {
        ...parsed,
        profileId: chosen.id,
        certificateId: certificate.id,
        certificateSerial: certificate.attributes?.serialNumber ?? null,
        createdNew: !reusable,
        profilePath: writtenPath,
        installedPath,
        appAppleId: appRecord?.id ?? null,
      };
    },

    async waitForProcessedBuild({ appId, appVersion, buildNumber, timeoutSec, pollIntervalSec }) {
      const deadline = Date.now() + timeoutSec * 1000;
      while (true) {
        const res = await request("GET", "/builds", {
          query: {
            "filter[app]": appId,
            "filter[preReleaseVersion.version]": appVersion,
            "filter[version]": buildNumber,
            limit: 5,
          },
        });
        const candidate = (res?.data ?? [])[0] ?? null;
        const state = candidate?.attributes?.processingState;
        if (state === "VALID") {
          return { timedOut: false, build: candidate };
        }
        if (state === "INVALID" || state === "FAILED") {
          throw new Error(
            `App Store Connect build ${appVersion} (${buildNumber}) failed processing (state=${state}).`,
          );
        }
        if (Date.now() >= deadline) {
          return {
            timedOut: true,
            buildId: candidate?.id ?? null,
            processingState: state ?? "NOT_VISIBLE_YET",
          };
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalSec * 1000));
      }
    },

    async updateBetaBuildWhatsNew({ buildId, whatsNew }) {
      if (!whatsNew || !whatsNew.trim()) return [];
      const trimmedNotes = whatsNew.trim().slice(0, 4000);
      const locsRes = await request("GET", `/builds/${buildId}/betaBuildLocalizations`, {
        query: { limit: 20 },
      });
      const existingLocs = locsRes?.data ?? [];
      const targetLocales =
        existingLocs.length > 0 ? existingLocs.map((l) => l.attributes.locale) : ["en-US"];

      const updatedLocales = [];
      for (const locale of targetLocales) {
        const existing = existingLocs.find((l) => l?.attributes?.locale === locale);
        if (existing) {
          await request("PATCH", `/betaBuildLocalizations/${existing.id}`, {
            body: {
              data: {
                type: "betaBuildLocalizations",
                id: existing.id,
                attributes: { whatsNew: trimmedNotes },
              },
            },
          });
        } else {
          await request("POST", "/betaBuildLocalizations", {
            body: {
              data: {
                type: "betaBuildLocalizations",
                attributes: { locale, whatsNew: trimmedNotes },
                relationships: { build: { data: { type: "builds", id: buildId } } },
              },
            },
          });
        }
        updatedLocales.push(locale);
      }
      return updatedLocales;
    },

    async attachBetaGroups({ appId, bundleId, buildId, groups }) {
      const cleanGroups = groups.map((g) => g.trim()).filter(Boolean);
      if (cleanGroups.length === 0) return [];
      const groupsRes = await request("GET", `/apps/${appId}/betaGroups`, {
        query: { limit: 100 },
      });
      const allGroups = groupsRes?.data ?? [];
      const attachedGroups = [];
      for (const wantedName of cleanGroups) {
        const matched = allGroups.find(
          (g) => g?.attributes?.name?.toLowerCase() === wantedName.toLowerCase(),
        );
        if (!matched) {
          console.error(
            `Warning: TestFlight beta group "${wantedName}" not found on app ${bundleId}.`,
          );
          continue;
        }
        await request("POST", `/betaGroups/${matched.id}/relationships/builds`, {
          body: { data: [{ type: "builds", id: buildId }] },
        });
        attachedGroups.push(matched.attributes.name);
      }
      return attachedGroups;
    },

    async syncTestFlightBuild({
      bundleId,
      appVersion,
      buildNumber,
      whatsNew = null,
      groups = [],
      timeoutSec = 180,
      pollIntervalSec = 15,
    }) {
      const appRecord = await this.findAppByBundleId(bundleId);
      if (!appRecord) {
        throw new Error(
          `App record for bundleId "${bundleId}" was not found in App Store Connect.`,
        );
      }

      const waitResult = await this.waitForProcessedBuild({
        appId: appRecord.id,
        appVersion,
        buildNumber,
        timeoutSec,
        pollIntervalSec,
      });
      if (waitResult.timedOut) {
        return {
          status: "processing_timeout",
          appAppleId: appRecord.id,
          buildId: waitResult.buildId,
          processingState: waitResult.processingState,
        };
      }

      const build = waitResult.build;
      const updatedLocales = await this.updateBetaBuildWhatsNew({ buildId: build.id, whatsNew });
      const attachedGroups = await this.attachBetaGroups({
        appId: appRecord.id,
        bundleId,
        buildId: build.id,
        groups,
      });

      return {
        status: "synced",
        appAppleId: appRecord.id,
        buildId: build.id,
        processingState: build.attributes?.processingState ?? "VALID",
        updatedLocales,
        attachedGroups,
      };
    },
  };
}

function writeProfileFile(targetPath, buffer) {
  if (!targetPath) return null;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

function readKeyMaterial(opts) {
  if (opts.keyFile) {
    return fs.readFileSync(opts.keyFile, "utf8");
  }
  return process.env.APPLE_API_KEY || process.env.APPLE_API_KEY_CONTENT || "";
}

const VALUE_FLAG_HANDLERS = {
  "--key-id": (opts, v) => {
    opts.keyId = v;
  },
  "--issuer-id": (opts, v) => {
    opts.issuerId = v;
  },
  "--key-file": (opts, v) => {
    opts.keyFile = path.resolve(v);
  },
  "--api-base": (opts, v) => {
    opts.apiBase = v;
  },
  "--bundle-id": (opts, v) => {
    opts.bundleId = v;
  },
  "--cert-serial": (opts, v) => {
    opts.certSerial = v;
  },
  "--profile-name": (opts, v) => {
    opts.profileName = v;
  },
  "--output": (opts, v) => {
    opts.outputPath = path.resolve(v);
  },
  "--install-dir": (opts, v) => {
    opts.installDir = path.resolve(v);
  },
  "--profile-file": (opts, v) => {
    opts.profileFile = path.resolve(v);
  },
  "--app-version": (opts, v) => {
    opts.appVersion = v;
  },
  "--base-build-number": (opts, v) => {
    opts.baseBuildNumber = v;
  },
  "--build-number": (opts, v) => {
    opts.buildNumber = v;
  },
  "--whats-new-file": (opts, v) => {
    opts.whatsNewFile = path.resolve(v);
  },
  "--groups": (opts, v) => {
    opts.groups = v;
  },
  "--timeout-sec": (opts, v) => {
    opts.timeoutSec = Number.parseInt(v || "180", 10);
  },
  "--poll-interval-sec": (opts, v) => {
    opts.pollIntervalSec = Number.parseInt(v || "15", 10);
  },
};

const BOOL_FLAG_HANDLERS = {
  "--install-default-dir": (opts) => {
    opts.installDir = path.join(os.homedir(), "Library/MobileDevice/Provisioning Profiles");
  },
  "--auto-register-bundle-id": (opts) => {
    opts.autoRegisterBundleId = true;
  },
  "--no-ensure-push": (opts) => {
    opts.ensurePush = false;
  },
  "-h": (opts) => {
    opts.help = true;
  },
  "--help": (opts) => {
    opts.help = true;
  },
};

function parseCliArgs(argv) {
  const [command = "", ...rest] = argv;
  const opts = {
    command,
    keyId: process.env.APPLE_API_KEY_ID || "",
    issuerId: process.env.APPLE_API_ISSUER || "",
    keyFile: "",
    apiBase: process.env.ASC_API_BASE || DEFAULT_ASC_API_BASE,
    bundleId: process.env.IOS_BUNDLE_ID || "",
    certSerial: "",
    profileName: "",
    outputPath: "",
    installDir: "",
    profileFile: "",
    appVersion: "",
    baseBuildNumber: "",
    buildNumber: "",
    whatsNewFile: "",
    groups: "",
    autoRegisterBundleId: false,
    ensurePush: true,
    timeoutSec: 180,
    pollIntervalSec: 15,
    help: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg in VALUE_FLAG_HANDLERS) {
      VALUE_FLAG_HANDLERS[arg](opts, rest[++i] ?? "");
    } else if (arg in BOOL_FLAG_HANDLERS) {
      BOOL_FLAG_HANDLERS[arg](opts);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage: node scripts/fork/ios-asc-api.mjs <command> [options]

Zero-dependency App Store Connect REST API helper for personal Fork TestFlight builds.

Commands:
  inspect-profile    Parse a local .mobileprovision file and emit JSON metadata
  write-key          Decode APPLE_API_KEY (PEM or base64) to a 0600 .p8 key file
  ensure-profile     Ensure an active IOS_APP_STORE provisioning profile exists & download it
  resolve-build      Look up ASC App ID and compute collision-free CFBundleVersion
  sync-testflight    Wait for build processing, attach What's New notes & optional beta groups
  check-app          Verify Bundle ID, App Store Connect app record, and Distribution certificate`);
}

function runLocalCommand(opts) {
  if (opts.command === "inspect-profile") {
    if (!opts.profileFile || !fs.existsSync(opts.profileFile)) {
      throw new Error(`--profile-file is required and must exist (got: ${opts.profileFile})`);
    }
    console.log(
      JSON.stringify(parseProvisioningProfile(fs.readFileSync(opts.profileFile)), null, 2),
    );
    return true;
  }
  if (opts.command === "write-key") {
    if (!opts.outputPath) {
      throw new Error("--output is required for write-key");
    }
    const pem = decodePrivateKeyPem(readKeyMaterial(opts));
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, `${pem}\n`, { mode: 0o600 });
    fs.chmodSync(opts.outputPath, 0o600);
    return true;
  }
  return false;
}

const API_COMMAND_HANDLERS = {
  async "ensure-profile"(client, opts) {
    if (!opts.bundleId) throw new Error("--bundle-id is required");
    return client.ensureAppStoreProfile({
      bundleId: opts.bundleId,
      certSerialHex: opts.certSerial || null,
      profileName: opts.profileName || null,
      autoRegisterBundleId: opts.autoRegisterBundleId,
      ensurePush: opts.ensurePush,
      outputPath: opts.outputPath || null,
      installDir: opts.installDir || null,
    });
  },
  async "resolve-build"(client, opts) {
    if (!opts.bundleId || !opts.appVersion || !opts.baseBuildNumber) {
      throw new Error("--bundle-id, --app-version, and --base-build-number are required");
    }
    const appRecord = await client.findAppByBundleId(opts.bundleId);
    if (!appRecord) {
      throw new Error(
        `App Store Connect app record not found for bundleId "${opts.bundleId}". Create the app placeholder once in App Store Connect -> Apps -> New App.`,
      );
    }
    const builds = await client.listBuildsForVersion({
      appId: appRecord.id,
      appVersion: opts.appVersion,
    });
    const existingBuildNumbers = builds.map((b) => b?.attributes?.version).filter(Boolean);
    const nextBuildNumber = computeNextBuildNumber({
      baseBuildNumber: opts.baseBuildNumber,
      existingBuildNumbers,
    });
    return {
      appAppleId: appRecord.id,
      bundleId: opts.bundleId,
      appVersion: opts.appVersion,
      baseBuildNumber: opts.baseBuildNumber,
      existingBuildNumbers,
      nextBuildNumber,
    };
  },
  async "sync-testflight"(client, opts) {
    if (!opts.bundleId || !opts.appVersion || !opts.buildNumber) {
      throw new Error("--bundle-id, --app-version, and --build-number are required");
    }
    const whatsNew =
      opts.whatsNewFile && fs.existsSync(opts.whatsNewFile)
        ? fs.readFileSync(opts.whatsNewFile, "utf8")
        : null;
    return client.syncTestFlightBuild({
      bundleId: opts.bundleId,
      appVersion: opts.appVersion,
      buildNumber: opts.buildNumber,
      whatsNew,
      groups: opts.groups ? opts.groups.split(",") : [],
      timeoutSec: opts.timeoutSec,
      pollIntervalSec: opts.pollIntervalSec,
    });
  },
  async "check-app"(client, opts) {
    if (!opts.bundleId) throw new Error("--bundle-id is required");
    const appRecord = await client.findAppByBundleId(opts.bundleId);
    let cert = null;
    let certError = null;
    try {
      cert = await client.findDistributionCertificate(opts.certSerial || null);
    } catch (error) {
      certError = error.message;
    }
    return {
      bundleId: opts.bundleId,
      appFound: Boolean(appRecord),
      appAppleId: appRecord?.id ?? null,
      appName: appRecord?.attributes?.name ?? null,
      distributionCertificateFound: Boolean(cert),
      distributionCertificateId: cert?.id ?? null,
      distributionCertificateSerial: cert?.attributes?.serialNumber ?? null,
      distributionCertificateError: certError,
    };
  },
};

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.command || opts.command === "-h" || opts.command === "--help" || opts.help) {
    printUsage();
    return;
  }
  if (runLocalCommand(opts)) return;

  const handler = API_COMMAND_HANDLERS[opts.command];
  if (!handler) {
    throw new Error(`Unknown command: ${opts.command}`);
  }
  const client = createAscClient({
    keyId: opts.keyId,
    issuerId: opts.issuerId,
    privateKeyPem: readKeyMaterial(opts),
    apiBase: opts.apiBase,
  });
  const result = await handler(client, opts);
  console.log(JSON.stringify(result, null, 2));
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
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
