(() => {
  const side = location.pathname.startsWith('/legacy/') ? 'legacy' : 'current';
  const viewport = () => document.querySelector(side === 'legacy' ? '#rows' : '.idle-timeline-viewport');
  const rowSelector = side === 'legacy' ? '#rows .row[data-key]' : '.idle-timeline-row';
  const send = event => navigator.sendBeacon('/api/record', new Blob([JSON.stringify({ side, ...event })], { type: 'application/json' }));
  const box = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  window.activityCompare = {
    scroll(fraction) {
      const node = viewport();
      if (node) node.scrollTop = fraction * (node.scrollHeight - node.clientHeight);
    },
    snapshot() {
      const node = viewport();
      const rect = node?.getBoundingClientRect();
      const rows = [...document.querySelectorAll(rowSelector)];
      return {
        side, url: location.pathname + location.search, viewport: { width: innerWidth, height: innerHeight },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scroll: node ? { top: node.scrollTop, height: node.scrollHeight, clientHeight: node.clientHeight } : null,
        model: { ...document.querySelector(side === 'legacy' ? '#rows' : '.idle-timeline')?.dataset },
        focus: { tag: document.activeElement?.tagName, id: document.activeElement?.id,
          row: { ...document.activeElement?.closest(rowSelector)?.dataset } },
        status: document.querySelector('[role="status"]')?.textContent,
        rows: rows.map(row => ({ text: row.innerText, data: { ...row.dataset }, selected: row.getAttribute('aria-selected'),
          visible: !!rect && row.getBoundingClientRect().bottom > rect.top && row.getBoundingClientRect().top < rect.bottom,
          bounds: box(row), cells: [...row.children].map(cell => ({ text: cell.innerText, bounds: box(cell) })),
          disclosures: [...row.querySelectorAll('[aria-expanded]')].map(button => ({ label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded') })),
        })),
        graph: [...document.querySelectorAll('svg')].filter(svg => svg.getBoundingClientRect().height > 0).map(svg => svg.outerHTML),
      };
    },
  };
  for (const type of ['click', 'dblclick', 'change', 'keydown']) {
    document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const row = target.closest(rowSelector);
      send({ kind: `ui.${type}`, target: { tag: target.tagName, id: target.id, class: target.className?.baseVal ?? target.className,
        text: target.textContent?.slice(0, 200), label: target.getAttribute('aria-label'), value: target.value },
        row: row ? { ...row.dataset } : undefined, key: event.key });
    }, true);
  }
  let scrollTimer;
  document.addEventListener('scroll', event => {
    if (event.target !== viewport()) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => send({ kind: 'ui.scroll', top: viewport()?.scrollTop }), 150);
  }, true);
  window.addEventListener('error', event => send({ kind: 'error', message: event.message }));
  window.addEventListener('unhandledrejection', event => send({ kind: 'error', message: String(event.reason) }));
  if (side === 'current') {
    let navigated = false;
    const apply = () => {
      if (!navigated) {
        const workspace = document.querySelector('select[id$="-workspace"]');
        const activity = [...document.querySelectorAll('button')].find(button => button.textContent === 'Activity');
        if (!workspace?.value || !activity) return false;
        navigated = true;
        activity.click();
      }
      if (new URL(location.href).searchParams.get('profile') !== 'git') return true;
      const select = document.querySelector('select[aria-label="Filter activity kind"]');
      if (!select || !document.querySelector('.idle-timeline-row')) return false;
      select.value = 'git';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      send({ kind: 'ui.profile', profile: 'git', control: 'Filter activity kind' });
      return true;
    };
    const watcher = new MutationObserver(() => { if (apply()) watcher.disconnect(); });
    watcher.observe(document.documentElement, { childList: true, subtree: true });
    if (apply()) watcher.disconnect();
  }
})();
