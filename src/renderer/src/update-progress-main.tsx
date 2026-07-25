import React from "react";
import ReactDOM from "react-dom/client";
import { UpdateProgressWindow } from "./update-progress";
import "./update-progress.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UpdateProgressWindow />
  </React.StrictMode>,
);
