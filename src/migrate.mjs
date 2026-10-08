import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { statSync } from 'node:fs';
import { createStore } from './store.mjs';

export function migrateLegacy(sourceFile, destinationFile) {
  if (path.resolve(sourceFile) === path.resolve(destinationFile))
    throw new Error('Source and destination must be different files');
  const source = new DatabaseSync(sourceFile, { readOnly: true }),
    target = createStore(destinationFile);
  try {
    if (target.one("SELECT name FROM migrations WHERE name='legacy-v1'"))
      return { alreadyMigrated: true };
    if (target.one('SELECT id FROM users LIMIT 1') || target.one('SELECT id FROM titles LIMIT 1'))
      throw new Error('Destination must be empty. Import before the first v2 startup.');
    const has = (table) =>
      !!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const records = has('library_records')
      ? source.prepare('SELECT type,json FROM library_records').all()
      : [];
    const rows = (type) => records.filter((r) => r.type === type).map((r) => JSON.parse(r.json));
    const users = has('users') ? source.prepare('SELECT * FROM users').all() : [];
    const itemIds = new Map(),
      titleIds = new Map(),
      report = { users: 0, titles: 0, items: 0, assets: 0, history: 0, skippedAssets: 0 };
    target.transaction(() => {
      for (const user of users) {
        target.run(
          'INSERT INTO users(id,email,name,pw_hash,role,active,can_download) VALUES(?,?,?,?,?,?,?)',
          user.id,
          user.email,
          user.name,
          user.pw_hash || '',
          user.role,
          user.active,
          0,
        );
        report.users++;
      }
      for (const title of rows('title')) {
        const saved = target.saveTitle({
          id: title.id,
          kind: title.kind,
          external_id: String(title.mediaId),
          name: title.title || String(title.mediaId),
          poster: title.cover || title.poster || '',
          description: title.description || title.overview || '',
          year: title.year || '',
          genres: title.genres || [],
        });
        titleIds.set(title.id, saved.id);
        report.titles++;
      }
      if (has('library_aliases'))
        for (const alias of source.prepare('SELECT * FROM library_aliases').all())
          if (titleIds.has(alias.title_id))
            target.run(
              'INSERT OR IGNORE INTO aliases VALUES(?,?,?)',
              alias.kind,
              String(alias.media_id),
              titleIds.get(alias.title_id),
            );
      for (const item of rows('item')) {
        if (!titleIds.has(item.titleId)) continue;
        const saved = target.saveItem({
          id: item.id,
          title_id: titleIds.get(item.titleId),
          season: item.season || 0,
          episode: Number(item.episode) || 0,
          name: item.title || '',
        });
        itemIds.set(item.id, saved.id);
        report.items++;
      }
      const libraries = new Map(rows('library').map((l) => [l.id, l])),
        policies = rows('policy');
      for (const asset of rows('asset')) {
        if (asset.state !== 'ready' || !itemIds.has(asset.itemId) || !asset.path) {
          report.skippedAssets++;
          continue;
        }
        const library = libraries.get(asset.libraryId);
        const readers = users
          .filter((u) => {
            const policy = policies.find(
              (p) => p.userId === u.id && p.libraryId === asset.libraryId,
            );
            return u.role === 'admin' || (policy ? policy.view : library?.public);
          })
          .map((u) => u.id);
        const legacyProbe = asset.probe;
        const metadata = legacyProbe
          ? {
              duration: legacyProbe.durationSec,
              video: legacyProbe.video?.codec || legacyProbe.video?.codec_name,
              width: legacyProbe.video?.width,
              height: legacyProbe.video?.height,
              audio: (legacyProbe.audio || []).map((t) => ({
                ...t,
                index: t.index ?? t.streamIndex,
                codec: t.codec || t.codec_name,
              })),
              subtitles: (legacyProbe.subtitles || []).map((t) => ({
                ...t,
                index: t.index ?? t.streamIndex,
                codec: t.codec || t.codec_name,
              })),
              chapters: [],
            }
          : undefined;
        target.addAsset({
          id: asset.id,
          item_id: itemIds.get(asset.itemId),
          path: asset.path,
          bytes: asset.bytes || 0,
          added_at: asset.created || asset.updated || Date.now(),
          readers,
          imported: !asset.managed,
          ...(metadata?.duration ? { probe: metadata } : {}),
        });
        report.assets++;
      }
      const importState = (user, item, position, duration, watched, updated) => {
        if (!users.some((u) => u.id === user)) return;
        const old = target.state(user, item);
        if (old.played_at > updated) return;
        target.run(
          'INSERT INTO history(user_id,item_id,position,duration,completed,ever_watched,played_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET position=excluded.position,duration=excluded.duration,completed=excluded.completed,ever_watched=excluded.ever_watched,played_at=excluded.played_at',
          user,
          item,
          position || 0,
          duration || 0,
          +!!watched,
          +!!watched,
          updated || 0,
        );
        report.history++;
      };
      for (const state of rows('state'))
        if (itemIds.has(state.itemId))
          importState(
            state.userId,
            itemIds.get(state.itemId),
            state.seconds,
            state.duration,
            state.watched,
            state.updated,
          );
      if (has('progress'))
        for (const p of source.prepare('SELECT * FROM progress').all()) {
          const kind = p.kind || 'anime',
            external = String(p.media_id ?? p.anilist_id);
          let title = target.unpack(
            target.one('SELECT * FROM titles WHERE kind=? AND external_id=?', kind, external),
          );
          if (!title)
            title = target.saveTitle({
              kind,
              external_id: external,
              name: p.title || external,
              poster: p.cover || '',
            });
          const item = target.saveItem({
            title_id: title.id,
            season: p.season || 0,
            episode: Number(p.episode) || 0,
          });
          if (
            !target.one(
              'SELECT item_id FROM history WHERE user_id=? AND item_id=?',
              p.user_id,
              item.id,
            )
          )
            importState(
              p.user_id,
              item.id,
              p.seconds,
              p.duration,
              p.duration > 0 && p.seconds / p.duration >= 0.95,
              p.updated,
            );
        }
      for (const user of users) {
        const states = target.all(
          'SELECT * FROM history WHERE user_id=? ORDER BY played_at',
          user.id,
        );
        for (const state of states) {
          const item = target.item(state.item_id);
          target.run(
            'INSERT INTO series_state(user_id,title_id,cursor) VALUES(?,?,?) ON CONFLICT(user_id,title_id) DO UPDATE SET cursor=excluded.cursor',
            user.id,
            item.title_id,
            item.id,
          );
        }
      }
      for (const tag of rows('tag'))
        if (titleIds.has(tag.titleId) && users.some((u) => u.id === tag.userId))
          target.run(
            'INSERT OR IGNORE INTO tags VALUES(?,?,?)',
            tag.userId,
            titleIds.get(tag.titleId),
            tag.tag,
          );
      for (const [table, tag] of [
        ['favorites', 'favorite'],
        ['watchlist', 'watchlist'],
      ])
        if (has(table))
          for (const r of source.prepare(`SELECT * FROM ${table}`).all()) {
            let title = target.unpack(
              target.one(
                "SELECT * FROM titles WHERE kind='anime' AND external_id=?",
                String(r.anilist_id),
              ),
            );
            if (!title)
              title = target.saveTitle({
                kind: 'anime',
                external_id: String(r.anilist_id),
                name: `Anime ${r.anilist_id}`,
              });
            target.run('INSERT OR IGNORE INTO tags VALUES(?,?,?)', r.user_id, title.id, tag);
          }
      for (const c of rows('collection')) {
        const items = c.titleIds.map((key) => titleIds.get(key)).filter(Boolean);
        target.run(
          'INSERT INTO collections VALUES(?,?,?,?)',
          c.id,
          c.userId,
          c.name,
          JSON.stringify({ items }),
        );
      }
      if (has('collections') && has('collection_items'))
        for (const c of source.prepare('SELECT * FROM collections').all()) {
          const key = `collection_legacy_${c.id}`;
          if (target.one('SELECT id FROM collections WHERE id=?', key)) continue;
          const items = source
            .prepare('SELECT anilist_id FROM collection_items WHERE collection_id=?')
            .all(c.id)
            .map((r) => {
              let title = target.unpack(
                target.one(
                  "SELECT * FROM titles WHERE kind='anime' AND external_id=?",
                  String(r.anilist_id),
                ),
              );
              if (!title)
                title = target.saveTitle({
                  kind: 'anime',
                  external_id: String(r.anilist_id),
                  name: `Anime ${r.anilist_id}`,
                });
              return title.id;
            });
          target.run(
            'INSERT INTO collections VALUES(?,?,?,?)',
            key,
            c.user_id,
            c.name,
            JSON.stringify({ items }),
          );
        }
      // Older v1 deployments predate library_records. Their cache labels only
      // identify movies and explicitly numbered TV episodes reliably. Never
      // guess an anime episode from the latest title-level progress record.
      if (has('cache_files')) {
        report.cacheAssets = 0;
        report.unmappedCache = 0;
        const normalize = (name) =>
          String(name || '')
            .normalize('NFKC')
            .trim()
            .toLowerCase();
        for (const cached of source.prepare('SELECT * FROM cache_files').all()) {
          if (
            cached.state !== 'complete' ||
            target.one('SELECT id FROM assets WHERE path=?', cached.path)
          )
            continue;
          const episode = /^(.*?)\s*·\s*S(\d+)\s*E(\d+)\s*$/i.exec(cached.title || '');
          const kind = episode ? 'tv' : 'movie';
          const name = normalize(episode ? episode[1] : cached.title);
          const matches = target
            .all('SELECT * FROM titles WHERE kind=?', kind)
            .filter((title) => normalize(title.name) === name);
          let file;
          try {
            file = statSync(cached.path);
          } catch {}
          if (
            matches.length !== 1 ||
            !file?.isFile() ||
            !file.size ||
            (cached.total > 0 && file.size !== cached.total)
          ) {
            report.unmappedCache++;
            continue;
          }
          const item = target.saveItem({
            title_id: matches[0].id,
            season: episode ? Number(episode[2]) : 0,
            episode: episode ? Number(episode[3]) : 0,
          });
          // Link the original file in place and protect it from v2 cleanup.
          // Legacy cache playback was shared by authenticated users.
          target.addAsset({
            item_id: item.id,
            path: cached.path,
            bytes: file.size,
            added_at: cached.created,
            imported: true,
            readers: users.map((user) => user.id),
          });
          report.assets++;
          report.cacheAssets++;
        }
      }
      target.run('INSERT INTO migrations VALUES(?,?)', 'legacy-v1', Date.now());
    });
    return report;
  } finally {
    source.close();
    target.close();
  }
}
