#!/usr/bin/env node
'use strict';
/**
 * Vybe Reels Server — ملف السيرفر (ملف واحد)
 * ------------------------------------------------------------------
 * يسحب ريلز (يوتيوب Shorts / تيك توك) ويكتبها بـ Firestore، وينظّف القديم، ويشتغل بجدولة،
 * ويقدّم صفحة التطبيق vybe-auth.html (اللي بنفس المجلد) على http://localhost:5173
 *
 * المتطلبات:  Node 18+ ، yt-dlp (pip install -U yt-dlp) ، ffmpeg
 *             npm i firebase-admin node-cron apify-client
 *
 * الملفات:    server.js (هذا) + vybe-auth.html (التطبيق) + serviceAccount.json (أو الصقه بقسم INLINE)
 *
 * التشغيل:    node server.js            سحب مجدول + الواجهة
 *             node server.js --once     دورة سحب وحدة ثم يطلع
 *             node server.js --web      الواجهة فقط (بدون Firebase/سحب)
 *             node server.js --no-web   سحب بدون الواجهة
 *
 * الإعدادات:  قسم INLINE بالأسفل أو متغيرات بيئة / ملف .env (البيئة تتقدّم).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) { /* dotenv اختياري */ }

/* ============================== INLINE: إعداداتك هنا ============================== */
const INLINE = {
  // مفتاح حساب الخدمة: الصق محتوى serviceAccount.json كامل هنا ككائن { ... } (أو اتركه null وحط الملف بجنبه)
  FIREBASE_SERVICE_ACCOUNT_JSON: null,
  FIREBASE_STORAGE_BUCKET: 'vybe-iq.firebasestorage.app',
  APIFY_TOKEN: '',                 // اختياري (تيك توك بالهاشتاغات)
  ENABLE_TIKTOK_APIFY: 'true',    // 'true' لتفعيل Apify
  IRAQ_CHANNELS: '',               // @channel1,@channel2
  IRAQ_TIKTOK_USERS: '',           // @user1,@user2
  CRON_SCHEDULE: '*/30 * * * *',
  ADMIN_KEY: ''
};
const envOr = k => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (INLINE[k] == null ? '' : INLINE[k]));

/* ============================== log ============================== */
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (...a) => console.log(`[${ts()}]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] ⚠`, ...a),
  error: (...a) => console.error(`[${ts()}] ✖`, ...a)
};

/* ============================== config ============================== */
const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const list = v => (v || '').split(',').map(x => x.trim()).filter(Boolean);

// قنوات يوتيوب عراقية مثال: IRAQ_CHANNELS=@channel1,@channel2
const channels = list(envOr('IRAQ_CHANNELS'));
// حسابات تيك توك عراقية مثال: IRAQ_TIKTOK_USERS=@user1,@user2
const tiktokUsers = list(envOr('IRAQ_TIKTOK_USERS'));

const cfg = {
  serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccount.json',
  bucket: envOr('FIREBASE_STORAGE_BUCKET') || 'vybe-iq.firebasestorage.app',
  cron: envOr('CRON_SCHEDULE') || '*/30 * * * *',

  ytdlp: process.env.YTDLP_BIN || 'yt-dlp',
  cookies: process.env.YTDLP_COOKIES || '',
  perTag: num(process.env.PER_TAG, 6),
  searchDepth: num(process.env.SEARCH_DEPTH, 25),
  maxDuration: num(process.env.MAX_DURATION, 75),

  maxReels: num(process.env.MAX_REELS, 400),
  keepDays: num(process.env.KEEP_DAYS, 14),
  tmpDir: process.env.TMP_DIR || './tmp',

  enableTiktok: envOr('ENABLE_TIKTOK_APIFY') === 'true',
  apifyToken: envOr('APIFY_TOKEN'),
  apifyActor: process.env.APIFY_ACTOR || 'clockworks/tiktok-scraper',

  port: num(process.env.PORT, 8080),
  webPort: num(process.env.WEB_PORT, 5173),
  adminKey: envOr('ADMIN_KEY'),

  // المحتوى العراقي: كلمات بحث بالعربي/اللهجة العراقية + (اختياري) قنوات/حسابات تحددها بالـ env
  tags: [
    { tag: 'عراق',     cat: 'ترند عراقي',     queries: ['ترند عراقي', 'العراق ترند', 'بغداد', 'البصرة', 'اربيل'], channels, tiktokUsers, tiktokTags: ['عراقي', 'العراق', 'بغداد'] },
    { tag: 'كوميديا',  cat: 'كوميديا عراقية', queries: ['كوميدي عراقي', 'مقالب عراقية', 'نكت عراقية', 'سكيتشات عراقية'], tiktokTags: ['كوميدي_عراقي'] },
    { tag: 'اغاني',    cat: 'اغاني عراقية',   queries: ['اغاني عراقية', 'دبكة عراقية', 'حفلة عراقية', 'اغنية عراقية جديدة'], tiktokTags: ['اغاني_عراقية'] },
    { tag: 'كرة',      cat: 'كرة القدم',      queries: ['اسود الرافدين', 'المنتخب العراقي', 'الدوري العراقي', 'كرة القدم العراقية'] },
    { tag: 'اكل',      cat: 'اكل عراقي',      queries: ['اكل عراقي', 'مطبخ عراقي', 'مطعم بغداد', 'كباب عراقي'] },
    { tag: 'تقنية',    cat: 'تقنية',          queries: ['تقنية عراقي', 'موبايلات العراق', 'تقنية بالعربي'] }
  ]
};

/* ============================== firebase (lazy) ============================== */
let _fb = null;
function fb() {
  if (_fb) return _fb;
  // واجهة firebase-admin الحديثة (تشتغل على كل الإصدارات: 11 / 12 / 13 / 14)
  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { getStorage } = require('firebase-admin/storage');

  function loadAccount() {
    // 1) JSON كامل داخل متغير بيئة أو قسم INLINE
    const inl = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || INLINE.FIREBASE_SERVICE_ACCOUNT_JSON;
    let acc;
    if (inl) acc = typeof inl === 'string' ? JSON.parse(inl) : inl;
    else {
      // 2) ملف المفتاح (نسبةً لمجلد هذا الملف إذا مسار نسبي)
      const p = path.isAbsolute(cfg.serviceAccount) ? cfg.serviceAccount : path.resolve(__dirname, cfg.serviceAccount);
      if (!fs.existsSync(p)) {
        throw new Error(
          `ملف حساب الخدمة غير موجود: ${p}\n` +
          'نزّله من Firebase Console → Project settings → Service accounts → Generate new private key'
        );
      }
      acc = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    if (!acc || !acc.private_key || !acc.client_email || !acc.project_id) {
      throw new Error('ملف حساب الخدمة ناقص (لازم فيه project_id و client_email و private_key). نزّل مفتاح جديد من Firebase Console → Service accounts.');
    }
    return acc;
  }

  if (!getApps().length) initializeApp({ credential: cert(loadAccount()), storageBucket: cfg.bucket });
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  _fb = { db, bucket: getStorage().bucket(), FieldValue };
  return _fb;
}

/* ============================== yt-dlp ============================== */
function runYt(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('yt-dlp timeout')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp exit ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`));
    });
  });
}

const ytBase = () => {
  const a = ['--no-warnings', '--no-playlist', '--socket-timeout', '20', '--retries', '2'];
  if (cfg.cookies) a.push('--cookies', cfg.cookies);
  return a;
};

async function ytVersion() {
  return (await runYt(['--version'], 15000)).trim();
}

function mapEntries(j) {
  return (j.entries || [])
    .filter(e => e && e.id && (e.duration == null || e.duration <= cfg.maxDuration))
    .map(e => ({
      sourceId: e.id,
      title: e.title || '',
      ownerName: e.channel || e.uploader || j.channel || j.uploader || '',
      ownerHandle: e.uploader_id || e.channel || j.uploader_id || '',
      ownerUrl: e.channel_url || e.uploader_url || j.channel_url || '',
      duration: e.duration || null,
      views: e.view_count || 0
    }));
}

/** بحث يوتيوب (Shorts) بكلمات -> مرشّحين خفيفين (بدون تحميل) */
async function ytSearch(query) {
  const q = `ytsearch${cfg.searchDepth}:${query} #shorts`;
  const out = await runYt([...ytBase(), '--flat-playlist', '--dump-single-json', q], 120000);
  return mapEntries(JSON.parse(out));
}

/** آخر Shorts من قناة محددة (@handle) */
async function ytChannelShorts(handle) {
  const h = String(handle).replace(/^@/, '');
  const url = `https://www.youtube.com/@${h}/shorts`;
  const out = await runYt([...ytBase(), '--flat-playlist', '--dump-single-json', '--playlist-end', String(cfg.searchDepth), url], 120000);
  return mapEntries(JSON.parse(out));
}

function ytSkip(id, why) { log.info(`  ⤳ تخطّي youtube/${id}: ${why}`); return null; }

/** فحص مقطع بدون تحميل: رأسي؟ مسموح تضمينه؟ ثم نرجع بياناته فقط. */
async function ytInspect(id) {
  const out = await runYt([
    ...ytBase(), '--skip-download', '--dump-json', '--ignore-no-formats-error',
    `https://www.youtube.com/shorts/${id}`
  ], 90000);
  const info = JSON.parse(out);
  if (info.playable_in_embed === false) return ytSkip(id, 'ممنوع التضمين');
  if (info.live_status && info.live_status !== 'not_live') return ytSkip(id, 'بث مباشر');
  if (info.age_limit && info.age_limit >= 18) return ytSkip(id, '+18');
  if (info.duration && info.duration > cfg.maxDuration) return ytSkip(id, `طويل ${info.duration}s`);
  if (info.width && info.height && info.width >= info.height) return ytSkip(id, `مو رأسي ${info.width}x${info.height}`);
  return {
    embedId: id,
    thumbUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    width: info.width || null,
    height: info.height || null,
    duration: info.duration || null,
    likesSource: info.like_count || 0,
    viewsSource: info.view_count || 0,
    title: info.title || null,
    ownerName: info.channel || info.uploader || null,
    ownerHandle: info.uploader_id || null,
    ownerUrl: info.channel_url || null
  };
}

/** يرجع مرشّحي يوتيوب جاهزين للـ pipeline */
async function ytCandidates(tagDef) {
  const seen = new Set();
  const out = [];
  const jobs = [
    ...(tagDef.channels || []).map(c => ({ name: c, run: () => ytChannelShorts(c) })),
    ...tagDef.queries.map(q => ({ name: q, run: () => ytSearch(q) }))
  ];
  for (const job of jobs) {
    try {
      for (const e of await job.run()) {
        if (seen.has(e.sourceId)) continue;
        seen.add(e.sourceId);
        out.push({
          platform: 'youtube',
          sourceId: e.sourceId,
          sourceUrl: `https://www.youtube.com/shorts/${e.sourceId}`,
          title: e.title,
          ownerName: e.ownerName,
          ownerHandle: e.ownerHandle,
          ownerUrl: e.ownerUrl,
          views: e.views,
          tag: tagDef.tag,
          cat: tagDef.cat,
          fetch: () => ytInspect(e.sourceId),
          cleanup: () => {}
        });
      }
    } catch (e) {
      log.warn(`yt-dlp "${job.name}" فشل: ${e.message}`);
    }
  }
  return out;
}

/* ============================== tiktok ============================== */
// TikTok بوضع التضمين (بدون تحميل ولا تخزين): نجيب بس IDs + بيانات، والصفحة تعرضها بمشغّل تيك توك الرسمي.
//  1) حسابات محددة IRAQ_TIKTOK_USERS (عبر yt-dlp، مجاني، ممكن يتعطل إذا تيك توك شدّد الحماية)
//  2) هاشتاغات عبر Apify (ENABLE_TIKTOK_APIFY=true + APIFY_TOKEN)
let ttWarned = false;
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** هاشتاغ تيك توك عشوائي عبر yt-dlp (مجاني، بدون Apify). ممكن يفشل إذا تيك توك شدّد الحماية. */
async function ttFreeTag(tag) {
  const t = String(tag).replace(/^#/, '');
  const args = ytBase().filter(a => a !== '--no-playlist');
  const out = await runYt([...args, '--flat-playlist', '--dump-single-json',
    '--playlist-end', String(cfg.searchDepth), `https://www.tiktok.com/tag/${encodeURIComponent(t)}`], 120000);
  const j = JSON.parse(out);
  return (j.entries || []).filter(e => e && e.id).map(e => {
    const h = String(e.uploader_id || e.uploader || e.channel || '').replace(/^@/, '');
    return {
      id: String(e.id),
      url: e.webpage_url || e.url || `https://www.tiktok.com/@${h || '_'}/video/${e.id}`,
      title: e.title || e.description || '',
      ownerName: e.uploader || e.channel || h,
      ownerHandle: e.uploader_id || h,
      ownerUrl: h ? `https://www.tiktok.com/@${h}` : '',
      views: e.view_count || 0, likes: e.like_count || 0,
      duration: e.duration || null, width: null, height: null
    };
  });
}

async function ttUserVideos(handle) {
  const h = String(handle).replace(/^@/, '');
  const args = ytBase().filter(a => a !== '--no-playlist');
  const out = await runYt([...args, '--flat-playlist', '--dump-single-json',
    '--playlist-end', String(cfg.searchDepth), `https://www.tiktok.com/@${h}`], 120000);
  const j = JSON.parse(out);
  return (j.entries || []).filter(e => e && e.id).map(e => ({
    id: String(e.id),
    url: `https://www.tiktok.com/@${h}/video/${e.id}`,
    title: e.title || e.description || '',
    ownerName: e.uploader || e.channel || h,
    ownerHandle: e.uploader_id || h,
    ownerUrl: `https://www.tiktok.com/@${h}`,
    views: e.view_count || 0, likes: e.like_count || 0,
    duration: e.duration || null, width: null, height: null
  }));
}

async function ttHashtagVideos(tags) {
  const { ApifyClient } = require('apify-client');
  const client = new ApifyClient({ token: cfg.apifyToken });
  const run = await client.actor(cfg.apifyActor).call({
    hashtags: tags,
    resultsPerPage: Math.max(cfg.perTag * 3, 10),
    shouldDownloadVideos: false,
    shouldDownloadCovers: false
  }, { waitSecs: 240 });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return (items || []).filter(it => it && it.id).map(it => {
    const o = it.authorMeta || {}, vm = it.videoMeta || {};
    return {
      id: String(it.id),
      url: it.webVideoUrl || `https://www.tiktok.com/@${o.name || '_'}/video/${it.id}`,
      title: it.text || '',
      ownerName: o.nickName || o.name || '', ownerHandle: o.name || '',
      ownerUrl: o.name ? `https://www.tiktok.com/@${o.name}` : '',
      views: it.playCount || 0, likes: it.diggCount || 0,
      duration: vm.duration || null, width: vm.width || null, height: vm.height || null
    };
  });
}

function ttToCand(tagDef, m) {
  return {
    platform: 'tiktok',
    sourceId: m.id,
    sourceUrl: m.url,
    title: m.title,
    ownerName: m.ownerName, ownerHandle: m.ownerHandle, ownerUrl: m.ownerUrl,
    views: m.views,
    tag: tagDef.tag, cat: tagDef.cat,
    fetch: async () => {
      if (m.duration && m.duration > cfg.maxDuration) return null;
      if (m.width && m.height && m.width >= m.height) return null;
      return {
        embedId: m.id, thumbUrl: null,
        width: m.width, height: m.height, duration: m.duration,
        likesSource: m.likes, viewsSource: m.views,
        title: m.title, ownerName: m.ownerName, ownerHandle: m.ownerHandle, ownerUrl: m.ownerUrl
      };
    },
    cleanup: () => {}
  };
}

async function ttCandidates(tagDef) {
  const users = tagDef.tiktokUsers || [];
  const useApify = cfg.enableTiktok && cfg.apifyToken;
  const tags = tagDef.tiktokTags || [];
  if (!users.length && !tags.length) return [];

  const seen = new Set(), out = [];
  const add = arr => { for (const m of shuffle(arr)) if (!seen.has(m.id)) { seen.add(m.id); out.push(ttToCand(tagDef, m)); } };

  for (const u of users) {
    try { add(await ttUserVideos(u)); }
    catch (e) { log.warn(`TikTok @${String(u).replace(/^@/, '')} فشل: ${e.message}`); }
  }
  if (useApify) {
    try { add(await ttHashtagVideos(tags)); }
    catch (e) { log.warn(`Apify فشل (${tags.join(',')}): ${e.message}`); }
  } else {
    // عشوائي مجاني: نختار هاشتاغين عشوائيين من القائمة بكل دورة
    for (const t of shuffle(tags).slice(0, 2)) {
      try { add(await ttFreeTag(t)); }
      catch (e) {
        if (!ttWarned) { ttWarned = true; log.warn(`تيك توك المجاني (#${t}) فشل: ${e.message.slice(0, 160)} — إذا يتكرر، فعّل Apify بقسم INLINE`); }
      }
    }
  }
  return out;
}

/* ============================== store ============================== */
const COL = 'reels';
const docId = (platform, sourceId) => `${platform}_${sourceId}`;

/** يرجع فقط المرشّحين اللي مو موجودين مسبقاً في Firestore */
async function filterNew(cands) {
  if (!cands.length) return [];
  const { db } = fb();
  const refs = cands.map(c => db.collection(COL).doc(docId(c.platform, c.sourceId)));
  const snaps = [];
  for (let i = 0; i < refs.length; i += 300) snaps.push(...await db.getAll(...refs.slice(i, i + 300)));
  return cands.filter((_, i) => !snaps[i].exists);
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function uploadFile(file, dest, contentType) {
  const { bucket } = fb();
  const token = crypto.randomUUID();
  await bucket.upload(file, {
    destination: dest,
    resumable: false,
    metadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(dest)}?alt=media&token=${token}`;
}

/** ينشر ريل (create() ذرّي: يفشل إذا موجود). يرجع 'created' | 'duplicate' */
async function publish(cand, media) {
  const { db, bucket, FieldValue } = fb();
  const id = docId(cand.platform, cand.sourceId);
  const ref = db.collection(COL).doc(id);
  if ((await ref.get()).exists) return 'duplicate';

  const embed = !!media.embedId;
  let hash = null, videoUrl = null, thumbUrl = media.thumbUrl || null;

  if (!embed) {
    // منع تكرار نفس الملف حرفياً (ريبوست بمنصة ثانية)
    hash = await sha1File(media.videoPath);
    const dup = await db.collection(COL).where('hash', '==', hash).limit(1).get();
    if (!dup.empty) return 'duplicate';
    videoUrl = await uploadFile(media.videoPath, `reels/${id}.mp4`, 'video/mp4');
    thumbUrl = media.thumbPath ? await uploadFile(media.thumbPath, `reels/${id}.jpg`, 'image/jpeg') : null;
  }

  try {
    await ref.create({
      platform: cand.platform,
      sourceId: cand.sourceId,
      sourceUrl: cand.sourceUrl,
      videoUrl,
      embedId: media.embedId || null,
      thumbUrl,
      title: (media.title || cand.title || '').slice(0, 300),
      owner: {
        name: media.ownerName || cand.ownerName || '',
        handle: media.ownerHandle || cand.ownerHandle || '',
        url: media.ownerUrl || cand.ownerUrl || ''
      },
      tag: cand.tag,
      category: cand.cat,
      duration: media.duration || null,
      width: media.width || null,
      height: media.height || null,
      sourceViews: media.viewsSource || cand.views || 0,
      hash,
      likes: 0,
      comments: 0,
      shares: 0,
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    // ALREADY_EXISTS (سباق بين دورتين) -> نحذف الملفات المرفوعة
    if (!embed) await Promise.allSettled([
      bucket.file(`reels/${id}.mp4`).delete(),
      bucket.file(`reels/${id}.jpg`).delete()
    ]);
    if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return 'duplicate';
    throw e;
  }
  return 'created';
}

/** حذف ريل كامل (وثيقة + ملفات + تعليقات + إعجابات) */
async function removeReel(docSnap) {
  const { db, bucket } = fb();
  const id = docSnap.id;
  const hasFiles = !!(docSnap.data() || {}).videoUrl;   // وضع التضمين: ما في ملفات بالتخزين
  await Promise.allSettled([
    ...(hasFiles ? [bucket.file(`reels/${id}.mp4`).delete(), bucket.file(`reels/${id}.jpg`).delete()] : []),
    db.recursiveDelete(docSnap.ref)
  ]);
}

/* ============================== cleanup ============================== */
/** يحذف الأقدم من KEEP_DAYS ثم يقصّ العدد على MAX_REELS */
async function cleanup() {
  const { db } = fb();
  let removed = 0;
  const cutoff = new Date(Date.now() - cfg.keepDays * 864e5);

  for (;;) {
    const old = await db.collection(COL).where('createdAt', '<', cutoff).orderBy('createdAt').limit(50).get();
    if (old.empty) break;
    for (const d of old.docs) { await removeReel(d); removed++; }
  }

  const total = (await db.collection(COL).count().get()).data().count;
  if (total > cfg.maxReels) {
    const extra = total - cfg.maxReels;
    const oldest = await db.collection(COL).orderBy('createdAt').limit(extra).get();
    for (const d of oldest.docs) { await removeReel(d); removed++; }
  }
  if (removed) log.info(`🧹 حذفت ${removed} ريل قديم`);
  return removed;
}

/* ============================== pipeline ============================== */
let running = false;

async function processTag(tagDef, stats) {
  const ya = shuffle(await ytCandidates(tagDef)), ta = shuffle(await ttCandidates(tagDef));
  const all = []; // نخلط يوتيوب وتيك توك بالتناوب حتى يطلع من الاثنين
  for (let i = 0; i < Math.max(ya.length, ta.length); i++) { if (ya[i]) all.push(ya[i]); if (ta[i]) all.push(ta[i]); }
  const fresh = await filterNew(all);
  stats.found += all.length;
  stats.duplicates += all.length - fresh.length;
  log.info(`#${tagDef.tag}: ${all.length} مرشّح، ${fresh.length} جديد`);

  let made = 0;
  for (const c of fresh) {
    if (made >= cfg.perTag) break;
    try {
      const media = await c.fetch();
      if (!media) { stats.skipped++; continue; } // مو رأسي / طويل
      const r = await publish(c, media);
      if (r === 'created') { made++; stats.created++; log.info(`  ✓ ${c.platform}/${c.sourceId} — ${(c.title || '').slice(0, 50)}`); }
      else stats.duplicates++;
    } catch (e) {
      stats.failed++;
      log.warn(`  ✗ ${c.platform}/${c.sourceId}: ${e.message}`);
    } finally {
      try { c.cleanup(); } catch (_) { /* ignore */ }
    }
  }
}

async function runCycle() {
  if (running) { log.warn('دورة شغّالة حالياً — تخطّيت'); return null; }
  running = true;
  const t0 = Date.now();
  const stats = { found: 0, created: 0, duplicates: 0, skipped: 0, failed: 0 };
  log.info('▶ بدأت دورة السحب');
  try {
    for (const tagDef of cfg.tags) {
      try { await processTag(tagDef, stats); }
      catch (e) { log.error(`#${tagDef.tag}: ${e.message}`); }
    }
    await cleanup().catch(e => log.warn(`cleanup: ${e.message}`));
  } finally {
    running = false;
  }
  stats.seconds = Math.round((Date.now() - t0) / 1000);
  log.info('■ انتهت الدورة:', JSON.stringify(stats));
  return stats;
}

/* ============================== web (الواجهة) ============================== */
// يقدّم vybe-auth.html من نفس المجلد على http://localhost:5173 (يوتيوب يرفض التضمين من file://).
// أمان: html/css/صور فقط — لا .js ولا .json ولا .env ولا ملفات مخفية، فمفاتيحك ما تنسحب.
const WEB_ROOT = __dirname;
const WEB_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function startWeb() {
  const home = ['vybe-auth.html', 'index.html'].find(f => fs.existsSync(path.join(WEB_ROOT, f)));
  http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch (_) { res.writeHead(400); return res.end(); }
    if (p === '/') p = '/' + (home || 'vybe-auth.html');
    const file = path.join(WEB_ROOT, p);
    const rel = path.relative(WEB_ROOT, file);
    const type = WEB_TYPES[path.extname(file).toLowerCase()];
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(x => x.startsWith('.')) || !type) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }).listen(cfg.webPort, () => log.info(`🖥  التطبيق: http://localhost:${cfg.webPort}${home ? '' : '  (⚠ ما لقيت vybe-auth.html بجنب الملف)'}`))
    .on('error', e => {
      if (e.code === 'EADDRINUSE') log.error(`المنفذ ${cfg.webPort} مشغول (سيرفر قديم شغّال؟). سكّر النافذة القديمة أو شغّل: set WEB_PORT=5174 && node server.js`);
      else log.error(e.message);
    });
}

/* ============================== main ============================== */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);

async function main() {
  if (has('--web')) { startWeb(); return; }

  try { log.info('yt-dlp', await ytVersion()); }
  catch (e) { log.error(`yt-dlp مو مثبّت/ما يشتغل (${e.message}). ثبّته: pip install -U yt-dlp  + ffmpeg`); process.exit(1); }

  try { fb(); }
  catch (e) { log.error(e.message); process.exit(1); }

  if (has('--once')) {
    await runCycle();
    process.exit(0);
  }

  let cron;
  try { cron = require('node-cron'); }
  catch (_) { log.error('node-cron غير مثبّت: npm i node-cron'); process.exit(1); }
  if (!cron.validate(cfg.cron)) { log.error(`CRON_SCHEDULE غير صالح: ${cfg.cron}`); process.exit(1); }

  cron.schedule(cfg.cron, () => { runCycle().catch(e => log.error(e.message)); });
  log.info(`⏰ الجدولة: ${cfg.cron}`);

  // Health + تشغيل يدوي
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/run' && cfg.adminKey && u.searchParams.get('key') === cfg.adminKey) {
      const started = !running;
      runCycle().catch(e => log.error(e.message));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ started }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running, cron: cfg.cron }));
  }).listen(cfg.port, () => log.info(`🌐 health على المنفذ ${cfg.port}`));

  if (!has('--no-web')) startWeb();

  // دورة أولى فوراً
  runCycle().catch(e => log.error(e.message));
}

process.on('unhandledRejection', e => log.error('unhandledRejection', e && e.message));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main();
