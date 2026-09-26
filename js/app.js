import { mountHero } from "../modules/hero/hero.js";

const disposers = [];

document.addEventListener("DOMContentLoaded", () => {
  disposers.push(mountHero());
});

// OFFLINE / CACHE
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      // La página sigue funcionando aunque el navegador no permita SW.
      console.warn("Service Worker no disponible:", error);
    });
  });
}

window.addEventListener("pagehide", () => {
  for (const dispose of disposers) {
    if (typeof dispose === "function") dispose();
  }
});
