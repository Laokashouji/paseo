import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { MainChatScreen } from "@/main-chat/main-chat-screen";

function readParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim() || null;
  return null;
}

export default function MainChatIndexRoute() {
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const serverId = readParam(params.serverId);

  return (
    <HostRouteBootstrapBoundary>
      <MainChatScreen serverId={serverId} />
    </HostRouteBootstrapBoundary>
  );
}
