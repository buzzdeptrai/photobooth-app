// ---------------------------------------------------------------------------
// Storage: upload generated images to an S3-compatible bucket (Vietnix),
// with a local-disk fallback.
//
// If the AWS_* env vars are present, images are uploaded to the bucket and a
// public URL is returned. Otherwise images are written to ./storage and served
// via /storage. This lets the app run for real immediately, and switch to S3
// by adding keys — no code change required.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const LOCAL_DIR = path.join(__dirname, '..', 'storage');
const LOCAL_PUBLIC_PATH = '/storage';
const S3_PREFIX = 'photo-booth';
const INDEX_S3_KEY = `${S3_PREFIX}/index.ndjson`;
const LOCAL_INDEX_FILE = path.join(LOCAL_DIR, 'index.ndjson');
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const s3Config = {
  bucket: process.env.AWS_BUCKET,
  region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};

const s3Configured = Boolean(
  s3Config.bucket && s3Config.accessKeyId && s3Config.secretAccessKey
);

let s3Client = null;
if (s3Configured) {
  s3Client = new S3Client({
    region: s3Config.region,
    endpoint: s3Config.endpoint,
    // Path-style is required for most S3-compatible providers.
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey
    }
  });
}

function isCloudEnabled() {
  return s3Configured;
}

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_DIR)) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
  }
}

function extFromMime(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function buildPublicUrl(key) {
  const base = s3Config.endpoint.replace(/\/+$/, '');
  return `${base}/${s3Config.bucket}/${key}`;
}

async function uploadToS3(key, base64, mimeType) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: Buffer.from(base64, 'base64'),
      ContentType: mimeType,
      ACL: 'public-read'
    })
  );
  return buildPublicUrl(key);
}

function saveToLocal(fileName, base64, baseUrl) {
  ensureLocalDir();
  fs.writeFileSync(path.join(LOCAL_DIR, fileName), Buffer.from(base64, 'base64'));
  return `${baseUrl}${LOCAL_PUBLIC_PATH}/${fileName}`;
}

// Normalise an initial into a lowercase, accent-free token used for filtering.
function slugifyInitial(initial) {
  if (!initial) return '';
  return String(initial)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase();
}

// Persist an image and return a publicly reachable URL + its id/size/mime.
async function saveImage(base64, mimeType, baseUrl) {
  const id = crypto.randomUUID();
  const fileName = `${id}.${extFromMime(mimeType)}`;
  const url = s3Configured
    ? await uploadToS3(`${S3_PREFIX}/${fileName}`, base64, mimeType)
    : saveToLocal(fileName, base64, baseUrl);
  return { id, url, size: Buffer.byteLength(base64, 'base64'), mimeType };
}

// List all stored images (newest first). Uses S3 when configured, else local disk.
async function listImages(baseUrl) {
  if (s3Configured) return listFromS3();
  return listFromLocal(baseUrl);
}

async function listFromS3() {
  const items = [];
  let token;
  do {
    const out = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: s3Config.bucket,
        Prefix: `${S3_PREFIX}/`,
        ContinuationToken: token
      })
    );
    (out.Contents || []).forEach((o) => {
      if (!IMAGE_EXT_RE.test(o.Key)) return;
      items.push({
        key: o.Key,
        url: buildPublicUrl(o.Key),
        size: o.Size,
        lastModified: o.LastModified
      });
    });
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return sortNewest(items);
}

function listFromLocal(baseUrl) {
  ensureLocalDir();
  const items = fs.readdirSync(LOCAL_DIR)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(LOCAL_DIR, f));
      return {
        key: f,
        url: `${baseUrl}${LOCAL_PUBLIC_PATH}/${f}`,
        size: stat.size,
        lastModified: stat.mtime
      };
    });
  return sortNewest(items);
}

function sortNewest(items) {
  return items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
}

// ---------------------------------------------------------------------------
// Index: an append-only NDJSON "ledger" mapping each image to its initial and
// metadata, so the gallery can search / filter by initial. Lives on S3 (same
// bucket as the images) when configured, otherwise on local disk.
// ---------------------------------------------------------------------------

// Serialise index writes: S3 has no append, so each write is read-modify-write.
// A single in-process promise chain prevents concurrent writers overwriting.
let indexWriteChain = Promise.resolve();
function withIndexLock(fn) {
  const run = indexWriteChain.then(fn, fn);
  indexWriteChain = run.then(() => {}, () => {});
  return run;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

async function readIndexText() {
  if (s3Configured) {
    try {
      const out = await s3Client.send(
        new GetObjectCommand({ Bucket: s3Config.bucket, Key: INDEX_S3_KEY })
      );
      return await streamToString(out.Body);
    } catch (err) {
      const code = err && (err.name || err.Code);
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) return '';
      throw err;
    }
  }
  ensureLocalDir();
  if (!fs.existsSync(LOCAL_INDEX_FILE)) return '';
  return fs.readFileSync(LOCAL_INDEX_FILE, 'utf8');
}

function parseIndex(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}

async function readIndexEntries() {
  return parseIndex(await readIndexText());
}

// Append one entry to the index. Safe to await; never throws to the caller's
// critical path if wrapped by the caller (store still succeeds without index).
async function appendIndexEntry(entry) {
  const line = JSON.stringify(entry);
  return withIndexLock(async () => {
    if (s3Configured) {
      const current = await readIndexText();
      const sep = current && !current.endsWith('\n') ? '\n' : '';
      const next = current + sep + line + '\n';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3Config.bucket,
          Key: INDEX_S3_KEY,
          Body: next,
          ContentType: 'application/x-ndjson'
        })
      );
    } else {
      ensureLocalDir();
      fs.appendFileSync(LOCAL_INDEX_FILE, line + '\n');
    }
  });
}

function extractId(key) {
  const m = String(key || '').match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

// Recover an initial from a legacy filename slug (older images saved before the
// index existed used a `<slug>-<uuid>` naming scheme).
function initialFromKey(key) {
  const base = String(key || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  const slug = base.replace(new RegExp('-?' + UUID_RE.source + '$', 'i'), '');
  const name = slug.replace(/-+/g, ' ').trim();
  return name || null;
}

// Gallery view: merge the authoritative image listing with index metadata.
// Images missing from the index (legacy) fall back to their filename slug.
async function listGallery(opts = {}) {
  const { baseUrl, q, sort } = opts;
  const [images, entries] = await Promise.all([
    listImages(baseUrl),
    readIndexEntries().catch(() => [])
  ]);

  const byId = new Map();
  entries.forEach((e) => { if (e && e.id) byId.set(String(e.id).toLowerCase(), e); });

  let items = images.map((img) => {
    const entry = byId.get(extractId(img.key));
    const initial = (entry && entry.initial) || initialFromKey(img.key) || null;
    return {
      url: img.url,
      key: img.key,
      size: entry && entry.size ? entry.size : img.size,
      createdAt: (entry && entry.createdAt) || img.lastModified,
      styleId: entry ? (entry.styleId || null) : null,
      initial,
      initialSlug: slugifyInitial(initial)
    };
  });

  if (q) {
    const needle = slugifyInitial(q);
    if (needle) items = items.filter((it) => it.initialSlug.indexOf(needle) !== -1);
  }

  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (sort === 'old') items.reverse();
  return items;
}

module.exports = {
  saveImage,
  listImages,
  listGallery,
  appendIndexEntry,
  readIndexEntries,
  slugifyInitial,
  isCloudEnabled,
  LOCAL_DIR,
  LOCAL_PUBLIC_PATH
};
