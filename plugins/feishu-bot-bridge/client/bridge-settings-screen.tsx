import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import {
  feishuGetStateRpc,
  feishuSendTestCardRpc,
  feishuTestConnectionRpc,
  feishuUpdateConfigRpc,
  type FeishuBridgeState,
  type FeishuDomainPreset,
  type FeishuReceiveIdType,
} from "../shared/contracts.js";

const DOMAIN_OPTIONS: readonly { label: string; value: FeishuDomainPreset }[] = [
  { label: "Feishu (open.feishu.cn)", value: "feishu" },
  { label: "Lark (open.larksuite.com)", value: "lark" },
  { label: "Custom URL", value: "custom" },
];

const RECEIVE_ID_TYPE_OPTIONS: readonly { label: string; value: FeishuReceiveIdType }[] = [
  { label: "Group (chat_id)", value: "chat_id" },
  { label: "User (open_id)", value: "open_id" },
  { label: "User ID (user_id)", value: "user_id" },
];

export function FeishuBridgePluginSettingsScreen({ theme }: PluginSurfaceProps) {
  const toast = useToast();
  const getState = useRpc(feishuGetStateRpc);
  const updateConfig = useRpc(feishuUpdateConfigRpc);
  const testConnection = useRpc(feishuTestConnectionRpc);
  const sendTestCard = useRpc(feishuSendTestCardRpc);

  const [state, setState] = useState<FeishuBridgeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecretDraft, setAppSecretDraft] = useState("");
  const [receiveId, setReceiveId] = useState("");
  const [customApiBaseUrl, setCustomApiBaseUrl] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const mutedStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getState({ auditLimit: 10 });
      setState(next);
      setAppId(next.config.appId);
      setReceiveId(next.config.receiveId);
      setCustomApiBaseUrl(next.config.apiBaseUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [getState]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      try {
        const next = await updateConfig({ patch: { enabled } });
        setState(next);
        toast.show(enabled ? "Feishu bridge enabled" : "Feishu bridge disabled");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [toast, updateConfig],
  );

  const handleChangeDomain = useCallback(
    async (domainPreset: FeishuDomainPreset) => {
      setSaving(true);
      try {
        const next = await updateConfig({ patch: { domainPreset } });
        setState(next);
        setCustomApiBaseUrl(next.config.apiBaseUrl);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [toast, updateConfig],
  );

  const handleChangeReceiveIdType = useCallback(
    async (receiveIdType: FeishuReceiveIdType) => {
      setSaving(true);
      try {
        const next = await updateConfig({ patch: { receiveIdType } });
        setState(next);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [toast, updateConfig],
  );

  const handleSave = useCallback(async () => {
    if (!state) return;
    setSaving(true);
    try {
      const next = await updateConfig({
        patch: {
          appId,
          receiveId,
          ...(state.config.domainPreset === "custom" ? { apiBaseUrl: customApiBaseUrl } : {}),
          ...(appSecretDraft.trim() ? { appSecret: appSecretDraft.trim() } : {}),
        },
      });
      setState(next);
      setAppSecretDraft("");
      toast.show("Saved Feishu bridge configuration");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [appId, appSecretDraft, customApiBaseUrl, receiveId, state, toast, updateConfig]);

  const handleTestConnection = useCallback(async () => {
    setSaving(true);
    try {
      const result = await testConnection({});
      setStatusMessage(`${result.ok ? "OK" : "FAIL"} (${result.latencyMs}ms): ${result.message}`);
      if (result.ok) {
        toast.show(result.message, { variant: "success" });
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [testConnection, toast]);

  const handleSendTestCard = useCallback(async () => {
    setSaving(true);
    try {
      const result = await sendTestCard({});
      setStatusMessage(`${result.ok ? "SENT" : "FAIL"} (${result.latencyMs}ms): ${result.message}`);
      if (result.ok) {
        toast.show(result.message, { variant: "success" });
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [sendTestCard, toast]);

  if (loading && !state) {
    return (
      <SettingsSection title="Feishu Bot Bridge">
        <Text style={mutedStyle}>Loading plugin state…</Text>
      </SettingsSection>
    );
  }

  if (error || !state) {
    return (
      <SettingsSection title="Feishu Bot Bridge">
        <Text style={textStyle}>{error ?? "Plugin state unavailable"}</Text>
        <SettingsAction label="Reload plugin state" actionLabel="Reload" onPress={reload} />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Feishu Bot Bridge">
      <SettingsCard>
        <SettingsSwitch
          label="Enable Feishu bot bridge"
          hint="Zero background polling or outbound traffic when disabled."
          value={state.config.enabled}
          disabled={saving}
          onValueChange={handleToggleEnabled}
        />
        <SettingsSelect
          label="API domain"
          value={state.config.domainPreset}
          options={DOMAIN_OPTIONS}
          disabled={saving}
          onValueChange={handleChangeDomain}
        />
        {state.config.domainPreset === "custom" ? (
          <SettingsInput
            label="Custom API Base URL"
            initialValue={customApiBaseUrl}
            onChangeText={setCustomApiBaseUrl}
            placeholder="https://open.feishu.cn"
            disabled={saving}
          />
        ) : null}
        <SettingsInput
          label="App ID"
          initialValue={appId}
          onChangeText={setAppId}
          placeholder="cli_xxxxxxxx"
          disabled={saving}
        />
        <SettingsInput
          label="App Secret"
          hint={
            state.config.hasAppSecret
              ? `Configured (${state.config.appSecretMask ?? "••••"}). Leave empty to keep.`
              : "Stored masked; never echoed in plaintext."
          }
          initialValue={appSecretDraft}
          onChangeText={setAppSecretDraft}
          placeholder="Enter new App Secret"
          secureTextEntry
          disabled={saving}
        />
        <SettingsSelect
          label="Receive ID type"
          value={state.config.receiveIdType}
          options={RECEIVE_ID_TYPE_OPTIONS}
          disabled={saving}
          onValueChange={handleChangeReceiveIdType}
        />
        <SettingsInput
          label="Receive ID"
          initialValue={receiveId}
          onChangeText={setReceiveId}
          placeholder="oc_xxxxxxxx or ou_xxxxxxxx"
          disabled={saving}
        />
        <SettingsAction
          label="Save credentials & target"
          actionLabel="Save"
          disabled={saving}
          onPress={handleSave}
        />
        <SettingsAction
          label="Verify tenant_access_token connectivity"
          actionLabel="Test Connection"
          disabled={saving}
          onPress={handleTestConnection}
        />
        <SettingsAction
          label="Send interactive test card"
          actionLabel="Send Test Card"
          disabled={saving}
          onPress={handleSendTestCard}
        />
      </SettingsCard>
      {statusMessage ? (
        <SettingsRow label="Latest check">
          <View>
            <Text style={textStyle}>{statusMessage}</Text>
          </View>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
