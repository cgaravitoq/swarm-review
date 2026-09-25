const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_WINDOW_MS = 5 * 60_000;
const REFRESH_AFTER_MS = 8 * 24 * 60 * 60_000;
const CODEX_KEY = "openai-codex";
const CLAUDE_KEY = "claude-code";

type CodexCredential = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh: string;
};
type ClaudeCredential = { token: string; lastRefresh: string };
type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_credential");
  }
  return value as Record<string, unknown>;
};

const required = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error("invalid_credential");
  }
  return field;
};

const expiry = (token: string): number => {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) throw new Error();
    const claims = record(
      JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))),
    );
    if (typeof claims["exp"] !== "number") throw new Error();
    return claims["exp"] * 1000;
  } catch {
    throw new Error("invalid_codex_access_token");
  }
};

export class CredentialVault {
  private refreshInFlight: Promise<CodexCredential> | undefined;

  constructor(private readonly storage: Storage) {}

  async seed(provider: string, input: unknown): Promise<void> {
    const value = record(input);
    if (provider === CODEX_KEY) {
      if (value["auth_mode"] !== "chatgpt" || value["OPENAI_API_KEY"] !== null)
        throw new Error("invalid_credential");
      const tokens = record(value["tokens"]);
      required(tokens, "id_token");
      const credential = {
        accessToken: required(tokens, "access_token"),
        refreshToken: required(tokens, "refresh_token"),
        accountId: required(tokens, "account_id"),
        lastRefresh: required(value, "last_refresh"),
      };
      expiry(credential.accessToken);
      if (!Number.isFinite(Date.parse(credential.lastRefresh)))
        throw new Error("invalid_credential");
      await this.storage.put(CODEX_KEY, credential);
      return;
    }
    if (provider === CLAUDE_KEY) {
      await this.storage.put(CLAUDE_KEY, {
        token: required(value, "token"),
        lastRefresh: new Date().toISOString(),
      });
      return;
    }
    throw new Error("unsupported_provider");
  }

  async status() {
    const [codex, claude] = await Promise.all([
      this.storage.get<CodexCredential>(CODEX_KEY),
      this.storage.get<ClaudeCredential>(CLAUDE_KEY),
    ]);
    return [
      ...(codex
        ? [
            {
              provider: CODEX_KEY,
              expiry: new Date(expiry(codex.accessToken)).toISOString(),
              lastRefresh: codex.lastRefresh,
            },
          ]
        : []),
      ...(claude
        ? [
            {
              provider: CLAUDE_KEY,
              expiry: null,
              lastRefresh: claude.lastRefresh,
            },
          ]
        : []),
    ];
  }

  async credential(provider: string, rejectedAccessToken?: string) {
    if (provider === CLAUDE_KEY) {
      const stored = await this.storage.get<ClaudeCredential>(CLAUDE_KEY);
      if (!stored) throw new Error("credential_unconfigured");
      return { authorization: `Bearer ${stored.token}` };
    }
    if (provider !== CODEX_KEY) throw new Error("unsupported_provider");
    let stored = await this.storage.get<CodexCredential>(CODEX_KEY);
    if (!stored) throw new Error("credential_unconfigured");
    if (
      (rejectedAccessToken !== undefined &&
        stored.accessToken === rejectedAccessToken) ||
      expiry(stored.accessToken) <= Date.now() + EXPIRY_WINDOW_MS ||
      Date.parse(stored.lastRefresh) <= Date.now() - REFRESH_AFTER_MS
    ) {
      stored = await this.refresh(stored.accessToken);
    }
    return {
      authorization: `Bearer ${stored.accessToken}`,
      accountId: stored.accountId,
    };
  }

  private async refresh(expectedAccessToken: string): Promise<CodexCredential> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshOnce(expectedAccessToken);
    this.refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    }
  }

  private async refreshOnce(
    expectedAccessToken: string,
  ): Promise<CodexCredential> {
    const current = await this.storage.get<CodexCredential>(CODEX_KEY);
    if (!current) throw new Error("credential_unconfigured");
    if (current.accessToken !== expectedAccessToken) return current;
    let response: Response;
    try {
      response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
      });
    } catch {
      throw new Error("credential_refresh_failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`credential_refresh_failed_${response.status}`);
    }
    let rotated: CodexCredential;
    try {
      const value = record(await response.json());
      rotated = {
        accessToken: required(value, "access_token"),
        refreshToken:
          value["refresh_token"] === undefined
            ? current.refreshToken
            : required(value, "refresh_token"),
        accountId: current.accountId,
        lastRefresh: new Date().toISOString(),
      };
      expiry(rotated.accessToken);
    } catch {
      throw new Error("credential_refresh_invalid");
    }
    await this.storage.put(CODEX_KEY, rotated);
    return rotated;
  }
}
