// YouTube plugin for Couchmate.
// - "YouTube" in the app menu: rows of videos from topics, channels and playlists chosen in the settings.
// - Search finds videos, channels (each opens a page with its videos) and playlists (played in order).
// - Videos play in sync for everyone, in up to 1080p (video and audio are separate files on YouTube –
//   the apps play them together) or as audio only. No ads: the server fetches the video itself.
// - SponsorBlock: sponsor segments inside videos are skipped for everyone (community database).
//
// The server uses yt-dlp (downloaded and kept up to date by the plugin) to find the videos' files and passes
// them on to the apps – YouTube only hands them out with the right headers, and the addresses belong to the
// server's IP address.

import { Readable } from 'node:stream';
import { createYtdlp } from './ytdlp.mjs';

const LOGO = 'M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.2 3.6z';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const CHANNEL_ID = /^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9_.-]{3,40})$/;
const SB_API = 'https://sponsor.ajay.app/api/skipSegments';

export default function setup(api) {
  const yt = createYtdlp(api);
  const s = () => api.settings;
  const timers = [];

  // ------------------------------------------------------------------ small helpers

  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e4 ? `${Math.floor(n / 1e3)} k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n));
  const clock = (sec) => {
    sec = Math.round(Number(sec) || 0);
    if (sec <= 0) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };
  const list = (v) => String(v || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const bestThumb = (t) => (Array.isArray(t) && t.length ? [...t].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url : null);
  const avatar = (t) => {
    const u = bestThumb(t);
    return u ? (u.startsWith('//') ? `https:${u}` : u) : null;
  };

  /** A small cache with a lifetime, and one request at a time per key. */
  function cached(ttlMs, max = 300) {
    const map = new Map();
    const inflight = new Map();
    return async (key, load, ttl = ttlMs) => {
      const hit = map.get(key);
      if (hit && hit.until > Date.now()) return hit.value;
      if (inflight.has(key)) return inflight.get(key);
      const p = load().then((value) => {
        map.set(key, { value, until: Date.now() + (typeof ttl === 'function' ? ttl(value) : ttl) });
        if (map.size > max) map.delete(map.keys().next().value);
        return value;
      }).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    };
  }

  // ------------------------------------------------------------------ items

  const videoItem = (e, playlist) => {
    const id = e?.id;
    if (!VIDEO_ID.test(String(id || ''))) return null;
    const live = e.live_status === 'is_live' || e.is_live === true;
    const views = Number(e.view_count) || 0;
    return {
      id: playlist ? `v:${id}~${playlist}` : `v:${id}`,
      kind: 'video',
      title: e.title || id,
      subtitle: e.channel || e.uploader || '',
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      live,
      duration: Number(e.duration) || undefined,
      // Only used by this plugin's own cards:
      channel: e.channel || e.uploader || '',
      viewsText: views ? api.t('{n} views', { n: compact(views) }) : '',
      durationText: live ? '' : clock(e.duration),
    };
  };

  const channelItem = (e) => {
    const cid = e?.channel_id || e?.id;
    const handle = e?.uploader_id && String(e.uploader_id).startsWith('@') ? e.uploader_id : null;
    const key = CHANNEL_ID.test(String(cid || '')) ? cid : handle;
    if (!key) return null;
    const subs = Number(e.channel_follower_count) || 0;
    return {
      id: `c:${key}`,
      kind: 'creator', // a YouTube channel – not a TV channel (those have a programme guide)
      action: 'open',
      view: 'channel',
      title: e.channel || e.title || key,
      subtitle: subs ? api.t('{n} subscribers', { n: compact(subs) }) : (handle || ''),
      image: avatar(e.thumbnails),
    };
  };

  const playlistItem = (e) => {
    const pid = e?.id;
    if (!LIST_ID.test(String(pid || '')) || VIDEO_ID.test(pid)) return null;
    return {
      id: `p:${pid}`,
      kind: 'playlist',
      action: 'open',
      view: 'playlist',
      title: e.title || pid,
      subtitle: e.channel || e.uploader || '',
      image: bestThumb(e.thumbnails),
      channel: e.channel || e.uploader || '',
      durationText: '',
    };
  };

  // ------------------------------------------------------------------ YouTube lookups (cached)

  const flatCache = cached(15 * 60 * 1000);
  const flat = (url, count, ttl) => flatCache(`${url}|${count}`, () => yt.json(['--flat-playlist', '--playlist-end', String(count), url], 45000), ttl);

  const searchVideos = async (q, n = 20) => (await flat(`ytsearch${n}:${q}`, n)).entries?.map((e) => videoItem(e)).filter(Boolean) || [];
  const searchUrl = (q, sp) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${sp}`;

  const channelUrl = (key) => (key.startsWith('@') ? `https://www.youtube.com/${key}/videos` : `https://www.youtube.com/channel/${key}/videos`);
  /** "@name", a channel id or a youtube.com link → the key used in ids. */
  function channelKey(v) {
    const t = String(v || '').trim();
    if (CHANNEL_ID.test(t)) return t;
    if (/^[A-Za-z0-9_.-]{3,40}$/.test(t)) return `@${t}`;
    const m = /youtube\.com\/(?:channel\/(UC[A-Za-z0-9_-]{22})|(@[A-Za-z0-9_.-]{3,40}))/.exec(t);
    return m ? (m[1] || m[2]) : null;
  }
  function listKey(v) {
    const t = String(v || '').trim();
    const m = /[?&]list=([A-Za-z0-9_-]{10,64})/.exec(t);
    return m ? m[1] : LIST_ID.test(t) ? t : null;
  }

  async function channelPage(key, n = 36) {
    const d = await flat(channelUrl(key), n);
    return {
      title: String(d.channel || d.uploader || d.title || key).replace(/ - Videos$/, ''),
      followers: Number(d.channel_follower_count) || 0,
      avatar: avatar((d.thumbnails || []).filter((t) => (t.width || 0) === (t.height || 0) && t.width)) || null,
      videos: (d.entries || []).map((e) => videoItem({ channel: d.channel || d.uploader, ...e })).filter(Boolean),
    };
  }

  async function playlistPage(pid, n = 200) {
    // A Mix (RD + video id) is YouTube's "more like this" list for a video – only reachable through the video.
    const mix = pid.startsWith('RD') && VIDEO_ID.test(pid.slice(2));
    const url = mix ? `https://www.youtube.com/watch?v=${pid.slice(2)}&list=${pid}` : `https://www.youtube.com/playlist?list=${pid}`;
    const d = await flat(url, mix ? 50 : n, mix ? 6 * 60 * 60 * 1000 : undefined);
    return {
      title: d.title || pid,
      channel: d.channel || d.uploader || '',
      videos: (d.entries || []).map((e) => videoItem(e, pid)).filter(Boolean),
    };
  }

  // The video's files. YouTube's addresses last about six hours – kept until shortly before they expire.
  const infos = new Map();
  const loading = new Map();
  async function info(vid, fresh = false) {
    const hit = infos.get(vid);
    if (!fresh && hit && hit.until > Date.now()) return hit.v;
    if (loading.has(vid)) return loading.get(vid);
    const p = (async () => {
      const d = await yt.json(['--no-playlist', `https://www.youtube.com/watch?v=${vid}`], 60000);
      const formats = (d.formats || []).filter((f) => f.url).map((f) => ({
        id: f.format_id, url: f.url, headers: f.http_headers || {}, protocol: f.protocol || '',
        vcodec: f.vcodec || 'none', acodec: f.acodec || 'none', height: f.height || 0, ext: f.ext, tbr: f.tbr || 0,
        drc: /drc/.test(f.format_id || ''),
        size: Number(f.filesize) || Number(new URL(f.url).searchParams.get('clen')) || 0,
        // YouTube only hands the file out a few seconds after the address was made.
        availableAt: (Number(f.available_at) || 0) * 1000,
      }));
      const v = {
        title: d.title, channel: d.channel || d.uploader || '', duration: d.duration || 0,
        live: d.is_live === true || d.live_status === 'is_live', image: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, formats,
      };
      const exp = Number(new URL(formats[0]?.url || 'http://x/').searchParams.get('expire')) * 1000;
      infos.set(vid, { v, until: exp ? exp - 15 * 60 * 1000 : Date.now() + 60 * 60 * 1000 });
      if (infos.size > 50) infos.delete(infos.keys().next().value);
      return v;
    })().finally(() => loading.delete(vid));
    loading.set(vid, p);
    return p;
  }

  /** The files to play for a quality: a video-only file and an audio file, or one file with both. */
  function pick(inf, quality) {
    const https = inf.formats.filter((f) => f.protocol === 'https');
    const audio = https.filter((f) => f.vcodec === 'none' && f.acodec.startsWith('mp4a'))
      .sort((a, b) => (a.drc - b.drc) || (b.tbr - a.tbr))[0];
    if (quality === 'audio' && audio) return { video: audio, audio: null, audioOnly: true };
    const max = Number(quality) || 1080;
    const video = https.filter((f) => f.acodec === 'none' && f.vcodec.startsWith('avc1') && f.height <= max)
      .sort((a, b) => (b.height - a.height) || (b.tbr - a.tbr))[0];
    if (video && audio) return { video, audio };
    const muxed = https.filter((f) => f.acodec !== 'none' && f.vcodec !== 'none').sort((a, b) => b.height - a.height)[0];
    if (muxed) return { video: muxed, audio: null };
    if (audio) return { video: audio, audio: null, audioOnly: true };
    throw new Error('YouTube gave no playable file for this video');
  }

  // ------------------------------------------------------------------ the files, passed on to the apps

  // YouTube slows down requests for a whole file, so the file is fetched in pieces (like yt-dlp does) and
  // passed on as one answer – with Range support, so the apps can jump anywhere.
  const CHUNK = 8 * 1024 * 1024;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  api.route('GET', '/s/*', async (req, res, { path: rest, query }) => {
    const m = /^([A-Za-z0-9_-]{11})\/(video|audio)$/.exec(rest);
    if (!m) { res.writeHead(400); return res.end(); }
    const [, vid, part] = m;
    const quality = String(query.get('q') || '1080');
    let closed = false;
    const ac = new AbortController();
    res.on('close', () => { closed = true; ac.abort(); });

    const file = async (fresh) => {
      const chosen = pick(await info(vid, fresh), quality);
      return part === 'audio' ? chosen.audio : chosen.video;
    };
    const piece = async (f, a, b) => {
      const wait = f.availableAt - Date.now();
      if (wait > 0) await sleep(Math.min(wait + 200, 15000));
      return fetch(`${f.url}&range=${a}-${b}`, { headers: f.headers, signal: ac.signal });
    };

    try {
      let f = await file(false);
      if (!f) { res.writeHead(404); return res.end(); }
      if (!f.size) { // unknown size: pass the request on as it is
        const up = await fetch(f.url, { headers: { ...f.headers, ...(req.headers.range ? { Range: req.headers.range } : {}) }, signal: ac.signal });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'video/mp4', ...(up.headers.get('content-range') ? { 'content-range': up.headers.get('content-range') } : {}) });
        return up.body ? Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res) : res.end();
      }
      const size = f.size;
      const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      let start = 0;
      let end = size - 1;
      if (r) {
        if (r[1] === '' && r[2]) start = Math.max(0, size - Number(r[2]));
        else { start = Number(r[1]) || 0; if (r[2]) end = Math.min(size - 1, Number(r[2])); }
        if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
      }
      // The first piece decides the answer (a fresh address if the old one has expired).
      let up = await piece(f, start, Math.min(start + CHUNK - 1, end));
      if (up.status === 403 || up.status === 410) { f = await file(true); up = await piece(f, start, Math.min(start + CHUNK - 1, end)); }
      if (!up.ok) { api.log(`stream ${vid}: YouTube answered ${up.status}`); res.writeHead(502); return res.end(); }
      res.writeHead(r ? 206 : 200, {
        'content-type': part === 'audio' ? 'audio/mp4' : (up.headers.get('content-type') || 'video/mp4'),
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        ...(r ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      });
      for (let a = start; a <= end && !closed; a += CHUNK) {
        if (a !== start) {
          up = await piece(f, a, Math.min(a + CHUNK - 1, end));
          if (!up.ok) throw new Error(`YouTube answered ${up.status}`);
        }
        for await (const buf of up.body) {
          if (closed) break;
          if (!res.write(buf)) {
            await new Promise((ok) => {
              const done = () => { res.off('drain', done); res.off('close', done); ok(); };
              res.on('drain', done);
              res.on('close', done);
            });
          }
        }
      }
      res.end();
    } catch (e) {
      if (!closed) {
        api.log(`stream ${vid}: ${e.message}`);
        if (!res.headersSent) res.writeHead(502);
        res.destroy();
      }
    }
  });

  // ------------------------------------------------------------------ SponsorBlock: skip sponsor segments for everyone

  const sbCache = cached(6 * 60 * 60 * 1000, 100);
  const segments = (vid) => sbCache(vid, async () => {
    const cats = list(s().sponsorCategories || 'sponsor,selfpromo,interaction,music_offtopic');
    const url = `${SB_API}?videoID=${vid}&categories=${encodeURIComponent(JSON.stringify(cats))}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) return [];
    const d = await r.json().catch(() => []);
    return (Array.isArray(d) ? d : []).map((x) => x.segment).filter((g) => Array.isArray(g) && g[1] - g[0] >= 1).sort((a, b) => a[0] - b[0]);
  });
  let sbVideo = null;
  let sbDone = new Set();
  timers.push(setInterval(async () => {
    if (s().sponsorBlock === false) return;
    const st = api.room.state();
    const media = st?.media;
    if (!media || media.plugin !== api.id || media.live) { sbVideo = null; return; }
    const vid = String(media.id).slice(2, 13);
    if (vid !== sbVideo) { sbVideo = vid; sbDone = new Set(); }
    if (st.paused || st.waiting) return;
    const segs = await segments(vid).catch(() => []);
    const pos = Number(st.position) || 0;
    for (const [a, b] of segs) {
      const key = `${a}`;
      if (pos >= a && pos < b - 1 && !sbDone.has(key)) {
        sbDone.add(key);
        api.room.seek(b, 'SponsorBlock');
        break;
      }
    }
  }, 700));

  // ------------------------------------------------------------------ cards

  const videoCard = {
    type: 'column', children: [
      {
        type: 'box', aspect: 1.7778, width: 'fill', children: [
          { type: 'image', src: '{{item.image}}', fallback: '{{item.title}}', fit: 'cover', width: 'fill', height: 'fill', radius: 12 },
          { type: 'badge', text: '{{item.durationText}}', color: 'dark', align: 'bottomEnd', padding: 8, when: '{{item.durationText}}' },
          { type: 'badge', text: 'LIVE', color: 'live', align: 'topStart', padding: 8, when: '{{item.live}}' },
          { type: 'badge', text: '★', color: 'dark', textColor: 'gold', align: 'topEnd', padding: 6, when: '{{item.$favorite}}' },
        ],
      },
      {
        type: 'column', padding: [10, 6, 10, 6], children: [
          { type: 'text', text: '{{item.title}}', style: 'bodyStrong', size: 15, maxLines: 2 },
          { type: 'text', join: ['{{item.channel}}', '{{item.viewsText}}'], separator: ' · ', style: 'dim', size: 12, maxLines: 1, padding: [0, 3, 0, 0] },
        ],
      },
    ],
  };

  const channelCard = {
    type: 'column', align: 'center', padding: [14, 10, 14, 10], children: [
      { type: 'image', src: '{{item.image}}', fallback: '{{item.title}}', fit: 'cover', width: 120, height: 120, radius: 60 },
      { type: 'spacer', height: 10 },
      { type: 'text', text: '{{item.title}}', style: 'bodyStrong', size: 15, maxLines: 1 },
      { type: 'text', text: '{{item.subtitle}}', style: 'dim', size: 12, maxLines: 1 },
    ],
  };

  const message = (text) => ({ type: 'column', padding: 20, children: [{ type: 'text', text, style: 'dim' }] });

  // ------------------------------------------------------------------ pages

  /** The front page: a row per playlist, channel and topic from the settings. */
  async function homeView() {
    const tasks = [];
    for (const v of list(s().playlists)) {
      const pid = listKey(v);
      if (pid) tasks.push(playlistPage(pid, 30).then((p) => ({ id: `p-${pid}`, title: p.title, items: p.videos, open: { open: 'playlist', params: { id: `p:${pid}` } } })));
    }
    for (const v of list(s().channels)) {
      const key = channelKey(v);
      if (key) tasks.push(channelPage(key, 20).then((c) => ({ id: `c-${key}`, title: c.title, items: c.videos, open: { open: 'channel', params: { id: `c:${key}` } } })));
    }
    for (const q of list(s().topics ?? 'Music, News, Gaming')) {
      tasks.push(searchVideos(q, 16).then((items) => ({ id: `t-${q}`, title: q, items })));
    }
    if (!tasks.length) return message(api.t('Add channels, playlists or topics in the settings – or search for anything in Search.'));
    const rows = (await Promise.all(tasks.map((t) => t.catch((e) => { api.log(e.message); return null; })))).filter((r) => r?.items?.length);
    return {
      type: 'column', refresh: 900, children: [
        {
          type: 'row', align: 'center', padding: [12, 0, 0, 10], children: [
            { type: 'icon', path: LOGO, size: 30, color: '#FF0033' },
            { type: 'spacer', width: 12 },
            { type: 'text', text: 'YouTube', style: 'title', size: 26 },
          ],
        },
        {
          type: 'list', id: 'rows', weight: 1, items: rows, focus: 'none', gap: 14, empty: api.t('Nothing here.'),
          item: {
            type: 'column', children: [
              { type: 'text', text: '{{item.title}}', style: 'headline', size: 20, padding: [12, 0, 0, 8] },
              {
                type: 'list', id: 'row-{{item.id}}', direction: 'horizontal', items: '{{item.items}}', focus: 'card',
                itemWidth: 320, gap: 16, padding: [12, 10, 12, 10],
                onClick: { play: '{{item}}' }, onLongClick: { favorite: '{{item}}' },
                item: videoCard,
              },
            ],
          },
        },
      ],
    };
  }

  async function channelView(id) {
    const key = String(id || '').replace(/^c:/, '');
    if (!CHANNEL_ID.test(key)) return message(api.t('Nothing here.'));
    const c = await channelPage(key, 48);
    const self = { id: `c:${key}`, plugin: api.id, kind: 'creator', action: 'open', view: 'channel', title: c.title, image: c.avatar };
    return {
      type: 'column', refresh: 900, view: { item: self }, children: [
        {
          type: 'row', align: 'center', padding: [8, 0, 14, 10], gap: 18, children: [
            { type: 'image', src: c.avatar, fallback: c.title, fit: 'cover', width: 88, height: 88, radius: 44 },
            {
              type: 'column', weight: 1, children: [
                { type: 'text', text: c.title, style: 'title', size: 26, maxLines: 1 },
                { type: 'text', text: c.followers ? api.t('{n} subscribers', { n: compact(c.followers) }) : '', style: 'dim', size: 15 },
              ],
            },
            { type: 'button', text: api.t('☆ Add to favorites'), onClick: { favorite: '{{view.item}}' }, unless: '{{view.item.$favorite}}' },
            { type: 'button', text: api.t('★ Favorite'), selected: true, onClick: { favorite: '{{view.item}}' }, when: '{{view.item.$favorite}}' },
          ],
        },
        {
          type: 'grid', id: 'videos', weight: 1, items: c.videos, focus: 'card', minWidth: 300, gap: 16, rowGap: 18, padding: [4, 10, 24, 10],
          autofocus: true, empty: api.t('Nothing here.'),
          onClick: { play: '{{item}}' }, onLongClick: { favorite: '{{item}}' },
          item: videoCard,
        },
      ],
    };
  }

  async function playlistView(id) {
    const pid = String(id || '').replace(/^p:/, '');
    if (!LIST_ID.test(pid)) return message(api.t('Nothing here.'));
    const p = await playlistPage(pid);
    const first = p.videos[0];
    const self = { id: `p:${pid}`, plugin: api.id, kind: 'playlist', action: 'open', view: 'playlist', title: p.title, image: first?.image };
    return {
      type: 'column', view: { item: self, first: first || null }, children: [
        {
          type: 'row', align: 'center', padding: [8, 0, 14, 10], gap: 18, children: [
            { type: 'image', src: first?.image, fallback: p.title, fit: 'cover', width: 160, height: 90, radius: 10 },
            {
              type: 'column', weight: 1, children: [
                { type: 'text', text: p.title, style: 'title', size: 26, maxLines: 1 },
                { type: 'text', join: [p.channel, api.t('{n} videos', { n: p.videos.length })], separator: ' · ', style: 'dim', size: 15 },
              ],
            },
            { type: 'button', text: api.t('▶ Play all'), selected: true, onClick: { play: '{{view.first}}' }, when: '{{view.first}}' },
            { type: 'button', text: api.t('☆ Add to favorites'), onClick: { favorite: '{{view.item}}' }, unless: '{{view.item.$favorite}}' },
            { type: 'button', text: api.t('★ Favorite'), selected: true, onClick: { favorite: '{{view.item}}' }, when: '{{view.item.$favorite}}' },
          ],
        },
        {
          type: 'list', id: 'videos', weight: 1, items: p.videos.map((v, i) => ({ ...v, n: i + 1 })), focus: 'row', itemHeight: 84, gap: 4,
          autofocus: true, empty: api.t('Nothing here.'), background: 'panel', radius: 12, padding: 8,
          onClick: { play: '{{item}}' }, onLongClick: { favorite: '{{item}}' },
          item: {
            type: 'row', align: 'center', children: [
              { type: 'text', text: '{{item.n}}', style: 'dim', width: 44 },
              { type: 'image', src: '{{item.image}}', fallback: '{{item.title}}', fit: 'cover', width: 112, height: 63, radius: 6 },
              { type: 'spacer', width: 16 },
              {
                type: 'column', weight: 1, children: [
                  { type: 'text', text: '{{item.title}}', style: 'bodyStrong', size: 15, maxLines: 1 },
                  { type: 'text', text: '{{item.channel}}', style: 'dim', size: 12, maxLines: 1 },
                ],
              },
              { type: 'text', text: '{{item.durationText}}', style: 'dim', size: 13 },
            ],
          },
        },
      ],
    };
  }

  // On top of the video (pause, seeking, or arrow up when nothing is queued): the video and the time line.
  const overlay = {
    type: 'box', width: 'fill', height: 'fill', children: [
      { type: 'topbar', align: 'topStart' },
      {
        type: 'column', align: 'bottomStart', width: 'fill', background: 'bottomFade', padding: [40, 80, 48, 40], children: [
          { type: 'text', text: '{{media.title}}', style: 'title', size: 26, maxLines: 1 },
          { type: 'text', text: '{{media.subtitle}}', style: 'dim', size: 17, maxLines: 1, when: '{{media.subtitle}}' },
          { type: 'spacer', height: 18 },
          { type: 'progress', value: '{{player.progress}}' },
          { type: 'spacer', height: 10 },
          {
            type: 'row', align: 'center', children: [
              { type: 'text', text: '{{player.positionText}}', size: 15 },
              { type: 'spacer', width: 16 },
              { type: 'text', text: '{{player.status}}', color: 'status', size: 14 },
              { type: 'spacer', weight: 1 },
              { type: 'text', text: '{{player.hints}}', style: 'faint', size: 13 },
              { type: 'spacer', width: 24 },
              { type: 'text', text: '{{player.remainingText}}', size: 15 },
            ],
          },
        ],
      },
    ],
  };

  /** Autoplay: a single video goes on with its Mix (similar videos, like on YouTube). */
  const autoplay = () => s().autoplay !== false;

  /** The list a video plays from: its playlist, or – for a single video with autoplay – its Mix. */
  function listOf(id) {
    const m = /^v:([A-Za-z0-9_-]{11})(?:~([A-Za-z0-9_-]{10,64}))?$/.exec(String(id || ''));
    if (!m) return null;
    if (m[2]) return { vid: m[1], list: m[2] };
    return autoplay() ? { vid: m[1], list: `RD${m[1]}` } : null;
  }

  /** Fetches videos' details in the background, one at a time (yt-dlp is heavy), so they start quickly later. */
  let warming = Promise.resolve();
  function warm(items) {
    for (const it of items) {
      const vid = /^v:([A-Za-z0-9_-]{11})/.exec(it?.id || '')?.[1];
      if (vid) warming = warming.then(() => info(vid)).catch(() => {});
    }
  }

  /** A list's videos, each only once – a Mix can bring a song back, which would make "next" go round in circles. */
  async function listVideos(list) {
    const p = await playlistPage(list);
    const seen = new Set();
    return { ...p, videos: p.videos.filter((v) => { const vid = v.id.slice(2, 13); return !seen.has(vid) && seen.add(vid); }) };
  }

  /** The queue (the side list in the player): the whole list the video plays from. */
  async function queue(id) {
    const l = listOf(id);
    if (!l) return { items: [] };
    const p = await listVideos(l.list);
    const current = p.videos.find((v) => v.id.startsWith(`v:${l.vid}~`))?.id || id;
    // The next few are fetched in the background, so picking one of them starts quickly.
    const at = p.videos.findIndex((v) => v.id === current);
    warm(p.videos.slice(at + 1, at + 4));
    return { title: p.title, current, items: p.videos.slice(0, 300) };
  }

  // ------------------------------------------------------------------ the source

  api.source({
    name: 'YouTube',
    icon: LOGO,
    // On the Favorites screen: YouTube's channels, playlists and videos each in a group of their own.
    favoriteGroups: {
      creator: { title: api.t('YouTube channels') },
      playlist: { title: api.t('YouTube playlists') },
      video: { title: api.t('YouTube videos') },
    },

    player: {
      keys: { ok: 'pause', left: 'seek_back', right: 'seek_forward', down: 'settings', up: 'queue' },
      queue: true,
      // Songs in a playlist or Mix: "next" shows 10 s before the end and the next one follows straight on.
      upNextBefore: 10,
      overlay,
      settings: [
        {
          type: 'choice', id: 'quality', title: api.t('Quality'), default: String(s().quality || '1080'),
          options: [
            { id: '1080', label: '1080p' }, { id: '720', label: '720p' }, { id: '480', label: '480p' },
            { id: 'audio', label: api.t('Audio only') },
          ],
        },
      ],
    },

    async data(name, params = {}) {
      if (name === 'queue') return queue(params.id);
      return null;
    },

    async view(id, params = {}) {
      if (id === 'channel') return channelView(params.id);
      if (id === 'playlist') return playlistView(params.id);
      return homeView();
    },

    async search(q) {
      const [videos, channels, playlists] = await Promise.all([
        searchVideos(q, 20).catch(() => []),
        flat(searchUrl(q, 'EgIQAg%3D%3D'), 6).then((d) => (d.entries || []).map(channelItem).filter(Boolean)).catch(() => []),
        flat(searchUrl(q, 'EgIQAw%3D%3D'), 8).then((d) => (d.entries || []).map(playlistItem).filter(Boolean)).catch(() => []),
      ]);
      return {
        sections: [
          { id: 'videos', title: api.t('Videos'), items: videos },
          { id: 'channels', title: api.t('Channels'), style: 'square', items: channels },
          { id: 'playlists', title: api.t('Playlists'), items: playlists },
        ],
      };
    },

    async resolve(id, { options = {} } = {}) {
      const m = /^v:([A-Za-z0-9_-]{11})(?:~([A-Za-z0-9_-]{10,64}))?$/.exec(String(id));
      if (!m) throw new Error('Not a YouTube video');
      const vid = m[1];
      const inf = await info(vid);
      const base = { title: inf.title, subtitle: inf.channel, image: inf.image, kind: 'video', duration: inf.duration || undefined };
      if (inf.live) {
        const hls = inf.formats.filter((f) => /m3u8/.test(f.protocol)).sort((a, b) => b.height - a.height)[0];
        if (!hls) throw new Error('YouTube gave no stream for this live video');
        return { ...base, url: hls.url, type: 'hls', live: true };
      }
      const quality = String(options.quality || s().quality || '1080');
      const chosen = pick(inf, quality);
      const q = `?q=${encodeURIComponent(quality)}`;
      return {
        ...base,
        url: `/plugins/${api.id}/s/${vid}/video${q}`,
        audio: chosen.audio ? `/plugins/${api.id}/s/${vid}/audio${q}` : undefined,
        type: 'file',
        live: false,
      };
    },

    /** The next video: the next one in its playlist – or in its Mix (autoplay). */
    async next(id) {
      const l = listOf(id);
      if (!l) return null;
      const p = await listVideos(l.list);
      const i = p.videos.findIndex((v) => v.id.startsWith(`v:${l.vid}~`));
      if (i >= 0) return p.videos[i + 1] || null;
      // Not in the list any more (a Mix can change): go on with this video's own Mix.
      if (!autoplay()) return null;
      const mix = await listVideos(`RD${l.vid}`);
      return mix.videos.find((v) => !v.id.startsWith(`v:${l.vid}~`)) || null;
    },
  });

  // yt-dlp is fetched (the first time) and updated now and then every day.
  yt.update();
  timers.push(setInterval(() => yt.update(), 24 * 60 * 60 * 1000));

  return () => timers.forEach(clearInterval);
}
