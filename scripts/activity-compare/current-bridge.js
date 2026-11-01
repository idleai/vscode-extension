(() => {
  const session = document.getElementById('main').dataset.hostSession;
  const stream = new EventSource(`/current/events?session=${encodeURIComponent(session)}`);
  let state;
  let acquired = false;
  let closed = false;
  const pending = new AbortController();
  stream.onmessage = event => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
  window.acquireVsCodeApi = () => {
    if (acquired) throw new Error('The editor API was acquired twice.');
    acquired = true;
    return {
      getState: () => state,
      setState: value => { state = value; },
      postMessage: message => {
        fetch('/current/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message), signal: pending.signal })
          .then(response => { if (!response.ok) throw new Error(`Host transport: ${response.status}`); })
          .catch(error => { if (!closed) window.dispatchEvent(new ErrorEvent('error', { message: String(error) })); });
      },
    };
  };
  window.addEventListener('pagehide', () => {
    closed = true;
    pending.abort();
    stream.close();
    navigator.sendBeacon(`/current/close?session=${encodeURIComponent(session)}`, '');
  });
})();
