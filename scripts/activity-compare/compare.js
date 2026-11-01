const sides = ['legacy', 'current'];
const manifest = await (await fetch('/api/manifest')).json();
document.getElementById('manifest').textContent = JSON.stringify(manifest, null, 2);
document.getElementById('revisions').textContent = `${manifest.legacy.revision.slice(0, 8)} → ${manifest.current.revision.slice(0, 8)} · ${manifest.input.rawFiles} matching raw files`;
function size() {
  const width = Number(document.getElementById('width').value);
  const height = Number(document.getElementById('height').value);
  for (const side of sides) {
    const frame = document.getElementById(side);
    const scale = frame.parentElement.clientWidth / width;
    frame.style.width = `${width}px`; frame.style.height = `${height}px`;
    frame.style.transform = `scale(${scale})`; frame.parentElement.style.height = `${height * scale}px`;
  }
}
let generation = 0;
function reload() {
  const profile = document.getElementById('profile').value;
  const instance = `${Date.now()}-${++generation}`;
  for (const side of sides) {
    const url = `/${side}/?profile=${profile}&instance=${instance}`;
    document.getElementById(side).src = url;
    document.getElementById(`${side}-link`).href = url;
  }
  document.getElementById('status').textContent = `Loaded ${profile === 'git' ? 'Git only' : 'all activity'}; views keep their own interactions.`;
}
document.getElementById('reload').onclick = reload;
document.getElementById('profile').onchange = reload;
for (const id of ['width', 'height']) document.getElementById(id).onchange = size;
window.addEventListener('resize', size);
document.getElementById('scroll').oninput = event => {
  for (const side of sides) document.getElementById(side).contentWindow.activityCompare?.scroll(Number(event.target.value) / 100);
};
document.getElementById('capture').onclick = async () => {
  const event = { side: 'harness', kind: 'checkpoint', profile: document.getElementById('profile').value,
    views: Object.fromEntries(sides.map(side => [side, document.getElementById(side).contentWindow.activityCompare?.snapshot()])) };
  const response = await fetch('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  document.getElementById('status').textContent = response.ok ? `Checkpoint saved in ${manifest.runDirectory}` : 'Checkpoint failed';
};
let after = 0;
const display = [];
async function poll() {
  try {
    const entries = await (await fetch(`/api/events?after=${after}`)).json();
    for (const event of entries) {
      after = Math.max(after, event.sequence);
      if (/^(ui\.|editor\.|error|checkpoint)/.test(event.kind ?? '')) display.push(JSON.stringify(event));
      if (event.kind === 'editor.open') document.getElementById('status').textContent =
        `${event.side === 'legacy' ? 'Old EditChain' : 'Current extension'} requested ${event.command}. Open “Actions and editor opens” for its resolved content details.`;
    }
    display.splice(0, Math.max(0, display.length - 30));
    document.getElementById('events').textContent = display.join('\n');
  } catch { document.getElementById('status').textContent = 'The comparison server is disconnected.'; }
  setTimeout(poll, 1000);
}
size(); reload(); poll();
