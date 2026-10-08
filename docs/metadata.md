# Catalog metadata and runtimes

Title details refresh from the catalog when first opened, then at most once per day. **Cast & details → Refresh metadata** forces a new lookup. Discovery saves the richer record immediately. A failed automatic refresh keeps the saved library usable and backs off for five minutes; a failed manual refresh reports the error. Existing item IDs, watch progress, and files survive refreshes. Empty provider fields do not erase saved metadata.

Movies and IMDb series use [Cinemeta's Stremio metadata](https://stremio.github.io/stremio-addon-sdk/api/responses/meta.html): synopsis, artwork, genres, release date, cast, directors, writers, IMDb rating, country, language, awards, trailers and runtime where provided. Series additionally use [TVmaze](https://www.tvmaze.com/api) for numbered episode summaries, images, air dates and runtimes, plus network and show status. The details page attributes TVmaze and its CC BY-SA license. Numeric anime identities use AniList's title details and typical episode duration.

Duration is stored in seconds. The displayed runtime prefers the selected, accessible local file's FFprobe duration, then an episode-specific catalog runtime. A show's typical duration is a fallback explicitly labelled **Estimated** on episodes. Missing duration is labelled **Runtime unavailable**. Local file details include resolution, codec, size, audio and subtitle languages without exposing filesystem paths or private copies.

Provider coverage varies; a typical anime/show runtime is not the measured length of every episode. Catalog runtimes can also differ from a downloaded edition. FFprobe metadata is saved on download/import and when older files are first probed for playback.

Validation: 28 automated tests passed, including unit normalization, refresh preservation, offline fallback and private-file isolation. A live Cinemeta/TVmaze series lookup verified different per-episode runtimes in an isolated in-memory library. The local movie page was checked for measured duration, expanded cast details and manual refresh.
