import sax from 'sax';
import { channelKey, competitionIds } from './catalog.mjs';

export function xmltvTime(value) {
  const m = String(value || '').match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(Z|[+-]\d{4})?$/,
  );
  if (!m) return null;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const date = new Date(base);
  if (
    date.getUTCMonth() !== +m[2] - 1 ||
    date.getUTCDate() !== +m[3] ||
    +m[4] > 23 ||
    +m[5] > 59 ||
    +(m[6] || 0) > 59
  )
    return null;
  const z = m[7] || '+0000';
  const offset = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3, 5));
  return base - offset * 60000;
}
export function parseXmltv(xml, { now = Date.now() } = {}) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 120 * 1024 * 1024)
    throw Error('Programme guide exceeds the 120 MB limit.');
  if (/<!ENTITY/i.test(xml)) throw Error('Custom XML entities are not supported.');
  const channels = [],
    programmes = [];
  let channel = null,
    programme = null,
    field = null,
    buf = '';
  const p = sax.parser(true, { trim: false, normalize: false, strictEntities: true });
  p.onopentag = ({ name, attributes: a }) => {
    if (name === 'channel') channel = { id: a.id, names: [] };
    if (name === 'programme')
      programme = {
        channel: a.channel,
        start: xmltvTime(a.start),
        end: xmltvTime(a.stop),
        title: '',
        description: '',
        categories: [],
      };
    if (['display-name', 'title', 'desc', 'sub-title', 'category'].includes(name)) {
      field = name;
      buf = '';
    }
  };
  const text = (t) => {
    if (field && buf.length < 12000) buf += t.slice(0, 12000 - buf.length);
  };
  p.ontext = text;
  p.oncdata = text;
  p.onclosetag = (name) => {
    if (name === field) {
      const value = buf.trim();
      if (channel && name === 'display-name') channel.names.push(value);
      if (programme) {
        if (name === 'title' && !programme.title) programme.title = value;
        if (name === 'desc') programme.description = value;
        if (name === 'sub-title') programme.subtitle = value;
        if (name === 'category') programme.categories.push(value);
      }
      field = null;
      buf = '';
    }
    if (name === 'channel' && channel) {
      channels.push(channel);
      channel = null;
    }
    if (name === 'programme' && programme) {
      if (
        programme.start != null &&
        programme.end > programme.start &&
        programme.end > now - 2 * 86400000 &&
        programme.start < now + 8 * 86400000 &&
        programme.title
      ) {
        programme.competitions = competitionIds(
          `${programme.title} ${programme.subtitle || ''} ${programme.description} ${programme.categories.join(' ')}`,
        );
        programme.eventLive = /\blive\b|\ben directo\b|مباشر/i.test(
          `${programme.title} ${programme.subtitle || ''}`,
        );
        programme.replay = /\breplay\b|\bhighlights\b|\brepeat\b|إعادة|ملخص/i.test(programme.title);
        programmes.push(programme);
      }
      programme = null;
    }
    if (channels.length > 50000 || programmes.length > 400000)
      throw Error('Programme guide contains too many entries.');
  };
  try {
    p.write(xml).close();
  } catch {
    throw Error('The programme guide is not valid XMLTV.');
  }
  return { channels, programmes };
}

export function matchGuide(channels, guide) {
  const ids = new Set(guide.channels.map((c) => c.id));
  const byName = new Map();
  for (const c of guide.channels)
    for (const name of c.names) {
      const key = channelKey(name);
      if (!byName.has(key)) byName.set(key, new Set());
      byName.get(key).add(c.id);
    }
  const programmes = new Map();
  for (const p of guide.programmes) {
    if (!programmes.has(p.channel)) programmes.set(p.channel, []);
    programmes.get(p.channel).push(p);
  }
  const result = new Map();
  for (const c of channels) {
    let id =
      c.guideOverride ||
      (c.epgId && ids.has(c.epgId) ? c.epgId : null) ||
      (c.streamId && ids.has(c.streamId) ? c.streamId : null);
    let method = c.guideOverride ? 'manual' : id ? 'id' : null;
    if (!id) {
      const matches = byName.get(channelKey(c.name));
      if (matches?.size === 1) {
        id = [...matches][0];
        method = 'name';
      }
    }
    result.set(c.id, {
      guideId: id || null,
      method,
      programmes: [...(programmes.get(id) || [])].sort((a, b) => a.start - b.start),
    });
  }
  return result;
}

export function channelSchedule(channel, match, now = Date.now(), limit = 160) {
  const slots = match?.programmes || [];
  const repeatedPlaceholder =
    slots.length >= 6 &&
    new Set(slots.map((p) => channelKey(p.title))).size === 1 &&
    slots.every((p) => !p.description || channelKey(p.description) === channelKey(p.title));
  // A provider sometimes repeats the channel's name all day. Preserve that
  // listing, but never manufacture a match, competition, or live-event claim.
  const clean = (p) =>
    p && {
      ...p,
      generic: repeatedPlaceholder || channelKey(p.title) === channelKey(channel.name),
      competitions: p.competitions.length ? p.competitions : channel.competitions,
    };
  return {
    now: clean(slots.find((p) => p.start <= now && p.end > now)) || null,
    next: clean(slots.find((p) => p.start > now)) || null,
    programmes: slots
      .filter((p) => p.end > now)
      .slice(0, limit)
      .map(clean),
    guideId: match?.guideId || null,
    guideMatch: match?.method || null,
  };
}
