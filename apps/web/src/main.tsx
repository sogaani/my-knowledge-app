import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

// Web Push lives in /sw.js (no offline caching). Registration failing (private mode, old browser) is not an error.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
