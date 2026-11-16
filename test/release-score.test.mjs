import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceConflict,
  sourceOf,
  yearMismatch,
  streamResolution,
  assessStream,
  releaseTraits,
  scoreRelease,
  rankReleases,
  lockFrom,
  trustedGroup,
} from '../src/release-score.mjs';
import { assessQuality, defaultRules, createTorrentPolicy } from '../src/torrent-policy.mjs';
import { createStore } from '../src/store.mjs';

const GiB = 1073741824;
const release = (name, extra = {}) => ({
  hash: (extra.hash || 'a').repeat(40).slice(0, 40),
  fileIndex: null,
  label: `${name}\n👤 40 💾 4.0 GB`,
  filename: `${name}.mkv`,
  seeders: 40,
  sizeBytes: 4 * GiB,
  resolution: /2160p/.test(name) ? 2160 : 1080,
  ...extra,
});

test('a WEB-DL label does not hide a disc rip, remux or capture in the file name', () => {
  for (const name of [
    'Show.S01E01.1080p.BDMux.x264',
    'Show.S01E01.1080p.BluRay.x264',
    'Show.S01E01.1080p.WEBRip.x264',
    'Show.S01E01.1080p.REMUX',
    'Show.S01E01.1080p.HDRip',
  ])
    assert.match(
      sourceConflict({ label: 'Show S01E01 1080p WEB-DL', filename: `${name}.mkv` }),
      /not WEB-DL/,
      name,
    );
  assert.match(
    sourceConflict({ label: 'Show S01E01 1080p WEB-DL BDMux', filename: '' }),
    /Release is BDMux/,
  );
  assert.equal(
    sourceConflict({
      label: 'Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb\n👤 50 💾 3 GB ⚙️ ThePirateBay',
      filename: 'Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb.mkv',
    }),
    null,
  );
  assert.equal(sourceConflict({ label: 'Movie 2160p WEB-DL HDR DV' }), null);
});

test('stream assessment keeps every download rule except the fixed resolution per kind', () => {
  const tv4k = release('Show.S01E01.2160p.AMZN.WEB-DL.DDP5.1.HDR.H.265-FLUX', {
    sizeBytes: 9 * GiB,
  });
  // Downloads still pin episodes to 1080p and movies to 2160p.
  assert.equal(assessQuality(tv4k, 'tv').accepted, false);
  assert.equal(assessStream(tv4k, 'tv', defaultRules, 2160).accepted, true);
  assert.equal(assessStream(tv4k, 'tv', defaultRules, 1080).accepted, false);
  const movie1080 = release('Movie.2023.1080p.NF.WEB-DL.DDP5.1.H.264-FLUX', { sizeBytes: 8 * GiB });
  assert.equal(assessStream(movie1080, 'movie', defaultRules, 1080).accepted, true);
  // Other rules still apply.
  const fewSeeds = { ...movie1080, seeders: 2 };
  assert.match(assessStream(fewSeeds, 'movie', defaultRules, 1080).reasons.join(), /Fewer than 5/);
  const huge = { ...release('Show.S01E01.1080p.WEB-DL.H.264-X'), sizeBytes: 40 * GiB };
  assert.match(assessStream(huge, 'tv', defaultRules, 1080).reasons.join(), /file-size limit/);
  const cam = release('Movie.2023.1080p.WEB-DL.HDCAM');
  assert.match(assessStream(cam, 'movie', defaultRules, 1080).reasons.join(), /CAM/);
  const mux = release('Show.S01E01.1080p.WEB-DL.H.264-X', {
    filename: 'Show.S01E01.1080p.BDMux.mkv',
  });
  assert.match(
    assessStream(mux, 'tv', defaultRules, 1080).reasons.join(),
    /BDMux release, not WEB-DL/,
  );
});

test('traits read group, service, HDR, Dolby Vision, dubs and season packs', () => {
  const traits = releaseTraits(
    release('Show.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', {
      fileIndex: 3,
      label:
        'Show S01 2160p ATVP WEB-DL DV HDR H.265-FLUX\nShow.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv\n👤 9 💾 8 GB',
    }),
  );
  assert.equal(traits.group, 'FLUX');
  assert.equal(traits.service, 'ATVP');
  assert.equal(traits.hdr, true);
  assert.equal(traits.dolbyVision, true);
  assert.equal(traits.dolbyVisionOnly, false);
  assert.equal(traits.hevc, true);
  assert.equal(traits.seasonPack, true);
  assert.equal(releaseTraits(release('Шоу Show.S01E01.1080p.WEB-DL.H.264-X')).foreignDub, true);
  assert.equal(
    releaseTraits(release('Show.S01E01.1080p.WEB-DL.H.264.with ASL-X')).signLanguage,
    true,
  );
});

test('ranking prefers untouched service WEB-DLs and penalises re-encodes, dubs, upscales and DV-only', () => {
  const best = release('Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb', { hash: 'b' });
  const reencode = release('Show.S01E01.1080p.WEB-DL.x265.10bit-PSA', {
    hash: 'c',
    sizeBytes: 0.6 * GiB,
    seeders: 900,
  });
  const dub = release('Шоу.S01E01.1080p.WEB-DL.H.264-RUS', { hash: 'd', seeders: 300 });
  const upscale = release('Show.S01E01.1080p.WEB-DL.AI.Upscale.H.264-X', {
    hash: 'e',
    seeders: 300,
  });
  const ranked = rankReleases([reencode, dub, upscale, best], 'tv');
  assert.equal(ranked[0].release, best);
  assert(scoreRelease(reencode, 'tv').parts.some((p) => p.reason === 'Re-encoded video'));
  assert(
    scoreRelease(reencode, 'tv').parts.some(
      (p) => p.reason === 'Too small for an untouched WEB-DL',
    ),
  );
  const dvOnly = release('Movie.2160p.WEB-DL.DV.H.265-X', { sizeBytes: 20 * GiB });
  const hdr = release('Movie.2160p.WEB-DL.HDR.H.265-X', { sizeBytes: 20 * GiB, hash: 'f' });
  assert.equal(rankReleases([dvOnly, hdr], 'movie')[0].release, hdr);
});

test('the size floor follows the runtime when it is known', () => {
  const anime = release('Anime.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-SubsPlease', {
    sizeBytes: 1.4 * GiB,
  });
  assert(
    scoreRelease(anime, 'anime').parts.some(
      (p) => p.reason === 'Too small for an untouched WEB-DL',
    ),
  );
  assert(
    scoreRelease(anime, 'anime', null, { runtimeSeconds: 1440 }).parts.some(
      (p) => p.reason === 'Full-bitrate size',
    ),
  );
});

test('a season lock keeps later episodes on the same pack or group and service', () => {
  const ntb = release('Show.S01E02.1080p.NF.WEB-DL.DDP5.1.H.264-NTb', { hash: 'b', seeders: 20 });
  const flux = release('Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX', {
    hash: 'c',
    seeders: 400,
  });
  assert.equal(rankReleases([ntb, flux], 'tv')[0].release, flux);
  const lock = { hash: 'z'.repeat(40), group: 'NTB', service: 'NF' };
  assert.equal(rankReleases([ntb, flux], 'tv', lock)[0].release, ntb);
  const pack = { ...ntb, hash: 'p'.repeat(40) };
  const top = rankReleases([pack, flux], 'tv', { hash: pack.hash, group: null, service: null })[0];
  assert.equal(top.release, pack);
  assert.deepEqual(lockFrom(top), { hash: pack.hash, group: 'NTB', service: 'NF' });
  assert.equal(lockFrom(null), null);
});

test('streaming weighs swarm health more than downloads do', () => {
  const small = release('Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP', { hash: 'b', seeders: 6 });
  const healthy = release('Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-OTH', { hash: 'c', seeders: 200 });
  const download = scoreRelease(healthy, 'tv').score - scoreRelease(small, 'tv').score;
  const stream =
    scoreRelease(healthy, 'tv', null, { streaming: true }).score -
    scoreRelease(small, 'tv', null, { streaming: true }).score;
  assert(stream > download + 15);
  assert(
    scoreRelease(small, 'tv', null, { streaming: true }).parts.some(
      (p) => p.reason === 'Small swarm, slow start likely',
    ),
  );
  // Quality still outweighs the swarm: an untouched service release beats a re-encode.
  const service = release('Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb', {
    hash: 'd',
    seeders: 12,
  });
  const reencode = release('Show.S01E01.1080p.WEB-DL.x265-PSA', {
    hash: 'e',
    seeders: 2000,
    sizeBytes: GiB,
  });
  assert.equal(
    rankReleases([reencode, service], 'tv', null, { streaming: true })[0].release,
    service,
  );
});

test('movies may stream from a disc source; series stay WEB-DL and poor sources stay out', () => {
  const movie = (name, extra = {}) => ({
    hash: 'a'.repeat(40),
    label: `${name}\n👤 400 💾 12 GB`,
    filename: `${name}.mkv`,
    seeders: 400,
    sizeBytes: 12 * 1073741824,
    resolution: 1080,
    ...extra,
  });
  const accepted = (r, kind = 'movie', options) =>
    assessStream(r, kind, defaultRules, 1080, options).accepted;
  assert.equal(sourceOf(movie('Film.2026.1080p.BluRay.DDP5.1.x264-GRP')), 'disc');
  assert.equal(sourceOf(movie('Film.2026.1080p.UHD.BDRemux.HEVC-GRP')), 'remux');
  assert.equal(sourceOf(movie('Film.2026.1080p.AMZN.WEB-DL.H.264-GRP')), 'web-dl');
  assert.equal(sourceOf(movie('Film.2026.1080p.WEBRip.x264-GRP')), 'poor');
  assert.equal(accepted(movie('Film.2026.1080p.BluRay.DDP5.1.x264-GRP')), true);
  assert.equal(accepted(movie('Film.2026.1080p.UHD.BDRemux.HEVC-GRP')), true);
  assert.equal(accepted(movie('Film.2026.1080p.AMZN.WEB-DL.H.264-GRP')), true);
  assert.equal(accepted(movie('Film.2026.1080p.WEBRip.x264-GRP')), false);
  assert.equal(accepted(movie('Film.2026.1080p.BluRay.HDTV.x264-GRP')), false);
  assert.equal(accepted(movie('Film.2026.1080p.BluRay.HDCAM-GRP')), false);
  // The same disc release is still refused for an episode.
  assert.equal(accepted(movie('Show.S01E01.1080p.BluRay.x264-GRP'), 'tv'), false);
});

test('a movie labelled with another year is a different film', () => {
  const r = (name) => ({ label: `${name}\n👤 400 💾 12 GB`, filename: '' });
  assert.equal(yearMismatch(r('The Odyssey 2026 1080p BluRay x264-GRP'), '2026'), null);
  assert.equal(
    yearMismatch(r('The Odyssey 1997 1080p WEB-DL x264-GRP'), '2026'),
    'Labelled 1997, not 2026: a different film',
  );
  // One year either side covers festival and regional release dates.
  assert.equal(yearMismatch(r('The Odyssey 2025 2160p WEB-DL'), '2026'), null);
  // No year on the label, or a title that is itself a year, is not evidence.
  assert.equal(yearMismatch(r('The Odyssey 1080p BluRay x264-GRP'), '2026'), null);
  assert.equal(yearMismatch(r('2001 A Space Odyssey 1968 2160p UHD BluRay'), '1968'), null);
  assert.equal(yearMismatch(r('The Odyssey 2026 2160p'), ''), null);
  assert.equal(
    assessStream(
      {
        ...r('The Odyssey 1997 1080p AMZN WEB-DL H.264-GRP'),
        seeders: 400,
        sizeBytes: 9 * 1073741824,
        resolution: 1080,
      },
      'movie',
      defaultRules,
      1080,
      { year: '2026' },
    ).accepted,
    false,
  );
});

test('for a movie stream a full-size disc encode outranks an undersized WEB-DL, and other-language releases rank lower', () => {
  const GiB = 1073741824;
  const r = (name, seeders, gigabytes, hash) => ({
    hash,
    label: `${name}\n👤 ${seeders} 💾 ${gigabytes} GB`,
    filename: `${name}.mkv`,
    seeders,
    sizeBytes: gigabytes * GiB,
    resolution: 1080,
  });
  const ranked = rankReleases(
    [
      r('Film 2026 1080p AMZN WEB-DL DDP5 1 H 264-Small', 2295, 4.35, 'a'),
      r('Film.2026.BluRay.1080p.DDP.5.1.x264-Full', 489, 12.8, 'b'),
      r('Film.2026.iTA-ENG.Bluray.1080p.x264-Dub', 489, 12.8, 'c'),
      r('Film.2026.1080p.UHD.BluRay.REMUX.HEVC-Huge', 489, 60, 'd'),
    ],
    'movie',
    null,
    { runtimeSeconds: 173 * 60, streaming: true },
  ).map((e) => e.release.hash);
  assert.deepEqual(ranked, ['b', 'c', 'd', 'a']);
});

test('720p and SD accept any real source, and SD is read from the label when no resolution is given', () => {
  const r = (name, resolution = null) => ({
    hash: 'a'.repeat(40),
    label: `${name}\n👤 40 💾 300 MB`,
    filename: `${name}.mkv`,
    seeders: 40,
    sizeBytes: 300 * 1048576,
    resolution,
  });
  assert.equal(streamResolution(r('Show.S01E01.DVDRip.XviD-GRP')), 480);
  assert.equal(streamResolution(r('Show S01E01 (360p re-dvdrip)')), 480);
  assert.equal(streamResolution(r('Show.S01E01.720p.HDTV.x264-GRP', 720)), 720);
  // Nothing on the label says what it is: not guessed.
  assert.equal(streamResolution(r('Show.S01E01.x264-GRP')), null);
  const ok = (release, resolution, options) =>
    assessStream(release, 'tv', defaultRules, resolution, options).accepted;
  assert.equal(ok(r('Show.S01E01.DVDRip.XviD-GRP'), 480), true);
  assert.equal(ok(r('Show.S01E01.720p.HDTV.x264-GRP', 720), 720), true);
  assert.equal(ok(r('Show.S01E01.720p.BluRay.x264-GRP', 720), 720), true);
  // A cinema capture is refused at every quality.
  assert.equal(ok(r('Show.S01E01.720p.HDCAM.x264-GRP', 720), 720), false);
  // The lower sources are not let into 1080p, and a DVD rip is not a 720p release.
  assert.equal(ok(r('Show.S01E01.1080p.HDTV.x264-GRP', 1080), 1080), false);
  assert.equal(ok(r('Show.S01E01.DVDRip.XviD-GRP'), 720), false);
  assert.equal(ok(r('Show.S01E01.x264-GRP'), 480), false);
});

test('an episode keeps to WEB-DL at 1080p and accepts Blu-ray only when relaxed', () => {
  const disc = {
    hash: 'a'.repeat(40),
    label: 'Show.S02E01.1080p.BluRay.x264-GRP\n👤 40 💾 3 GB',
    filename: 'Show.S02E01.1080p.BluRay.x264-GRP.mkv',
    seeders: 40,
    sizeBytes: 3 * 1073741824,
    resolution: 1080,
  };
  assert.equal(assessStream(disc, 'tv', defaultRules, 1080).accepted, false);
  assert.equal(assessStream(disc, 'tv', defaultRules, 1080, { relaxed: true }).accepted, true);
  const rip = { ...disc, label: disc.label.replace('BluRay', 'WEBRip'), filename: '' };
  assert.equal(assessStream(rip, 'tv', defaultRules, 1080, { relaxed: true }).accepted, false);
});

test('a revival or remake labelled outside the years a series ran is a different series', () => {
  const r = (name) => ({ label: `${name}\n👤 40 💾 1 GB`, filename: '' });
  const original = { series: true, endYear: 2010 };
  assert.equal(yearMismatch(r('Scrubs S01E01 1080p DSNP WEB-DL'), '2001', original), null);
  assert.equal(yearMismatch(r('Scrubs 2001 S01E01 DVDRip'), '2001', original), null);
  assert.equal(yearMismatch(r('Scrubs 2005 S05E01 720p HDTV'), '2001', original), null);
  assert.match(
    yearMismatch(r('Scrubs 2026 S01E01 My Return 1080p DSNP WEB-DL'), '2001', original),
    /2026: a different series/,
  );
  // Still airing: later years cannot be ruled out, earlier ones can.
  assert.equal(yearMismatch(r('Show 2026 S09E01 1080p WEB-DL'), '2018', { series: true }), null);
  assert.match(yearMismatch(r('Show 1987 S01E01 DVDRip'), '2018', { series: true }), /1987/);
  // A pixel size is not a year.
  assert.equal(yearMismatch(r('Show S01E01 1920x1080 WEB-DL'), '2001', original), null);
});

test('trusted releases are recognised by their group, at the end or in brackets', () => {
  const groups = defaultRules.trustedGroups;
  const named = (name, filename = `${name}.mkv`) => ({ label: `${name}\n👤 50`, filename });
  assert.equal(trustedGroup(named('Show.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb'), groups), 'NTb');
  assert.equal(trustedGroup(named('Show.S01E01.1080p.WEB-DL.H.264-ntb'), groups), 'ntb');
  assert.equal(
    trustedGroup(named('[Erai-raws] Show - 01 [1080p][Multiple Subtitle]'), groups),
    'Erai-raws',
  );
  assert.equal(
    trustedGroup(named('[SubsPlease] Show - 01 (1080p) [ABCD1234]'), groups),
    'SubsPlease',
  );
  // The file inside decides as much as the label: a trusted label with a stranger's file
  // still counts, but an unknown group, or no group, does not.
  assert.equal(trustedGroup(named('Show.S01E01.1080p.WEB-DL.H.264-GRP'), groups), null);
  assert.equal(trustedGroup(named('Show S01E01 1080p WEB-DL'), groups), null);
  assert.equal(trustedGroup(named('Show.S01E01.1080p.WEB-DL.H.264-NTb'), []), null);
});

test('streaming filter rules are validated and saved with the other torrent rules', () => {
  const store = createStore(':memory:');
  const policy = createTorrentPolicy(store);
  assert.equal(policy.get().trustedOnly, true);
  assert.equal(policy.get().requireSubtitles, true);
  assert(policy.get().trustedGroups.includes('FLUX'));
  const saved = policy.set({ trustedOnly: false, trustedGroups: ['NTb', ' FLUX ', 'NTb'] });
  assert.equal(saved.trustedOnly, false);
  assert.deepEqual(saved.trustedGroups, ['NTb', 'FLUX']);
  assert.deepEqual(policy.get().trustedGroups, ['NTb', 'FLUX']);
  assert.throws(() => policy.set({ requireSubtitles: 'yes' }), /Invalid streaming filter/);
  assert.throws(() => policy.set({ trustedGroups: ['bad group!'] }), /Release groups/);
  store.close();
});
