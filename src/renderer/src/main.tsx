import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AutomationProvider } from "./features/automation/automation-provider";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@xyflow/react/dist/style.css";
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
import "./styles/agent-memory.css";
import "./styles/agent-memory-sync.css";
import "./styles/team-chat.css";
import "./styles/automation-upstream/part-01.css";
import "./styles/automation-upstream/part-02.css";
import "./styles/automation-upstream/part-03.css";
import "./styles/automation-upstream/part-04.css";
import "./styles/automation-upstream/part-05.css";
import "./styles/automation-upstream/part-06.css";
import "./styles/automation.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AutomationProvider>
      <App />
    </AutomationProvider>
  </React.StrictMode>,
);
