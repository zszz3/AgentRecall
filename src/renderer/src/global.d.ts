import type { SessionSearchApi } from "../../preload";

declare global {
  interface Window {
    sessionSearch: SessionSearchApi;
  }
}
