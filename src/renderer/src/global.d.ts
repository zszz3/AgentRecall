import type { CoreApi } from "../../shared/core-api";
import type { SessionSearchApi as LegacySessionSearchApi } from "../../preload/legacy-preload";

/**
 * The production preload exposes CoreApi. The legacy intersection is a
 * temporary renderer-only compile boundary while dormant advanced UI modules
 * remain in the tree; it does not add any runtime preload methods.
 */
type RendererSessionSearchApi = LegacySessionSearchApi & Pick<CoreApi, "productProfile">;

declare global {
  interface Window {
    sessionSearch: RendererSessionSearchApi;
  }
}
