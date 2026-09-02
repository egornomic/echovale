import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { KeyRound, LoaderCircle, LogIn, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { SessionUser } from "../shared/types";
import { api, errorMessage } from "./api";
import { BrandIdentity } from "./brand";

export function SessionLoading() {
  return (
    <main className="auth-page" aria-busy="true">
      <div className="session-loading" role="status" aria-label="Opening feedfold">
        <BrandIdentity decorative />
      </div>
    </main>
  );
}

export function LoginPage({ onAuthenticated }: { onAuthenticated: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [usingPasskey, setUsingPasskey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationAvailable, setRegistrationAvailable] = useState(false);
  const [passkeysAvailable, setPasskeysAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .authConfig()
      .then((config) => {
        if (!active) return;
        setRegistrationAvailable(config.registrationAvailable);
        setPasskeysAvailable(config.passkeysAvailable && browserSupportsWebAuthn());
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      onAuthenticated(
        mode === "login"
          ? await api.login(username, password)
          : await api.register(username, password),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setMode((current) => (current === "login" ? "register" : "login"));
    setPassword("");
    setError(null);
  };

  const signInWithPasskey = async () => {
    setUsingPasskey(true);
    setError(null);
    try {
      const { ceremonyId, options } = await api.passkeyAuthenticationOptions();
      const response = await startAuthentication({ optionsJSON: options });
      onAuthenticated(await api.passkeyLogin(ceremonyId, response));
    } catch (caught) {
      setError(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Passkey sign-in was cancelled or timed out."
          : errorMessage(caught),
      );
    } finally {
      setUsingPasskey(false);
    }
  };

  const createAccountWithPasskey = async () => {
    setUsingPasskey(true);
    setError(null);
    try {
      const { registrationId, options } = await api.passkeySignupOptions(username);
      const response = await startRegistration({ optionsJSON: options });
      onAuthenticated(await api.completePasskeySignup(registrationId, response));
    } catch (caught) {
      setError(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Passkey creation was cancelled or timed out."
          : errorMessage(caught),
      );
    } finally {
      setUsingPasskey(false);
    }
  };

  const registering = mode === "register";
  const actionLabel = registering ? "Create account" : "Sign in";
  const progressLabel = registering ? "Creating account" : "Signing in";
  const ActionIcon = registering ? UserPlus : LogIn;

  return (
    <main className="auth-page">
      <section className="login-panel" aria-labelledby="auth-heading">
        <BrandIdentity className="login-brand" />
        <div className="login-heading">
          <h1 id="auth-heading">{actionLabel}</h1>
          <p>
            {registering
              ? "Create the account that will own this reading queue."
              : "Sign in to open your reading queue."}
          </p>
        </div>
        <form className="login-form" onSubmit={submit}>
          {!registering && passkeysAvailable ? (
            <button
              className="primary-button login-button"
              type="button"
              disabled={submitting || usingPasskey}
              onClick={() => void signInWithPasskey()}
            >
              {usingPasskey ? (
                <LoaderCircle className="spin" aria-hidden="true" size={16} />
              ) : (
                <KeyRound aria-hidden="true" size={16} />
              )}
              {usingPasskey ? "Waiting for passkey" : "Sign in with a passkey"}
            </button>
          ) : null}
          {!registering && passkeysAvailable ? (
            <div className="auth-divider">
              <span>or</span>
            </div>
          ) : null}
          <label className="login-field" htmlFor="auth-username">
            <span>Username</span>
            <input
              id="auth-username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={registering ? 3 : undefined}
              maxLength={registering ? 32 : 80}
              pattern={registering ? "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?" : undefined}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          {registering && passkeysAvailable ? (
            <button
              className="primary-button login-button"
              type="button"
              disabled={submitting || usingPasskey || username.trim().length < 3}
              onClick={() => void createAccountWithPasskey()}
            >
              {usingPasskey ? (
                <LoaderCircle className="spin" aria-hidden="true" size={16} />
              ) : (
                <KeyRound aria-hidden="true" size={16} />
              )}
              {usingPasskey ? "Creating passkey" : "Create account with a passkey"}
            </button>
          ) : null}
          {registering && passkeysAvailable ? (
            <div className="auth-divider">
              <span>or</span>
            </div>
          ) : null}
          <label className="login-field" htmlFor="auth-password">
            <span>Password</span>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              required
              minLength={registering ? 15 : undefined}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <div className="login-error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className={
              passkeysAvailable ? "secondary-button login-button" : "primary-button login-button"
            }
            type="submit"
            disabled={submitting || usingPasskey}
          >
            {submitting ? (
              <LoaderCircle className="spin" aria-hidden="true" size={16} />
            ) : (
              <ActionIcon aria-hidden="true" size={16} />
            )}
            {submitting ? progressLabel : actionLabel}
          </button>
        </form>
        {registering || registrationAvailable ? (
          <div className="auth-switch">
            <span>{registering ? "Already have an account?" : "Need an account?"}</span>
            <button type="button" onClick={switchMode} disabled={submitting || usingPasskey}>
              {registering ? "Sign in" : "Create account"}
            </button>
          </div>
        ) : (
          <p className="registration-closed">Account creation is closed on this server.</p>
        )}
      </section>
    </main>
  );
}
