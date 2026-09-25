import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialVault } from "../credential-vault";

const jwt = (expiry: number, suffix: string) =>
  `header.${btoa(JSON.stringify({ exp: expiry }))}.${suffix}`;

const auth = (accessToken: string, refreshToken = "fake-refresh-old") => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "fake-id",
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: "fake-account",
  },
  last_refresh: new Date().toISOString(),
});

const setup = () => {
  const values = new Map<string, unknown>();
  const writes: unknown[] = [];
  const storage = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, value);
      writes.push(value);
    },
  };
  return { vault: new CredentialVault(storage), values, writes };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credential vault", () => {
  it("single-flights concurrent expiry refreshes and persists the rotated pair before use", async () => {
    const old = jwt(Math.floor(Date.now() / 1000) + 60, "old");
    const nextExpiry = Math.floor(Date.now() / 1000) + 3600;
    const next = jwt(nextExpiry, "new");
    const { vault, values } = setup();
    await vault.seed("openai-codex", auth(old));
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "fake-refresh-old",
      });
      await Promise.resolve();
      return Response.json({
        access_token: next,
        refresh_token: "fake-refresh-new",
      });
    });
    vi.stubGlobal("fetch", upstream);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const credential = await vault.credential("openai-codex");
        expect(values.get("openai-codex")).toMatchObject({
          accessToken: next,
          refreshToken: "fake-refresh-new",
        });
        return credential;
      }),
    );
    expect(upstream).toHaveBeenCalledOnce();
    expect(attempts).toEqual(
      Array.from({ length: 12 }, () => ({
        authorization: `Bearer ${next}`,
        accountId: "fake-account",
      })),
    );
    expect(values.get("openai-codex")).toMatchObject({
      accessToken: next,
      refreshToken: "fake-refresh-new",
    });
    expect(await vault.status()).toEqual([
      {
        provider: "openai-codex",
        expiry: new Date(nextExpiry * 1000).toISOString(),
        lastRefresh: expect.any(String),
      },
    ]);
  });

  it("refreshes a pair that has not been refreshed for 8 days before it expires", async () => {
    const current = jwt(Math.floor(Date.now() / 1000) + 3600, "current");
    const next = jwt(Math.floor(Date.now() / 1000) + 7200, "new");
    const { vault, values } = setup();
    await vault.seed("openai-codex", {
      ...auth(current),
      last_refresh: new Date(Date.now() - 9 * 24 * 60 * 60_000).toISOString(),
    });
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "fake-refresh-old",
      });
      return Response.json({
        access_token: next,
        refresh_token: "fake-refresh-new",
      });
    });
    vi.stubGlobal("fetch", upstream);
    expect(await vault.credential("openai-codex")).toEqual({
      authorization: `Bearer ${next}`,
      accountId: "fake-account",
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect(values.get("openai-codex")).toMatchObject({
      accessToken: next,
      refreshToken: "fake-refresh-new",
    });
  });

  it("keeps the previous pair when refresh fails and names the failure", async () => {
    const old = jwt(Math.floor(Date.now() / 1000) + 60, "old");
    const { vault, values } = setup();
    await vault.seed("openai-codex", auth(old));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(vault.credential("openai-codex")).rejects.toThrow(
      "credential_refresh_failed_503",
    );
    expect(values.get("openai-codex")).toMatchObject({
      accessToken: old,
      refreshToken: "fake-refresh-old",
    });
  });

  it("keeps a pair seeded while a refresh is pending instead of the rotation", async () => {
    const old = jwt(Math.floor(Date.now() / 1000) + 60, "old");
    const seeded = jwt(Math.floor(Date.now() / 1000) + 3600, "seeded");
    const rotated = jwt(Math.floor(Date.now() / 1000) + 3600, "rotated");
    const { vault, values } = setup();
    await vault.seed("openai-codex", auth(old));
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const upstream = vi.fn<typeof fetch>(async () => held);
    vi.stubGlobal("fetch", upstream);
    const attempt = vault.credential("openai-codex");
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
    await vault.seed("openai-codex", auth(seeded, "fake-refresh-seeded"));
    release(
      Response.json({
        access_token: rotated,
        refresh_token: "fake-refresh-rotated",
      }),
    );
    expect(await attempt).toEqual({
      authorization: `Bearer ${seeded}`,
      accountId: "fake-account",
    });
    expect(values.get("openai-codex")).toMatchObject({
      accessToken: seeded,
      refreshToken: "fake-refresh-seeded",
    });
  });

  it("stores a Claude setup token and reveals only status", async () => {
    const { vault } = setup();
    await vault.seed("claude-code", { token: "fake-claude-token" });
    expect(await vault.credential("claude-code")).toEqual({
      authorization: "Bearer fake-claude-token",
    });
    expect(JSON.stringify(await vault.status())).not.toContain(
      "fake-claude-token",
    );
  });
});
