import type { SessionSearchApi } from "../../preload";
import type { UpdateProgressApi } from "../../preload/update-progress";

declare global {
  interface Window {
    sessionSearch: SessionSearchApi;
    updateProgress: UpdateProgressApi;
  }
}
