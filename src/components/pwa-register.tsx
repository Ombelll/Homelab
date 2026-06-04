"use client";

import { useEffect } from "react";

/** Registers the service worker so the dashboard is installable as a PWA. */
export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
