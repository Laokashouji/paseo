import type { PluginServerContext } from "@getpaseo/plugin/server";
import { FeishuBridgeEngine } from "./server/bridge-engine.js";
import {
  feishuCompleteCallbackActionRpc,
  feishuDispatchEventRpc,
  feishuGetStateRpc,
  feishuHandleWebhookRpc,
  feishuListAuditRpc,
  feishuSendTestCardRpc,
  feishuTestConnectionRpc,
  feishuUpdateConfigRpc,
} from "./shared/contracts.js";

export default function contribute(server: PluginServerContext) {
  const engine = new FeishuBridgeEngine({
    dataDirectory: server.dataDirectory,
  });

  server.handle(feishuGetStateRpc, (input) =>
    engine.getState({
      auditLimit: input.auditLimit,
      webhookUrl: input.webhookUrl,
    }),
  );

  server.handle(feishuUpdateConfigRpc, (input) =>
    engine.updateConfig(input.patch, {
      webhookUrl: input.webhookUrl,
    }),
  );

  server.handle(feishuTestConnectionRpc, (input) =>
    engine.testConnection({
      forceRefreshToken: input.forceRefreshToken,
    }),
  );

  server.handle(feishuSendTestCardRpc, (input) =>
    engine.sendTestCard({
      receiveId: input.receiveId,
      receiveIdType: input.receiveIdType,
      title: input.title,
    }),
  );

  server.handle(feishuListAuditRpc, (input) =>
    engine.listAudit({
      limit: input.limit,
      direction: input.direction,
    }),
  );

  server.handle(feishuDispatchEventRpc, (input) => engine.dispatchEvent(input));

  server.handle(feishuHandleWebhookRpc, (input) =>
    engine.handleWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
    }),
  );

  server.handle(feishuCompleteCallbackActionRpc, (input) =>
    engine.completeCallbackAction({
      intent: input.intent,
      succeeded: input.succeeded,
      outcomeLabel: input.outcomeLabel,
      detailMessage: input.detailMessage,
      errorCode: input.errorCode,
    }),
  );

  return () => {
    engine.dispose();
  };
}
