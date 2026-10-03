import init from "./pkg/idle_vscode_webview.js";

async function start() {
  document.getElementById("main").replaceChildren();
  await init();
}

start().catch((error) => {
  console.error("Idle failed to start", error);
  document.getElementById("main").textContent = "Idle could not start.";
});
