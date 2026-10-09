export const subtitleSizes = [
  ['s', 'Small', 0.03],
  ['m', 'Medium', 0.038],
  ['l', 'Large', 0.048],
  ['xl', 'Extra large', 0.06],
  ['xxl', 'Huge', 0.075],
];
export const subtitleColors = [
  ['white', 'White', '#ffffff'],
  ['yellow', 'Yellow', '#ffe066'],
  ['green', 'Green', '#a5e6a2'],
  ['cyan', 'Cyan', '#8ce4ef'],
  ['pink', 'Pink', '#ffb3d1'],
  ['grey', 'Grey', '#c9ced8'],
  ['black', 'Black', '#000000'],
];
export const subtitleBackgrounds = [
  ['none', 'None', null],
  ['black', 'Black', '#000000'],
  ['grey', 'Grey', '#333333'],
  ['white', 'White', '#ffffff'],
  ['navy', 'Deep blue', '#101a34'],
  ['yellow', 'Yellow', '#ffe867'],
];
export const subtitleDefaults = {
  size: 'm',
  color: 'white',
  bg: 'black',
  bgOpacity: 0.75,
  pos: 6,
  align: 'center',
};
export function subtitleStyle(saved) {
  const s = { ...subtitleDefaults };
  if (!saved || typeof saved !== 'object') return s;
  for (const [key, choices] of [
    ['size', subtitleSizes],
    ['color', subtitleColors],
    ['bg', subtitleBackgrounds],
  ])
    if (choices.some(([id]) => id === saved[key])) s[key] = saved[key];
  if (['left', 'center', 'right'].includes(saved.align)) s.align = saved.align;
  if (Number.isFinite(saved.pos)) s.pos = Math.max(0, Math.min(80, Math.round(saved.pos)));
  if (Number.isFinite(saved.bgOpacity)) s.bgOpacity = Math.max(0, Math.min(1, saved.bgOpacity));
  return s;
}
export function srtToVtt(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r/g, '');
  return /^WEBVTT(?:\s|$)/.test(text)
    ? text
    : 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
export function decodeSubtitle(bytes, language = '') {
  const buffer = new Uint8Array(bytes);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const encodings = {
      ara: 'windows-1256',
      ar: 'windows-1256',
      per: 'windows-1256',
      fas: 'windows-1256',
      rus: 'windows-1251',
      bul: 'windows-1251',
      ukr: 'windows-1251',
      srp: 'windows-1251',
      gre: 'windows-1253',
      ell: 'windows-1253',
      heb: 'windows-1255',
      tur: 'windows-1254',
      tha: 'windows-874',
      vie: 'windows-1258',
    };
    return new TextDecoder(encodings[language.toLowerCase()] || 'windows-1252').decode(buffer);
  }
}
export const isArabic = (language) => /^(ar|ara)(-|$)/i.test(language || '');
export const subtitleLanguageLabel = (language) =>
  isArabic(language) ? 'Arabic · العربية' : language;
// Always derive from the original timestamps: repeated nudges must not drift.
export function shiftSubtitleCues(cues, delay, offset = 0, originals = new WeakMap()) {
  for (const cue of Array.from(cues || [])) {
    if (!originals.has(cue)) originals.set(cue, [cue.startTime, cue.endTime]);
    const [start, end] = originals.get(cue);
    cue.startTime = start + delay - offset;
    cue.endTime = end + delay - offset;
  }
  return originals;
}
export function createSubtitleRenderer(video, layer) {
  let style,
    track = null,
    preview = false;
  try {
    style = subtitleStyle(JSON.parse(localStorage.getItem('mw:substyle')));
  } catch {
    style = subtitleStyle();
  }
  function render() {
    layer.textContent = '';
    // A paused conversion can load at time zero before the browser refreshes
    // activeCues. Use the shifted timestamps so its first frame is correct too.
    const cues = preview
      ? []
      : Array.from(track?.track.cues || []).filter(
          (cue) => cue.startTime <= video.currentTime && cue.endTime > video.currentTime,
        );
    layer.hidden = !preview && !cues.length;
    if (layer.hidden) return;
    const bounds = video.getBoundingClientRect(),
      parent = layer.parentElement.getBoundingClientRect();
    const scale =
      video.videoWidth && video.videoHeight
        ? Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight)
        : 1;
    const width = video.videoWidth ? video.videoWidth * scale : bounds.width;
    const height = video.videoHeight ? video.videoHeight * scale : bounds.height;
    Object.assign(layer.style, {
      left: `${bounds.left - parent.left + (bounds.width - width) / 2}px`,
      top: `${bounds.top - parent.top + (bounds.height - height) / 2}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    const stacks = {};
    function add(content, edge = 'bottom') {
      if (!stacks[edge]) {
        const stack = document.createElement('div');
        stack.className = 'subtitle-stack';
        stack.style[edge] = `${style.pos}%`;
        stack.style.alignItems = { left: 'flex-start', center: 'center', right: 'flex-end' }[
          style.align
        ];
        layer.appendChild(stack);
        stacks[edge] = stack;
      }
      const box = document.createElement('div');
      box.className = 'subtitle-cue';
      box.dir = 'auto';
      const color = subtitleColors.find(([id]) => id === style.color)[2];
      const bg = subtitleBackgrounds.find(([id]) => id === style.bg)[2];
      const rgb = bg && [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16)).join(',');
      Object.assign(box.style, {
        fontSize: `${Math.max(13, height * subtitleSizes.find(([id]) => id === style.size)[2])}px`,
        color,
        textAlign: style.align,
        background: bg ? `rgba(${rgb},${style.bgOpacity})` : 'transparent',
        textShadow: bg && style.bgOpacity >= 0.5 ? 'none' : '0 0 4px #000, 0 2px 5px #000',
      });
      if (typeof content === 'string') box.textContent = content;
      else box.appendChild(content);
      stacks[edge].appendChild(box);
    }
    if (preview) add('Subtitles will look like this.');
    for (const cue of cues) {
      const top =
        cue.line !== 'auto' &&
        Number.isFinite(Number(cue.line)) &&
        (cue.snapToLines === false
          ? Number(cue.line) < 50
          : Number(cue.line) >= 0 && Number(cue.line) < 6);
      // The browser parses WebVTT markup; never insert remote cue text as HTML.
      add(
        cue.getCueAsHTML ? cue.getCueAsHTML() : String(cue.text).replace(/<[^>]*>/g, ''),
        top ? 'top' : 'bottom',
      );
    }
  }
  const renderer = {
    get style() {
      return style;
    },
    set(next) {
      style = subtitleStyle(next);
      try {
        localStorage.setItem('mw:substyle', JSON.stringify(style));
      } catch {}
      render();
    },
    reset() {
      this.set(subtitleDefaults);
    },
    preview(on) {
      preview = on;
      render();
    },
    attach(element) {
      this.detach();
      track = element;
      track.track.mode = 'hidden';
      track.track.addEventListener('cuechange', render);
      render();
    },
    detach() {
      track?.track.removeEventListener('cuechange', render);
      track = null;
      render();
    },
    render,
  };
  window.addEventListener('resize', render);
  document.addEventListener('fullscreenchange', render);
  video.addEventListener('loadedmetadata', render);
  video.addEventListener('resize', render);
  video.addEventListener('timeupdate', render);
  return renderer;
}
