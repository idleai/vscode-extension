async function probe() {
  while (!window.smoke.posts || window.smoke.listeners) await new Promise(resolve => setTimeout(resolve, 20));
  const { initializeHostBridge } = await import("/dist/pkg/idle_vscode_webview.js");
  const ready = await initializeHostBridge();
  if (ready.configuration.trusted !== true || window.smoke.acquisitions !== 1 || window.smoke.listeners !== 0) throw new Error("Repeated handshake or listener cleanup failed.");
  window.smoke.malformed = true;
  let rejected = false;
  try { await initializeHostBridge(); } catch { rejected = true; }
  if (!rejected || window.smoke.listeners || window.smoke.errors.length) throw new Error(`Protocol error handling failed: ${window.smoke.errors}`);
  if (!document.getElementById("main").textContent.includes("Ready for workspace setup")) throw new Error("Shared Rust view did not render.");
  document.documentElement.dataset.smoke = "pass";
}
probe().catch(error => { document.documentElement.dataset.smoke = "fail"; document.documentElement.dataset.smokeError = String(error); });
