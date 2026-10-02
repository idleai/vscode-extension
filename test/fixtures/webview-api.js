// Only this fixture supplies the editor API in the isolated artifact smoke test.
window.smoke = { acquisitions: 0, posts: 0, listeners: 0, malformed: false, errors: [] };
const add = window.addEventListener.bind(window);
const remove = window.removeEventListener.bind(window);
window.addEventListener = (type, ...args) => { if (type === "message") window.smoke.listeners++; add(type, ...args); };
window.removeEventListener = (type, ...args) => { if (type === "message") window.smoke.listeners--; remove(type, ...args); };
add("error", event => { window.smoke.errors.push(event.message); });
add("unhandledrejection", event => { window.smoke.errors.push(String(event.reason)); });
window.acquireVsCodeApi = () => {
  if (++window.smoke.acquisitions !== 1) throw new Error("The editor API was acquired twice.");
  return {
    getState: () => undefined,
    setState: value => value,
    postMessage(request) {
      if (!["host.ready", "app.workspace"].includes(request.method) || request.session !== "smoke-session" || request.protocol !== 1) throw new Error("Invalid request from Rust.");
      window.smoke.posts++;
      window.dispatchEvent(new MessageEvent("message", { data: {
        protocol: window.smoke.malformed ? 2 : 1, session: request.session, id: request.id,
        result: request.method === "app.workspace" ? { Ok: { Directory: [] } } :
          { capabilities: ["host.ready"], configuration: { trusted: true, folders: [], remoteName: null } },
      } }));
    },
  };
};
