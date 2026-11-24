import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { MainChatConversationScreen } from "@/main-chat/conversation-screen";

function readParam(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

export default function MainChatConversationRoute() {
  const params = useLocalSearchParams<{
    conversationId?: string | string[];
    serverId?: string | string[];
  }>();
  const conversationId = readParam(params.conversationId);
  const serverId = readParam(params.serverId) || null;

  return (
    <HostRouteBootstrapBoundary>
      <MainChatConversationScreen conversationId={conversationId} serverId={serverId} />
    </HostRouteBootstrapBoundary>
  );
}
