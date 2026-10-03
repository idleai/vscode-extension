// Synthetic VS Code API for the packaged application/native-service integration.
let state;
let acquired = false;
const fixture = window.assemblyFixture = { requests: [], responses: [], held: [], holdMethod: undefined };
const nativeTimeout = window.setTimeout.bind(window);
window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback,
  delay === 60_000 && fixture.holdMethod === "host.ready" ? 100 : delay, ...args);
window.acquireVsCodeApi = () => {
  if (acquired) throw new Error("The editor API was acquired twice.");
  acquired = true;
  return {
    getState: () => state,
    setState: value => { state = value; },
    postMessage(request) {
      fixture.requests.push(request);
      fetch("/host", { method: "POST", body: JSON.stringify(request) })
        .then(response => response.json())
        .then(data => {
          fixture.responses.push({ request, data });
          if (request.method === fixture.holdMethod || (fixture.holdMutation && request.method === 'app.coordination' && JSON.parse(request.params.command).kind === 'mutate')) fixture.held.push(data);
          else window.dispatchEvent(new MessageEvent("message", { data }));
        });
    },
  };
};
