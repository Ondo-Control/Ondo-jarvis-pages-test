(() => {
  'use strict';

  const VERSION = '1.0.0';
  const MARKER_ID = 'ondo-alexa-visual-control-marker';
  const COMMAND_PREFIX = '#ondo_alexa_vc=1';
  let running = false;

  function clip(value, max = 400) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function marker() {
    let el = document.getElementById(MARKER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = MARKER_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      Object.assign(el.style, {
        position: 'fixed',
        right: '10px',
        top: '10px',
        zIndex: '2147483647',
        padding: '6px 10px',
        borderRadius: '8px',
        background: '#1f6f43',
        color: '#fff',
        font: '600 12px/1.35 system-ui,sans-serif',
        boxShadow: '0 2px 10px rgba(0,0,0,.28)',
        pointerEvents: 'none'
      });
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function setMarker(state, detail, result = null) {
    const el = marker();
    const color = state === 'error' ? '#9d2c2c' : state === 'running' ? '#7a6200' : '#1f6f43';
    el.style.background = color;
    el.textContent = detail;

    const summary = {
      version: VERSION,
      state,
      command_id: result?.command_id || null,
      ok: result?.ok ?? null,
      total_ms: result?.total_ms ?? null,
      error: result?.error || null,
      detail: result?.detail ? clip(result.detail, 700) : null,
      diagnostic: result?.steps?.find((step) => step.op === 'debugger_status')?.state || null
    };
    el.setAttribute('aria-label', `ONDO_ALEXA_VISUAL_CONTROL ${clip(JSON.stringify(summary), 1200)}`);
  }

  function fromB64url(value) {
    const raw = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function numberIfPresent(params, name) {
    const raw = params.get(name);
    if (raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`invalid ${name}`);
    return value;
  }

  function simpleCommand(params) {
    const op = params.get('op');
    if (!op) return null;

    const action = { op };
    for (const name of ['x','y','dx','dy','wait_ms','steps']) {
      const value = numberIfPresent(params, name);
      if (value !== undefined) action[name] = value;
    }

    if (params.has('key')) action.key = params.get('key');
    if (params.has('value')) action.value = params.get('value');
    if (params.has('text_value')) action.text = params.get('text_value');

    const target = {};
    if (params.has('target_text')) target.text = params.get('target_text');
    if (params.has('target_aria')) target.aria_label = params.get('target_aria');
    if (params.has('target_role')) target.role = params.get('target_role');
    if (params.has('target_placeholder')) target.placeholder = params.get('target_placeholder');
    if (params.has('target_selector')) target.selector = params.get('target_selector');
    if (Object.keys(target).length) action.target = target;

    return {
      schema: 'ondo.visual.command.v1',
      command_id: params.get('id') || `local-${Date.now()}`,
      action,
      readback: params.get('readback') === '1'
    };
  }

  function decodeCommand(hash) {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const params = new URLSearchParams(raw);
    if (params.get('ondo_alexa_vc') !== '1') return null;

    if (params.has('cmd')) {
      const parsed = JSON.parse(fromB64url(params.get('cmd')));
      if (!parsed.command_id) parsed.command_id = `local-${Date.now()}`;
      return parsed;
    }

    if (params.has('json')) {
      const parsed = JSON.parse(params.get('json'));
      if (!parsed.command_id) parsed.command_id = `local-${Date.now()}`;
      return parsed;
    }

    return simpleCommand(params);
  }

  function clearCommandHash() {
    if (!location.hash.startsWith('#ondo_alexa_vc=1')) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  async function executeHashCommand() {
    if (running) return;
    const hash = location.hash || '';
    if (!hash.startsWith(COMMAND_PREFIX)) return;
    running = true;

    let command;
    try {
      command = decodeCommand(hash);
      if (!command) throw new Error('missing command');
      clearCommandHash();
    } catch (error) {
      setMarker('error', 'ONDO JARVIS Alexa Control · ungültiger Befehl', {
        ok: false,
        error: 'INVALID_HASH_COMMAND'
      });
      running = false;
      return;
    }

    setMarker('running', `ONDO JARVIS Alexa Control · läuft · ${clip(command.command_id, 48)}`, {
      command_id: command.command_id
    });

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ONDO_ALEXA_VISUAL_COMMAND',
        command
      });

      if (response?.ok) {
        setMarker(
          'ready',
          `ONDO JARVIS Alexa Control · fertig · ${response.total_ms ?? '?'} ms`,
          response
        );
      } else {
        setMarker(
          'error',
          `ONDO JARVIS Alexa Control · Fehler · ${clip(response?.error || 'UNKNOWN', 80)}${response?.detail ? ` · ${clip(response.detail, 180)}` : ''}`,
          response || { ok: false, error: 'NO_RESPONSE' }
        );
      }
    } catch (error) {
      setMarker('error', `ONDO JARVIS Alexa Control · Fehler · ${clip(error?.message || error, 80)}`, {
        command_id: command.command_id,
        ok: false,
        error: 'RUNTIME_MESSAGE_FAILED'
      });
    } finally {
      running = false;
      if (location.hash.startsWith(COMMAND_PREFIX)) {
        queueMicrotask(executeHashCommand);
      }
    }
  }

  setMarker('ready', `ONDO JARVIS Alexa Control aktiv · v${VERSION}`);
  executeHashCommand();

  window.addEventListener('hashchange', executeHashCommand);

  const observer = new MutationObserver(() => {
    if (!document.getElementById(MARKER_ID)) {
      setMarker('ready', `ONDO JARVIS Alexa Control aktiv · v${VERSION}`);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
