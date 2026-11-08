import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LiveView } from "./LiveView";
import "./styles.css";

// /live is the view-only page for phones; everything else is the console.
const isLive: boolean = window.location.pathname.replace(/\/+$/, "") === "/live";

createRoot(document.getElementById("root")!).render(<StrictMode>{isLive ? <LiveView /> : <App />}</StrictMode>);
