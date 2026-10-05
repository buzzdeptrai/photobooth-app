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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const LOCAL_DIR = path.join(__dirname, '..', 'storage');
const LOCAL_PUBLIC_PATH = '/storage';
const S3_PREFIX = 'photo-booth';

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

// Persist an image and return a publicly reachable URL + its id.
async function saveImage(base64, mimeType, baseUrl) {
  const id = crypto.randomUUID();
  const fileName = `${id}.${extFromMime(mimeType)}`;
  const url = s3Configured
    ? await uploadToS3(`${S3_PREFIX}/${fileName}`, base64, mimeType)
    : saveToLocal(fileName, base64, baseUrl);
  return { id, url };
}

module.exports = {
  saveImage,
  isCloudEnabled,
  LOCAL_DIR,
  LOCAL_PUBLIC_PATH
};
