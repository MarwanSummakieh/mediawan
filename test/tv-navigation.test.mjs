import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/tv.js', import.meta.url), 'utf8');

// A small DOM with real selector, ancestry, event and mutation behavior. Tests
// operate the public navigator and remote keys, rather than its implementation.
function fixture(build, { tv = true, scale = 1, width = 1920, height = 1080 } = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), observers = [], pending = new Map();
  const split = (value, separator) => {
    const out = []; let depth = 0, quote = '', part = '';
    for (const char of value) {
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '[' || char === '(') depth++;
      else if (char === ']' || char === ')') depth--;
      if (!depth && !quote && (separator === ' ' ? /\s/.test(char) : char === separator)) {
        if (part.trim()) out.push(part.trim()); part = '';
      } else part += char;
    }
    if (part.trim()) out.push(part.trim());
    return out;
  };
  function compound(el, value) {
    let pass = true;
    value = value.replace(/:not\(((?:[^()]|\([^()]*\))*)\)/g, (_, selector) => {
      if (matches(el, selector)) pass = false; return '';
    });
    value = value.replace(/:is\(((?:[^()]|\([^()]*\))*)\)/g, (_, selector) => {
      if (!matches(el, selector)) pass = false; return '';
    });
    value = value.replace(/:focus(?:-visible)?/g, () => {
      if (document.activeElement !== el) pass = false; return '';
    }).replace(/:disabled/g, () => { if (!el.disabled) pass = false; return ''; });
    value = value.replace(/\[([^\]]+)\]/g, (_, raw) => {
      const found = raw.match(/^([^\s~|^$*=]+)\s*(?:([~|^$*]?=)\s*["']?(.*?)["']?)?$/);
      if (!found) throw new Error(`Unsupported attribute selector: ${raw}`);
      const [, name, operator, expected] = found, actual = el.getAttribute(name);
      if (!operator) { if (actual === null) pass = false; }
      else if (actual === null || (operator === '=' && actual !== expected) ||
        (operator === '^=' && !actual.startsWith(expected)) ||
        (operator === '$=' && !actual.endsWith(expected)) ||
        (operator === '*=' && !actual.includes(expected))) pass = false;
      return '';
    });
    const tag = value.match(/^[a-zA-Z][\w-]*|^\*/)?.[0];
    if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) pass = false;
    for (const [, id] of value.matchAll(/#([\w-]+)/g)) if (el.id !== id) pass = false;
    for (const [, name] of value.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(name)) pass = false;
    const remaining = value.replace(/^[a-zA-Z][\w-]*|^\*/, '').replace(/[.#][\w-]+/g, '');
    if (remaining) throw new Error(`Unsupported selector: ${remaining}`);
    return pass;
  }
  function matches(el, selector) {
    return split(selector, ',').some(option => {
      const parts = split(option, ' '); let at = el;
      if (!compound(at, parts.pop())) return false;
      while (parts.length) {
        let part = parts.pop();
        if (part === '>') { part = parts.pop(); at = at.parentElement; if (!at || !compound(at, part)) return false; }
        else { do { at = at.parentElement; } while (at && !compound(at, part)); if (!at) return false; }
      }
      return true;
    });
  }
  function descendants(el) { return el.children.flatMap(child => [child, ...descendants(child)]); }
  function notify(target, type, attributeName) {
    const record = { target, type, attributeName, addedNodes: [], removedNodes: [] };
    for (const observer of observers) for (const binding of observer.bindings) {
      if (binding.target !== target && !(binding.options.subtree && binding.target.contains(target))) continue;
      if (!binding.options[type]) continue;
      if (type === 'attributes' && binding.options.attributeFilter && !binding.options.attributeFilter.includes(attributeName)) continue;
      if (!pending.has(observer)) pending.set(observer, []); pending.get(observer).push(record); break;
    }
  }
  class Element {
    constructor(tag = 'div', properties = {}) {
      this.tagName = tag.toUpperCase(); this.nodeType = 1; this.id = properties.id || '';
      this.children = []; this.parentElement = null; this.attributes = new Map(); this.events = new Map();
      this.dataset = {}; this.style = {
        display: 'block', visibility: 'visible', opacity: '1', zIndex: 'auto',
        getPropertyValue: name => this.style[name] ?? '',
      };
      this.disabled = false; this.readOnly = false; this.value = ''; this.checked = false; this.type = tag === 'input' ? 'text' : '';
      this.rect = { left: 100, top: 100, width: 100, height: 50, ...(properties.rect || {}) };
      this.clicks = 0; this.focusCalls = 0; this.scrolls = []; this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1;
      this._hidden = false;
      const classes = new Set((properties.className || '').split(/\s+/).filter(Boolean));
      const mutate = fn => { const before = [...classes].join(' '); fn(); if (before !== [...classes].join(' ')) notify(this, 'attributes', 'class'); };
      this.classList = {
        contains: name => classes.has(name), add: (...names) => mutate(() => names.forEach(name => classes.add(name))),
        remove: (...names) => mutate(() => names.forEach(name => classes.delete(name))),
        toggle: (name, value) => { const on = value ?? !classes.has(name); mutate(() => on ? classes.add(name) : classes.delete(name)); return on; },
        toString: () => [...classes].join(' '),
      };
      for (const [key, value] of Object.entries(properties)) if (!['rect', 'className'].includes(key)) this[key] = value;
    }
    get hidden() { return this._hidden; }
    set hidden(value) { const before = this._hidden; this._hidden = !!value; if (before !== this._hidden) notify(this, 'attributes', 'hidden'); }
    get className() { return this.classList.toString(); }
    set className(value) {
      this.classList.remove(...this.classList.toString().split(/\s+/).filter(Boolean));
      this.classList.add(...String(value).split(/\s+/).filter(Boolean));
    }
    get options() { return this.tagName === 'SELECT' ? descendants(this).filter(el => el.tagName === 'OPTION') : undefined; }
    get selectedIndex() { const options = this.options || []; const selected = options.findIndex(option => option.selected); return selected < 0 ? (options.length ? 0 : -1) : selected; }
    set selectedIndex(index) { (this.options || []).forEach((option, i) => { option.selected = i === index; }); this._value = this.options?.[index]?.value ?? ''; }
    get value() { return this.tagName === 'SELECT' && this.options.length ? this.options[this.selectedIndex]?.value ?? '' : this._value || ''; }
    set value(value) { this._value = String(value); (this.options || []).forEach(option => { option.selected = option.value === this._value; }); }
    get isConnected() { return document.documentElement.contains(this); }
    get parentNode() { return this.parentElement; }
    get offsetWidth() { return this.rect.width; }
    get offsetHeight() { return this.rect.height; }
    get offsetTop() { return this.rect.top; }
    get offsetLeft() { return this.rect.left; }
    get clientWidth() { return this.rect.width; }
    get scrollWidth() { return this._scrollWidth ?? this.rect.width; }
    getBoundingClientRect() {
      for (let at = this.parentElement; at; at = at.parentElement) {
        if (at.tagName === 'DETAILS' && !at.open) {
          const summary = at.children.find(el => el.tagName === 'SUMMARY');
          if (!summary?.contains(this)) return { ...this.rect, width: 0, height: 0, right: this.rect.left, bottom: this.rect.top };
        }
      }
      return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height, x: this.rect.left, y: this.rect.top };
    }
    getClientRects() { return this.rect.width && this.rect.height ? [this.getBoundingClientRect()] : []; }
    contains(el) { return this === el || this.children.some(child => child.contains(el)); }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let at = this; at; at = at.parentElement) if (matches(at, selector)) return at; return null; }
    querySelectorAll(selector) { return descendants(this).filter(el => matches(el, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    appendChild(child) {
      if (child.flowLayout) { child.rect.left = this.rect.left; child.rect.top = this.rect.top + this.children.length * 60; }
      child.parentElement = this; this.children.push(child); notify(this, 'childList'); return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() { const parent = this.parentElement; if (!parent) return; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; notify(parent, 'childList'); }
    replaceWith(child) { const parent = this.parentElement; const index = parent.children.indexOf(this); parent.children[index] = child; child.parentElement = parent; this.parentElement = null; notify(parent, 'childList'); }
    getAttribute(name) {
      if (name === 'id') return this.id || null;
      if (name === 'class') return this.className || null;
      if (name === 'hidden') return this.hidden ? '' : null;
      if (name === 'disabled') return this.disabled ? '' : null;
      if (name === 'type') return this.type || null;
      if (name.startsWith('data-')) { const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return this.dataset[key] ?? null; }
      return this.attributes.get(name) ?? null;
    }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    setAttribute(name, value) {
      if (name === 'hidden') this.hidden = true;
      else if (name === 'id') this.id = String(value);
      else if (name === 'class') this.className = String(value);
      else if (name === 'tabindex') { this.tabIndex = Number(value); this.attributes.set(name, String(value)); }
      else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      else this.attributes.set(name, String(value));
      notify(this, 'attributes', name);
    }
    removeAttribute(name) { if (name === 'hidden') this.hidden = false; else this.attributes.delete(name); notify(this, 'attributes', name); }
    addEventListener(type, callback) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(callback); }
    dispatchEvent(event) {
      event.target = this;
      for (const callback of this.events.get(event.type) || []) callback(event);
      if (event.bubbles) for (let at = this.parentElement; at; at = at.parentElement) for (const callback of at.events.get(event.type) || []) callback(event);
      return !event.defaultPrevented;
    }
    click() {
      if (this.disabled) return;
      this.clicks++;
      if (this.tagName === 'INPUT' && ['checkbox', 'radio'].includes(this.type)) {
        this.checked = this.type === 'radio' || !this.checked;
        this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.dispatchEvent(new Event('click', { bubbles: true })); this.onclick?.({ target: this });
      if (this.tagName === 'SUMMARY' && this.parentElement?.tagName === 'DETAILS') {
        this.parentElement.open = !this.parentElement.open; notify(this.parentElement, 'attributes', 'open');
      }
    }
    focus() { this.focusCalls++; document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = document.body; this.dispatchEvent(new Event('blur')); }
    scrollIntoView(options) { this.scrolls.push(options); }
    select() { this.selected = true; }
    canPlayType() { return ''; }
  }
  class Event {
    constructor(type, options = {}) { this.type = type; this.defaultPrevented = false; this.stopped = false; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.stopped = true; }
  }
  const document = {
    activeElement: null, events: new Map(),
    querySelectorAll(selector) { return [this.documentElement, ...descendants(this.documentElement)].filter(el => matches(el, selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementById(id) { return this.querySelector(`#${id}`); },
    contains(el) { return this.documentElement.contains(el); },
    createElement(tag) { const element = new Element(tag); element.flowLayout = true; return element; },
    addEventListener(type, callback) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(callback); },
  };
  document.documentElement = new Element('html'); document.body = new Element('body');
  document.documentElement.appendChild(document.body); document.activeElement = document.body;
  document.documentElement.style['--tv-scale'] = String(scale);
  const storage = new Map(), calls = [];
  const player = {
    video: { paused: true }, showStatus() {}, showStatusAction() {},
    hideMenus() { calls.push('hideMenus'); document.querySelectorAll('#player .p-menu').forEach(menu => { menu.hidden = true; }); },
    closeDrawer() { calls.push('closeDrawer'); document.querySelectorAll('#player .p-drawer.show').forEach(drawer => drawer.classList.remove('show')); },
    close() { calls.push('closePlayer'); document.getElementById('player')?.classList.remove('show'); },
    poke() {}, togglePlay() { calls.push('togglePlay'); }, nudge(delta) { calls.push(['seek', delta]); },
    gotoSub(sub) { calls.push(['gotoSub', sub]); },
  };
  const scrollPositions = [];
  const window = {
    Player: player, addEventListener() {}, scrollTo(x, y) { scrollPositions.push({ x, y }); },
    pageYOffset: 0, innerWidth: width, innerHeight: height,
    MediawanSports: {
      closePlayer() { document.querySelector('[data-close-player]')?.click(); },
      closeModal() { document.querySelector('[data-close-modal]')?.click(); },
    },
  };
  const h = {
    document, window, calls, scrollPositions,
    element(tag, properties = {}, parent = document.body) { return parent.appendChild(new Element(tag, properties)); },
    get(id) { return document.getElementById(id); },
    focus() { return document.querySelector('.tv-focus'); },
    key(key) {
      const keyCode = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Enter: 13, Escape: 27, Backspace: 8, BrowserBack: 10009 }[key];
      const event = new Event('keydown', { key, keyCode, which: keyCode, target: document.activeElement });
      for (const callback of document.events.get('keydown') || []) { callback(event); if (event.stopped) break; }
      return event;
    },
    flush(ms = 1000) {
      for (let i = 0; pending.size && i < 20; i++) {
        const batch = [...pending]; pending.clear(); batch.forEach(([observer, records]) => observer.callback(records));
      }
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) if (timers.delete(id)) timer.callback();
      for (let i = 0; pending.size && i < 20; i++) {
        const batch = [...pending]; pending.clear(); batch.forEach(([observer, records]) => observer.callback(records));
      }
    },
  };
  build(h);
  const context = vm.createContext({
    window, document, location: { search: tv ? '?tv=1' : '' }, console, Event,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    getComputedStyle: el => el.style, innerWidth: width, innerHeight: height,
    setTimeout(callback, delay = 0) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++nextTimer; }, clearInterval() {},
    requestAnimationFrame(callback) { const id = ++nextTimer; timers.set(id, { callback, at: now + 16 }); return id; }, cancelAnimationFrame(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.bindings = []; observers.push(this); }
      observe(target, options) { this.bindings.push({ target, options }); }
      disconnect() { this.bindings = []; }
    },
    fetch: async () => ({ ok: true }),
  });
  vm.runInContext(source, context);
  h.nav = window.TVNav;
  return h;
}

test('TV behavior is opt-in and leaves ordinary browser keys alone', () => {
  const h = fixture(h => h.element('button', { id: 'retry' }), { tv: false });
  assert.equal(h.nav, undefined);
  assert.equal(h.document.documentElement.classList.contains('tv'), false);
  assert.equal(h.key('ArrowDown').defaultPrevented, false);
  assert.equal(h.focus(), null);
});

test('plain retry buttons, library links and admin controls are remote destinations', () => {
  const h = fixture(h => {
    h.element('button', { id: 'retry', rect: { top: 100 } });
    const link = h.element('a', { id: 'library', rect: { top: 200 } }); link.setAttribute('href', '/library');
    h.element('button', { id: 'admin-save', rect: { top: 300 } });
  });
  h.nav.ensure(); assert.equal(h.focus()?.id, 'retry');
  h.key('Enter'); assert.equal(h.get('retry').clicks, 1);
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'library');
  h.key('Enter'); assert.equal(h.get('library').clicks, 1);
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'admin-save');
});

test('remote skips disabled, hidden, inert and aria-hidden controls but can scroll to a later row', () => {
  const h = fixture(h => {
    h.element('button', { id: 'start', rect: { top: 100 } });
    h.element('button', { id: 'disabled', disabled: true, rect: { top: 180 } });
    h.element('button', { id: 'hidden', hidden: true, rect: { top: 220 } });
    const inert = h.element('div'); inert.setAttribute('inert', ''); h.element('button', { id: 'inert-child', rect: { top: 260 } }, inert);
    const aria = h.element('div'); aria.setAttribute('aria-hidden', 'true'); h.element('button', { id: 'aria-child', rect: { top: 300 } }, aria);
    const parked = h.element('div', { className: 'p-drawer' }); h.element('button', { id: 'parked', rect: { top: 350 } }, parked);
    h.element('button', { id: 'next-row', rect: { top: 1200 } });
  });
  h.nav.setFocus(h.get('start'));
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'next-row');
  assert.equal(h.get('next-row').scrolls.length > 0, true);
});

test('browse row navigation uses the same hidden and disabled eligibility as spatial navigation', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    const row = h.element('section', { className: 'row' }, app);
    const cards = h.element('div', { className: 'cards' }, row);
    h.element('div', { id: 'first-card', className: 'card', rect: { left: 100 } }, cards);
    h.element('div', { id: 'hidden-card', className: 'card', hidden: true, rect: { left: 250 } }, cards);
    h.element('div', { id: 'disabled-card', className: 'card', rect: { left: 400 } }, cards).setAttribute('aria-disabled', 'true');
    h.element('div', { id: 'last-card', className: 'card', rect: { left: 550 } }, cards);
  });
  h.nav.ensure(); assert.equal(h.focus()?.id, 'first-card');
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'last-card');
});

test('library hub links remain navigable when the page also contains poster rows', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    const links = h.element('nav', { className: 'library-hub-links' }, app);
    const anime = h.element('a', { id: 'anime-link', rect: { left: 100, top: 100 } }, links); anime.setAttribute('href', '/anime');
    const films = h.element('a', { id: 'films-link', rect: { left: 300, top: 100 } }, links); films.setAttribute('href', '/films');
    const row = h.element('section', { className: 'row', rect: { top: 300 } }, app);
    const cards = h.element('div', { className: 'cards', rect: { top: 300 } }, row);
    h.element('div', { id: 'first-card', className: 'card', rect: { left: 100, top: 300 } }, cards);
  });
  h.nav.setFocus(h.get('anime-link')); h.key('ArrowRight'); assert.equal(h.focus()?.id, 'films-link');
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'first-card');
  h.key('ArrowUp'); assert.ok(['anime-link', 'films-link'].includes(h.focus()?.id));
});

test('generic sports rail controls reveal their horizontal overflow when the remote moves right', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    const rail = h.element('div', { className: 'competition-rail', rect: { width: 500 } }, app);
    const first = h.element('a', { id: 'competition-first', rect: { left: 100 } }, rail); first.setAttribute('href', '/sports/competition/first');
    const offscreen = h.element('a', { id: 'competition-later', rect: { left: 2100 } }, rail); offscreen.setAttribute('href', '/sports/competition/later');
  });
  h.nav.setFocus(h.get('competition-first'));
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'competition-later');
  const scroll = h.get('competition-later').scrolls.at(-1);
  assert.ok(scroll, 'a generic action must reveal its horizontally clipped ancestor');
  assert.equal(scroll.inline, 'nearest'); assert.equal(scroll.behavior, 'auto');
});

test('admin summary disclosures are remote controls and reveal nested setup instructions', () => {
  const h = fixture(h => {
    const outer = h.element('details', { id: 'setup' });
    h.element('summary', { id: 'setup-title', rect: { top: 100 } }, outer);
    const inner = h.element('details', { id: 'install' }, outer);
    h.element('summary', { id: 'install-title', rect: { top: 200 } }, inner);
    h.element('div', { id: 'instructions', rect: { top: 300 } }, inner).setAttribute('data-tv-scroll', '');
  });
  h.nav.ensure(); assert.equal(h.focus()?.id, 'setup-title');
  h.key('Enter'); assert.equal(h.get('setup').open, true);
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'install-title');
  h.key('Enter'); assert.equal(h.get('install').open, true);
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'instructions');
});

test('form order keeps a narrow language selector reachable below a wide URL input', () => {
  const h = fixture(h => {
    const form = h.element('form');
    h.element('input', { id: 'guide-url', type: 'url', rect: { top: 100, left: 100, width: 700 } }, form);
    h.element('select', { id: 'default-language', rect: { top: 200, left: 100, width: 160 } }, form);
    h.element('button', { id: 'save-guide', rect: { top: 300, left: 350, width: 200 } }, form);
    h.element('button', { id: 'refresh-guide', rect: { top: 300, left: 650, width: 200 } }, form);
  });
  h.nav.setFocus(h.get('guide-url'));
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'default-language');
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'save-guide');
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'refresh-guide');
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'default-language', 'Up leaves the horizontal button row');
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'guide-url');
});

test('D-pad highlights login inputs without summoning the keyboard; OK deliberately starts editing', () => {
  const h = fixture(h => {
    const form = h.element('form', { className: 'auth-card' });
    h.element('input', { id: 'email', rect: { left: 100 } }, form);
    h.element('input', { id: 'password', type: 'password', rect: { left: 250 } }, form);
    h.element('button', { id: 'login', className: 'btn', rect: { left: 400 } }, form);
  });
  h.nav.setFocus(h.get('email'));
  assert.notEqual(h.document.activeElement, h.get('email'));
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'password');
  assert.notEqual(h.document.activeElement, h.get('password'));
  h.key('Enter'); assert.equal(h.document.activeElement, h.get('password'));
  assert.equal(h.key('ArrowLeft').defaultPrevented, false, 'editing keeps native caret behavior');
  assert.equal(h.key('Backspace').defaultPrevented, false, 'editing keeps native text deletion');
  assert.equal(h.focus()?.id, 'password');
  assert.equal(h.key('BrowserBack').defaultPrevented, true);
  assert.notEqual(h.document.activeElement, h.get('password'));
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'login');
});

test('OK on a checkbox uses its native toggle and emits the form change event', () => {
  let changes = 0;
  const h = fixture(h => {
    const input = h.element('input', { id: 'enabled', type: 'checkbox' });
    input.addEventListener('change', () => { changes++; });
  });
  h.nav.setFocus(h.get('enabled')); h.key('Enter');
  assert.equal(h.get('enabled').checked, true); assert.equal(changes, 1);
  h.key('Enter'); assert.equal(h.get('enabled').checked, false); assert.equal(changes, 2);
});

test('D-pad changes a range by its step and dispatches input and change once', () => {
  const emitted = [];
  const h = fixture(h => {
    const range = h.element('input', { id: 'guide-hour', type: 'range', min: '0', max: '23', step: '1', value: '12' });
    range.addEventListener('input', () => emitted.push('input'));
    range.addEventListener('change', () => emitted.push('change'));
  });
  h.nav.setFocus(h.get('guide-hour'));
  assert.equal(h.key('ArrowRight').defaultPrevented, true);
  assert.equal(h.get('guide-hour').value, '13'); assert.deepEqual(emitted, ['input', 'change']);
  h.key('ArrowLeft'); assert.equal(h.get('guide-hour').value, '12');
  assert.equal(h.focus()?.id, 'guide-hour');
});

test('select options form their own remote layer and selecting dispatches a single form update', () => {
  const emitted = [];
  const h = fixture(h => {
    const select = h.element('select', { id: 'live-language' });
    h.element('option', { value: 'all', textContent: 'All languages', selected: true }, select);
    h.element('option', { value: 'en', textContent: 'English' }, select);
    select.addEventListener('input', () => emitted.push('input'));
    select.addEventListener('change', () => emitted.push('change'));
    h.element('button', { id: 'next', rect: { left: 500 } });
  });
  h.nav.setFocus(h.get('live-language')); h.key('Enter'); h.flush(400);
  assert.ok(h.document.querySelector('.tv-select-dialog'));
  assert.ok(h.focus()?.closest('.tv-select-dialog'));
  h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.get('live-language').value, 'en');
  assert.equal(h.document.querySelector('.tv-select-dialog'), null);
  assert.deepEqual(emitted, ['input', 'change']);
  assert.equal(h.focus()?.id, 'live-language');
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'next');
});

test('Back cancels a select overlay before closing the player menu that opened it', () => {
  const h = fixture(h => {
    const player = h.element('div', { id: 'player', className: 'show' });
    const menu = h.element('div', { id: 'settingsMenu', className: 'p-menu' }, player);
    const select = h.element('select', { id: 'caption-language' }, menu);
    h.element('option', { value: 'off', textContent: 'Off', selected: true }, select);
    h.element('option', { value: 'en', textContent: 'English' }, select);
  });
  h.nav.setFocus(h.get('caption-language')); h.key('Enter'); h.flush(400);
  assert.ok(h.document.querySelector('.tv-select-dialog'));
  h.key('BrowserBack');
  assert.equal(h.document.querySelector('.tv-select-dialog'), null);
  assert.equal(h.get('settingsMenu').hidden, false);
  assert.equal(h.get('caption-language').value, 'off');
  assert.equal(h.focus()?.id, 'caption-language');
  assert.equal(h.calls.includes('closePlayer'), false);
  assert.equal(h.calls.includes('hideMenus'), false);
});

test('sports settings is the active layer even when a live player was mounted first', () => {
  const h = fixture(h => {
    const live = h.element('section', { className: 'sports-player' });
    h.element('button', { id: 'live-close' }, live);
    const modal = h.element('div', { className: 'sports-modal' });
    const dialog = h.element('section', { className: 'sports-dialog' }, modal);
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    h.element('button', { id: 'settings-close', className: 'sports-dialog-close' }, dialog).setAttribute('data-close-modal', '');
    h.element('button', { id: 'settings-save', rect: { top: 200 } }, dialog);
  });
  h.nav.ensure(); assert.equal(h.focus()?.id, 'settings-close');
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'settings-save');
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'settings-close');
});

test('Back and Escape close a sports modal before its live player', () => {
  for (const key of ['BrowserBack', 'Escape']) {
    const closed = [];
    const h = fixture(h => {
      const live = h.element('section', { className: 'sports-player' });
      const liveClose = h.element('button', { id: 'live-close' }, live); liveClose.setAttribute('data-close-player', '');
      liveClose.onclick = () => { closed.push('live'); live.remove(); };
      const modal = h.element('div', { className: 'sports-modal' });
      const dialog = h.element('section', { className: 'sports-dialog' }, modal);
      const close = h.element('button', { id: 'modal-close', className: 'sports-dialog-close' }, dialog); close.setAttribute('data-close-modal', '');
      close.onclick = () => { closed.push('modal'); modal.remove(); };
    });
    h.nav.ensure(); assert.equal(h.key(key).defaultPrevented, true);
    assert.deepEqual(closed, ['modal']);
    h.key(key); assert.deepEqual(closed, ['modal', 'live']);
  }
});

test('player Back closes an open picker before closing the containing menu or player', () => {
  const h = fixture(h => {
    const player = h.element('div', { id: 'player', className: 'show' });
    const menu = h.element('div', { id: 'settingsMenu', className: 'p-menu' }, player);
    const picker = h.element('div', { id: 'quality-picker', className: 'picker', dataset: { open: 'true' } }, menu);
    const button = h.element('button', { id: 'quality', className: 'picker-btn' }, picker);
    button.onclick = () => { picker.setAttribute('data-open', 'false'); list.hidden = true; };
    const list = h.element('div', { id: 'quality-options', className: 'picker-menu' }, picker);
    h.element('button', { id: 'quality-auto', className: 'picker-opt active' }, list);
  });
  h.nav.ensure(); assert.equal(h.focus()?.id, 'quality-auto');
  h.key('BrowserBack');
  assert.equal(h.get('quality-options').hidden, true);
  assert.equal(h.get('settingsMenu').hidden, false);
  assert.equal(h.calls.includes('closePlayer'), false);
  assert.equal(h.focus()?.id, 'quality');
});

test('dynamic page replacement restores the same named control instead of jumping to the first', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    h.element('button', { id: 'first', rect: { top: 100 } }, app);
    h.element('button', { id: 'retry', rect: { top: 200 } }, app);
  });
  h.nav.setFocus(h.get('retry'));
  const replacement = h.document.createElement('button'); replacement.id = 'retry'; replacement.rect.top = 200;
  h.get('retry').replaceWith(replacement); h.flush(); h.flush(400);
  assert.equal(h.focus(), replacement);
});

test('player top actions are reachable with the remote after climbing from the controls', () => {
  const h = fixture(h => {
    const player = h.element('div', { id: 'player', className: 'show' });
    const top = h.element('div', { className: 'p-top' }, player);
    h.element('button', { id: 'pBack', className: 'p-icon', rect: { top: 30, left: 100 } }, top);
    h.element('button', { id: 'pWatch', className: 'p-icon', rect: { top: 30, left: 1500 } }, top);
    const bottom = h.element('div', { className: 'p-bottom' }, player);
    h.element('div', { id: 'scrub', className: 'scrub', rect: { top: 850, width: 1700 } }, bottom);
    h.element('button', { id: 'pPlay', className: 'p-icon', rect: { top: 950, left: 100 } }, bottom);
  });
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'pPlay');
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'scrub');
  h.key('ArrowUp'); assert.equal(h.focus()?.closest('.p-top') !== null, true);
  h.key('ArrowLeft'); assert.equal(h.focus()?.id, 'pBack');
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'pWatch');
  h.key('Enter'); assert.equal(h.get('pWatch').clicks, 1);
  assert.equal(h.calls.includes('togglePlay'), false);
});

test('1080p and 4K poster rows keep the title band visible and pin the selected card at the same visual inset', () => {
  for (const scale of [1, 2]) {
    const h = fixture(h => {
      const app = h.element('main', { id: 'app' });
      const row = h.element('section', { id: 'poster-row', className: 'row', rect: { top: 900 * scale } }, app);
      const cards = h.element('div', { id: 'posters', className: 'cards', rect: { top: 950 * scale, width: 1400 * scale } }, row);
      cards._scrollWidth = 3000 * scale;
      h.element('div', { id: 'first', className: 'card', rect: { left: 200 * scale, top: 950 * scale, width: 330 * scale, height: 470 * scale } }, cards);
      h.element('div', { id: 'second', className: 'card', rect: { left: 560 * scale, top: 950 * scale, width: 330 * scale, height: 470 * scale } }, cards);
    }, { scale, width: 1920 * scale, height: 1080 * scale });
    h.nav.ensure(); assert.equal(h.focus()?.id, 'first');
    assert.equal(h.scrollPositions.at(-1).y, 750 * scale, 'the row title stays in the readable top band');
    h.key('ArrowRight'); assert.equal(h.focus()?.id, 'second');
    assert.equal(h.get('posters').scrollLeft, 552 * scale, 'the card inset scales with its poster and focus ring');
    assert.equal(h.scrollPositions.at(-1).y, 750 * scale);
  }
});

test('4K grid movement retains the selected column and the readable line position', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    const grid = h.element('div', { className: 'cards-grid' }, app);
    for (const [name, top] of [['upper', 800], ['lower', 2000]]) {
      h.element('div', { id: `${name}-left`, className: 'card', rect: { left: 400, top, width: 660, height: 940 } }, grid);
      h.element('div', { id: `${name}-middle`, className: 'card', rect: { left: 1120, top, width: 660, height: 940 } }, grid);
      h.element('div', { id: `${name}-right`, className: 'card', rect: { left: 1840, top, width: 660, height: 940 } }, grid);
    }
  }, { scale: 2, width: 3840, height: 2160 });
  h.nav.ensure(); h.key('ArrowRight'); assert.equal(h.focus()?.id, 'upper-middle');
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'lower-middle');
  assert.equal(h.scrollPositions.at(-1).y, 1580);
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'upper-middle');
  assert.equal(h.scrollPositions.at(-1).y, 380);
});

test('4K page actions with unequal heights remain one horizontal remote row', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    h.element('button', { id: 'primary', rect: { left: 400, top: 600, width: 400, height: 128 } }, app);
    h.element('button', { id: 'secondary', rect: { left: 1000, top: 628, width: 400, height: 72 } }, app);
    h.element('button', { id: 'next-row', rect: { left: 400, top: 1000, width: 400, height: 128 } }, app);
  }, { scale: 2, width: 3840, height: 2160 });
  h.nav.setFocus(h.get('primary'));
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'secondary');
  h.key('ArrowDown'); assert.equal(h.focus()?.id, 'next-row');
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'secondary', 'returning to a row restores its selected action');
});

test('4K form navigation leaves an unequal-height button row for the field above it', () => {
  const h = fixture(h => {
    const form = h.element('form');
    h.element('select', { id: 'language', rect: { top: 400, left: 200, width: 320, height: 128 } }, form);
    h.element('button', { id: 'save', rect: { top: 600, left: 200, width: 400, height: 128 } }, form);
    h.element('button', { id: 'refresh', rect: { top: 628, left: 800, width: 400, height: 72 } }, form);
  }, { scale: 2, width: 3840, height: 2160 });
  h.nav.setFocus(h.get('refresh'));
  h.key('ArrowUp'); assert.equal(h.focus()?.id, 'language');
});

test('a viewport scale change recalculates row scroll positions without restarting navigation', () => {
  const h = fixture(h => {
    const app = h.element('main', { id: 'app' });
    const row = h.element('section', { id: 'poster-row', className: 'row', rect: { top: 600 } }, app);
    const cards = h.element('div', { className: 'cards' }, row);
    h.element('div', { id: 'first', className: 'card', rect: { left: 200, top: 650 } }, cards);
    h.element('div', { id: 'second', className: 'card', rect: { left: 560, top: 650 } }, cards);
  });
  h.nav.ensure(); assert.equal(h.scrollPositions.at(-1).y, 450);
  h.document.documentElement.style['--tv-scale'] = '2';
  h.window.innerWidth = 3840; h.window.innerHeight = 2160;
  h.get('poster-row').rect.top = 1200;
  h.key('ArrowRight'); assert.equal(h.focus()?.id, 'second');
  assert.equal(h.scrollPositions.at(-1).y, 900);
  h.document.documentElement.style['--tv-scale'] = '1';
  h.window.innerWidth = 1920; h.window.innerHeight = 1080;
  h.get('poster-row').rect.top = 600;
  h.key('ArrowLeft'); assert.equal(h.focus()?.id, 'first');
  assert.equal(h.scrollPositions.at(-1).y, 450);
});
