import init from "./pkg/idle_vscode_webview.js";

init().catch((error) => {
  console.error("Idle failed to start", error);
  document.getElementById("main").textContent = "Idle could not start.";
});
