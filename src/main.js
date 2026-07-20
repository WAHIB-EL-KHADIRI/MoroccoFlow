import "./styles.css";
import "./design-system/components.js";
import "./app/app.js";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`, {
        type: "module",
      });
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  });
}
