import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("passkey authentication", () => {
  it("creates an account with a discoverable passkey and signs in without a username or password", async () => {
    const database = new AppDatabase(":memory:");
    const authService = new AuthService(database.auth);
    const extractionQueue = new ExtractionQueue(database.extractions, 1, 1_000);
    const refreshService = new FeedRefreshService(database.feeds, 1, 1_000);
    const app = await createApp({
      database,
      authService,
      extractionQueue,
      refreshService,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ headless: true });
    cleanups.push(
      () => browser.close(),
      () => app.close(),
      () => Promise.all([refreshService.stop(), extractionQueue.stop()]).then(() => undefined),
      () => database.close(),
    );

    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`${origin}/health`);

    const result = await page.evaluate(async () => {
      const decode = (value: string): Uint8Array => {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      };
      const encode = (value: ArrayBuffer): string => {
        const binary = String.fromCharCode(...new Uint8Array(value));
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      };
      const json = async (path: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (init?.body) headers.set("Content-Type", "application/json");
        const response = await fetch(path, {
          ...init,
          headers,
        });
        return { response, body: response.status === 204 ? null : await response.json() };
      };

      const registrationOptions = await json("/api/auth/register/passkey/options", {
        method: "POST",
        body: JSON.stringify({ username: "passkey-reader" }),
      });
      if (!registrationOptions.response.ok)
        throw new Error(JSON.stringify(registrationOptions.body));
      const pendingConfig = await json("/api/auth/config");
      const creation = registrationOptions.body.options;
      const created = (await navigator.credentials.create({
        publicKey: {
          ...creation,
          challenge: decode(creation.challenge),
          user: { ...creation.user, id: decode(creation.user.id) },
          excludeCredentials: creation.excludeCredentials?.map(
            (credential: PublicKeyCredentialDescriptor & { id: string }) => ({
              ...credential,
              id: decode(credential.id),
            }),
          ),
        },
      })) as PublicKeyCredential;
      const attestation = created.response as AuthenticatorAttestationResponse;
      const completionPayload = {
        registrationId: registrationOptions.body.registrationId,
        response: {
          id: created.id,
          rawId: encode(created.rawId),
          type: created.type,
          authenticatorAttachment: created.authenticatorAttachment,
          clientExtensionResults: created.getClientExtensionResults(),
          response: {
            clientDataJSON: encode(attestation.clientDataJSON),
            attestationObject: encode(attestation.attestationObject),
            transports: attestation.getTransports(),
          },
        },
      };
      const saved = await json("/api/auth/register/passkey", {
        method: "POST",
        body: JSON.stringify(completionPayload),
      });
      if (!saved.response.ok) throw new Error(JSON.stringify(saved.body));
      const replayed = await json("/api/auth/register/passkey", {
        method: "POST",
        body: JSON.stringify(completionPayload),
      });
      const savedCredentials = await json("/api/auth/passkeys");
      const renamed = await json(
        `/api/auth/passkeys/${encodeURIComponent(savedCredentials.body.passkeys[0].id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: "MacBook Touch ID" }),
        },
      );
      const passkeys = await json("/api/auth/passkeys");
      await json("/api/auth/logout", { method: "POST" });

      const authenticationOptions = await json("/api/auth/passkey/options", { method: "POST" });
      if (!authenticationOptions.response.ok) {
        throw new Error(JSON.stringify(authenticationOptions.body));
      }
      const request = authenticationOptions.body.options;
      const asserted = (await navigator.credentials.get({
        publicKey: {
          ...request,
          challenge: decode(request.challenge),
          allowCredentials: request.allowCredentials?.map(
            (credential: PublicKeyCredentialDescriptor & { id: string }) => ({
              ...credential,
              id: decode(credential.id),
            }),
          ),
        },
      })) as PublicKeyCredential;
      const assertion = asserted.response as AuthenticatorAssertionResponse;
      const login = await json("/api/auth/passkey", {
        method: "POST",
        body: JSON.stringify({
          ceremonyId: authenticationOptions.body.ceremonyId,
          response: {
            id: asserted.id,
            rawId: encode(asserted.rawId),
            type: asserted.type,
            authenticatorAttachment: asserted.authenticatorAttachment,
            clientExtensionResults: asserted.getClientExtensionResults(),
            response: {
              clientDataJSON: encode(assertion.clientDataJSON),
              authenticatorData: encode(assertion.authenticatorData),
              signature: encode(assertion.signature),
              userHandle: assertion.userHandle ? encode(assertion.userHandle) : undefined,
            },
          },
        }),
      });
      const session = await json("/api/auth/session");
      return {
        pendingRegistrationAvailable: pendingConfig.body.registrationAvailable,
        userHandleLength: decode(creation.user.id).length,
        savedStatus: saved.response.status,
        replayedStatus: replayed.response.status,
        renamedStatus: renamed.response.status,
        renamedBody: renamed.body,
        passkeysBody: passkeys.body,
        loginStatus: login.response.status,
        loginBody: login.body,
        sessionStatus: session.response.status,
        sessionBody: session.body,
      };
    });

    expect(result).toEqual({
      pendingRegistrationAvailable: true,
      userHandleLength: 32,
      savedStatus: 201,
      replayedStatus: 403,
      renamedStatus: 200,
      renamedBody: {
        passkey: expect.objectContaining({ name: "MacBook Touch ID" }),
      },
      passkeysBody: {
        passkeys: [expect.objectContaining({ name: "MacBook Touch ID" })],
        hasPassword: false,
      },
      loginStatus: 200,
      loginBody: {
        user: {
          id: expect.stringMatching(/^[a-f0-9]{32}$/),
          username: "passkey-reader",
          hasPassword: false,
        },
      },
      sessionStatus: 200,
      sessionBody: {
        user: {
          id: expect.stringMatching(/^[a-f0-9]{32}$/),
          username: "passkey-reader",
          hasPassword: false,
        },
      },
    });
    const account = database.auth.findEnabledUser("passkey-reader");
    expect(database.feeds.listFeeds(account?.id ?? 0)).toMatchObject([
      {
        title: "feedfold releases",
        feedUrl: "https://github.com/egornomic/feedfold/releases.atom",
      },
    ]);
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    database.connection
      .prepare("UPDATE sessions SET recent_auth_at = '2000-01-01T00:00:00.000Z'")
      .run();
    const stepUp = await page.evaluate(async () => {
      const decode = (value: string): Uint8Array => {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      };
      const encode = (value: ArrayBuffer): string => {
        const binary = String.fromCharCode(...new Uint8Array(value));
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      };
      const json = async (path: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (init?.body) headers.set("Content-Type", "application/json");
        const response = await fetch(path, { ...init, headers });
        return { response, body: response.status === 204 ? null : await response.json() };
      };

      const blocked = await json("/api/auth/passkeys/options", { method: "POST" });
      const options = await json("/api/auth/step-up/passkey/options", {
        method: "POST",
        body: JSON.stringify({ operationId: blocked.body.operationId }),
      });
      const request = options.body.options;
      const asserted = (await navigator.credentials.get({
        publicKey: {
          ...request,
          challenge: decode(request.challenge),
          allowCredentials: request.allowCredentials?.map(
            (credential: PublicKeyCredentialDescriptor & { id: string }) => ({
              ...credential,
              id: decode(credential.id),
            }),
          ),
        },
      })) as PublicKeyCredential;
      const assertion = asserted.response as AuthenticatorAssertionResponse;
      const authenticated = await json("/api/auth/step-up/passkey", {
        method: "POST",
        body: JSON.stringify({
          ceremonyId: options.body.ceremonyId,
          response: {
            id: asserted.id,
            rawId: encode(asserted.rawId),
            type: asserted.type,
            authenticatorAttachment: asserted.authenticatorAttachment,
            clientExtensionResults: asserted.getClientExtensionResults(),
            response: {
              clientDataJSON: encode(assertion.clientDataJSON),
              authenticatorData: encode(assertion.authenticatorData),
              signature: encode(assertion.signature),
              userHandle: assertion.userHandle ? encode(assertion.userHandle) : undefined,
            },
          },
        }),
      });
      const resumed = await json("/api/auth/passkeys/options", { method: "POST" });
      const creation = resumed.body.options;
      const created = (await navigator.credentials.create({
        publicKey: {
          ...creation,
          challenge: decode(creation.challenge),
          user: { ...creation.user, id: decode(creation.user.id) },
          excludeCredentials: creation.excludeCredentials?.map(
            (credential: PublicKeyCredentialDescriptor & { id: string }) => ({
              ...credential,
              id: decode(credential.id),
            }),
          ),
        },
      })) as PublicKeyCredential;
      const attestation = created.response as AuthenticatorAttestationResponse;
      const added = await json("/api/auth/passkeys", {
        method: "POST",
        body: JSON.stringify({
          ceremonyId: resumed.body.ceremonyId,
          response: {
            id: created.id,
            rawId: encode(created.rawId),
            type: created.type,
            authenticatorAttachment: created.authenticatorAttachment,
            clientExtensionResults: created.getClientExtensionResults(),
            response: {
              clientDataJSON: encode(attestation.clientDataJSON),
              attestationObject: encode(attestation.attestationObject),
              transports: attestation.getTransports(),
            },
          },
        }),
      });
      const beforeRemoval = await json("/api/auth/passkeys");
      const removalStatuses = [];
      for (const passkey of beforeRemoval.body.passkeys) {
        const removed = await json(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, {
          method: "DELETE",
        });
        removalStatuses.push(removed.response.status);
      }
      const afterRemoval = await json("/api/auth/passkeys");
      const session = await json("/api/auth/session");
      return {
        blockedStatus: blocked.response.status,
        blockedCode: blocked.body.code,
        stepUpStatus: authenticated.response.status,
        resumedStatus: resumed.response.status,
        addedStatus: added.response.status,
        lastUsedAt: beforeRemoval.body.passkeys.find(
          (passkey: { name: string }) => passkey.name === "MacBook Touch ID",
        ).lastUsedAt,
        removalStatuses,
        remainingPasskeys: afterRemoval.body.passkeys.length,
        sessionStatus: session.response.status,
      };
    });
    expect(stepUp).toEqual({
      blockedStatus: 428,
      blockedCode: "RECENT_AUTH_REQUIRED",
      stepUpStatus: 204,
      resumedStatus: 200,
      addedStatus: 201,
      lastUsedAt: expect.any(String),
      removalStatuses: [204, 204],
      remainingPasskeys: 0,
      sessionStatus: 200,
    });
    expect(database.connection.prepare("SELECT COUNT(*) FROM passkeys").pluck().get()).toBe(0);
  });
});
