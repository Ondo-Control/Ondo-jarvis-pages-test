(() => {
  'use strict';

  const VERSION = '1.0.0';
  const MARKER_ID = 'ondo-jarvis-aws-control-marker';

  function marker(state, detail = '') {
    let el = document.getElementById(MARKER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = MARKER_ID;
      el.setAttribute('role', 'status');
      Object.assign(el.style, {
        position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
        padding: '8px 12px', borderRadius: '8px', color: '#fff',
        font: '600 12px/1.35 system-ui,sans-serif', boxShadow: '0 2px 10px rgba(0,0,0,.35)',
        pointerEvents: 'none'
      });
      document.documentElement.appendChild(el);
    }
    el.dataset.version = VERSION;
    el.dataset.state = state;
    el.style.background = state === 'ready' ? '#16794a' : state === 'working' ? '#8a6500' : state === 'pass' ? '#166534' : '#991b1b';
    el.textContent = `ONDO JARVIS AWS Control · v${VERSION} · ${state}${detail ? ` · ${detail}` : ''}`;
  }

  marker('ready');

  function params() {
    if (!location.hash.startsWith('#ondo_jarvis_aws=1')) return null;
    return new URLSearchParams(location.hash.slice(1));
  }

  const p = params();
  if (!p) return;
  const op = p.get('op');
  const id = p.get('id') || `aws-${Date.now()}`;
  if (op !== 'set_probe') {
    marker('error', 'unsupported');
    return;
  }
  const enabledRaw = p.get('enabled');
  if (!['true', 'false'].includes(enabledRaw)) {
    marker('error', 'invalid-enabled');
    return;
  }

  history.replaceState(null, '', location.pathname + location.search);
  marker('working', enabledRaw === 'true' ? 'probe→ON' : 'probe→OFF');

  chrome.runtime.sendMessage({
    schema: 'ondo.jarvis.aws.command.v1',
    command_id: id,
    op: 'set_probe',
    enabled: enabledRaw === 'true'
  }, (reply) => {
    if (chrome.runtime.lastError) {
      marker('error', 'runtime');
      return;
    }
    if (!reply || reply.ok !== true) {
      marker('error', reply?.stage || reply?.error || 'failed');
      return;
    }
    marker('pass', reply.enabled ? 'probe=ON' : 'probe=OFF');
  });
})();
