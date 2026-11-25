import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FeishuBridgePluginSettingsScreen } from "./client/bridge-settings-screen.js";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "feishu-bridge",
    title: "Feishu Bot Bridge",
    icon: "Bot",
    Component: FeishuBridgePluginSettingsScreen,
  });
  return () => {};
}
