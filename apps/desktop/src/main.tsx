import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance, readAppearance } from "./styles/appearance";
import "./styles/global.css";

applyAppearance(readAppearance());

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("缺少 #root 节点");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
