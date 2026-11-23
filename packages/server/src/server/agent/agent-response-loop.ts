import { z } from "zod";
import Ajv, { type ErrorObject, type Options as AjvOptions } from "ajv";
import type { AgentProvider, AgentSessionConfig, AgentUsage } from "./agent-sdk-types.js";
import type { AgentManager } from "./agent-manager.js";

export interface StructuredGenerationLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export type JsonSchema = Record<string, unknown>;

export type AgentCaller = (prompt: string) => Promise<string>;

export class StructuredAgentResponseError extends Error {
  readonly lastResponse: string;
  readonly validationErrors: string[];

  constructor(message: string, options: { lastResponse: string; validationErrors: string[] }) {
    super(message);
    this.name = "StructuredAgentResponseError";
    this.lastResponse = options.lastResponse;
    this.validationErrors = options.validationErrors;
  }
}

export interface StructuredGenerationProvider {
  provider: AgentProvider;
  model?: string;
  thinkingOptionId?: string;
}

export interface StructuredGenerationAttempt {
  provider: AgentProvider;
  model: string | null;
  available: boolean;
  error: string | null;
}

export class StructuredAgentFallbackError extends Error {
  readonly attempts: StructuredGenerationAttempt[];

  constructor(attempts: StructuredGenerationAttempt[]) {
    const summary = attempts
      .map((attempt) => {
        const modelSuffix = attempt.model ? ` (${attempt.model})` : "";
        if (!attempt.available) {
          return `${attempt.provider}${modelSuffix}: unavailable${attempt.error ? ` (${attempt.error})` : ""}`;
        }
        return `${attempt.provider}${modelSuffix}: failed${attempt.error ? ` (${attempt.error})` : ""}`;
      })
      .join("; ");

    super(
      summary.length > 0
        ? `Structured generation failed for all providers: ${summary}`
        : "Structured generation failed for all providers",
    );
    this.name = "StructuredAgentFallbackError";
    this.attempts = attempts;
  }
}

export interface StructuredAgentResponseOptions<T> {
  caller: AgentCaller;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  maxRetries?: number;
  schemaName?: string;
}

export interface StructuredAgentGenerationOptions<T> {
  manager: AgentManager;
  agentConfig: AgentSessionConfig;
  agentId?: string;
  persistSession?: boolean;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  maxRetries?: number;
  schemaName?: string;
  onUsage?: (usage: AgentUsage, meta: { provider: AgentProvider; model: string | null }) => void;
}

export interface StructuredAgentGenerationWithFallbackOptions<T> {
  manager: AgentManager;
  cwd: string;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  providers: readonly StructuredGenerationProvider[];
  agentConfigOverrides?: Omit<
    AgentSessionConfig,
    "provider" | "cwd" | "model" | "thinkingOptionId"
  >;
  persistSession?: boolean;
  maxRetries?: number;
  schemaName?: string;
  logger?: StructuredGenerationLogger;
  runner?: <TResult>(options: StructuredAgentGenerationOptions<TResult>) => Promise<TResult>;
  /** Cooldown duration after a provider auth hard failure (401/403/OAuth expired) during multi-provider fallback. */
  authFailureCooldownMs?: number;
  now?: () => number;
  onUsage?: (usage: AgentUsage, meta: { provider: AgentProvider; model: string | null }) => void;
}

// Re-export from the legacy module path so existing server consumers keep working.
export { DEFAULT_STRUCTURED_GENERATION_PROVIDERS } from "./structured-generation-providers.js";

interface SchemaValidator<T> {
  jsonSchema: JsonSchema;
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof (value as z.ZodType | undefined)?.safeParse === "function";
}

function buildZodValidator<T>(schema: z.ZodType, schemaName: string): SchemaValidator<T> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  }) as JsonSchema;
  if (typeof jsonSchema.title !== "string") {
    jsonSchema.title = schemaName;
  }
  return {
    jsonSchema,
    validate: (value) => {
      const result = schema.safeParse(value);
      if (result.success) {
        return { ok: true, value: result.data as T };
      }
      const errors = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      });
      return { ok: false, errors };
    },
  };
}

function buildJsonSchemaValidator<T>(schema: JsonSchema): SchemaValidator<T> {
  const AjvConstructor = Ajv as unknown as {
    new (options?: AjvOptions): {
      compile: (input: JsonSchema) => ((value: unknown) => boolean) & {
        errors?: ErrorObject[] | null;
      };
    };
  };
  const ajv = new AjvConstructor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return {
    jsonSchema: schema,
    validate: (value) => {
      const ok = validate(value);
      if (ok) {
        return { ok: true, value: value as T };
      }
      const errors = (validate.errors ?? []).map((error: ErrorObject) => {
        const path =
          error.instancePath && error.instancePath.length > 0 ? error.instancePath : "(root)";
        const message = error.message ?? "is invalid";
        return `${path}: ${message}`;
      });
      return { ok: false, errors };
    },
  };
}

function buildValidator<T>(
  schema: z.ZodType<T> | JsonSchema,
  schemaName: string,
): SchemaValidator<T> {
  if (isZodSchema(schema)) {
    return buildZodValidator(schema, schemaName);
  }
  return buildJsonSchemaValidator(schema);
}

function buildBasePrompt(prompt: string, jsonSchema: JsonSchema): string {
  const schemaText = JSON.stringify(jsonSchema, null, 2);
  return [
    prompt.trim(),
    "",
    "You must respond with JSON only that matches this JSON Schema:",
    schemaText,
  ].join("\n");
}

export function buildStructuredAgentResponsePrompt(options: {
  prompt: string;
  schema: z.ZodType | JsonSchema;
  schemaName?: string;
}): string {
  const validator = buildValidator(options.schema, options.schemaName ?? "Response");
  return buildBasePrompt(options.prompt, validator.jsonSchema);
}

function buildRetryPrompt(basePrompt: string, errors: string[]): string {
  const formattedErrors = errors.map((error) => `- ${error}`).join("\n");
  return [
    basePrompt,
    "",
    "Previous response was invalid with validation errors:",
    formattedErrors.length > 0 ? formattedErrors : "- Unknown validation error",
    "",
    "Respond again with JSON only that matches the schema.",
  ].join("\n");
}

function extractJsonFromMarkdown(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const extracted = extractFirstJsonSnippet(text);
  if (extracted) {
    return extracted;
  }

  return text.trim();
}

function tryParseJson(candidate: string): string | null {
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function extractBalancedJsonCandidate(source: string, start: number): string | null {
  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch !== close) {
      continue;
    }
    depth -= 1;
    if (depth !== 0) {
      continue;
    }
    const candidate = source.slice(start, i + 1).trim();
    const parsed = tryParseJson(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function extractFirstJsonSnippet(text: string): string | null {
  const source = text.trim();
  if (!source) {
    return null;
  }

  // Try to find the first valid JSON object/array within a larger response.
  // This is intentionally provider-agnostic and improves resilience when models
  // add extra prose before/after the JSON.
  const startIndexes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "[") {
      startIndexes.push(i);
    }
  }

  for (const start of startIndexes) {
    const candidate = extractBalancedJsonCandidate(source, start);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

export async function getStructuredAgentResponse<T>(
  options: StructuredAgentResponseOptions<T>,
): Promise<T> {
  const { caller, prompt, schema, maxRetries = 2, schemaName = "Response" } = options;
  const validator = buildValidator(schema, schemaName);
  const basePrompt = buildBasePrompt(prompt, validator.jsonSchema);

  let attemptPrompt = basePrompt;
  let lastResponse = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await caller(attemptPrompt);
    lastResponse = response;
    const jsonText = extractJsonFromMarkdown(response);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrors = [`Invalid JSON: ${message}`];
      if (attempt === maxRetries) {
        break;
      }
      attemptPrompt = buildRetryPrompt(basePrompt, lastErrors);
      continue;
    }

    const validation = validator.validate(parsed);
    if (validation.ok) {
      return validation.value;
    }

    lastErrors = validation.errors;
    if (attempt === maxRetries) {
      break;
    }
    attemptPrompt = buildRetryPrompt(basePrompt, lastErrors);
  }

  throw new StructuredAgentResponseError("Agent response did not match the required JSON schema", {
    lastResponse,
    validationErrors: lastErrors,
  });
}

export async function generateStructuredAgentResponse<T>(
  options: StructuredAgentGenerationOptions<T>,
): Promise<T> {
  const {
    manager,
    agentConfig,
    agentId,
    persistSession,
    prompt,
    schema,
    maxRetries,
    schemaName,
    onUsage,
  } = options;
  // Structured generation runs ephemeral helper turns; default to internal so callers that omit
  // `internal` never persist junk sessions into visible workspaces or trigger fleet listeners.
  const resolvedAgentConfig: AgentSessionConfig = {
    ...agentConfig,
    internal: agentConfig.internal ?? true,
  };
  const agent = await manager.createAgent(resolvedAgentConfig, agentId, {
    persistSession,
    workspaceId: undefined,
  });
  try {
    const caller: AgentCaller = async (nextPrompt) => {
      const result = await manager.runAgent(agent.id, nextPrompt);
      if (result.usage && onUsage) {
        onUsage(result.usage, {
          provider: resolvedAgentConfig.provider,
          model: resolvedAgentConfig.model ?? null,
        });
      }
      if (typeof result.finalText === "string" && result.finalText.length > 0) {
        return result.finalText;
      }
      // Fallback for providers that may not populate finalText consistently.
      const lastAssistant = result.timeline.findLast((item) => item.type === "assistant_message");
      return lastAssistant?.text ?? "";
    };
    return await getStructuredAgentResponse({
      caller,
      prompt,
      schema,
      maxRetries,
      schemaName,
    });
  } finally {
    try {
      await manager.closeAgent(agent.id);
    } catch {
      // ignore cleanup errors
    } finally {
      await manager.deleteAgentState(agent.id).catch(() => undefined);
    }
  }
}

const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

const STRUCTURED_GENERATION_AUTH_ERROR_PATTERNS = [
  /failed to authenticate/i,
  /oauth.*expired/i,
  /api key.*(expired|invalid|missing|revoked)/i,
  /invalid[_ ]api[_ ]key/i,
  /invalid[_ ]token/i,
  /not logged in/i,
  /please run \/login/i,
  /"statusCode"\s*:\s*(401|403)\b/,
  /\b(401|403)\b.*(unauthorized|forbidden|expired|invalid|auth)/i,
];

interface AuthFailureCooldownEntry {
  expiresAt: number;
  reason: string;
}

const authFailureCooldownByManager = new WeakMap<
  AgentManager,
  Map<AgentProvider, AuthFailureCooldownEntry>
>();

export function isStructuredGenerationAuthFailure(message: string): boolean {
  return STRUCTURED_GENERATION_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getAuthCooldownEntry(
  manager: AgentManager,
  provider: AgentProvider,
  currentTimeMs: number,
): AuthFailureCooldownEntry | null {
  const byProvider = authFailureCooldownByManager.get(manager);
  if (!byProvider) return null;
  const entry = byProvider.get(provider);
  if (!entry) return null;
  if (entry.expiresAt <= currentTimeMs) {
    byProvider.delete(provider);
    return null;
  }
  return entry;
}

function recordAuthCooldown(
  manager: AgentManager,
  provider: AgentProvider,
  reason: string,
  currentTimeMs: number,
  cooldownMs: number,
): void {
  let byProvider = authFailureCooldownByManager.get(manager);
  if (!byProvider) {
    byProvider = new Map();
    authFailureCooldownByManager.set(manager, byProvider);
  }
  byProvider.set(provider, {
    expiresAt: currentTimeMs + cooldownMs,
    reason,
  });
}

function clearAuthCooldown(manager: AgentManager, provider: AgentProvider): void {
  authFailureCooldownByManager.get(manager)?.delete(provider);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function checkStructuredGenerationCandidate(options: {
  manager: AgentManager;
  candidate: StructuredGenerationProvider;
  enforceCooldown: boolean;
  nowMs: number;
  schemaName?: string;
  logger?: StructuredGenerationLogger;
}): Promise<StructuredGenerationAttempt | null> {
  const { manager, candidate, enforceCooldown, nowMs, schemaName, logger } = options;
  if (enforceCooldown) {
    const cooled = getAuthCooldownEntry(manager, candidate.provider, nowMs);
    if (cooled) {
      const reason = `auth failure cooldown (${cooled.reason})`;
      logger?.warn(
        { provider: candidate.provider, model: candidate.model, schemaName, reason },
        "Structured generation: skipping provider in auth failure cooldown",
      );
      return {
        provider: candidate.provider,
        model: candidate.model ?? null,
        available: false,
        error: reason,
      };
    }
  }

  const availabilityEntry = await manager.getProviderAvailability(candidate.provider);
  if (!availabilityEntry.available) {
    const reason = availabilityEntry.error ?? "unavailable";
    logger?.warn(
      { provider: candidate.provider, model: candidate.model, schemaName, reason },
      "Structured generation: skipping unavailable provider",
    );
    return {
      provider: candidate.provider,
      model: candidate.model ?? null,
      available: false,
      error: availabilityEntry.error ?? null,
    };
  }

  return null;
}

export async function generateStructuredAgentResponseWithFallback<T>(
  options: StructuredAgentGenerationWithFallbackOptions<T>,
): Promise<T> {
  const {
    manager,
    cwd,
    prompt,
    schema,
    providers,
    agentConfigOverrides,
    persistSession,
    maxRetries,
    schemaName,
    logger,
    runner,
    authFailureCooldownMs = DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
    now,
    onUsage,
  } = options;

  if (providers.length === 0) {
    throw new StructuredAgentFallbackError([]);
  }

  const runStructured =
    runner ??
    ((input: StructuredAgentGenerationOptions<T>) => generateStructuredAgentResponse<T>(input));
  const attempts: StructuredGenerationAttempt[] = [];
  const getNowMs = () => (now ? now() : Date.now());
  const enforceCooldown = authFailureCooldownMs > 0 && providers.length > 1;

  for (const candidate of providers) {
    const skippedAttempt = await checkStructuredGenerationCandidate({
      manager,
      candidate,
      enforceCooldown,
      nowMs: getNowMs(),
      schemaName,
      logger,
    });
    if (skippedAttempt) {
      attempts.push(skippedAttempt);
      continue;
    }

    try {
      const result = await runStructured({
        manager,
        prompt,
        schema,
        maxRetries,
        schemaName,
        persistSession,
        onUsage,
        agentConfig: {
          ...agentConfigOverrides,
          provider: candidate.provider,
          cwd,
          ...(candidate.model ? { model: candidate.model } : {}),
          ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
        },
      });
      clearAuthCooldown(manager, candidate.provider);
      if (attempts.length > 0) {
        logger?.info(
          {
            provider: candidate.provider,
            model: candidate.model,
            schemaName,
            priorAttempts: attempts,
          },
          "Structured generation: succeeded after fallback",
        );
      }
      return result;
    } catch (error) {
      const message = errorMessage(error);
      if (authFailureCooldownMs > 0 && isStructuredGenerationAuthFailure(message)) {
        recordAuthCooldown(
          manager,
          candidate.provider,
          message.slice(0, 160),
          getNowMs(),
          authFailureCooldownMs,
        );
      }
      attempts.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        available: true,
        error: message,
      });
      logger?.warn(
        { err: error, provider: candidate.provider, model: candidate.model, schemaName },
        "Structured generation: provider failed",
      );
    }
  }

  throw new StructuredAgentFallbackError(attempts);
}

const EXPLICIT_SILENT_SENTINEL_RE =
  /^(?:`*(?:\[silent\]|silent|no_action|\[no_action\]|<silent\s*\/>|<silent>\s*<\/silent>)`*)[.。!！\s]*$/i;

const PLACEHOLDER_EMPTY_REPLY_RE =
  /^(?:\(no content\)|no content|no response requested|no response needed|no_response|\[no_response\])[.。!！\s]*$/i;

export function isExplicitSilentSentinel(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return EXPLICIT_SILENT_SENTINEL_RE.test(trimmed);
}

export function isPlaceholderEmptyReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDER_EMPTY_REPLY_RE.test(trimmed);
}

export interface SilentBackgroundReplyCheckInput {
  assistantTexts: readonly string[];
  hadUserFacingCardTool: boolean;
}

export function isSilentBackgroundReply(input: SilentBackgroundReplyCheckInput): boolean {
  if (input.hadUserFacingCardTool) return false;
  const combined = input.assistantTexts
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (combined.length === 0) return true;
  return isExplicitSilentSentinel(combined) || isPlaceholderEmptyReply(combined);
}

export interface MissingFinalReplyCheckInput {
  hadToolCalls: boolean;
  assistantTexts: readonly string[];
  canceled: boolean;
  failed: boolean;
  isBackground: boolean;
  isSilent: boolean;
  alreadyRecovered: boolean;
}

export function shouldRecoverMissingFinalReply(input: MissingFinalReplyCheckInput): boolean {
  if (
    !input.hadToolCalls ||
    input.canceled ||
    input.failed ||
    input.isBackground ||
    input.isSilent ||
    input.alreadyRecovered
  ) {
    return false;
  }
  const combined = input.assistantTexts
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (isExplicitSilentSentinel(combined)) {
    return false;
  }
  return isPlaceholderEmptyReply(combined);
}

export function buildMissingReplyRecoveryPrompt(): string {
  return [
    "【系统自动补答提醒】",
    "上一轮你在响应用户消息时调用了工具，但最终没有向用户输出任何可见自然语言回复。",
    "请**不要再调用任何工具**，直接基于已有工具结果，用简洁清晰的中文向用户给出结论与下一步建议。",
  ].join("\n");
}
