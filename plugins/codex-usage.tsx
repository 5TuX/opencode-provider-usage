import type {
  Message,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { readFileSync } from "node:fs";
import { createRoot } from "solid-js";
import { createSignal, Show } from "solid-js";

const PLUGIN_ID = "codex-usage";
const AUTH_PATH = `${process.env.HOME}/.local/share/opencode/auth.json`;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 60_000;

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

type UsageState =
  | { status: "loading" }
  | {
      status: "ready";
      planType?: string;
      primary?: WindowSnapshot;
      secondary?: WindowSnapshot;
      updatedAt: number;
    }
  | { status: "error"; message: string };

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

async function fetchUsage(): Promise<Exclude<UsageState, { status: "loading" | "error" }>> {
  const auth = readOpenAIAuth();
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "ChatGPT-Account-Id": auth.accountId,
      "User-Agent": "opencode-codex-usage",
    },
  });

  if (!response.ok) {
    throw new Error(`Usage request failed (${response.status})`);
  }

  const payload = (await response.json()) as UsagePayload;
  return {
    status: "ready",
    planType: payload.plan_type,
    primary: payload.rate_limit?.primary_window,
    secondary: payload.rate_limit?.secondary_window,
    updatedAt: Date.now(),
  };
}

function formatPlan(planType?: string): string | undefined {
  if (!planType) return undefined;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

function formatWindowLabel(window?: WindowSnapshot, fallback?: string): string {
  const seconds = window?.limit_window_seconds;
  if (!seconds) return fallback ?? "limit";
  if (Math.abs(seconds - 18_000) < 120) return "5h";
  if (Math.abs(seconds - 604_800) < 600) return "wk";
  if (seconds % 86_400 === 0) return `${Math.round(seconds / 86_400)}d`;
  if (seconds % 3_600 === 0) return `${Math.round(seconds / 3_600)}h`;
  return fallback ?? "limit";
}

function formatReset(window?: WindowSnapshot): string | undefined {
  const seconds = window?.reset_after_seconds;
  if (typeof seconds !== "number") return undefined;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86400)}d`;
}

function usageColor(theme: TuiThemeCurrent, usedPercent?: number) {
  if (typeof usedPercent !== "number") return theme.textMuted;
  if (usedPercent >= 90) return theme.error;
  if (usedPercent >= 75) return theme.warning;
  return theme.text;
}

function isCodexLikeProvider(providerID?: string, modelID?: string): boolean {
  const p = (providerID ?? "").toLowerCase();
  const m = (modelID ?? "").toLowerCase();
  if (p.includes("copilot") || m.includes("copilot")) return false;
  if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex")) return true;
  if (m.includes("codex")) return true;
  return false;
}

function configuredProviderHint(api: TuiPluginApi): { providerID?: string; modelID?: string } {
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

function extractProvider(message: Message): { providerID?: string; modelID?: string } {
  if (message.role === "assistant") {
    return { providerID: message.providerID, modelID: message.modelID };
  }
  return {
    providerID: message.model?.providerID,
    modelID: message.model?.modelID,
  };
}

function shouldShowUsageForSession(api: TuiPluginApi, sessionID?: string): boolean {
  const configured = configuredProviderHint(api);
  if (configured.providerID || configured.modelID) {
    return isCodexLikeProvider(configured.providerID, configured.modelID);
  }

  if (!sessionID) return false;
  const messages = api.state.session.messages(sessionID);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const current = extractProvider(messages[i]);
    if (current.providerID || current.modelID) {
      return isCodexLikeProvider(current.providerID, current.modelID);
    }
  }
  return false;
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  if (route.name === "session") return route.params.sessionID;
  return undefined;
}

function UsageBadge(props: {
  state: UsageState;
  theme: TuiThemeCurrent;
}) {
  return (
    <Show
      when={props.state.status === "ready"}
      fallback={
        <text fg={props.theme.textMuted}>
          {props.state.status === "error" ? "Codex usage unavailable" : "Codex usage..."}
        </text>
      }
    >
      {(() => {
        const ready = props.state as Extract<UsageState, { status: "ready" }>;
        const plan = formatPlan(ready.planType);
        const primaryLabel = formatWindowLabel(ready.primary, "5h");
        const secondaryLabel = formatWindowLabel(ready.secondary, "wk");
        const primaryUsed = ready.primary?.used_percent;
        const secondaryUsed = ready.secondary?.used_percent;
        const primaryReset = formatReset(ready.primary);
        const secondaryReset = formatReset(ready.secondary);
        return (
          <box>
            <text fg={props.theme.textMuted}>{plan ? `${plan} ` : ""}</text>
            <text fg={usageColor(props.theme, primaryUsed)}>
              {typeof primaryUsed === "number" ? `${primaryLabel} ${primaryUsed}%` : `${primaryLabel} --`}
            </text>
            <Show when={primaryReset}>
              <text fg={props.theme.textMuted}>{` (${primaryReset})`}</text>
            </Show>
            <Show when={typeof secondaryUsed === "number"}>
              <text fg={props.theme.textMuted}>{" | "}</text>
              <text fg={usageColor(props.theme, secondaryUsed)}>
                {`${secondaryLabel} ${secondaryUsed}%`}
              </text>
            </Show>
            <Show when={typeof secondaryUsed === "number" && secondaryReset}>
              <text fg={props.theme.textMuted}>{` (${secondaryReset})`}</text>
            </Show>
          </box>
        );
      })()}
    </Show>
  );
}

function createRefreshLoop(api: TuiPluginApi) {
  const [state, setState] = createSignal<UsageState>({ status: "loading" });
  const [visibilityNonce, setVisibilityNonce] = createSignal(0);
  let disposed = false;
  let inflight = false;

  const bumpVisibility = () => setVisibilityNonce((value) => value + 1);

  const refresh = async () => {
    if (disposed || inflight) return;
    inflight = true;
    try {
      setState((current) => (current.status === "ready" ? current : { status: "loading" }));
      setState(await fetchUsage());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState({ status: "error", message });
    } finally {
      inflight = false;
    }
  };

  void refresh();
  const interval = setInterval(() => void refresh(), REFRESH_MS);

  const commandDispose = api.command.register(() => [
    {
      title: "Refresh Codex usage",
      value: "codex-usage-refresh",
      description: "Refresh Codex 5h/weekly usage badge",
      category: "Plugins",
      onSelect: () => void refresh(),
    },
  ]);

  const offTuiCommand = api.event.on("tui.command.execute", bumpVisibility);
  const offSessionSelect = api.event.on("tui.session.select", bumpVisibility);
  const offSessionUpdated = api.event.on("session.updated", bumpVisibility);
  const offMessageUpdated = api.event.on("message.updated", bumpVisibility);

  api.slots.register({
    order: 90,
    slots: {
      home_prompt_right(ctx: TuiSlotContext) {
        visibilityNonce();
        if (!shouldShowUsageForSession(api, currentSessionID(api))) return null;
        return <UsageBadge state={state()} theme={ctx.theme.current} />;
      },
      session_prompt_right(ctx: TuiSlotContext & { session_id?: string }) {
        visibilityNonce();
        const sessionID = ctx.session_id ?? currentSessionID(api);
        if (!shouldShowUsageForSession(api, sessionID)) return null;
        return <UsageBadge state={state()} theme={ctx.theme.current} />;
      },
    },
  });

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(interval);
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
