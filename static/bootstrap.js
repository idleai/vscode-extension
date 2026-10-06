import init, { start as mount } from "./pkg/idle_vscode_webview.js";

window.addEventListener("message", ({ data }) => {
  if (data?.event !== "host.appearance" || data.session !== document.getElementById("main").dataset.hostSession) return;
  for (const key of ["modern", "compact", "uppercase"]) {
    if (typeof data.params?.[key] === "boolean") document.body.dataset[`vscode${key[0].toUpperCase()}${key.slice(1)}`] = String(data.params[key]);
  }
});

async function start() {
  document.getElementById("main").replaceChildren();
  await init();
  mount();
}

start().catch((error) => {
  console.error("Idle failed to start", error);
  document.getElementById("main").textContent = "Idle could not start.";
});
