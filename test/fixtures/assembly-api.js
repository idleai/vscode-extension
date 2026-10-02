// Synthetic VS Code API for the packaged application/native-service integration.
let state;
let acquired = false;
window.acquireVsCodeApi = () => {
  if (acquired) throw new Error("The editor API was acquired twice.");
  acquired = true;
  return {
    getState: () => state,
    setState: value => { state = value; },
    postMessage(request) {
      fetch("/host", { method: "POST", body: JSON.stringify(request) })
        .then(response => response.json())
        .then(data => window.dispatchEvent(new MessageEvent("message", { data })));
    },
  };
};
