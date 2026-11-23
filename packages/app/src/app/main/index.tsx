import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { MainChatScreen } from "@/main-chat/main-chat-screen";

export default function MainChatIndexRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <MainChatScreen />
    </HostRouteBootstrapBoundary>
  );
}
