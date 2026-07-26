import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QuickSearch } from "./quick-search";
import "./quick-search.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickSearch />
  </StrictMode>,
);
