import { id, fail } from './store.mjs';
export function createQueues(store, random = Math.random) {
  function get(user, key) {
    const queue = store.unpack(
      store.one('SELECT * FROM queues WHERE id=? AND user_id=?', key, user.id),
    );
    if (!queue) fail(404, 'Queue not found');
    return queue;
  }
  function save(queue) {
    store.run(
      'INSERT INTO queues VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated=excluded.updated,json=excluded.json',
      queue.id,
      queue.user_id,
      queue.revision,
      Date.now(),
      JSON.stringify(queue),
    );
    return queue;
  }
  return {
    get,
    fork(user, key) {
      const queue = get(user, key);
      return save({ ...queue, id: id(), revision: 1 });
    },
    list(user) {
      return store
        .all('SELECT * FROM queues WHERE user_id=? ORDER BY updated DESC LIMIT 20', user.id)
        .map(store.unpack);
    },
    create(
      user,
      { titleId, season, mode = 'sequential', unwatched = false, startItem, items: supplied },
    ) {
      if (!['sequential', 'shuffle'].includes(mode)) fail(400, 'Invalid queue mode');
      if (
        supplied != null &&
        (!Array.isArray(supplied) ||
          supplied.some((i) => typeof i !== 'string') ||
          new Set(supplied).size !== supplied.length)
      )
        fail(400, 'Invalid queue items');
      let items = supplied
        ? supplied.map((i) => store.item(i)).filter(Boolean)
        : store
            .items(titleId)
            .filter((i) =>
              season == null
                ? i.season > 0 || store.title(i.title_id).kind !== 'tv'
                : i.season === Number(season),
            );
      if (mode === 'shuffle')
        items = items.filter(
          (i) =>
            store.available(user, i.id) && (!unwatched || !store.state(user.id, i.id).completed),
        );
      else items = items.filter((i) => store.canReadItem(user, i.id));
      if (!items.length || items.length > 5000)
        fail(400, 'No eligible episodes, or queue is too large');
      if (mode === 'shuffle')
        for (let n = items.length - 1; n > 0; n--) {
          const j = Math.floor(random() * (n + 1));
          [items[n], items[j]] = [items[j], items[n]];
        }
      const index = startItem ? items.findIndex((i) => i.id === startItem) : 0;
      if (index < 0) fail(400, 'Starting item is not in this queue');
      return save({
        id: id(),
        user_id: user.id,
        revision: 1,
        name: store.title(items[0].title_id).name,
        mode,
        items: items.map((i) => i.id),
        index,
      });
    },
    edit(user, key, patch) {
      const queue = get(user, key);
      if (patch.revision !== queue.revision) fail(409, 'Queue changed. Refresh and try again.');
      let items = [...queue.items],
        index = queue.index;
      if (patch.items != null) {
        if (
          !Array.isArray(patch.items) ||
          patch.items.length > 5000 ||
          new Set(patch.items).size !== patch.items.length ||
          patch.items.some((i) => typeof i !== 'string' || !store.canReadItem(user, i))
        )
          fail(400, 'Invalid queue items');
        items = patch.items;
        index = Math.max(0, items.indexOf(queue.items[queue.index]));
      }
      if (patch.index != null) {
        if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index >= items.length)
          fail(400, 'End of queue');
        index = patch.index;
      }
      return save({ ...queue, items, index, revision: queue.revision + 1 });
    },
  };
}
