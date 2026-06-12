import type {
  Message,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { createSignal, Show } from "solid-js";

const PLUGIN_ID = "provider-usage";
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const CODEX_ACCOUNTS_PATH = join(homedir(), ".opencode", "oc-codex-multi-auth-accounts.json");
const SECRETS_ENV_PATH = join(homedir(), ".config", "opencode", "secrets.env");
const MODEL_STATE_PATH = join(homedir(), ".local", "state", "opencode", "model.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const REFRESH_MS = 10_000;
const VISIBILITY_REFRESH_MS = 1_000;
const JET_PASTEL_MIX = 0.28;

const ZEN_FALLBACK_MODEL_COSTS: Record<string, ZenModelCost> = {
  "big-pickle": { input: 0, output: 0 },
  "claude-3-5-haiku": { input: 0, output: 0 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "deepseek-v4-flash-free": { input: 0, output: 0 },
  "gemini-3-flash": { input: 0.5, output: 3 },
  "gemini-3.1-pro": { input: 2, output: 12 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "glm-5": { input: 1, output: 3.2 },
  "glm-5.1": { input: 1.4, output: 4.4 },
  "gpt-5": { input: 1.07, output: 8.5 },
  "gpt-5-codex": { input: 1.07, output: 8.5 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5.1": { input: 1.07, output: 8.5 },
  "gpt-5.1-codex": { input: 1.07, output: 8.5 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.2-codex": { input: 1.75, output: 14 },
  "gpt-5.3-codex": { input: 1.75, output: 14 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-pro": { input: 30, output: 180 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "grok-build-0.1": { input: 1, output: 2 },
  "kimi-k2.5": { input: 0.6, output: 3 },
  "kimi-k2.6": { input: 0.95, output: 4 },
  "minimax-m2.5": { input: 0.3, output: 1.2 },
  "minimax-m2.7": { input: 0.3, output: 1.2 },
  "mimo-v2.5-free": { input: 0, output: 0 },
  "nemotron-3-super-free": { input: 0, output: 0 },
  "qwen3.5-plus": { input: 0.2, output: 1.2 },
  "qwen3.6-plus": { input: 0.5, output: 3 },
};

type Rgb = [number, number, number];

const JET_STOPS: Array<{ at: number; color: Rgb }> = [
  { at: 0, color: [0, 0, 1] },
  { at: 0.25, color: [0, 1, 1] },
  { at: 0.5, color: [0, 1, 0] },
  { at: 0.75, color: [1, 1, 0] },
  { at: 1, color: [1, 0, 0] },
];

type WindowSnapshot = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

type UsagePayload = {
  plan_type?: string;
  rate_limit?: {
    primary_window?: WindowSnapshot;
    secondary_window?: WindowSnapshot;
  };
};

type ProviderHint = {
  providerID?: string;
  modelID?: string;
};

type CodexAccount = {
  accountId?: string;
  accessToken?: string;
  enabled?: boolean;
};

type CodexAccountStorage = {
  accounts?: CodexAccount[];
  activeIndex?: number;
  activeIndexByFamily?: Record<string, number>;
};

type CopilotQuotaSnapshot = {
  percent_remaining?: number;
  remaining?: number;
  entitlement?: number;
};

type CopilotUsagePayload = {
  copilot_plan?: string;
  access_type_sku?: string;
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaSnapshot;
  };
};

type AnthropicRateLimit = {
  requestsRemaining?: number;
  requestsResetAt?: number;
  inputTokensRemaining?: number;
  outputTokensRemaining?: number;
};

type ZenModelCost = {
  input?: number;
  output?: number;
};

type SessionUsageSnapshot = {
  cost?: number;
  tokens?: number;
  approximate?: boolean;
};

type ZenPriceResult = {
  cost?: ZenModelCost;
  fallback?: boolean;
};

type ZenModelsPayload = {
  data?: Array<{
    id?: string;
    cost?: {
      input?: number;
      output?: number;
    };
  }>;
};

type ActiveProvider = "openai" | "copilot" | "anthropic" | "zen" | "other";

type ProviderResolution = {
  provider: ActiveProvider;
  hint: ProviderHint;
  sessionID?: string;
  generation: number;
  key: string;
};

type UsageState =
  | { status: "loading" }
  | {
      status: "ready";
      provider: ActiveProvider;
      planType?: string;
      accountEmail?: string;
      primary?: WindowSnapshot;
      secondary?: WindowSnapshot;
      copilot?: {
        plan?: string;
        usedPercent?: number;
        remaining?: number;
        entitlement?: number;
        resetAt?: number;
      };
      anthropic?: AnthropicRateLimit;
      zen?: {
        price?: ZenModelCost;
        priceFallback?: boolean;
        session?: SessionUsageSnapshot;
      };
      updatedAt: number;
    }
  | { status: "error"; message: string };

type SessionMessageRecord = {
  info?: Message;
};

type LiveSessionUsageProvider = {
  matches: (providerID?: string, modelID?: string) => boolean;
  exactSessionUsage: (api: TuiPluginApi, sessionID?: string) => SessionUsageSnapshot | undefined;
  estimateTokens: (text: string) => number;
  outputPrice: (state: Extract<UsageState, { status: "ready" }>) => number | undefined;
  applyEstimate: (
    state: Extract<UsageState, { status: "ready" }>,
    estimate: SessionUsageSnapshot,
  ) => Extract<UsageState, { status: "ready" }>;
};

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeJwtPayload(access: string): Record<string, unknown> | undefined {
  const tokenParts = String(access).split(".");
  if (tokenParts.length < 2) return undefined;
  return JSON.parse(decodeBase64Url(tokenParts[1]));
}

function extractChatGptAccountId(access: string): string | undefined {
  const payload = decodeJwtPayload(access);
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function extractJwtEmail(access: string): string | undefined {
  const payload = decodeJwtPayload(access);
  return typeof payload?.email === "string" ? payload.email : undefined;
}

function readCodexAccounts(): CodexAccountStorage | undefined {
  if (!existsSync(CODEX_ACCOUNTS_PATH)) return undefined;
  const raw = JSON.parse(readFileSync(CODEX_ACCOUNTS_PATH, "utf8"));
  if (!Array.isArray(raw?.accounts)) return undefined;
  return raw as CodexAccountStorage;
}

function hasGlobalCodexAccounts(): boolean {
  try {
    const storage = readCodexAccounts();
    return Boolean(storage?.accounts?.some((account) => account?.enabled !== false && account?.accessToken));
  } catch {
    return false;
  }
}

function readCodexOpenAIAuth(): { access: string; accountId: string; email?: string } | undefined {
  const storage = readCodexAccounts();
  const accounts = storage?.accounts ?? [];
  if (accounts.length === 0) return undefined;
  const rawIndex = storage?.activeIndexByFamily?.codex ?? storage?.activeIndex ?? 0;
  const activeIndex = Number.isFinite(rawIndex) ? Math.max(0, Math.min(accounts.length - 1, Math.trunc(rawIndex))) : 0;
  const activeAccount = accounts[activeIndex];
  const account = activeAccount?.enabled !== false ? activeAccount : accounts.find((candidate) => candidate?.enabled !== false);
  const access = account?.accessToken;
  if (!access) return undefined;
  const accountId = account.accountId ?? extractChatGptAccountId(access);
  if (!accountId) return undefined;
  return { access, accountId, email: extractJwtEmail(access) };
}

function readOpenAIAuth(): { access: string; accountId: string; email?: string } {
  const codexAuth = readCodexOpenAIAuth();
  if (codexAuth) return codexAuth;

  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const openai = raw?.openai;
  if (!openai?.access) {
    throw new Error("OpenAI auth not found");
  }

  const accountId = extractChatGptAccountId(openai.access);
  if (!accountId) {
    throw new Error("ChatGPT account id not found in token");
  }

  return { access: openai.access, accountId, email: extractJwtEmail(openai.access) };
}

function readCopilotAuth(): { access: string } {
  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const copilot = raw?.["github-copilot"];
  if (!copilot?.access) {
    throw new Error("GitHub Copilot auth not found");
  }
  return { access: copilot.access };
}

function readAnthropicAuth(): { key: string } {
  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const anthropic = raw?.anthropic;
  if (!anthropic?.key) {
    throw new Error("Anthropic auth not found");
  }
  return { key: anthropic.key };
}

function readEnvVarFromFile(path: string, key: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const name = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (name === key) return value;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function readZenAuth(): { key: string } {
  const envKey = process.env.OPENCODE_API_KEY;
  if (envKey) return { key: envKey };

  const fileKey = readEnvVarFromFile(SECRETS_ENV_PATH, "OPENCODE_API_KEY");
  if (fileKey) return { key: fileKey };

  try {
    const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const opencode = raw?.opencode;
    if (opencode?.key) return { key: opencode.key };
  } catch {
    // ignore
  }

  throw new Error("OpenCode Zen auth not found");
}

async function fetchOpenAIUsage(): Promise<Exclude<UsageState, { status: "loading" | "error" }>> {
  const auth = readOpenAIAuth();
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "ChatGPT-Account-Id": auth.accountId,
      "User-Agent": "opencode-provider-usage",
    },
  });

  if (!response.ok) {
    throw new Error(`Usage request failed (${response.status})`);
  }

  const payload = (await response.json()) as UsagePayload;
  return {
    status: "ready",
    provider: "openai",
    planType: payload.plan_type,
    accountEmail: auth.email,
    primary: payload.rate_limit?.primary_window,
    secondary: payload.rate_limit?.secondary_window,
    updatedAt: Date.now(),
  };
}

function inferCopilotPlan(payload: CopilotUsagePayload, quota?: CopilotQuotaSnapshot): string | undefined {
  const entitlement = quota?.entitlement;
  if (entitlement === 1500) return "Pro+";
  if (entitlement === 300) return "Pro";
  if (entitlement === 50) return "Free";

  const sku = (payload.access_type_sku ?? "").toLowerCase();
  if (sku.includes("pro_plus") || sku.includes("pro+")) return "Pro+";
  if (sku.includes("pro")) return "Pro";
  if (sku.includes("free")) return "Free";
  return undefined;
}

async function fetchCopilotUsage(): Promise<Exclude<UsageState, { status: "loading" | "error" }>> {
  const auth = readCopilotAuth();
  const response = await fetch(COPILOT_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-provider-usage",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`Copilot usage request failed (${response.status})`);
  }

  const payload = (await response.json()) as CopilotUsagePayload;
  const quota = payload.quota_snapshots?.premium_interactions;
  const entitlement = quota?.entitlement;
  const remaining = quota?.remaining;
  const usedPercent =
    typeof quota?.percent_remaining === "number"
      ? Math.round((100 - quota.percent_remaining) * 10) / 10
      : typeof entitlement === "number" && typeof remaining === "number" && entitlement > 0
        ? Math.round(((entitlement - remaining) / entitlement) * 1000) / 10
        : undefined;

  return {
    status: "ready",
    provider: "copilot",
    copilot: {
      plan: inferCopilotPlan(payload, quota),
      usedPercent,
      remaining,
      entitlement,
      resetAt: payload.quota_reset_date_utc ? Date.parse(payload.quota_reset_date_utc) : undefined,
    },
    updatedAt: Date.now(),
  };
}

function parseHeaderNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseHeaderTime(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeZenModelID(modelID?: string): string {
  return (modelID ?? "").toLowerCase().replace(/^opencode\//, "");
}

function hasZenModelCost(cost?: ZenModelCost): cost is ZenModelCost {
  return typeof cost?.input === "number" && typeof cost?.output === "number";
}

async function fetchAnthropicUsage(modelID: string): Promise<Exclude<UsageState, { status: "loading" | "error" }>> {
  const auth = readAnthropicAuth();
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": auth.key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "User-Agent": "opencode-provider-usage",
    },
    body: JSON.stringify({
      model: modelID,
      max_tokens: 0,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic usage request failed (${response.status})`);
  }

  return {
    status: "ready",
    provider: "anthropic",
    anthropic: {
      requestsRemaining: parseHeaderNumber(response.headers.get("anthropic-ratelimit-requests-remaining")),
      requestsResetAt: parseHeaderTime(response.headers.get("anthropic-ratelimit-requests-reset")),
      inputTokensRemaining: parseHeaderNumber(response.headers.get("anthropic-ratelimit-input-tokens-remaining")),
      outputTokensRemaining: parseHeaderNumber(response.headers.get("anthropic-ratelimit-output-tokens-remaining")),
    },
    updatedAt: Date.now(),
  };
}

async function fetchZenModelCost(modelID?: string): Promise<ZenPriceResult | undefined> {
  if (!modelID) return undefined;
  const normalizedModelID = normalizeZenModelID(modelID);
  const fallback = ZEN_FALLBACK_MODEL_COSTS[normalizedModelID];

  try {
    const auth = readZenAuth();
    const response = await fetch(ZEN_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${auth.key}`,
        "User-Agent": "opencode-provider-usage",
      },
    });

    if (!response.ok) {
      return fallback ? { cost: fallback, fallback: true } : undefined;
    }

    const payload = (await response.json()) as ZenModelsPayload;
    const model = payload.data?.find((item) => normalizeZenModelID(item.id) === normalizedModelID);
    if (hasZenModelCost(model?.cost)) {
      return { cost: model.cost, fallback: false };
    }
  } catch {
    // ignore
  }

  return fallback ? { cost: fallback, fallback: true } : undefined;
}

function sessionZenUsage(api: TuiPluginApi, sessionID?: string): SessionUsageSnapshot | undefined {
  if (!sessionID) return undefined;
  const messages = api.state.session.messages(sessionID) as Array<
    Message & {
      cost?: number;
      tokens?: {
        total?: number;
      };
    }
  >;
  let cost = 0;
  let tokens = 0;
  let found = false;

  for (const message of messages) {
    if (!isOpenCodeZenProvider(message.providerID, message.modelID)) continue;
    found = true;
    if (typeof message.cost === "number" && Number.isFinite(message.cost)) cost += message.cost;
    if (typeof message.tokens?.total === "number" && Number.isFinite(message.tokens.total)) tokens += message.tokens.total;
  }

  return found ? { cost, tokens } : undefined;
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function addLiveEstimate(base: SessionUsageSnapshot | undefined, tokens: number, outputPrice?: number): SessionUsageSnapshot {
  const baseTokens = typeof base?.tokens === "number" && Number.isFinite(base.tokens) ? base.tokens : 0;
  const baseCost = typeof base?.cost === "number" && Number.isFinite(base.cost) ? base.cost : undefined;
  const estimatedCost = typeof outputPrice === "number" && Number.isFinite(outputPrice) ? (tokens * outputPrice) / 1_000_000 : undefined;
  return {
    tokens: baseTokens + tokens,
    cost:
      typeof baseCost === "number" || typeof estimatedCost === "number"
        ? (baseCost ?? 0) + (estimatedCost ?? 0)
        : undefined,
    approximate: true,
  };
}

async function fetchZenUsage(
  api: TuiPluginApi,
  modelID: string | undefined,
  sessionID?: string,
): Promise<Exclude<UsageState, { status: "loading" | "error" }>> {
  const price = await fetchZenModelCost(modelID);
  return {
    status: "ready",
    provider: "zen",
    zen: {
      price: price?.cost,
      priceFallback: price?.fallback,
      session: sessionZenUsage(api, sessionID),
    },
    updatedAt: Date.now(),
  };
}

function formatPlan(planType?: string): string | undefined {
  if (!planType) return undefined;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

function formatOpenAIAccount(planType?: string, email?: string): string | undefined {
  const plan = formatPlan(planType);
  const trimmedEmail = email?.trim();
  if (trimmedEmail && plan) return `[${trimmedEmail} ${plan}]`;
  if (trimmedEmail) return `[${trimmedEmail}]`;
  return plan ? `[${plan}]` : undefined;
}

function formatAbsoluteReset(resetAt?: number): string | undefined {
  if (typeof resetAt !== "number" || Number.isNaN(resetAt)) return undefined;
  const seconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
  return formatReset({ reset_after_seconds: seconds });
}

function formatCountdown(resetAt?: number): string | undefined {
  if (typeof resetAt !== "number" || Number.isNaN(resetAt)) return undefined;
  const totalSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
  if (totalSeconds <= 1) return undefined;
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function formatWindowLabel(window?: WindowSnapshot, fallback?: string): string {
  const seconds = window?.limit_window_seconds;
  if (!seconds) return fallback ?? "limit";
  if (Math.abs(seconds - 18_000) < 120) return "5h";
  if (Math.abs(seconds - 604_800) < 600) return "7d";
  if (seconds % 86_400 === 0) return `${Math.round(seconds / 86_400)}d`;
  if (seconds % 3_600 === 0) return `${Math.round(seconds / 3_600)}h`;
  return fallback ?? "limit";
}

function formatReset(window?: WindowSnapshot): string | undefined {
  const seconds = window?.reset_after_seconds;
  if (typeof seconds !== "number") return undefined;

  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }

  return `${minutes}m`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toHexByte(value: number): string {
  return Math.round(clamp(value, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
}

function jetColor(usedPercent: number): string {
  const value = clamp(usedPercent, 0, 100) / 100;
  const [rawRed, rawGreen, rawBlue] = interpolateJet(value);
  const red = pastelize(rawRed);
  const green = pastelize(rawGreen);
  const blue = pastelize(rawBlue);
  return `#${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}`;
}

function interpolateJet(value: number): Rgb {
  for (let i = 1; i < JET_STOPS.length; i += 1) {
    const previous = JET_STOPS[i - 1];
    const next = JET_STOPS[i];
    if (value <= next.at) {
      const span = next.at - previous.at;
      const amount = span === 0 ? 0 : (value - previous.at) / span;
      return [
        previous.color[0] + (next.color[0] - previous.color[0]) * amount,
        previous.color[1] + (next.color[1] - previous.color[1]) * amount,
        previous.color[2] + (next.color[2] - previous.color[2]) * amount,
      ];
    }
  }
  return JET_STOPS[JET_STOPS.length - 1].color;
}

function pastelize(channel: number): number {
  return channel * (1 - JET_PASTEL_MIX) + JET_PASTEL_MIX;
}

function usageColor(theme: TuiThemeCurrent, usedPercent?: number) {
  if (typeof usedPercent !== "number") return theme.textMuted;
  return jetColor(usedPercent);
}

function formatCompactNumber(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  if (Math.abs(value) < 1_000) return `${Math.round(value)}`;
  if (Math.abs(value) < 10_000) return `${Math.round(value / 100) / 10}k`;
  if (Math.abs(value) < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value / 100_000) / 10}m`;
}

function formatMoney(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  if (value === 0) return "$0";
  return `$${Math.round(value * 100) / 100}`;
}

function isOpenAIUsageProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  if (provider.includes("copilot") || model.includes("copilot")) return false;
  if (provider.includes("openai") || provider.includes("chatgpt") || provider.includes("codex")) return true;
  if (model.includes("codex")) return true;
  return false;
}

function isCopilotProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  return provider.includes("copilot") || model.includes("copilot");
}

function isAnthropicProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  return provider.includes("anthropic") || model.includes("claude");
}

function isOpenCodeGoProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  return provider === "opencode-go" || model === "go" || model.startsWith("go-") || model.includes("opencode-go");
}

function isKnownZenModelID(modelID?: string): boolean {
  const model = normalizeZenModelID(modelID);
  if (!model) return false;
  return (
    model === "claude-3-5-haiku" ||
    model.startsWith("gpt-") ||
    model.startsWith("claude-") ||
    model.startsWith("gemini-") ||
    model.startsWith("qwen") ||
    model.startsWith("minimax-") ||
    model.startsWith("glm-") ||
    model.startsWith("kimi-") ||
    model.startsWith("grok-") ||
    model.startsWith("deepseek-") ||
    model.startsWith("mimo-") ||
    model.startsWith("nemotron-") ||
    model === "big-pickle"
  );
}

function isOpenCodeZenProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  if (!model || isOpenCodeGoProvider(provider, model)) return false;
  return (provider === "opencode" || model.startsWith("opencode/")) && isKnownZenModelID(model);
}

function isSupportedUsageProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  if (!provider && !model) return true;
  return (
    isOpenAIUsageProvider(provider, model) ||
    isCopilotProvider(provider, model) ||
    isAnthropicProvider(provider, model) ||
    isOpenCodeZenProvider(provider, model)
  );
}

const LIVE_SESSION_USAGE_PROVIDERS: LiveSessionUsageProvider[] = [
  {
    matches: isOpenCodeZenProvider,
    exactSessionUsage: sessionZenUsage,
    estimateTokens: estimateTokensFromText,
    outputPrice: (state) => state.zen?.price?.output,
    applyEstimate: (state, session) => ({
      ...state,
      zen: {
        ...state.zen,
        session,
      },
      updatedAt: Date.now(),
    }),
  },
];

function liveSessionUsageProviderForHint(hint: ProviderHint): LiveSessionUsageProvider | undefined {
  return LIVE_SESSION_USAGE_PROVIDERS.find((provider) => provider.matches(hint.providerID, hint.modelID));
}

function providerResolutionKey(provider: ActiveProvider, hint: ProviderHint, sessionID?: string): string {
  const providerID = (hint.providerID ?? "").toLowerCase();
  const modelID = isOpenCodeZenProvider(hint.providerID, hint.modelID)
    ? normalizeZenModelID(hint.modelID)
    : (hint.modelID ?? "").toLowerCase();
  return `${sessionID ?? ""}|${provider}|${providerID}|${modelID}`;
}

function hasProviderHint(hint: ProviderHint | undefined): boolean {
  return Boolean(hint?.providerID || hint?.modelID);
}

function sameProviderHint(left: ProviderHint | undefined, right: ProviderHint | undefined): boolean {
  return (left?.providerID ?? "") === (right?.providerID ?? "") && (left?.modelID ?? "") === (right?.modelID ?? "");
}

function sessionProviderHint(api: TuiPluginApi, sessionID?: string): ProviderHint {
  if (sessionID) {
    const messages = api.state.session.messages(sessionID);
    let fallback: ProviderHint = {};
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      const current = extractProvider(message);
      if (!hasProviderHint(current)) continue;
      if (message?.role === "user") return current;
      if (!hasProviderHint(fallback)) fallback = current;
    }
    return fallback;
  }

  return {};
}

async function fetchSessionProviderHint(api: TuiPluginApi, sessionID?: string): Promise<ProviderHint> {
  if (!sessionID) return {};

  const client = api.client as {
    session?: {
      messages?: (parameters: {
        sessionID: string;
        limit?: number;
      }) => Promise<{
        data?: Array<SessionMessageRecord>;
      }>;
    };
    session2?: {
      messages?: (parameters: {
        sessionID: string;
        limit?: number;
      }) => Promise<{
        data?: Array<SessionMessageRecord>;
      }>;
    };
  };

  const messagesApi = client.session?.messages ?? client.session2?.messages;
  if (!messagesApi) return sessionProviderHint(api, sessionID);

  try {
    const response = await messagesApi({ sessionID, limit: 8 });
    const records = response?.data ?? [];
    let fallback: ProviderHint = {};
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const message = records[i]?.info as Message | undefined;
      const current = extractProvider(message);
      if (!hasProviderHint(current)) continue;
      if (message?.role === "user") return current;
      if (!hasProviderHint(fallback)) fallback = current;
    }
    if (hasProviderHint(fallback)) return fallback;
  } catch {
    // Fall back to in-memory state if the SDK call is unavailable or fails.
  }

  return sessionProviderHint(api, sessionID);
}

function currentProviderHint(
  api: TuiPluginApi,
  sessionID?: string,
  sessionEntrySelectedHint?: ProviderHint,
  sessionSelectionChanged?: boolean,
): ProviderHint {
  const selected = selectedProviderHint();
  const session = sessionProviderHint(api, sessionID);

  if (sessionSelectionChanged && hasProviderHint(selected)) return selected;
  if (hasProviderHint(session)) return session;
  if (hasProviderHint(selected)) return selected;

  return configuredProviderHint(api);
}

function currentHomeProviderHint(
  api: TuiPluginApi,
  homeEntryProviderHint?: ProviderHint,
  homeEntrySelectedHint?: ProviderHint,
  homeSelectionChanged?: boolean,
): ProviderHint {
  const selected = selectedProviderHint();
  const configured = configuredProviderHint(api);
  if (homeSelectionChanged && hasProviderHint(selected)) return selected;
  if (hasProviderHint(configured)) return configured;
  if (hasProviderHint(homeEntryProviderHint)) return homeEntryProviderHint;
  if (hasProviderHint(selected)) return selected;
  return configuredProviderHint(api);
}

async function resolveProvider(
  api: TuiPluginApi,
  sessionID: string | undefined,
  sessionEntrySelectedHint: ProviderHint | undefined,
  sessionSelectionChanged: boolean,
  homeEntryProviderHint: ProviderHint | undefined,
  homeEntrySelectedHint: ProviderHint | undefined,
  homeSelectionChanged: boolean,
): Promise<{ provider: ActiveProvider; hint: ProviderHint }> {
  if (!sessionID) {
    const hint = currentHomeProviderHint(api, homeEntryProviderHint, homeEntrySelectedHint, homeSelectionChanged);
    return { provider: providerFromHint(hint), hint };
  }

  const fetchedSession = await fetchSessionProviderHint(api, sessionID);
  const selected = selectedProviderHint();
  let hint: ProviderHint;

  if (sessionSelectionChanged && hasProviderHint(selected)) {
    hint = selected;
  } else if (hasProviderHint(fetchedSession)) {
    hint = fetchedSession;
  } else {
    hint = currentProviderHint(api, sessionID, sessionEntrySelectedHint, sessionSelectionChanged);
  }

  return { provider: providerFromHint(hint), hint };
}

function providerFromHint(hint: ProviderHint): ActiveProvider {
  if (hint.providerID || hint.modelID) {
    if (isOpenCodeZenProvider(hint.providerID, hint.modelID)) return "zen";
    if (isCopilotProvider(hint.providerID, hint.modelID)) return "copilot";
    if (isOpenAIUsageProvider(hint.providerID, hint.modelID)) return "openai";
    if (isAnthropicProvider(hint.providerID, hint.modelID)) return "anthropic";
    return "other";
  }

  return "openai";
}

function selectedProviderHint(): ProviderHint {
  try {
    const raw = JSON.parse(readFileSync(MODEL_STATE_PATH, "utf8"));
    const selected = raw?.recent?.[0];
    if (selected?.providerID || selected?.modelID) {
      return {
        providerID: selected.providerID,
        modelID: selected.modelID,
      };
    }
  } catch {
    // Missing or stale TUI model state should not hide the badge.
  }
  return {};
}

function configuredProviderHint(api: TuiPluginApi): ProviderHint {
  const model = api.state.config.model;
  if (typeof model !== "string" || !model.trim()) return {};
  const value = model.trim();
  const slash = value.indexOf("/");
  if (slash > 0) {
    return {
      providerID: value.slice(0, slash),
      modelID: value.slice(slash + 1),
    };
  }
  return { modelID: value };
}

function extractProvider(message?: Message): ProviderHint {
  if (!message) return {};
  if (message.role === "assistant") {
    return { providerID: message.providerID, modelID: message.modelID };
  }
  return {
    providerID: message.model?.providerID,
    modelID: message.model?.modelID,
  };
}

function shouldShowUsageForSession(
  api: TuiPluginApi,
  sessionID?: string,
  sessionEntrySelectedHint?: ProviderHint,
  sessionSelectionChanged?: boolean,
  homeEntryProviderHint?: ProviderHint,
  homeEntrySelectedHint?: ProviderHint,
  homeSelectionChanged?: boolean,
): boolean {
  const current = sessionID
    ? currentProviderHint(api, sessionID, sessionEntrySelectedHint, sessionSelectionChanged)
    : currentHomeProviderHint(api, homeEntryProviderHint, homeEntrySelectedHint, homeSelectionChanged);
  if (current.providerID || current.modelID) {
    if (isOpenAIUsageProvider(current.providerID, current.modelID) && hasGlobalCodexAccounts()) return false;
    return isSupportedUsageProvider(current.providerID, current.modelID);
  }
  return !hasGlobalCodexAccounts();
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  if (route.name === "session") return route.params.sessionID;
  return undefined;
}

function stateMatchesResolution(
  state: UsageState,
  resolution: ProviderResolution | undefined,
  key: string,
): boolean {
  if (!resolution || resolution.key !== key) return false;
  if (state.status === "ready") return state.provider === resolution.provider;
  if (state.status === "error") return true;
  return false;
}

function providerLabel(provider: ActiveProvider | undefined): string | undefined {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "copilot":
      return "Copilot";
    case "anthropic":
      return "Anthropic";
    case "zen":
      return "Zen";
    default:
      return undefined;
  }
}

function UsageBadge(props: {
  state: UsageState;
  theme: TuiThemeCurrent;
  compact?: boolean;
  provider?: ActiveProvider;
}) {
  const label = providerLabel(props.provider);
  const errorPrefix = label ? `[${label}] ` : "";
  return (
    <Show
      when={props.state.status === "ready"}
      fallback={
        props.state.status === "error" ? (
          <text fg={props.theme.textMuted}>{`${errorPrefix}Usage unavailable`}</text>
        ) : null
      }
    >
      {(() => {
        const ready = props.state as Extract<UsageState, { status: "ready" }>;
        if (ready.provider === "anthropic") {
          const requests = `${formatCompactNumber(ready.anthropic?.requestsRemaining)} req`;
          const input = `${formatCompactNumber(ready.anthropic?.inputTokensRemaining)} in`;
          const output = `${formatCompactNumber(ready.anthropic?.outputTokensRemaining)} out`;
          const reset = formatCountdown(ready.anthropic?.requestsResetAt);
          return (
            <box flexDirection="row">
              <text fg={props.theme.textMuted}>[API] </text>
              <text>{requests}</text>
              <text fg={props.theme.textMuted}>{" | "}</text>
              <text>{input}</text>
              <text fg={props.theme.textMuted}>{" | "}</text>
              <text>{output}</text>
              <Show when={!props.compact && reset}>
                <text fg={props.theme.textMuted}>{` (-${reset})`}</text>
              </Show>
            </box>
          );
        }

        if (ready.provider === "copilot") {
          const plan = ready.copilot?.plan;
          const used = ready.copilot?.usedPercent;
          const reset = formatAbsoluteReset(ready.copilot?.resetAt);
          const planPrefix = plan ? `[${plan}] ` : "";
          return (
            <box flexDirection="row">
              <text fg={props.theme.textMuted}>{planPrefix}</text>
              <text fg={usageColor(props.theme, used)}>
                {typeof used === "number" ? `mo: ${used}%` : "mo: --"}
              </text>
              <Show when={!props.compact && reset}>
                <text fg={props.theme.textMuted}>{` (-${reset})`}</text>
              </Show>
            </box>
          );
        }

        if (ready.provider === "zen") {
          const input = formatMoney(ready.zen?.price?.input);
          const output = formatMoney(ready.zen?.price?.output);
          const cost = formatMoney(ready.zen?.session?.cost);
          const tokens = formatCompactNumber(ready.zen?.session?.tokens);
          const approximate = ready.zen?.session?.approximate ? "~" : "";
          const session = props.compact ? "" : ` | sess: ${approximate}${cost}/${tokens}t`;
          return (
            <box flexDirection="column">
              <text>{`[Zen] ${input}/${output} per M${session}`}</text>
              <Show when={!props.compact && ready.zen?.priceFallback}>
                <text fg={props.theme.textMuted}>* bundled fallback pricing</text>
              </Show>
            </box>
          );
        }

        const account = formatOpenAIAccount(ready.planType, ready.accountEmail);
        const primaryLabel = formatWindowLabel(ready.primary, "5h");
        const secondaryLabel = formatWindowLabel(ready.secondary, "7d");
        const primaryUsed = ready.primary?.used_percent;
        const secondaryUsed = ready.secondary?.used_percent;
        const primaryReset = formatReset(ready.primary);
        const secondaryReset = formatReset(ready.secondary);
        return (
          <box flexDirection="row">
            <Show when={account}>
              <text fg={props.theme.success}>{account}</text>
              <text fg={props.theme.textMuted}>{" · "}</text>
            </Show>
            <text fg={usageColor(props.theme, primaryUsed)}>
              {typeof primaryUsed === "number" ? `${primaryLabel} ${primaryUsed}%` : `${primaryLabel} --`}
            </text>
            <Show when={!props.compact && primaryReset}>
              <text fg={props.theme.textMuted}>{` (-${primaryReset})`}</text>
            </Show>
            <Show when={typeof secondaryUsed === "number"}>
              <text fg={props.theme.textMuted}>{" · "}</text>
              <text fg={usageColor(props.theme, secondaryUsed)}>
                {`${secondaryLabel} ${secondaryUsed}%`}
              </text>
            </Show>
            <Show when={!props.compact && typeof secondaryUsed === "number" && secondaryReset}>
              <text fg={props.theme.textMuted}>{` (-${secondaryReset})`}</text>
            </Show>
          </box>
        );
      })()}
    </Show>
  );
}

function createRefreshLoop(api: TuiPluginApi) {
  const [state, setState] = createSignal<UsageState>({ status: "loading" });
  const [resolution, setResolution] = createSignal<ProviderResolution | undefined>();
  const [visibilityNonce, setVisibilityNonce] = createSignal(0);
  let disposed = false;
  let inflight = false;
  let refreshQueued = false;
  let lastSessionID: string | undefined;
  let generation = 0;
  let scheduleRefresh = () => {
    refreshQueued = true;
  };
  let sessionEntrySelectedHint: ProviderHint | undefined;
  let sessionSelectionChanged = false;
  let homeEntryProviderHint: ProviderHint | undefined;
  let homeEntrySelectedHint: ProviderHint | undefined;
  let homeSelectionChanged = false;
  let liveSessionKey: string | undefined;
  let liveSessionID: string | undefined;
  let liveMessageID: string | undefined;
  let liveText = "";
  let liveBaseUsage: SessionUsageSnapshot | undefined;
  let liveApplyTimer: ReturnType<typeof setTimeout> | undefined;

  const clearLiveEstimate = () => {
    liveSessionKey = undefined;
    liveSessionID = undefined;
    liveMessageID = undefined;
    liveText = "";
    liveBaseUsage = undefined;
    if (liveApplyTimer) {
      clearTimeout(liveApplyTimer);
      liveApplyTimer = undefined;
    }
  };

  const activeLiveContext = (sessionID?: string) => {
    if (!sessionID || sessionID !== currentSessionID(api)) return undefined;
    const hint = currentProviderHint(api, sessionID, sessionEntrySelectedHint, sessionSelectionChanged);
    const capability = liveSessionUsageProviderForHint(hint);
    if (!capability) return undefined;
    const provider = providerFromHint(hint);
    const key = providerResolutionKey(provider, hint, sessionID);
    const currentState = state();
    if (!stateMatchesResolution(currentState, resolution(), key)) return undefined;
    if (currentState.status !== "ready") return undefined;
    return { capability, key, state: currentState };
  };

  const applyLiveEstimate = () => {
    liveApplyTimer = undefined;
    const context = activeLiveContext(liveSessionID);
    if (!context || !liveText) return;
    const tokens = context.capability.estimateTokens(liveText);
    const session = addLiveEstimate(liveBaseUsage, tokens, context.capability.outputPrice(context.state));
    setState(context.capability.applyEstimate(context.state, session));
    setVisibilityNonce((value) => value + 1);
  };

  const scheduleLiveEstimate = () => {
    if (liveApplyTimer) return;
    liveApplyTimer = setTimeout(applyLiveEstimate, 500);
  };

  const handleMessagePartDelta = (event: {
    properties: { sessionID: string; messageID: string; field: string; delta: string };
  }) => {
    const { sessionID, messageID, field, delta } = event.properties;
    if (!delta || (field !== "text" && field !== "content")) return;
    const context = activeLiveContext(sessionID);
    if (!context) return;
    if (liveSessionKey !== context.key || liveMessageID !== messageID) {
      liveSessionKey = context.key;
      liveSessionID = sessionID;
      liveMessageID = messageID;
      liveText = "";
      liveBaseUsage = context.capability.exactSessionUsage(api, sessionID);
    }
    liveText += delta;
    scheduleLiveEstimate();
  };

  const handleMessageUpdated = (event: { properties: { sessionID: string; info: Message } }) => {
    syncVisibility();
    const { sessionID, info } = event.properties;
    if (sessionID !== currentSessionID(api) || info.role !== "assistant") return;
    if (info.time.completed) {
      clearLiveEstimate();
      void refresh();
    }
  };

  const syncSessionContext = (sessionID?: string) => {
    const current = sessionID ?? currentSessionID(api);
    if (current !== lastSessionID) {
      generation += 1;
      clearLiveEstimate();
      setResolution(undefined);
      setState({ status: "loading" });
      const previousSessionID = lastSessionID;
      const previousSessionEntrySelectedHint = sessionEntrySelectedHint;
      if (current) {
        lastSessionID = current;
        sessionEntrySelectedHint = selectedProviderHint();
        sessionSelectionChanged = false;
        homeEntryProviderHint = undefined;
        homeEntrySelectedHint = undefined;
        homeSelectionChanged = false;
      } else {
        homeEntrySelectedHint = selectedProviderHint();
        homeEntryProviderHint = previousSessionID
          ? currentProviderHint(api, previousSessionID, previousSessionEntrySelectedHint, sessionSelectionChanged)
          : undefined;
        homeSelectionChanged = false;
        lastSessionID = undefined;
        sessionEntrySelectedHint = undefined;
        sessionSelectionChanged = false;
      }
      scheduleRefresh();
    }
    return current;
  };

  const syncVisibility = () => {
    const previousGeneration = generation;
    const sessionID = syncSessionContext();
    let providerChanged = generation !== previousGeneration;
    if (sessionID) {
      const selected = selectedProviderHint();
      if (hasProviderHint(selected) && !sameProviderHint(selected, sessionEntrySelectedHint)) {
        sessionEntrySelectedHint = selected;
        sessionSelectionChanged = true;
        providerChanged = true;
      }
    }
    if (!sessionID) {
      const selected = selectedProviderHint();
      if (hasProviderHint(selected) && !sameProviderHint(selected, homeEntrySelectedHint)) {
        homeEntrySelectedHint = selected;
        homeSelectionChanged = true;
        providerChanged = true;
      }
    }
    const visibleHint = sessionID
      ? currentProviderHint(api, sessionID, sessionEntrySelectedHint, sessionSelectionChanged)
      : currentHomeProviderHint(api, homeEntryProviderHint, homeEntrySelectedHint, homeSelectionChanged);
    const visibleKey = providerResolutionKey(providerFromHint(visibleHint), visibleHint, sessionID);
    if (resolution()?.key && resolution()?.key !== visibleKey) {
      providerChanged = true;
    }
    if (providerChanged) {
      generation += 1;
      clearLiveEstimate();
      setResolution(undefined);
      setState({ status: "loading" });
      void refresh();
    }
    setVisibilityNonce((value) => value + 1);
  };

  const refresh = async () => {
    if (disposed) return;
    if (inflight) {
      refreshQueued = true;
      return;
    }
    inflight = true;
    let requestGeneration = generation;
    try {
      const sessionID = syncSessionContext();
      requestGeneration = generation;
      const resolved = await resolveProvider(
        api,
        sessionID,
        sessionEntrySelectedHint,
        sessionSelectionChanged,
        homeEntryProviderHint,
        homeEntrySelectedHint,
        homeSelectionChanged,
      );
      if (requestGeneration !== generation || disposed) return;
      const { provider, hint } = resolved;
      const key = providerResolutionKey(provider, hint, sessionID);
      if (resolution()?.key !== key) {
        setState({ status: "loading" });
      }
      setResolution({
        provider,
        hint,
        sessionID,
        generation: requestGeneration,
        key,
      });
      let nextState: Exclude<UsageState, { status: "loading" }>;
      if (provider === "copilot") {
        nextState = await fetchCopilotUsage();
      } else if (provider === "openai") {
        nextState = await fetchOpenAIUsage();
      } else if (provider === "anthropic") {
        const anthropicModel = hint.modelID ?? configuredProviderHint(api).modelID;
        if (!anthropicModel) {
          throw new Error("Anthropic model not found");
        }
        nextState = await fetchAnthropicUsage(anthropicModel);
      } else if (provider === "zen") {
        const zenModel = hint.modelID ?? configuredProviderHint(api).modelID;
        if (!zenModel) {
          throw new Error("OpenCode Zen model not found");
        }
        nextState = await fetchZenUsage(api, zenModel, sessionID);
      } else {
        nextState = { status: "error", message: "Usage unavailable for active provider" };
      }
      if (requestGeneration !== generation || disposed) return;
      setState(nextState);
    } catch (error) {
      if (requestGeneration !== generation || disposed) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      setState({ status: "error", message });
    } finally {
      inflight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  };

  scheduleRefresh = () => {
    setTimeout(() => {
      if (!disposed) void refresh();
    }, 0);
  };

  void refresh();
  const interval = setInterval(() => void refresh(), REFRESH_MS);
  const visibilityInterval = setInterval(syncVisibility, VISIBILITY_REFRESH_MS);

  const commandDispose = api.command.register(() => []);

  const offTuiCommand = api.event.on("tui.command.execute", syncVisibility);
  const offSessionSelect = api.event.on("tui.session.select", syncVisibility);
  const offSessionUpdated = api.event.on("session.updated", syncVisibility);
  const offMessageUpdated = api.event.on("message.updated", handleMessageUpdated);
  const offMessagePartDelta = api.event.on("message.part.delta", handleMessagePartDelta);
  const offMessagePartUpdated = api.event.on("message.part.updated", syncVisibility);

  api.slots.register({
    order: 90,
    slots: {
      home_prompt_right(ctx: TuiSlotContext) {
        visibilityNonce();
        const sessionID = syncSessionContext();
        const hint = currentHomeProviderHint(api, homeEntryProviderHint, homeEntrySelectedHint, homeSelectionChanged);
        if (
          !shouldShowUsageForSession(
            api,
            sessionID,
            sessionEntrySelectedHint,
            sessionSelectionChanged,
            homeEntryProviderHint,
            homeEntrySelectedHint,
            homeSelectionChanged,
          )
        )
          return null;
        if (!stateMatchesResolution(state(), resolution(), providerResolutionKey(providerFromHint(hint), hint, sessionID)))
          return null;
        return <UsageBadge state={state()} theme={ctx.theme.current} compact provider={resolution()?.provider} />;
      },
      session_prompt_right(ctx: TuiSlotContext & { session_id?: string }) {
        visibilityNonce();
        const sessionID = syncSessionContext(ctx.session_id);
        const hint = currentProviderHint(api, sessionID, sessionEntrySelectedHint, sessionSelectionChanged);
        if (
          !shouldShowUsageForSession(
            api,
            sessionID,
            sessionEntrySelectedHint,
            sessionSelectionChanged,
            homeEntryProviderHint,
            homeEntrySelectedHint,
            homeSelectionChanged,
          )
        )
          return null;
        if (!stateMatchesResolution(state(), resolution(), providerResolutionKey(providerFromHint(hint), hint, sessionID)))
          return null;
        return <UsageBadge state={state()} theme={ctx.theme.current} provider={resolution()?.provider} />;
      },
    },
  });

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearLiveEstimate();
    clearInterval(interval);
    clearInterval(visibilityInterval);
    offTuiCommand();
    offSessionSelect();
    offSessionUpdated();
    offMessageUpdated();
    offMessagePartDelta();
    offMessagePartUpdated();
    commandDispose();
  });
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  createRoot((dispose) => {
    createRefreshLoop(api);
    api.lifecycle.onDispose(dispose);
  });
};

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
