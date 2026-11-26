import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PersonaSurface } from "@/persona/persona-surface";

export default function PersonaRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <PersonaSurface />
    </HostRouteBootstrapBoundary>
  );
}
