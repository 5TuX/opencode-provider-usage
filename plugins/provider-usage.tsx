import type {
  Message,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { createSignal, Show } from "solid-js";

const PLUGIN_ID = "provider-usage";
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const MODEL_STATE_PATH = join(homedir(), ".local", "state", "opencode", "model.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const REFRESH_MS = 60_000;
const VISIBILITY_REFRESH_MS = 1_000;
const JET_PASTEL_MIX = 0.28;

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

type ActiveProvider = "openai" | "copilot" | "anthropic" | "other";

type ProviderResolution = {
  provider: ActiveProvider;
  hint: ProviderHint;
  sessionID?: string;
  generation: number;
};

type UsageState =
  | { status: "loading" }
  | {
      status: "ready";
      provider: ActiveProvider;
      planType?: string;
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
      updatedAt: number;
    }
  | { status: "error"; message: string };

type SessionMessageRecord = {
  info?: Message;
};

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;
  return Buffer.from(padded, "base64").toString("utf8");
}

function readOpenAIAuth(): { access: string; accountId: string } {
  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const openai = raw?.openai;
  if (!openai?.access) {
    throw new Error("OpenAI auth not found");
  }

  const tokenParts = String(openai.access).split(".");
  if (tokenParts.length < 2) {
    throw new Error("Invalid OpenAI access token");
  }

  const payload = JSON.parse(decodeBase64Url(tokenParts[1]));
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("ChatGPT account id not found in token");
  }

  return { access: openai.access, accountId };
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

function formatPlan(planType?: string): string | undefined {
  if (!planType) return undefined;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
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

function isSupportedUsageProvider(providerID?: string, modelID?: string): boolean {
  const provider = (providerID ?? "").toLowerCase();
  const model = (modelID ?? "").toLowerCase();
  if (!provider && !model) return true;
  return isOpenAIUsageProvider(provider, model) || isCopilotProvider(provider, model) || isAnthropicProvider(provider, model);
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
    return isSupportedUsageProvider(current.providerID, current.modelID);
  }
  return true;
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  if (route.name === "session") return route.params.sessionID;
  return undefined;
}

function stateMatchesProvider(state: UsageState, provider: ActiveProvider): boolean {
  return state.status === "ready" && state.provider === provider;
}

function stateMatchesResolution(state: UsageState, resolution: ProviderResolution | undefined, sessionID?: string): boolean {
  return !!resolution && resolution.sessionID === sessionID && stateMatchesProvider(state, resolution.provider);
}

function UsageBadge(props: {
  state: UsageState;
  theme: TuiThemeCurrent;
  compact?: boolean;
}) {
  return (
    <Show
      when={props.state.status === "ready"}
      fallback={
        props.state.status === "error" ? <text fg={props.theme.textMuted}>Usage unavailable</text> : null
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

        const plan = formatPlan(ready.planType);
        const primaryLabel = formatWindowLabel(ready.primary, "5h");
        const secondaryLabel = formatWindowLabel(ready.secondary, "7d");
        const primaryUsed = ready.primary?.used_percent;
        const secondaryUsed = ready.secondary?.used_percent;
        const primaryReset = formatReset(ready.primary);
        const secondaryReset = formatReset(ready.secondary);
        const planPrefix = plan ? `[${plan}] ` : "";
        return (
          <box flexDirection="row">
            <text fg={props.theme.textMuted}>{planPrefix}</text>
            <text fg={usageColor(props.theme, primaryUsed)}>
              {typeof primaryUsed === "number" ? `${primaryLabel}: ${primaryUsed}%` : `${primaryLabel}: --`}
            </text>
            <Show when={!props.compact && primaryReset}>
              <text fg={props.theme.textMuted}>{` (-${primaryReset})`}</text>
            </Show>
            <Show when={typeof secondaryUsed === "number"}>
              <text fg={props.theme.textMuted}>{" | "}</text>
              <text fg={usageColor(props.theme, secondaryUsed)}>
                {`${secondaryLabel}: ${secondaryUsed}%`}
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

  const syncSessionContext = (sessionID?: string) => {
    const current = sessionID ?? currentSessionID(api);
    if (current !== lastSessionID) {
      generation += 1;
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
    if (providerChanged) {
      generation += 1;
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
      setState((current) => (current.status === "ready" ? current : { status: "loading" }));
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
      setResolution({ provider, hint, sessionID, generation: requestGeneration });
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
  const offMessageUpdated = api.event.on("message.updated", syncVisibility);

  api.slots.register({
    order: 90,
    slots: {
      home_prompt_right(ctx: TuiSlotContext) {
        visibilityNonce();
        const sessionID = syncSessionContext();
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
        if (!stateMatchesResolution(state(), resolution(), sessionID)) return null;
        return <UsageBadge state={state()} theme={ctx.theme.current} compact />;
      },
      session_prompt_right(ctx: TuiSlotContext & { session_id?: string }) {
        visibilityNonce();
        const sessionID = syncSessionContext(ctx.session_id);
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
        if (!stateMatchesResolution(state(), resolution(), sessionID)) return null;
        return <UsageBadge state={state()} theme={ctx.theme.current} />;
      },
    },
  });

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(interval);
    clearInterval(visibilityInterval);
    offTuiCommand();
    offSessionSelect();
    offSessionUpdated();
    offMessageUpdated();
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
