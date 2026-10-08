import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AutomationProvider } from "./features/automation/automation-provider";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@xyflow/react/dist/style.css";
import "./app-styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AutomationProvider>
      <App />
    </AutomationProvider>
  </React.StrictMode>,
);
