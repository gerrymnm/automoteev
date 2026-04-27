import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Register the service worker so push notifications can fire when the
// app is closed. Service workers must be served from the same origin and
// over HTTPS (localhost is exempt). We only register in browsers that
// support it — older browsers just continue without push capability.
if ("serviceWorker" in navigator) {
  // Register after the page is fully loaded so we don't compete with the
  // initial render for resources.
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        console.warn("[sw] registration failed:", err);
      });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
