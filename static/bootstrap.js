import init, { initializeHostBridge } from "./pkg/idle_vscode_webview.js";

async function start() {
  await init();
  await initializeHostBridge();
}

start().catch((error) => {
  console.error("Idle failed to start", error);
  document.getElementById("main").textContent = "Idle could not start.";
});
