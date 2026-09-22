const VERSION = '0.1.0';
const TARGET_ORIGIN = 'https://developer.amazon.com';
const SKILL_ID = 'amzn1.ask.skill.5bd2503a-290c-4e80-adc8-b639b915c673';
const TARGET_QUERY_FLAG = 'ondo_controller';
const TARGET_QUERY_VALUE = '1';
const MAX_TEXT = 20000;
const MAX_SEQUENCE = 30;
const MAX_WAIT_MS = 1500;
const DEBUGGER_VERSION = '1.3';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

function clip(value, max = 220) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function fail(code, detail = '') {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function ensureFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail('INVALID_NUMBER', name);
  return number;
}

function keySpec(raw) {
  const input = String(raw || '').trim();
  if (!input) fail('INVALID_KEY');

  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === 'alt') modifiers |= 1;
    else if (normalized === 'ctrl' || normalized === 'control') modifiers |= 2;
    else if (normalized === 'meta' || normalized === 'cmd' || normalized === 'command') modifiers |= 4;
    else if (normalized === 'shift') modifiers |= 8;
    else fail('UNSUPPORTED_MODIFIER', part);
  }

  const table = {
    backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    tab: { key: 'Tab', code: 'Tab', vk: 9 },
    enter: { key: 'Enter', code: 'Enter', vk: 13 },
    escape: { key: 'Escape', code: 'Escape', vk: 27 },
    esc: { key: 'Escape', code: 'Escape', vk: 27 },
    space: { key: ' ', code: 'Space', vk: 32 },
    pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
    end: { key: 'End', code: 'End', vk: 35 },
    home: { key: 'Home', code: 'Home', vk: 36 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    delete: { key: 'Delete', code: 'Delete', vk: 46 },
  };

  const lower = key.toLowerCase();
  if (table[lower]) return { ...table[lower], modifiers };

  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return { key: modifiers & 8 ? upper : key.toLowerCase(), code: `Key${upper}`, vk: upper.charCodeAt(0), modifiers };
  }

  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, vk: key.charCodeAt(0), modifiers };
  }

  fail('UNSUPPORTED_KEY', key);
}

async function findTargetTab() {
  const tabs = await chrome.tabs.query({});
  const mistral = tabs.filter((tab) => {
    try {
      return new URL(tab.url || '').origin === TARGET_ORIGIN;
    } catch {
      return false;
    }
  });

  const explicitlyAuthorized = mistral.filter((tab) => {
    try {
      const url = new URL(tab.url || '');
      return url.searchParams.get(TARGET_QUERY_FLAG) === TARGET_QUERY_VALUE;
    } catch {
      return false;
    }
  });

  if (explicitlyAuthorized.length === 1) return explicitlyAuthorized[0];
  if (explicitlyAuthorized.length > 1) fail('MULTIPLE_AUTHORIZED_MISTRAL_TABS', explicitlyAuthorized.map((t) => t.id).join(','));
  if (mistral.length === 1) return mistral[0];
  if (!mistral.length) fail('NO_MISTRAL_TAB');
  fail('MULTIPLE_MISTRAL_TABS', mistral.map((t) => t.id).join(','));
}

const attachedTabs = new Set();

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId) attachedTabs.delete(source.tabId);
});

async function debuggerTargetInfo(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find((candidate) => candidate.tabId === tabId) || null;
    if (!target) return { found: false, attached: null };
    return {
      found: true,
      attached: Boolean(target.attached),
      id: target.id || '',
      type: target.type || '',
      title: clip(target.title || '', 160),
      url: clip(target.url || '', 240),
    };
  } catch (error) {
    return {
      found: false,
      attached: null,
      get_targets_error: clip(error?.message || error, 300),
    };
  }
}

function debuggerAttachErrorCode(message) {
  const value = String(message || '').toLowerCase();
  if (/another debugger|already attached|being debugged|debugger is attached/.test(value)) return 'DEBUGGER_BUSY';
  if (/protocol version|required version|not supported/.test(value)) return 'DEBUGGER_PROTOCOL_ERROR';
  if (/restricted by policy|host access is restricted|screenshot capture is restricted/.test(value)) return 'DEBUGGER_POLICY_BLOCKED';
  return 'DEBUGGER_ATTACH_FAILED';
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;

  let probeError = '';
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    attachedTabs.add(tabId);
    return;
  } catch (error) {
    probeError = clip(error?.message || error, 300);
  }

  const targetBefore = await debuggerTargetInfo(tabId);
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    attachedTabs.add(tabId);
  } catch (error) {
    const attachError = clip(error?.message || error, 500);
    const targetAfter = await debuggerTargetInfo(tabId);
    const detail = JSON.stringify({
      protocol: DEBUGGER_VERSION,
      probe_error: probeError,
      target_before: targetBefore,
      target_after: targetAfter,
      attach_error: attachError,
    });
    fail(debuggerAttachErrorCode(attachError), detail);
  }
}

async function detachTab(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  attachedTabs.delete(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    attachedTabs.delete(tabId);
    throw error;
  }
}

async function viewport(tabId) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      href: location.href,
      title: document.title
    })`,
    returnByValue: true,
  });
  return result?.result?.value || {};
}

async function assertPoint(tabId, xRaw, yRaw) {
  const x = ensureFiniteNumber(xRaw, 'x');
  const y = ensureFiniteNumber(yRaw, 'y');
  const vp = await viewport(tabId);
  if (x < 0 || y < 0 || x >= Number(vp.width || 0) || y >= Number(vp.height || 0)) {
    fail('POINT_OUTSIDE_VIEWPORT', `${x},${y} vs ${vp.width}x${vp.height}`);
  }
  return { x, y, viewport: vp };
}

async function locateSemantic(tabId, target = {}) {
  const selector = target.selector ? String(target.selector) : '';
  const text = target.text ? String(target.text) : '';
  const aria = target.aria_label ? String(target.aria_label) : '';
  const placeholder = target.placeholder ? String(target.placeholder) : '';
  const role = target.role ? String(target.role) : '';
  const nth = Number.isInteger(target.nth) ? target.nth : 0;

  if (!selector && !text && !aria && !placeholder && !role) fail('EMPTY_TARGET');

  const expression = `(() => {
    const wanted = ${JSON.stringify({ selector, text, aria, placeholder, role, nth })};
    const norm = (v) => String(v ?? '').replace(/\\s+/g,' ').trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    let items = [];
    if (wanted.selector) {
      items = [...document.querySelectorAll(wanted.selector)];
    } else {
      const q = [
        'a[href]','button','input','textarea','select','option',
        '[role="button"]','[role="link"]','[role="menuitem"]','[role="option"]',
        '[role="tab"]','[role="checkbox"]','[role="radio"]',
        '[contenteditable="true"]','[tabindex]:not([tabindex="-1"])'
      ].join(',');
      items = [...document.querySelectorAll(q)];
    }

    const matches = items.filter(visible).filter((el) => {
      if (wanted.text && norm(el.innerText || el.textContent) !== norm(wanted.text)) return false;
      if (wanted.aria && norm(el.getAttribute('aria-label')) !== norm(wanted.aria)) return false;
      if (wanted.placeholder && norm(el.getAttribute('placeholder')) !== norm(wanted.placeholder)) return false;
      if (wanted.role && norm(el.getAttribute('role') || el.tagName.toLowerCase()) !== norm(wanted.role)) return false;
      return true;
    });

    const el = matches[wanted.nth] || null;
    if (!el) return { count: matches.length, found: false };
    const r = el.getBoundingClientRect();
    return {
      count: matches.length,
      found: true,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height },
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: String(el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,240),
      aria_label: el.getAttribute('aria-label') || '',
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
    };
  })()`;

  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const value = result?.result?.value;
  if (!value?.found) fail('TARGET_NOT_FOUND', `matches=${value?.count ?? 0}`);
  if (value.disabled) fail('TARGET_DISABLED');
  await assertPoint(tabId, value.x, value.y);
  return value;
}

async function resolvePoint(tabId, action) {
  if (action.target) {
    const located = await locateSemantic(tabId, action.target);
    return { x: located.x, y: located.y, located };
  }
  const checked = await assertPoint(tabId, action.x, action.y);
  return { x: checked.x, y: checked.y, located: null };
}

async function pointInfo(tabId, x, y) {
  const expression = `(() => {
    const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: String(el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,240),
      aria_label: el.getAttribute('aria-label') || '',
      rect: { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }
    };
  })()`;
  const result = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
  return result?.result?.value || null;
}

async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1 } = {}) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
}

async function sendKey(tabId, raw) {
  const spec = keySpec(raw);
  const common = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers: spec.modifiers,
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

async function insertText(tabId, text) {
  const value = String(text ?? '');
  if (value.length > MAX_TEXT) fail('TEXT_TOO_LARGE');
  await cdp(tabId, 'Input.insertText', { text: value });
}

async function assertActiveTargetSafeForText(tabId) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.activeElement;
      if (!el) return { ok:false, reason:'NO_ACTIVE_ELEMENT' };
      const tag = (el.tagName || '').toLowerCase();
      const type = (el.getAttribute?.('type') || '').toLowerCase();
      const editable = Boolean(
        tag === 'textarea' ||
        (tag === 'input' && type !== 'password') ||
        el.isContentEditable
      );
      return {
        ok: editable,
        tag,
        type,
        contenteditable: Boolean(el.isContentEditable),
        password: tag === 'input' && type === 'password'
      };
    })()`,
    returnByValue: true
  });
  const value = result?.result?.value || {};
  if (value.password) fail('PASSWORD_FIELD_REFUSED');
  if (!value.ok) fail('ACTIVE_TARGET_NOT_EDITABLE', JSON.stringify(value));
}

async function observe(tabId) {
  const expression = `(() => {
    const clip = (v, n=180) => String(v ?? '').replace(/\\s+/g,' ').trim().slice(0,n);
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0 &&
        r.top <= innerHeight && r.left <= innerWidth &&
        s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const q = [
      'a[href]','button','input','textarea','select',
      '[role="button"]','[role="link"]','[role="menuitem"]','[role="option"]',
      '[role="tab"]','[role="checkbox"]','[role="radio"]',
      '[contenteditable="true"]','[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const elements = [...document.querySelectorAll(q)].filter(visible).slice(0,160).map((el,index) => {
      const r = el.getBoundingClientRect();
      return {
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        text: clip(el.innerText || el.textContent),
        aria_label: clip(el.getAttribute('aria-label')),
        placeholder: clip(el.getAttribute('placeholder')),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        checked: typeof el.checked === 'boolean' ? el.checked : null,
        selected: typeof el.selected === 'boolean' ? el.selected : null,
        rect: {
          x: r.left + r.width/2,
          y: r.top + r.height/2,
          left:r.left, top:r.top, width:r.width, height:r.height
        }
      };
    });
    const a = document.activeElement;
    return {
      revision_hint: Date.now(),
      url: location.href,
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        scrollX,
        scrollY
      },
      active: a ? {
        tag: a.tagName?.toLowerCase() || '',
        role: a.getAttribute?.('role') || '',
        aria_label: clip(a.getAttribute?.('aria-label')),
        text: clip(a.innerText || a.textContent),
        value: 'value' in a && a.type !== 'password' ? clip(a.value, 500) : ''
      } : null,
      elements
    };
  })()`;
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value || {};
}

async function executeOne(tabId, action = {}) {
  const op = String(action.op || action.action || '').trim();
  if (!op) fail('MISSING_ACTION');

  if (op === 'debugger_status') {
    return { op, state: await debuggerTargetInfo(tabId) };
  }

  if (op === 'observe') {
    return { op, state: await observe(tabId) };
  }

  if (op === 'click' || op === 'double_click' || op === 'right_click' || op === 'hover') {
    const point = await resolvePoint(tabId, action);
    const before = await pointInfo(tabId, point.x, point.y);

    if (op === 'hover') {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    } else if (op === 'double_click') {
      await mouseClick(tabId, point.x, point.y, { clickCount: 1 });
      await mouseClick(tabId, point.x, point.y, { clickCount: 2 });
    } else if (op === 'right_click') {
      await mouseClick(tabId, point.x, point.y, { button: 'right', clickCount: 1 });
    } else {
      await mouseClick(tabId, point.x, point.y);
    }
    if (action.wait_ms) await sleep(Math.min(MAX_WAIT_MS, Math.max(0, Number(action.wait_ms) || 0)));
    return { op, x: point.x, y: point.y, before };
  }

  if (op === 'type') {
    if (action.target || action.x !== undefined || action.y !== undefined) {
      const point = await resolvePoint(tabId, action);
      await mouseClick(tabId, point.x, point.y);
    }
    await assertActiveTargetSafeForText(tabId);
    await insertText(tabId, action.text ?? action.value ?? '');
    return { op, length: String(action.text ?? action.value ?? '').length };
  }

  if (op === 'key' || op === 'shortcut') {
    await sendKey(tabId, action.key);
    return { op, key: action.key };
  }

  if (op === 'clear_text' || op === 'replace_text') {
    if (action.target || action.x !== undefined || action.y !== undefined) {
      const point = await resolvePoint(tabId, action);
      await mouseClick(tabId, point.x, point.y);
    }
    await assertActiveTargetSafeForText(tabId);
    await sendKey(tabId, 'CTRL+A');
    await sendKey(tabId, 'BACKSPACE');
    if (op === 'replace_text') await insertText(tabId, action.text ?? action.value ?? '');
    return { op, length: op === 'replace_text' ? String(action.text ?? action.value ?? '').length : 0 };
  }

  if (op === 'scroll') {
    const vp = await viewport(tabId);
    const x = action.x === undefined ? Number(vp.width || 0) / 2 : ensureFiniteNumber(action.x, 'x');
    const y = action.y === undefined ? Number(vp.height || 0) / 2 : ensureFiniteNumber(action.y, 'y');
    await assertPoint(tabId, x, y);
    const deltaX = ensureFiniteNumber(action.dx ?? action.delta_x ?? 0, 'dx');
    const deltaY = ensureFiniteNumber(action.dy ?? action.delta_y ?? 0, 'dy');
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      button: 'none'
    });
    return { op, x, y, deltaX, deltaY };
  }

  if (op === 'drag') {
    const from = action.from || {};
    const to = action.to || {};
    const start = await assertPoint(tabId, from.x, from.y);
    const end = await assertPoint(tabId, to.x, to.y);
    const steps = Math.max(2, Math.min(20, Number(action.steps) || 6));
    await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x:start.x, y:start.y, button:'none' });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mousePressed', x:start.x, y:start.y, button:'left', clickCount:1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'left', buttons:1 });
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type:'mouseReleased', x:end.x, y:end.y, button:'left', clickCount:1 });
    return { op, from:{x:start.x,y:start.y}, to:{x:end.x,y:end.y}, steps };
  }

  if (op === 'wait') {
    const ms = Math.min(MAX_WAIT_MS, Math.max(0, Number(action.ms) || 0));
    await sleep(ms);
    return { op, ms };
  }

  fail('UNSUPPORTED_ACTION', op);
}

async function runCommand(command = {}, preferredTab = null) {
  if (command.schema && command.schema !== 'ondo.visual.command.v1') fail('BAD_SCHEMA');
  if (!command.command_id || typeof command.command_id !== 'string') fail('MISSING_COMMAND_ID');

  let tab = preferredTab;
  if (tab?.id) {
    let origin = '';
    try { origin = new URL(tab.url || '').origin; } catch {}
    if (origin !== TARGET_ORIGIN || !String(tab.url || '').includes(SKILL_ID)) fail('UNAUTHORIZED_SENDER_TAB', tab.url || '');
  } else {
    tab = await findTargetTab();
  }
  if (!tab?.id) fail('TARGET_TAB_NO_ID');
  const started = now();

  const actions = Array.isArray(command.actions)
    ? command.actions
    : command.action
      ? [command.action]
      : command.op
        ? [{ ...command, op: command.op }]
        : [];

  if (!actions.length) fail('NO_ACTIONS');
  if (actions.length > MAX_SEQUENCE) fail('SEQUENCE_TOO_LONG');

  const steps = [];
  for (let i = 0; i < actions.length; i++) {
    const stepStarted = now();
    const result = await executeOne(tab.id, actions[i]);
    steps.push({ index:i, ms:Math.round(now() - stepStarted), ...result });
  }

  const finalState = command.readback === false ? null : await observe(tab.id);
  return {
    ok: true,
    schema: 'ondo.visual.result.v1',
    version: VERSION,
    command_id: command.command_id,
    target_tab_id: tab.id,
    target_url: tab.url,
    total_ms: Math.round(now() - started),
    steps,
    state: finalState,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ONDO_ALEXA_VISUAL_COMMAND') return;

  const sourceTab = sender?.tab || null;
  let sourceOrigin = '';
  try { sourceOrigin = new URL(sourceTab?.url || '').origin; } catch {}
  if (!sourceTab?.id || sourceOrigin !== TARGET_ORIGIN || !String(sourceTab.url || '').includes(SKILL_ID)) {
    sendResponse({
      ok: false,
      schema: 'ondo.visual.result.v1',
      version: VERSION,
      command_id: message?.command?.command_id || null,
      error: 'UNAUTHORIZED_COMMAND_SOURCE',
      detail: sourceTab?.url || ''
    });
    return false;
  }

  (async () => {
    try {
      const result = await runCommand(message.command || {}, sourceTab);
      sendResponse(result);
    } catch (error) {
      sendResponse({
        ok: false,
        schema: 'ondo.visual.result.v1',
        version: VERSION,
        command_id: message?.command?.command_id || null,
        error: error?.code || 'COMMAND_FAILED',
        detail: clip(error?.message || error, 500),
      });
    } finally {
      await detachTab(sourceTab.id);
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    ondo_visual_version: VERSION,
    ondo_visual_installed_at: new Date().toISOString(),
  });
});
