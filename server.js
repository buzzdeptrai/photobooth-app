require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { GoogleGenAI } = require('@google/genai');
const storage = require('./lib/storage');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB) || 5;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

// Access control & token budget
const EVENT_CODE = (process.env.EVENT_CODE || '').trim();
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '0', 10); // 0 = unlimited

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = [
  {
    id: 'office-cartoon',
    label: 'Nh\u00e2n vi\u00ean ho\u1ea1t h\u00ecnh',
    preview: '/img/s1.png',
    prompt:
      'Transform this person into a friendly cartoon-style modern office worker. ' +
      'Keep the same face and identity clearly recognizable. Clean modern office ' +
      'background, Novo Nordisk blue color tone. Professional, cheerful, high quality illustration.'
  },
  {
    id: 'apis-buddy',
    label: 'Ch\u1ee5p c\u00f9ng b\u00f2 Apis',
    preview: '/img/s2.png',
    prompt:
      "Keep this person's face and identity. Place a cute friendly cartoon Apis bull " +
      'mascot standing next to them in a modern bright office. Warm, playful, Novo ' +
      'Nordisk blue accents. High quality.'
  },
  {
    id: 'digital-poster',
    label: 'Poster Digital Week',
    preview: '/img/s3.png',
    prompt:
      "Create an event poster style image from this photo. Keep the person's face " +
      "recognizable. Add clean modern 'Digital Week' vibe: subtle tech icons, blue " +
      'gradient, minimalist corporate design. Leave clear space at the top for a title.'
  }
];

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter
// ---------------------------------------------------------------------------

const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodically clean up stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Access control & daily token budget
// ---------------------------------------------------------------------------

function isValidCode(code) {
  if (!EVENT_CODE) return true; // feature disabled when no code configured
  return typeof code === 'string' && code.trim() === EVENT_CODE;
}

let dailyUsage = { date: '', count: 0 };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Returns false when the daily cap is reached; otherwise increments and returns true.
function reserveDailyQuota() {
  const today = todayStr();
  if (dailyUsage.date !== today) {
    dailyUsage = { date: today, count: 0 };
  }
  if (DAILY_LIMIT > 0 && dailyUsage.count >= DAILY_LIMIT) {
    return false;
  }
  dailyUsage.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDataUri(dataUri) {
  const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/s);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function estimateBase64Bytes(base64Str) {
  return Math.ceil((base64Str.length * 3) / 4);
}

function sanitiseStyleForClient(style) {
  return { id: style.id, label: style.label, preview: style.preview, prompt: style.prompt };
}

const MAX_PROMPT_LENGTH = 2000;

function resolvePrompt(style, customPrompt) {
  if (typeof customPrompt !== 'string') return style.prompt;
  const trimmed = customPrompt.trim();
  if (!trimmed) return style.prompt;
  return trimmed.slice(0, MAX_PROMPT_LENGTH);
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Block search engines & crawlers (keep the app private, avoid token abuse)
app.use((_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  next();
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(storage.LOCAL_PUBLIC_PATH, express.static(storage.LOCAL_DIR));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/styles', (_req, res) => {
  res.json(STYLES.map(sanitiseStyleForClient));
});

app.get('/api/config', (_req, res) => {
  res.json({ requireCode: Boolean(EVENT_CODE) });
});

app.post('/api/verify-code', (req, res) => {
  if (isValidCode(req.body && req.body.code)) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'M\u00e3 s\u1ef1 ki\u1ec7n kh\u00f4ng \u0111\u00fang.' });
});

app.post('/api/generate', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
      return res.status(429).json({ error: 'Qu\u00e1 nhi\u1ec1u y\u00eau c\u1ea7u. Vui l\u00f2ng th\u1eed l\u1ea1i sau 1 ph\u00fat.' });
    }

    const { image, styleId, prompt: customPrompt, code } = req.body;

    if (!isValidCode(code)) {
      return res.status(401).json({ error: 'M\u00e3 s\u1ef1 ki\u1ec7n kh\u00f4ng \u0111\u00fang ho\u1eb7c \u0111\u00e3 h\u1ebft hi\u1ec7u l\u1ef1c.' });
    }

    if (!image) {
      return res.status(400).json({ error: 'Thi\u1ebfu \u1ea3nh \u0111\u1ea7u v\u00e0o.' });
    }
    if (!styleId) {
      return res.status(400).json({ error: 'Thi\u1ebfu ki\u1ec3u phong c\u00e1ch.' });
    }

    const style = STYLES.find((s) => s.id === styleId);
    if (!style) {
      return res.status(400).json({ error: 'Phong c\u00e1ch kh\u00f4ng h\u1ee3p l\u1ec7.' });
    }

    const parsed = parseDataUri(image);
    if (!parsed) {
      return res.status(400).json({ error: '\u0110\u1ecbnh d\u1ea1ng \u1ea3nh kh\u00f4ng h\u1ee3p l\u1ec7.' });
    }

    if (estimateBase64Bytes(parsed.data) > MAX_IMAGE_BYTES) {
      return res.status(400).json({ error: `\u1ea2nh v\u01b0\u1ee3t qu\u00e1 ${MAX_IMAGE_MB}MB.` });
    }

    if (!reserveDailyQuota()) {
      return res.status(429).json({ error: '\u0110\u00e3 \u0111\u1ea1t gi\u1edbi h\u1ea1n t\u1ea1o \u1ea3nh trong ng\u00e0y. Vui l\u00f2ng quay l\u1ea1i sau.' });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: parsed.mimeType, data: parsed.data } },
            { text: resolvePrompt(style, customPrompt) }
          ]
        }
      ],
      config: {
        responseModalities: ['Text', 'Image']
      }
    });

    const parts = response.candidates[0].content.parts;
    const imagePart = parts.find((p) => p.inlineData);

    if (!imagePart) {
      return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 t\u1ea1o \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i.' });
    }

    const resultBase64 = imagePart.inlineData.data;
    const resultMime = imagePart.inlineData.mimeType;

    return res.json({ image: `data:${resultMime};base64,${resultBase64}` });
  } catch (err) {
    console.error('[generate] Error:', err.message || err);
    return res.status(502).json({ error: 'L\u1ed7i khi t\u1ea1o \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i sau.' });
  }
});

app.post('/api/store', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Thi\u1ebfu \u1ea3nh \u0111\u1ec3 l\u01b0u.' });
    }

    const parsed = parseDataUri(image);
    if (!parsed) {
      return res.status(400).json({ error: '\u0110\u1ecbnh d\u1ea1ng \u1ea3nh kh\u00f4ng h\u1ee3p l\u1ec7.' });
    }

    const saved = await storage.saveImage(parsed.data, parsed.mimeType, getBaseUrl(req));
    const qr = await QRCode.toDataURL(saved.url, { margin: 1, width: 240 });

    return res.json({ url: saved.url, id: saved.id, qr });
  } catch (err) {
    console.error('[store] Error:', err.message || err);
    return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 l\u01b0u \u1ea3nh. Vui l\u00f2ng th\u1eed l\u1ea1i.' });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Photo Booth AI server running on http://localhost:${PORT}`);
});
