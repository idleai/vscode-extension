async function probe() {
  // The Rust bridge and the host appearance adapter each retain one listener.
  const persistentListeners = 2;
  while (window.smoke.posts < 2 || window.smoke.listeners !== persistentListeners) await new Promise(resolve => setTimeout(resolve, 20));
  window.dispatchEvent(new MessageEvent("message", { data: {
    protocol: 1, session: "smoke-session", event: "host.appearance",
    params: { modern: true, compact: false, uppercase: true },
  } }));
  if (document.body.dataset.vscodeModern !== "true" || document.body.dataset.vscodeUppercase !== "true") throw new Error("Workbench appearance did not update.");
  const { initializeHostBridge } = await import("/dist/pkg/idle_vscode_webview.js");
  const ready = await initializeHostBridge();
  if (ready.configuration.trusted !== true || window.smoke.acquisitions !== 1 || window.smoke.listeners !== persistentListeners) throw new Error("Repeated handshake or listener cleanup failed.");
  window.smoke.malformed = true;
  let rejected = false;
  try { await initializeHostBridge(); } catch { rejected = true; }
  if (!rejected || window.smoke.listeners !== persistentListeners || window.smoke.errors.length) throw new Error(`Protocol error handling failed: ${window.smoke.errors}`);
  if (!document.getElementById("main").textContent.includes("No workspaces available")) throw new Error("Shared Rust view did not render.");
  document.documentElement.dataset.smoke = "pass";
}
probe().catch(error => { document.documentElement.dataset.smoke = "fail"; document.documentElement.dataset.smokeError = String(error); });
