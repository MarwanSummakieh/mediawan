// Watch rooms contain catalog references and a shared clock, never stream URLs.
// The invite code grants admission. After joining, a separate per-device secret,
// bound to the signed-in account, is required to read or control the room.
import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const WATCH_CODE_LENGTH = 8;
export const WATCH_MEMBER_TIMEOUT_MS = 30_000;
const MAX_POSITION = 7 * 24 * 60 * 60;

export class WatchTogetherError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WatchTogetherError';
    this.status = status;
  }
}

const fail = (status, message) => { throw new WatchTogetherError(status, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

export function normalizeWatchCode(raw) {
  if (typeof raw !== 'string' || raw.length > 40) fail(400, 'Enter a valid room code.');
  const code = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== WATCH_CODE_LENGTH || [...code].some(char => !CODE_ALPHABET.includes(char))) {
    fail(400, 'Enter a valid room code.');
  }
  return code;
}

export function validateWatchMedia(value) {
  if (!record(value) || !onlyKeys(value, ['kind', 'id', 'episode', 'season', 'mode', 'title'])) {
    fail(400, 'Choose a valid title to watch together.');
  }
  if (!['anime', 'movie', 'tv'].includes(value.kind) || typeof value.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) ||
      (value.kind === 'anime' && !/^\d{1,20}$/.test(value.id)) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 240 ||
      /[\u0000-\u001f\u007f]/.test(value.title)) {
    fail(400, 'Choose a valid title to watch together.');
  }
  const media = { kind: value.kind, id: value.id, title: value.title.trim() };
  if (value.kind === 'movie' && ['episode', 'season', 'mode'].some(key => Object.hasOwn(value, key))) {
    fail(400, 'Choose a film without episode or language-mode fields.');
  }
  if (value.kind === 'anime' && Object.hasOwn(value, 'season')) {
    fail(400, 'Choose the anime season as its own catalog title.');
  }
  if (value.kind === 'tv' && Object.hasOwn(value, 'mode')) {
    fail(400, 'Sub or dub mode is only available for anime.');
  }
  if (value.kind !== 'movie' && value.episode === undefined) {
    fail(400, 'Choose a valid episode.');
  }
  if (value.kind === 'tv' && value.season === undefined) {
    fail(400, 'Choose a valid season.');
  }
  if (value.episode !== undefined) {
    if (typeof value.episode !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(value.episode)) {
      fail(400, 'Choose a valid episode.');
    }
    if (value.kind === 'tv' && (!/^\d{1,5}$/.test(value.episode) || Number(value.episode) < 1)) {
      fail(400, 'Choose a valid series episode number.');
    }
    media.episode = value.episode;
  }
  if (value.season !== undefined) {
    if (!Number.isInteger(value.season) || value.season < 0 || value.season > 1_000) {
      fail(400, 'Choose a valid season.');
    }
    media.season = value.season;
  }
  if (value.mode !== undefined) {
    if (!['sub', 'dub'].includes(value.mode)) fail(400, 'Choose sub or dub.');
    media.mode = value.mode;
  }
  return media;
}

export function validateWatchState(value) {
  if (!record(value) || !onlyKeys(value, ['position', 'paused', 'rate']) ||
      typeof value.position !== 'number' || !Number.isFinite(value.position) ||
      value.position < 0 || value.position > MAX_POSITION ||
      typeof value.paused !== 'boolean' || typeof value.rate !== 'number' ||
      !Number.isFinite(value.rate) || value.rate < 0.25 || value.rate > 2) {
    fail(400, 'Playback position, pause state and speed must be valid.');
  }
  return { position: value.position, paused: value.paused, rate: value.rate };
}

function account(user) {
  if (!user || !['number', 'string'].includes(typeof user.id) ||
      (typeof user.id === 'number' && !Number.isSafeInteger(user.id)) ||
      !String(user.id) || String(user.id).length > 128) {
    fail(401, 'Sign in to watch together.');
  }
  const name = typeof user.name === 'string'
    ? user.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
    : '';
  return { id: String(user.id), name: name || 'Viewer' };
}

function randomCode() {
  return Array.from({ length: WATCH_CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

// Factories keep tests and independently mounted apps isolated. All limits are
// enforced before insertion; cleanup also runs on every room operation.
export function createWatchTogetherStore({
  now = Date.now,
  memberTimeoutMs = WATCH_MEMBER_TIMEOUT_MS,
  maxRoomAgeMs = 12 * 60 * 60 * 1_000,
  maxRooms = 100,
  maxMembersPerRoom = 12,
  maxMembershipsPerUser = 12,
} = {}) {
  const rooms = new Map();

  function freezeAndTransfer(room, timestamp) {
    room.hostId = room.members.values().next().value.id;
    const elapsed = room.state.paused ? 0 : Math.max(0, timestamp - room.state.updatedAt) / 1_000 * room.state.rate;
    room.state = {
      ...room.state,
      position: Math.min(MAX_POSITION, room.state.position + elapsed),
      paused: true,
      updatedAt: timestamp,
      revision: room.state.revision + 1,
    };
  }

  function sweep(timestamp = now()) {
    for (const [code, room] of rooms) {
      if (timestamp - room.createdAt >= maxRoomAgeMs) {
        rooms.delete(code);
        continue;
      }
      for (const [token, member] of room.members) {
        if (timestamp - member.lastSeen >= memberTimeoutMs) room.members.delete(token);
      }
      if (!room.members.size) rooms.delete(code);
      else if (![...room.members.values()].some(member => member.id === room.hostId)) {
        freezeAndTransfer(room, timestamp);
      }
    }
  }

  function snapshot(room, timestamp) {
    return {
      code: room.code,
      hostId: room.hostId,
      members: [...room.members.values()].map(member => ({ id: member.id, name: member.name })),
      media: { ...room.media },
      state: { ...room.state },
      serverTime: timestamp,
    };
  }

  function findRoom(rawCode, timestamp) {
    const code = normalizeWatchCode(rawCode);
    sweep(timestamp);
    const room = rooms.get(code);
    if (!room) fail(404, 'This watch room has ended.');
    return room;
  }

  function authorized(room, token, user) {
    const identity = account(user);
    const member = typeof token === 'string' && token.length === 64 ? room.members.get(token) : null;
    if (!member || member.userId !== identity.id) fail(403, 'Join this room before watching together.');
    return member;
  }

  function addMember(room, identity, timestamp) {
    if (room.members.size >= maxMembersPerRoom) fail(409, 'This watch room is full.');
    let memberships = 0;
    for (const current of rooms.values()) {
      for (const member of current.members.values()) if (member.userId === identity.id) memberships++;
    }
    if (memberships >= maxMembershipsPerUser) fail(429, 'Leave another watch room before joining a new one.');
    const member = {
      id: crypto.randomBytes(12).toString('base64url'),
      token: crypto.randomBytes(32).toString('hex'),
      userId: identity.id,
      name: identity.name,
      lastSeen: timestamp,
    };
    room.members.set(member.token, member);
    return member;
  }

  function credentials(room, member, timestamp) {
    return { room: snapshot(room, timestamp), memberId: member.id, memberToken: member.token };
  }

  return {
    create(user, mediaInput, stateInput) {
      const identity = account(user);
      const media = validateWatchMedia(mediaInput);
      const state = validateWatchState(stateInput);
      const timestamp = now();
      sweep(timestamp);
      if (rooms.size >= maxRooms) fail(503, 'All watch rooms are busy. Try again shortly.');
      let code;
      do { code = randomCode(); } while (rooms.has(code));
      const room = {
        code, createdAt: timestamp, hostId: null, members: new Map(), media,
        state: { ...state, updatedAt: timestamp, revision: 1 },
      };
      const member = addMember(room, identity, timestamp);
      room.hostId = member.id;
      rooms.set(code, room);
      return credentials(room, member, timestamp);
    },

    join(rawCode, user) {
      const identity = account(user);
      const timestamp = now();
      const room = findRoom(rawCode, timestamp);
      const member = addMember(room, identity, timestamp);
      return credentials(room, member, timestamp);
    },

    read(rawCode, token, user) {
      const timestamp = now();
      const room = findRoom(rawCode, timestamp);
      const member = authorized(room, token, user);
      member.lastSeen = timestamp;
      return { room: snapshot(room, timestamp) };
    },

    update(rawCode, token, user, stateInput, mediaInput) {
      const timestamp = now();
      const room = findRoom(rawCode, timestamp);
      const member = authorized(room, token, user);
      if (member.id !== room.hostId) fail(403, 'Only the host can control playback.');
      const state = validateWatchState(stateInput);
      const media = mediaInput === undefined ? room.media : validateWatchMedia(mediaInput);
      // Validate the entire change before replacing either media or state.
      room.media = media;
      room.state = { ...state, updatedAt: timestamp, revision: room.state.revision + 1 };
      member.lastSeen = timestamp;
      return { room: snapshot(room, timestamp) };
    },

    leave(rawCode, token, user) {
      const timestamp = now();
      const room = findRoom(rawCode, timestamp);
      const member = authorized(room, token, user);
      room.members.delete(member.token);
      if (!room.members.size) rooms.delete(room.code);
      else if (member.id === room.hostId) freezeAndTransfer(room, timestamp);
      return { ok: true };
    },

    sweep,
    get size() { sweep(); return rooms.size; },
  };
}
