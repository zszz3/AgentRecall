import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import "./styles/sessions.css";
import "./styles/session-detail.css";
import "./styles/skills.css";
import "./styles/settings.css";
import "./styles/providers.css";
import "./styles/overlays.css";
import "./styles/app-shell.css";
import "./styles/workbench.css";
import "./styles/skills-page.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
