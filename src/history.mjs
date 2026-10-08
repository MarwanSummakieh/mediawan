import { id, fail, finite } from './store.mjs';
export function createHistory(store) {
  return {
    start(user, itemId, { replay = false, mode = 'sequential' } = {}) {
      if (!store.available(user, itemId)) fail(404, 'Media is not downloaded or accessible');
      const item = store.item(itemId),
        prior = store.state(user.id, itemId),
        sessionId = id();
      const position = replay || prior.completed ? 0 : prior.position;
      store.transaction(() => {
        store.run(
          'INSERT INTO playback(id,user_id,item_id,mode,started,touched) VALUES(?,?,?,?,?,?)',
          sessionId,
          user.id,
          itemId,
          mode,
          Date.now(),
          Date.now(),
        );
        store.run(
          `INSERT INTO history(user_id,item_id,session_id,position,duration,completed,ever_watched,played_at) VALUES(?,?,?,?,?,0,?,?)
          ON CONFLICT(user_id,item_id) DO UPDATE SET session_id=excluded.session_id,position=excluded.position,completed=0,played_at=excluded.played_at`,
          user.id,
          itemId,
          sessionId,
          position,
          prior.duration,
          prior.ever_watched,
          Date.now(),
        );
        store.run(
          'INSERT INTO series_state(user_id,title_id,hidden) VALUES(?,?,0) ON CONFLICT(user_id,title_id) DO UPDATE SET hidden=0',
          user.id,
          item.title_id,
        );
        if (mode === 'sequential')
          store.run(
            'UPDATE series_state SET cursor=? WHERE user_id=? AND title_id=?',
            itemId,
            user.id,
            item.title_id,
          );
      });
      return { id: sessionId, position, itemId };
    },
    event(user, sessionId, event) {
      const session = store.one(
        'SELECT * FROM playback WHERE id=? AND user_id=?',
        sessionId,
        user.id,
      );
      if (!session || !store.canReadItem(user, session.item_id))
        fail(404, 'Playback session not found');
      if (
        !Number.isSafeInteger(event.seq) ||
        event.seq < 0 ||
        !finite(event.position, 0, 604800) ||
        !finite(event.duration, 0, 604800) ||
        !['progress', 'pause', 'seek', 'ended', 'stop'].includes(event.type)
      )
        fail(400, 'Invalid playback event');
      if (event.seq <= session.seq) return { ignored: true };
      const prior = store.state(user.id, session.item_id);
      const duration = event.duration || prior.duration,
        position = duration ? Math.min(duration, event.position) : event.position;
      const completed = duration > 0 && (position / duration >= 0.95 || event.type === 'ended');
      store.transaction(() => {
        store.run(
          'UPDATE playback SET seq=?,position=?,touched=?,stopped=? WHERE id=?',
          event.seq,
          position,
          Date.now(),
          +['stop', 'ended'].includes(event.type),
          sessionId,
        );
        store.run(
          'UPDATE history SET position=?,duration=?,completed=?,ever_watched=MAX(ever_watched,?),played_at=? WHERE user_id=? AND item_id=? AND session_id=?',
          position,
          duration,
          completed ? 1 : 0,
          completed ? 1 : 0,
          Date.now(),
          user.id,
          session.item_id,
          sessionId,
        );
      });
      return { ignored: prior.session_id !== sessionId, completed };
    },
    watched(user, itemIds, watched) {
      if (
        !Array.isArray(itemIds) ||
        !itemIds.length ||
        itemIds.length > 1000 ||
        typeof watched !== 'boolean'
      )
        fail(400, 'Select up to 1,000 episodes');
      if (itemIds.some((item) => typeof item !== 'string' || !store.canReadItem(user, item)))
        fail(404, 'Media is unavailable');
      const previous = itemIds.map((item) => ({ itemId: item, state: store.state(user.id, item) }));
      store.transaction(() => {
        for (const item of itemIds)
          store.run(
            `INSERT INTO history(user_id,item_id,completed,ever_watched) VALUES(?,?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET session_id=NULL,position=0,completed=excluded.completed,ever_watched=excluded.ever_watched`,
            user.id,
            item,
            +watched,
            +watched,
          );
      });
      const undoToken = id();
      store.run(
        'INSERT INTO undo VALUES(?,?,?,?)',
        undoToken,
        user.id,
        Date.now() + 60000,
        JSON.stringify(previous),
      );
      return { undoToken };
    },
    undo(user, token) {
      const change = store.one(
        'SELECT * FROM undo WHERE id=? AND user_id=? AND expires>?',
        token,
        user.id,
        Date.now(),
      );
      if (!change) fail(410, 'Undo has expired');
      const previous = JSON.parse(change.json);
      if (previous.some((p) => !store.canReadItem(user, p.itemId)))
        fail(403, 'Media access changed');
      store.transaction(() => {
        for (const p of previous) {
          const current = store.state(user.id, p.itemId);
          if (current.session_id) fail(409, 'Playback has started since this change');
          store.run(
            'UPDATE history SET position=?,duration=?,completed=?,ever_watched=?,played_at=? WHERE user_id=? AND item_id=?',
            p.state.position,
            p.state.duration,
            p.state.completed,
            p.state.ever_watched,
            p.state.played_at,
            user.id,
            p.itemId,
          );
        }
        store.run('DELETE FROM undo WHERE id=?', token);
      });
      return { ok: true };
    },
    dismiss(user, titleId, hidden) {
      if (!store.title(titleId) || typeof hidden !== 'boolean') fail(400, 'Invalid title');
      store.run(
        'INSERT INTO series_state(user_id,title_id,hidden) VALUES(?,?,?) ON CONFLICT(user_id,title_id) DO UPDATE SET hidden=excluded.hidden',
        user.id,
        titleId,
        +hidden,
      );
    },
  };
}
