import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  AlertTriangle,
  Check,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Minus,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AI_PROMPT_MAX_LENGTH,
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
} from "../../shared/ai-prompts";
import type {
  AiCustomPrompt,
  AiProvider,
  AiSettings,
  AppSettings,
  DuplicateArticleWindowDays,
} from "../../shared/types";
import { DUPLICATE_ARTICLE_WINDOW_DAYS } from "../../shared/types";
import { ApiError, api, errorMessage } from "../api";
import type { ReaderDataMutations } from "../data-resource";
import { isDesktopApp } from "../desktop";
import { DropdownCombobox, DropdownSelect } from "../dropdown";
import { useAnimatedDialog } from "../motion";
import type { Theme } from "../reader-preferences";
import { ExportOpmlLink, formatRefreshInterval, ImportOpmlButton, Kbd, PageHeader } from "./shared";
import { ShortcutReference } from "./shortcut-help";
import "./dialogs.css";
import "./settings.css";

type SensitiveAction = <T>(action: () => Promise<T>) => Promise<T>;

interface PendingSensitiveAction {
  operationId: string;
  action: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function AccountSettingsSection({
  showToast,
  runSensitive,
}: {
  showToast: (message: string) => void;
  runSensitive: SensitiveAction;
}) {
  const [passkeys, setPasskeys] = useState<Awaited<ReturnType<typeof api.passkeys>>["passkeys"]>(
    [],
  );
  const [hasPassword, setHasPassword] = useState(false);
  const [passkeysAvailable, setPasskeysAvailable] = useState(false);
  const [loadingPasskeys, setLoadingPasskeys] = useState(true);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null);
  const [passkeyName, setPasskeyName] = useState("");
  const [renamingPasskey, setRenamingPasskey] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passkeyNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([api.authConfig(), api.passkeys()])
      .then(([config, credentials]) => {
        if (!active) return;
        setPasskeysAvailable(config.passkeysAvailable && browserSupportsWebAuthn());
        setPasskeys(credentials.passkeys);
        setHasPassword(credentials.hasPassword);
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoadingPasskeys(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const addPasskey = async () => {
    setEditingPasskeyId(null);
    setPasskeyBusy(true);
    setError(null);
    try {
      const passkey = await runSensitive(async () => {
        const { ceremonyId, options } = await api.passkeyRegistrationOptions();
        const response = await startRegistration({ optionsJSON: options });
        return (await api.registerPasskey(ceremonyId, response)).passkey;
      });
      setPasskeys((current) => [passkey, ...current]);
      showToast("Passkey added");
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "NotAllowedError")) {
        setError(errorMessage(caught));
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  const startRenamingPasskey = (id: string, name: string) => {
    setEditingPasskeyId(id);
    setPasskeyName(name);
    setError(null);
    window.requestAnimationFrame(() => {
      passkeyNameRef.current?.focus();
      passkeyNameRef.current?.select();
    });
  };

  const cancelRenamingPasskey = () => {
    if (renamingPasskey) return;
    setEditingPasskeyId(null);
    setPasskeyName("");
  };

  const renamePasskey = async (event: FormEvent, id: string, currentName: string) => {
    event.preventDefault();
    const name = passkeyName.trim();
    if (!name) return;
    if (name === currentName) {
      cancelRenamingPasskey();
      return;
    }
    setRenamingPasskey(true);
    setError(null);
    try {
      const { passkey } = await api.renamePasskey(id, name);
      setPasskeys((current) => current.map((item) => (item.id === id ? passkey : item)));
      setEditingPasskeyId(null);
      setPasskeyName("");
      showToast("Passkey renamed");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRenamingPasskey(false);
    }
  };

  const removePasskey = async (id: string) => {
    setPasskeyBusy(true);
    setError(null);
    try {
      await runSensitive(() => api.deletePasskey(id));
      setPasskeys((current) => current.filter((passkey) => passkey.id !== id));
      showToast("Passkey removed");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPasskeyBusy(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setChangingPassword(true);
    setError(null);
    try {
      await runSensitive(() => api.changePassword(newPassword));
      setHasPassword(true);
      setNewPassword("");
      setConfirmPassword("");
      showToast("Password changed. Other sessions were signed out");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setChangingPassword(false);
    }
  };

  const removePassword = async () => {
    setChangingPassword(true);
    setError(null);
    try {
      await runSensitive(() => api.removePassword());
      setHasPassword(false);
      setNewPassword("");
      setConfirmPassword("");
      showToast("Password removed");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <section
      className="settings-section account-settings-section"
      aria-labelledby="account-heading"
    >
      <div className="settings-heading">
        <h2 id="account-heading">Account security</h2>
        <p>Manage the credentials you use to sign in.</p>
      </div>
      <div className="account-setting-block">
        <div className="account-setting-heading">
          <div>
            <strong>Passkeys</strong>
            <p>Use your device lock, fingerprint, face, or security key instead of a password.</p>
          </div>
          <div className="passkey-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!passkeysAvailable || loadingPasskeys || passkeyBusy}
              onClick={() => void addPasskey()}
            >
              {passkeyBusy ? (
                <LoaderCircle className="spin" aria-hidden="true" size={15} />
              ) : (
                <KeyRound aria-hidden="true" size={15} />
              )}
              Add passkey
            </button>
          </div>
        </div>
        {!loadingPasskeys && !passkeysAvailable ? (
          <p className="account-setting-note">Passkeys require a supported browser and HTTPS.</p>
        ) : null}
        {passkeys.length > 0 ? (
          <ul className="passkey-list">
            {passkeys.map((passkey) => (
              <li key={passkey.id}>
                <div className="passkey-copy">
                  {editingPasskeyId === passkey.id ? (
                    <form
                      className="passkey-rename-form"
                      onSubmit={(event) => void renamePasskey(event, passkey.id, passkey.name)}
                    >
                      <label className="sr-only" htmlFor={`passkey-name-${passkey.id}`}>
                        Passkey name
                      </label>
                      <input
                        ref={passkeyNameRef}
                        id={`passkey-name-${passkey.id}`}
                        type="text"
                        value={passkeyName}
                        maxLength={80}
                        required
                        disabled={renamingPasskey}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          cancelRenamingPasskey();
                        }}
                        onChange={(event) => setPasskeyName(event.target.value)}
                      />
                      <button
                        className="icon-button passkey-save-name"
                        type="submit"
                        aria-label="Save passkey name"
                        disabled={renamingPasskey || !passkeyName.trim()}
                      >
                        {renamingPasskey ? (
                          <LoaderCircle className="spin" aria-hidden="true" size={15} />
                        ) : (
                          <Check aria-hidden="true" size={15} />
                        )}
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="Cancel renaming passkey"
                        disabled={renamingPasskey}
                        onClick={cancelRenamingPasskey}
                      >
                        <X aria-hidden="true" size={15} />
                      </button>
                    </form>
                  ) : (
                    <strong title={passkey.name}>{passkey.name}</strong>
                  )}
                  <p>
                    Added {new Date(passkey.createdAt).toLocaleDateString()}
                    {passkey.lastUsedAt
                      ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                      : " · Never used"}
                  </p>
                </div>
                {editingPasskeyId === passkey.id ? null : (
                  <div className="passkey-item-actions">
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Rename ${passkey.name}`}
                      disabled={passkeyBusy || renamingPasskey}
                      onClick={() => startRenamingPasskey(passkey.id, passkey.name)}
                    >
                      <Pencil aria-hidden="true" size={15} />
                    </button>
                    <button
                      className="icon-button danger-action"
                      type="button"
                      aria-label={`Remove ${passkey.name}`}
                      disabled={passkeyBusy || renamingPasskey}
                      onClick={() => void removePasskey(passkey.id)}
                    >
                      <Trash2 aria-hidden="true" size={15} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <form
        className="account-setting-block password-change-form"
        onSubmit={(event) => void changePassword(event)}
      >
        <div>
          <strong>{hasPassword ? "Change password" : "Add password"}</strong>
          <p>Use at least 15 characters.</p>
        </div>
        <div className="password-change-fields">
          <label>
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              minLength={15}
              maxLength={128}
              required
              disabled={changingPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              minLength={15}
              maxLength={128}
              required
              disabled={changingPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            type="submit"
            disabled={
              changingPassword || newPassword.length < 15 || newPassword !== confirmPassword
            }
          >
            {changingPassword ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : null}
            {hasPassword ? "Change password" : "Add password"}
          </button>
          {hasPassword ? (
            <button
              className="danger-button"
              type="button"
              disabled={changingPassword}
              onClick={() => void removePassword()}
            >
              Remove password
            </button>
          ) : null}
        </div>
      </form>
      {error ? (
        <div className="ai-settings-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}

function AiSettingsSection({
  settings,
  aiSettings,
  onSettings,
  onAiSettings,
  showToast,
  runSensitive,
}: {
  settings: AppSettings;
  aiSettings: AiSettings;
  onSettings: (settings: AppSettings) => void;
  onAiSettings: (settings: AiSettings) => void;
  showToast: (message: string) => void;
  runSensitive: SensitiveAction;
}) {
  const initialFeature = aiSettings.features.articleSummary;
  const initialProvider = initialFeature?.provider ?? "gemini";
  const initialModel =
    initialFeature?.model ??
    aiSettings.providers.find((provider) => provider.id === initialProvider)?.defaultModel ??
    "";
  const [providerId, setProviderId] = useState<AiProvider>(initialProvider);
  const [modelId, setModelId] = useState(initialModel);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingFeature, setSavingFeature] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);
  const [savingPrompts, setSavingPrompts] = useState(false);
  const [savingCustomPrompt, setSavingCustomPrompt] = useState(false);
  const [summaryPrompt, setSummaryPrompt] = useState(settings.summaryPrompt);
  const [translationPrompt, setTranslationPrompt] = useState(settings.translationPrompt);
  const [editingCustomPrompt, setEditingCustomPrompt] = useState<AiCustomPrompt | null>(null);
  const [customPromptName, setCustomPromptName] = useState("");
  const [customPromptText, setCustomPromptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [customPromptError, setCustomPromptError] = useState<string | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const summaryPromptRef = useRef<HTMLTextAreaElement>(null);
  const customPromptNameRef = useRef<HTMLInputElement>(null);

  const resetPromptDraft = useCallback(() => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
    setPromptError(null);
  }, [settings.summaryPrompt, settings.translationPrompt]);
  const promptDialog = useAnimatedDialog(resetPromptDraft, { autoOpen: false });
  const customPromptDialog = useAnimatedDialog(() => setCustomPromptError(null), {
    autoOpen: false,
  });

  useEffect(() => {
    const feature = aiSettings.features.articleSummary;
    const nextProviderId = feature?.provider ?? "gemini";
    const nextProvider = aiSettings.providers.find((provider) => provider.id === nextProviderId);
    setProviderId(nextProviderId);
    setModelId(feature?.model ?? nextProvider?.defaultModel ?? "");
  }, [aiSettings]);

  useEffect(() => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
  }, [settings.summaryPrompt, settings.translationPrompt]);

  const provider = aiSettings.providers.find((option) => option.id === providerId);
  if (!provider) return null;
  const activeFeature = aiSettings.features.articleSummary;
  const modelChanged =
    activeFeature?.provider !== providerId || activeFeature?.model !== modelId.trim();
  const promptsChanged =
    summaryPrompt.trim() !== settings.summaryPrompt ||
    translationPrompt.trim() !== settings.translationPrompt;
  const defaultPromptsSelected =
    summaryPrompt.trim() === DEFAULT_ARTICLE_SUMMARY_PROMPT &&
    translationPrompt.trim() === DEFAULT_ARTICLE_TRANSLATION_PROMPT;
  const busy = savingFeature || savingKey || removingKey || savingPrompts || savingCustomPrompt;

  const updateFeature = async (nextProvider: AiProvider, nextModel: string) => {
    setSavingFeature(true);
    setError(null);
    try {
      onAiSettings(
        await api.updateAiFeature("article_summary", {
          provider: nextProvider,
          model: nextModel.trim(),
        }),
      );
      showToast("AI provider and model saved");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingFeature(false);
    }
  };

  const selectProvider = (nextProviderId: AiProvider) => {
    const nextProvider = aiSettings.providers.find((option) => option.id === nextProviderId);
    if (!nextProvider) return;
    setProviderId(nextProviderId);
    setModelId(
      activeFeature?.provider === nextProviderId ? activeFeature.model : nextProvider.defaultModel,
    );
    setApiKey("");
    setShowKey(false);
    setError(null);
    window.requestAnimationFrame(() => modelInputRef.current?.focus());
  };

  const saveModel = async (event: FormEvent) => {
    event.preventDefault();
    if (!modelId.trim()) return;
    await updateFeature(providerId, modelId);
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    const nextKey = apiKey.trim();
    const nextModel = modelId.trim();
    if (!nextKey || !nextModel) return;
    setSavingKey(true);
    setError(null);
    try {
      const keySettings = await runSensitive(() => api.saveAiProviderKey(providerId, nextKey));
      try {
        const updated = await api.updateAiFeature("article_summary", {
          provider: providerId,
          model: nextModel,
        });
        onAiSettings(updated);
        setApiKey("");
        setShowKey(false);
        showToast(`${provider.label} API key saved for summaries and translations`);
      } catch (caught) {
        onAiSettings(keySettings);
        throw caught;
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    if (
      !window.confirm(
        `Remove the ${provider.label} API key? Summaries and translations will stop until you save another key.`,
      )
    ) {
      return;
    }
    setRemovingKey(true);
    setError(null);
    try {
      onAiSettings(await runSensitive(() => api.deleteAiProviderKey(providerId)));
      setApiKey("");
      setShowKey(false);
      showToast(`${provider.label} API key removed`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRemovingKey(false);
    }
  };

  const openPromptDialog = () => {
    setSummaryPrompt(settings.summaryPrompt);
    setTranslationPrompt(settings.translationPrompt);
    setPromptError(null);
    promptDialog.open();
    window.requestAnimationFrame(() => summaryPromptRef.current?.focus());
  };

  const closePromptDialog = () => {
    if (!savingPrompts) promptDialog.close();
  };

  const savePrompts = async (event: FormEvent) => {
    event.preventDefault();
    const nextSummaryPrompt = summaryPrompt.trim();
    const nextTranslationPrompt = translationPrompt.trim();
    if (!nextSummaryPrompt || !nextTranslationPrompt || !promptsChanged) return;
    setSavingPrompts(true);
    setError(null);
    setPromptError(null);
    try {
      onSettings(
        await api.updateSettings({
          summaryPrompt: nextSummaryPrompt,
          translationPrompt: nextTranslationPrompt,
        }),
      );
      showToast("Default AI prompts saved");
      promptDialog.close();
    } catch (caught) {
      setPromptError(errorMessage(caught));
    } finally {
      setSavingPrompts(false);
    }
  };

  const openCustomPromptDialog = (prompt?: AiCustomPrompt) => {
    setEditingCustomPrompt(prompt ?? null);
    setCustomPromptName(prompt?.name ?? "");
    setCustomPromptText(prompt?.prompt ?? "");
    setCustomPromptError(null);
    customPromptDialog.open();
    window.requestAnimationFrame(() => customPromptNameRef.current?.focus());
  };

  const closeCustomPromptDialog = () => {
    if (!savingCustomPrompt) customPromptDialog.close();
  };

  const saveCustomPrompt = async (event: FormEvent) => {
    event.preventDefault();
    const name = customPromptName.trim();
    const prompt = customPromptText.trim();
    if (!name || !prompt) return;
    const nextPrompt: AiCustomPrompt = {
      id: editingCustomPrompt?.id ?? crypto.randomUUID(),
      name,
      prompt,
    };
    const customPrompts = editingCustomPrompt
      ? settings.customPrompts.map((item) =>
          item.id === editingCustomPrompt.id ? nextPrompt : item,
        )
      : [...settings.customPrompts, nextPrompt];
    setSavingCustomPrompt(true);
    setCustomPromptError(null);
    try {
      onSettings(await api.updateSettings({ customPrompts }));
      showToast(editingCustomPrompt ? "Custom prompt updated" : "Custom prompt added");
      customPromptDialog.close();
    } catch (caught) {
      setCustomPromptError(errorMessage(caught));
    } finally {
      setSavingCustomPrompt(false);
    }
  };

  const deleteCustomPrompt = async (prompt: AiCustomPrompt) => {
    if (!window.confirm(`Delete the custom prompt “${prompt.name}”?`)) return;
    setSavingCustomPrompt(true);
    setError(null);
    try {
      onSettings(
        await api.updateSettings({
          customPrompts: settings.customPrompts.filter((item) => item.id !== prompt.id),
        }),
      );
      showToast("Custom prompt deleted");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingCustomPrompt(false);
    }
  };

  return (
    <section
      id="ai-settings"
      className="settings-section ai-settings-section"
      aria-labelledby="ai-heading"
    >
      <div className="settings-heading">
        <div>
          <h2 id="ai-heading">AI</h2>
          <p>Choose the provider and model used for summaries, translations, and custom prompts.</p>
        </div>
        {busy ? (
          <span className="saving-label" role="status">
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
            Saving
          </span>
        ) : null}
      </div>

      {!aiSettings.credentialStorageAvailable ? (
        <div className="ai-settings-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>
            {isDesktopApp() ? (
              "Secure API-key storage is unavailable on this Mac."
            ) : (
              <>
                To save provider keys, set <code>AI_CREDENTIALS_KEY</code>, then restart or recreate
                the server.
              </>
            )}
          </span>
        </div>
      ) : null}

      <div className="setting-row">
        <label htmlFor="ai-summary-provider">
          <strong>Provider</strong>
          <p>The active provider runs every AI action.</p>
        </label>
        <div className="ai-provider-control">
          <DropdownSelect
            id="ai-summary-provider"
            value={providerId}
            disabled={busy || !aiSettings.credentialStorageAvailable}
            options={aiSettings.providers.map((option) => ({
              value: option.id,
              label: `${option.label}${option.configured ? " (key saved)" : ""}`,
            }))}
            onChange={(value) => selectProvider(value as AiProvider)}
          />
        </div>
      </div>

      <div className="setting-row">
        <label htmlFor="ai-summary-model">
          <strong>Model</strong>
          <p id="ai-summary-model-help">
            Enter the exact {provider.label} model ID. Default: <code>{provider.defaultModel}</code>
            .
          </p>
        </label>
        <form className="ai-model-form" onSubmit={(event) => void saveModel(event)}>
          <input
            ref={modelInputRef}
            id="ai-summary-model"
            type="text"
            value={modelId}
            placeholder={provider.defaultModel}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            required
            aria-describedby="ai-summary-model-help"
            disabled={busy || !aiSettings.credentialStorageAvailable}
            onChange={(event) => {
              setModelId(event.target.value);
              setError(null);
            }}
          />
          <button
            className="secondary-button"
            type="submit"
            disabled={
              !modelId.trim() || !modelChanged || busy || !aiSettings.credentialStorageAvailable
            }
          >
            {savingFeature ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            Save model
          </button>
        </form>
      </div>

      <div className="setting-row ai-key-row">
        <div>
          <strong>{provider.label} API key</strong>
          <p id="ai-api-key-help">
            {provider.configured
              ? "A key is saved. Enter a new key only if you want to replace it."
              : "feedfold encrypts this key on the server and does not show it again."}
          </p>
        </div>
        <form className="ai-key-form" onSubmit={(event) => void saveKey(event)}>
          <div className="ai-key-input">
            <label className="sr-only" htmlFor="ai-api-key">
              {provider.label} API key
            </label>
            <input
              ref={keyInputRef}
              id="ai-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder={provider.configured ? "Paste a replacement key" : "Paste API key"}
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="ai-api-key-help"
              disabled={busy || !aiSettings.credentialStorageAvailable}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
            <button
              className="icon-button"
              type="button"
              disabled={!apiKey || busy}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              aria-pressed={showKey}
              onClick={() => setShowKey((current) => !current)}
            >
              {showKey ? (
                <EyeOff aria-hidden="true" size={16} />
              ) : (
                <Eye aria-hidden="true" size={16} />
              )}
            </button>
          </div>
          <button
            className="primary-button"
            type="submit"
            disabled={
              !apiKey.trim() || !modelId.trim() || busy || !aiSettings.credentialStorageAvailable
            }
          >
            {savingKey ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
            {provider.configured ? "Replace key" : "Save key"}
          </button>
          {provider.configured ? (
            <button
              className="secondary-button ai-key-remove"
              type="button"
              disabled={busy || !aiSettings.credentialStorageAvailable}
              onClick={() => void removeKey()}
            >
              Remove key
            </button>
          ) : null}
        </form>
      </div>

      {error ? (
        <div className="ai-settings-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="setting-row">
        <div>
          <strong>Default prompts</strong>
          <p>Set the instructions used by the Summarize and Translate actions.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={openPromptDialog}
        >
          <Edit3 aria-hidden="true" size={15} />
          Edit defaults
        </button>
      </div>

      <div className="custom-prompts-setting">
        <div className="custom-prompts-heading">
          <div>
            <strong>Custom prompts</strong>
            <p>Add named instructions that you can run from an article's AI menu.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => openCustomPromptDialog()}
          >
            <Plus aria-hidden="true" size={15} />
            Add prompt
          </button>
        </div>
        {settings.customPrompts.length > 0 ? (
          <ul className="custom-prompt-list">
            {settings.customPrompts.map((prompt) => (
              <li className="custom-prompt-list-item" key={prompt.id}>
                <div>
                  <strong>{prompt.name}</strong>
                  <p>{prompt.prompt}</p>
                </div>
                <div className="custom-prompt-actions">
                  <button
                    className="icon-button"
                    type="button"
                    disabled={busy}
                    aria-label={`Edit ${prompt.name}`}
                    onClick={() => openCustomPromptDialog(prompt)}
                  >
                    <Edit3 aria-hidden="true" size={15} />
                  </button>
                  <button
                    className="icon-button danger-action"
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${prompt.name}`}
                    onClick={() => void deleteCustomPrompt(prompt)}
                  >
                    <Trash2 aria-hidden="true" size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="custom-prompts-empty">
            No custom prompts. Add one to create another article action.
          </p>
        )}
      </div>

      <dialog
        ref={promptDialog.dialogRef}
        className="management-dialog is-wide ai-prompt-dialog"
        aria-labelledby="ai-prompt-dialog-title"
        data-state={promptDialog.closing ? "closing" : "open"}
        inert={promptDialog.closing}
        onClose={promptDialog.handleClose}
        onCancel={(event) => {
          if (savingPrompts) {
            event.preventDefault();
            return;
          }
          promptDialog.handleCancel(event);
        }}
      >
        <form className="ai-prompt-dialog-form" onSubmit={(event) => void savePrompts(event)}>
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <Edit3 size={16} />
            </span>
            <div>
              <h2 id="ai-prompt-dialog-title">Edit default prompts</h2>
              <p>Edit the instructions behind the Summarize and Translate actions.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={savingPrompts}
              onClick={closePromptDialog}
              aria-label="Close prompt editor"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          <div className="management-dialog-body ai-prompt-dialog-body">
            <label className="ai-prompt-field" htmlFor="ai-summary-prompt">
              <span>Summary prompt</span>
              <p id="ai-summary-prompt-help">
                Controls the structure, detail, and tone of summaries.
              </p>
              <textarea
                ref={summaryPromptRef}
                id="ai-summary-prompt"
                value={summaryPrompt}
                rows={12}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingPrompts}
                aria-describedby="ai-summary-prompt-help"
                onChange={(event) => {
                  setSummaryPrompt(event.target.value);
                  setPromptError(null);
                }}
              />
            </label>
            <label className="ai-prompt-field" htmlFor="ai-translation-prompt">
              <span>Translation prompt</span>
              <p id="ai-translation-prompt-help">
                Keep the JSON and data-translation-id requirements so translated articles can be
                rebuilt.
              </p>
              <textarea
                id="ai-translation-prompt"
                value={translationPrompt}
                rows={12}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingPrompts}
                aria-describedby="ai-translation-prompt-help"
                onChange={(event) => {
                  setTranslationPrompt(event.target.value);
                  setPromptError(null);
                }}
              />
            </label>

            {promptError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{promptError}</span>
              </div>
            ) : null}
          </div>

          <footer className="management-dialog-footer">
            <button
              className="secondary-button"
              type="button"
              disabled={savingPrompts || defaultPromptsSelected}
              onClick={() => {
                setSummaryPrompt(DEFAULT_ARTICLE_SUMMARY_PROMPT);
                setTranslationPrompt(DEFAULT_ARTICLE_TRANSLATION_PROMPT);
                setPromptError(null);
              }}
            >
              Restore defaults
            </button>
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={savingPrompts}
                onClick={closePromptDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  savingPrompts ||
                  !summaryPrompt.trim() ||
                  !translationPrompt.trim() ||
                  !promptsChanged
                }
              >
                {savingPrompts ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : null}
                Save prompts
              </button>
            </div>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={customPromptDialog.dialogRef}
        className="management-dialog custom-prompt-dialog"
        aria-labelledby="custom-prompt-dialog-title"
        data-state={customPromptDialog.closing ? "closing" : "open"}
        inert={customPromptDialog.closing}
        onClose={customPromptDialog.handleClose}
        onCancel={(event) => {
          if (savingCustomPrompt) {
            event.preventDefault();
            return;
          }
          customPromptDialog.handleCancel(event);
        }}
      >
        <form className="custom-prompt-form" onSubmit={(event) => void saveCustomPrompt(event)}>
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <MessageSquareText size={16} />
            </span>
            <div>
              <h2 id="custom-prompt-dialog-title">
                {editingCustomPrompt ? "Edit custom prompt" : "Add custom prompt"}
              </h2>
              <p>Write the task only. feedfold adds the article title and text.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={savingCustomPrompt}
              onClick={closeCustomPromptDialog}
              aria-label="Close custom prompt editor"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          <div className="management-dialog-body custom-prompt-dialog-body">
            <label htmlFor="custom-prompt-name">
              <span>Name</span>
              <p id="custom-prompt-name-help">This name appears in the article's AI menu.</p>
              <input
                ref={customPromptNameRef}
                id="custom-prompt-name"
                type="text"
                value={customPromptName}
                maxLength={80}
                required
                disabled={savingCustomPrompt}
                aria-describedby="custom-prompt-name-help"
                onChange={(event) => {
                  setCustomPromptName(event.target.value);
                  setCustomPromptError(null);
                }}
              />
            </label>
            <label htmlFor="custom-prompt-text">
              <span>Prompt</span>
              <p id="custom-prompt-text-help">
                Tell the AI how to analyze or transform the article.
              </p>
              <textarea
                id="custom-prompt-text"
                value={customPromptText}
                rows={10}
                maxLength={AI_PROMPT_MAX_LENGTH}
                required
                disabled={savingCustomPrompt}
                aria-describedby="custom-prompt-text-help"
                onChange={(event) => {
                  setCustomPromptText(event.target.value);
                  setCustomPromptError(null);
                }}
              />
            </label>
            {customPromptError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{customPromptError}</span>
              </div>
            ) : null}
          </div>

          <footer className="management-dialog-footer">
            <span />
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={savingCustomPrompt}
                onClick={closeCustomPromptDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={
                  savingCustomPrompt || !customPromptName.trim() || !customPromptText.trim()
                }
              >
                {savingCustomPrompt ? (
                  <LoaderCircle className="spin" aria-hidden="true" size={15} />
                ) : null}
                {editingCustomPrompt ? "Save prompt" : "Add prompt"}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
    </section>
  );
}

function SettingsPage({
  settings,
  aiSettings,
  theme,
  fontSize,
  mutations,
  onMenu,
  onTheme,
  onFontSize,
  onSettings,
  onAiSettings,
  showToast,
}: {
  settings: AppSettings;
  aiSettings: AiSettings;
  theme: Theme;
  fontSize: number;
  mutations: ReaderDataMutations;
  onMenu: () => void;
  onTheme: (theme: Theme) => void;
  onFontSize: (value: number | ((current: number) => number)) => void;
  onSettings: (settings: AppSettings) => void;
  onAiSettings: (settings: AiSettings) => void;
  showToast: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState(settings.translationLanguage);
  const [pendingSensitive, setPendingSensitive] = useState<PendingSensitiveAction | null>(null);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [stepUpHasPassword, setStepUpHasPassword] = useState(false);
  const [stepUpHasPasskey, setStepUpHasPasskey] = useState(false);
  const stepUpDialogRef = useRef<HTMLDialogElement>(null);
  const stepUpPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTranslationLanguage(settings.translationLanguage);
  }, [settings.translationLanguage]);

  const runSensitive = useCallback<SensitiveAction>(async <T,>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (caught) {
      if (
        !(caught instanceof ApiError) ||
        caught.code !== "RECENT_AUTH_REQUIRED" ||
        !caught.operationId
      )
        throw caught;
      const credentials = await api.passkeys();
      setStepUpHasPassword(credentials.hasPassword);
      setStepUpHasPasskey(credentials.passkeys.length > 0);
      setStepUpPassword("");
      setStepUpError(null);
      return await new Promise<T>((resolve, reject) => {
        setPendingSensitive({
          operationId: caught.operationId as string,
          action,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        window.requestAnimationFrame(() => {
          stepUpDialogRef.current?.showModal();
          stepUpPasswordRef.current?.focus();
        });
      });
    }
  }, []);

  const finishStepUp = async (authenticate: () => Promise<void>) => {
    const pending = pendingSensitive;
    if (!pending) return;
    setStepUpBusy(true);
    setStepUpError(null);
    try {
      await authenticate();
      const result = await pending.action();
      pending.resolve(result);
      setPendingSensitive(null);
      setStepUpPassword("");
      stepUpDialogRef.current?.close();
    } catch (caught) {
      setStepUpError(errorMessage(caught));
    } finally {
      setStepUpBusy(false);
    }
  };

  const authenticateWithPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingSensitive || !stepUpPassword) return;
    await finishStepUp(() => api.stepUpPassword(pendingSensitive.operationId, stepUpPassword));
  };

  const authenticateWithPasskey = async () => {
    if (!pendingSensitive) return;
    await finishStepUp(async () => {
      const { ceremonyId, options } = await api.stepUpPasskeyOptions(pendingSensitive.operationId);
      const response = await startAuthentication({ optionsJSON: options });
      await api.stepUpPasskey(ceremonyId, response);
    });
  };

  const cancelStepUp = () => {
    if (stepUpBusy) return;
    pendingSensitive?.reject(new DOMException("Authentication was cancelled.", "AbortError"));
    setPendingSensitive(null);
    setStepUpPassword("");
    stepUpDialogRef.current?.close();
  };

  const saveSettings = async (change: Partial<AppSettings>) => {
    setSaving(true);
    try {
      onSettings(await api.updateSettings(change));
      showToast("Settings saved");
    } catch (error) {
      showToast(`Could not save settings: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="management-page settings-page">
      <PageHeader
        title="Settings"
        description="Manage account security, reading behavior, refresh intervals, AI, keyboard shortcuts, and OPML transfer."
        onMenu={onMenu}
        actions={
          saving ? (
            <span className="saving-label">
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
              Saving
            </span>
          ) : undefined
        }
      />
      {!isDesktopApp() ? (
        <AccountSettingsSection showToast={showToast} runSensitive={runSensitive} />
      ) : null}
      <section className="settings-section" aria-labelledby="appearance-heading">
        <div className="settings-heading">
          <h2 id="appearance-heading">Appearance</h2>
          <p>These display choices apply to this account in this browser.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Theme</strong>
            <p>Choose a theme or follow your device appearance.</p>
          </div>
          <div className="theme-options">
            <button type="button" aria-pressed={theme === "auto"} onClick={() => onTheme("auto")}>
              <Monitor aria-hidden="true" size={17} />
              Auto
            </button>
            <button type="button" aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}>
              <Moon aria-hidden="true" size={17} />
              Dark
            </button>
            <button type="button" aria-pressed={theme === "light"} onClick={() => onTheme("light")}>
              <Sun aria-hidden="true" size={17} />
              Light
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Article text size</strong>
            <p>This size applies to full articles in both reading views.</p>
          </div>
          <div className="font-stepper">
            <button
              type="button"
              disabled={fontSize <= 15}
              onClick={() => onFontSize((current) => Math.max(15, current - 1))}
              aria-label="Decrease article text size"
            >
              <Minus aria-hidden="true" size={16} />
              <Kbd>[</Kbd>
            </button>
            <output>{fontSize}px</output>
            <button
              type="button"
              disabled={fontSize >= 23}
              onClick={() => onFontSize((current) => Math.min(23, current + 1))}
              aria-label="Increase article text size"
            >
              <Plus aria-hidden="true" size={16} />
              <Kbd>]</Kbd>
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="reading-behavior-heading">
        <div className="settings-heading">
          <h2 id="reading-behavior-heading">Reading behavior</h2>
          <p>These choices apply to every feed and folder.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Mark as read on scroll</strong>
            <p>Mark an article as read after you scroll completely past it.</p>
          </div>
          <button
            className={`switch ${settings.markReadOnScroll ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-label="Mark as read on scroll"
            aria-checked={settings.markReadOnScroll}
            disabled={saving}
            onClick={() => void saveSettings({ markReadOnScroll: !settings.markReadOnScroll })}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>YouTube descriptions</strong>
            <p>Show descriptions from YouTube videos and Shorts in lists and below the player.</p>
          </div>
          <button
            className={`switch ${settings.showYouTubeDescriptions ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-label="Show YouTube descriptions"
            aria-checked={settings.showYouTubeDescriptions}
            disabled={saving}
            onClick={() =>
              void saveSettings({
                showYouTubeDescriptions: !settings.showYouTubeDescriptions,
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <label htmlFor="translation-language">
            <strong>Translation language</strong>
            <p>Translate articles into this language with the configured AI model.</p>
          </label>
          <form
            className="translation-language-form"
            onSubmit={(event) => {
              event.preventDefault();
              const language = translationLanguage.trim();
              if (language) void saveSettings({ translationLanguage: language });
            }}
          >
            <DropdownCombobox
              id="translation-language"
              ariaLabel="Translation language"
              value={translationLanguage}
              suggestions={[
                "English",
                "Polish",
                "German",
                "Spanish",
                "French",
                "Italian",
                "Portuguese",
                "Ukrainian",
              ]}
              maxLength={80}
              required
              disabled={saving}
              onChange={setTranslationLanguage}
            />
            <button
              className="secondary-button"
              type="submit"
              disabled={
                saving ||
                !translationLanguage.trim() ||
                translationLanguage.trim() === settings.translationLanguage
              }
            >
              Save language
            </button>
          </form>
        </div>
      </section>

      <AiSettingsSection
        settings={settings}
        aiSettings={aiSettings}
        onSettings={onSettings}
        onAiSettings={onAiSettings}
        showToast={showToast}
        runSensitive={runSensitive}
      />

      <section className="settings-section" aria-labelledby="refresh-heading">
        <div className="settings-heading">
          <h2 id="refresh-heading">Refresh</h2>
        </div>
        <div className="setting-row">
          <label htmlFor="poll-interval">
            <strong>New feed interval</strong>
            <p>
              Published feeds start here, then adapt between 5 and 60 minutes based on new posts.
            </p>
          </label>
          <DropdownSelect
            id="poll-interval"
            value={String(settings.pollIntervalMinutes)}
            disabled={saving}
            options={[5, 10, 20, 30, 60].map((minutes) => ({
              value: String(minutes),
              label: formatRefreshInterval(minutes),
            }))}
            onChange={(value) => void saveSettings({ pollIntervalMinutes: Number(value) })}
          />
        </div>
        <div className="setting-row">
          <label htmlFor="duplicate-article-window">
            <strong>Duplicate article window</strong>
            <p>
              Skip a new article when its exact URL or exact title appeared in any feed during this
              period.
            </p>
          </label>
          <DropdownSelect
            id="duplicate-article-window"
            value={String(settings.duplicateArticleWindowDays)}
            disabled={saving}
            options={DUPLICATE_ARTICLE_WINDOW_DAYS.map((days) => ({
              value: String(days),
              label: days === 1 ? "Past day" : `Past ${days} days`,
            }))}
            onChange={(value) =>
              void saveSettings({
                duplicateArticleWindowDays: Number(value) as DuplicateArticleWindowDays,
              })
            }
          />
        </div>
      </section>

      <section className="settings-section" aria-labelledby="keyboard-heading">
        <div className="settings-heading">
          <h2 id="keyboard-heading">Keyboard</h2>
          <p>Single-key shortcuts pause while you type in a form field.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Single-key shortcuts</strong>
            <p>Turn off letter and number shortcuts. Tab navigation remains available.</p>
          </div>
          <button
            className={`switch ${settings.singleKeyShortcuts ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-label="Single-key shortcuts"
            aria-checked={settings.singleKeyShortcuts}
            disabled={saving}
            onClick={() => void saveSettings({ singleKeyShortcuts: !settings.singleKeyShortcuts })}
          >
            <span />
          </button>
        </div>
        <ShortcutReference compact />
      </section>

      <section className="settings-section" aria-labelledby="portable-heading">
        <div className="settings-heading">
          <h2 id="portable-heading">Subscriptions</h2>
          <p>Use OPML to move feed URLs and folder structure between readers.</p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Import or export OPML</strong>
            <p>Import adds new feeds and skips feed URLs you already follow.</p>
          </div>
          <div className="settings-actions">
            <ImportOpmlButton mutations={mutations} showToast={showToast} />
            <ExportOpmlLink />
          </div>
        </div>
      </section>
      <dialog
        ref={stepUpDialogRef}
        className="management-dialog passkey-dialog"
        aria-labelledby="step-up-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          cancelStepUp();
        }}
      >
        <form
          className="passkey-dialog-form"
          onSubmit={(event) => void authenticateWithPassword(event)}
        >
          <header className="management-dialog-heading">
            <span className="dialog-icon" aria-hidden="true">
              <KeyRound size={16} />
            </span>
            <div>
              <h2 id="step-up-dialog-title">Authenticate to continue</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              disabled={stepUpBusy}
              onClick={cancelStepUp}
              aria-label="Close authentication"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <div className="management-dialog-body passkey-dialog-body">
            {stepUpHasPassword ? (
              <label className="passkey-dialog-field" htmlFor="step-up-password">
                <span>Password</span>
                <input
                  ref={stepUpPasswordRef}
                  id="step-up-password"
                  type="password"
                  autoComplete="current-password"
                  value={stepUpPassword}
                  maxLength={128}
                  required
                  disabled={stepUpBusy}
                  onChange={(event) => {
                    setStepUpPassword(event.target.value);
                    setStepUpError(null);
                  }}
                />
              </label>
            ) : null}
            {stepUpHasPasskey ? (
              <button
                className="secondary-button"
                type="button"
                disabled={stepUpBusy}
                onClick={() => void authenticateWithPasskey()}
              >
                <KeyRound aria-hidden="true" size={15} />
                Use a passkey
              </button>
            ) : null}
            {stepUpError ? (
              <div className="management-dialog-error" role="alert">
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{stepUpError}</span>
              </div>
            ) : null}
          </div>
          <footer className="management-dialog-footer">
            <span />
            <div>
              <button
                className="secondary-button"
                type="button"
                disabled={stepUpBusy}
                onClick={cancelStepUp}
              >
                Cancel
              </button>
              {stepUpHasPassword ? (
                <button
                  className="primary-button"
                  type="submit"
                  disabled={stepUpBusy || !stepUpPassword}
                >
                  {stepUpBusy ? (
                    <LoaderCircle className="spin" aria-hidden="true" size={15} />
                  ) : null}
                  Continue
                </button>
              ) : null}
            </div>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

export default SettingsPage;
