import { createHash } from 'node:crypto';
import { competitionList, channelKey } from './catalog.mjs';
import { channelSchedule } from './guide.mjs';
import { fail } from '../store.mjs';

const competitions = new Map(competitionList().map((c) => [c.id, c]));
const dateFormatters = new Map();
export const SPORTS = [
  'Football',
  'American football',
  'Ice hockey',
  'Basketball',
  'Motorsport',
  'Tennis',
  'Rugby',
  'Combat sports',
  'Cricket',
  'Golf',
  'Other',
];
export function localDate(time, timezone) {
  if (!dateFormatters.has(timezone)) {
    if (dateFormatters.size >= 20) dateFormatters.delete(dateFormatters.keys().next().value);
    dateFormatters.set(
      timezone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    );
  }
  const parts = dateFormatters.get(timezone).formatToParts(time);
  const get = (key) => parts.find((p) => p.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function validateDay(date, timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    fail(400, 'Choose a valid time zone');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    fail(400, 'Choose a valid date');
}
function sportFor(p, channel) {
  const found = (p.competitions || []).map((id) => competitions.get(id)).find(Boolean);
  if (found) return found.sport;
  const text = `${p.title} ${(p.categories || []).join(' ')} ${channel.group}`;
  return (
    [...SPORTS]
      .sort((a, b) => b.length - a.length)
      .find((s) => s !== 'Other' && new RegExp(`\\b${s}\\b`, 'i').test(text)) ||
    (/soccer/i.test(text) ? 'Football' : /hockey/i.test(text) ? 'Ice hockey' : 'Other')
  );
}
function channelView(c) {
  return { id: c.id, name: c.name, language: c.language, quality: c.quality };
}
export function dailyEvents(
  channels,
  matches,
  manual,
  { date, timezone = 'UTC', now = Date.now() },
) {
  validateDay(date, timezone);
  const events = new Map(),
    byId = new Map(channels.map((c) => [c.id, c]));
  const add = (event) => {
    // A programme that crosses midnight is visible on both local dates.
    if (localDate(event.start, timezone) > date || localDate(event.end - 1, timezone) < date)
      return;
    event.status = event.end <= now ? 'finished' : event.start <= now ? 'live' : 'upcoming';
    events.set(event.id, event);
  };
  for (const c of channels) {
    const slots = matches.get(c.id)?.programmes || [];
    // channelSchedule suppresses all-day repeated channel-name placeholders.
    const cleaned = channelSchedule(
      c,
      { ...matches.get(c.id), programmes: slots },
      -Infinity,
      slots.length,
    );
    for (const p of cleaned.programmes) {
      if (p.generic || p.replay) continue;
      const sport = sportFor(p, c);
      if (
        sport === 'Other' &&
        !p.competitions?.length &&
        !/sport|match|football|soccer|hockey|basketball|tennis|rugby|cricket|golf|motorsport|boxing|ufc|racing/i.test(
          `${p.title} ${(p.categories || []).join(' ')} ${c.group}`,
        )
      )
        continue;
      // A guide title alone is not evidence of a fixture: skip news and studio shows.
      if (/\b(news|highlights|magazine|preview|review|sportscenter|sports centre)\b/i.test(p.title))
        continue;
      const key = createHash('sha256')
        .update(`${channelKey(p.title)}:${p.start}`)
        .digest('hex')
        .slice(0, 24);
      const existing = events.get(key);
      if (existing) {
        if (!existing.channels.some((x) => x.id === c.id)) existing.channels.push(channelView(c));
        continue;
      }
      add({
        id: key,
        title: p.title,
        subtitle: p.subtitle || '',
        sport,
        competition: (p.competitions || [])
          .map((id) => competitions.get(id)?.name)
          .filter(Boolean)
          .join(' / '),
        start: p.start,
        end: p.end,
        source: 'guide',
        channels: [channelView(c)],
      });
    }
  }
  for (const event of manual)
    add({
      ...event,
      source: 'manual',
      channels: event.channelIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(channelView),
    });
  return [...events.values()].sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}
export function validateEvent(input, channels) {
  const title = String(input.title || '').trim(),
    competition = String(input.competition || '').trim();
  const start = Date.parse(input.start),
    end = Date.parse(input.end);
  if (!title || title.length > 180 || competition.length > 100 || !SPORTS.includes(input.sport))
    fail(400, 'Enter an event name and sport');
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 2 * 86400000
  )
    fail(400, 'Choose an end time after the start, within two days');
  if (
    !Array.isArray(input.channelIds) ||
    input.channelIds.length > 30 ||
    input.channelIds.some((id) => !channels.some((c) => c.id === id))
  )
    fail(400, 'Choose channels from the current playlist');
  return {
    title,
    competition,
    sport: input.sport,
    start,
    end,
    channelIds: [...new Set(input.channelIds)],
  };
}
