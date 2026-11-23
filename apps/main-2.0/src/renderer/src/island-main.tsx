import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles/theme.css";
import "./styles/tokens.css";
import "./island.css";
import { DynamicIsland } from "./island";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DynamicIsland />
  </StrictMode>,
);
