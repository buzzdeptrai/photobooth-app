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
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = [
  {
    id: 'digital-leader',
    label: 'Empowered Digital Leader',
    preview: '/img/s1.png',
    prompt:
      'A high-end editorial corporate portrait of the person in this photo, strictly ' +
      'maintaining 100% identical facial features, natural skin tone, eyes, and genuine ' +
      'expression without distortion. The subject poses as an Empowered Digital Leader during ' +
      'Novo Nordisk Digital Week, exuding confidence and intellect, looking directly at the ' +
      'camera with a subtle, warm smile. Dressed in a bespoke tailored Novo Nordisk deep navy ' +
      'blue blazer with a subtle metallic company pin on the lapel, layered over an elegant silk ' +
      'white or light-cream inner blouse/shirt. Naturally holding a sleek digital tablet and an ' +
      'executive leather portfolio notebook. Set in a grand, state-of-the-art corporate innovation ' +
      'hub with high ceilings, vast glass architecture, and subtle blurred displays showing ' +
      'holographic medical charts, DNA structures, and digital analytics. Prominent yet tasteful ' +
      "event branding with 'DIGITAL WEEK' and 'EMPOWERING HEALTHCARE' standees, paired with refined " +
      'navy, white, and silver balloons and corporate floral accents. Soft daylight through ' +
      'expansive floor-to-ceiling glass blended with modern studio rim lighting. Shallow depth of ' +
      'field, creamy bokeh, clean 8k photorealistic resolution, authentic 35mm photography aesthetic.'
  },
  {
    id: 'nordic-grace',
    label: 'Nordic Grace Celebration (20/10)',
    preview: '/img/s2.png',
    prompt:
      'A natural-light corporate event portrait of the person in this photo, strictly preserving ' +
      'their authentic facial identity, bone structure, and facial expression. The subject stands ' +
      "in a vibrant corporate office lobby during Novo Nordisk's Vietnamese Women's Day (October 20) " +
      'celebration. Wearing an elegant navy blue blazer over a soft pastel pink or cream dress shirt, ' +
      'gracefully holding a delicate bouquet of fresh pastel roses, lisianthus, and lush greenery ' +
      'tied with a neat navy blue ribbon. Looking at the camera with a warm, welcoming smile. The ' +
      'modern glass-and-steel lobby is tastefully decorated for an office company party: branded ' +
      "backdrops reading 'Chúc mừng Ngày Phụ nữ Việt Nam 20-10' and 'Happy Women's Day 20/10', " +
      "standing 'Digital Week' roll-up banners, and clusters of corporate blue and white balloons. " +
      'Blurred background shows corporate colleagues casually networking, completely free of any ' +
      'wedding drapes, romantic arches, or wedding-like motifs. Bright, diffused daylight through ' +
      'lobby windows, shallow depth of field, sharp subject focus, realistic photographic texture.'
  },
  {
    id: 'future-healthcare',
    label: 'Future Healthcare & AI Innovation',
    preview: '/img/s3.png',
    prompt:
      'A visionary future healthcare portrait of the person in this photo, accurately preserving ' +
      'their identical facial features, eyes, and natural skin texture. Dressed in a sleek, ' +
      'smart-casual corporate blazer in Novo Nordisk True Blue (#001965) over a clean white shirt, ' +
      'featuring a discreet logo on the chest. Set inside a cutting-edge healthcare technology ' +
      'laboratory and digital innovation center, strictly devoid of any party decorations or flowers. ' +
      'The background features glowing medical data monitors, floating network connection nodes, ' +
      "smart health visualization screens, and frosted glass partitions with faint 'FUTURE HEALTHCARE' " +
      'typography. Controlled cool-toned interior illumination with soft blue and teal ambient rim ' +
      'lights. Sharp focus on the subject, balanced studio depth of field, premium editorial look, ' +
      'photorealistic 8k render.'
  },
  {
    id: 'driving-change',
    label: 'Driving Change & Dynamic Collaboration',
    preview: '/img/s4.png',
    prompt:
      'An energetic, candid lifestyle corporate portrait of the person in this photo, preserving ' +
      'authentic face shape, smile, and natural facial proportions. Wearing a casual corporate navy ' +
      'blue polo shirt with a subtle chest logo. Positioned in a bustling, open-concept collaborative ' +
      'workspace and innovation lounge. Warm daylight streams through expansive windows, illuminating ' +
      'an interactive company culture atmosphere: blurred colleagues brainstorming at touchscreens, ' +
      "event display boards with 'DRIVING CHANGE' and 'DIGITAL WEEK', and modest company-colored " +
      'decorative balloons. Authentic documentary feel, dynamic yet professional, shallow depth of ' +
      'field, sharp eye focus, crisp 35mm camera aesthetics.'
  },
  {
    id: 'digital-toy',
    label: 'The Digital Toy',
    preview: '/img/s5.png',
    prompt:
      'A high-quality, professional 3D toy figure based on the person in this photo, strictly ' +
      'maintaining 100% identical facial features, original skin tone, eyes, and friendly ' +
      'expression, reimagined as an adorable chibi-style collectible art toy (blind box figure ' +
      "style, similar to Pop Mart). The character is an 'AI & DIGITAL WEEK' champion, wearing a " +
      'cute oversized deep navy blue hoodie with a tiny Novo Nordisk logo and futuristic ' +
      'data/network motifs on the chest, paired with tiny stylish blue and white sneakers. The ' +
      "figure is standing on a mini glossy plastic pedestal with 'SPECIAL EDITION 20/10' written " +
      'on it, positioned inside or next to a transparent open-front toy packaging box (blind box ' +
      "style) decorated with vibrant 'NOVO NORDISK DIGITAL WEEK' and 'HAPPY WOMEN'S DAY 20/10' " +
      'branding, logos, and playful digital glitches. Soft, colorful volumetric lighting illuminates ' +
      'the scene, highlighting shiny, smooth plastic/resin toy materials, vibrant pastel gradients, ' +
      'and playful holographic micro-details on the box packaging. In the background, there is a ' +
      'blurry, out-of-focus corporate office. Creative CGI/Clay 3D render, Octane render, pop-toy ' +
      'art aesthetic with rich depth of field.'
  },
  {
    id: 'webtoon-weekday',
    label: 'Webtoon Weekday',
    preview: '/img/s6.png',
    prompt:
      'A vibrant, high-quality 2D anime/manhwa Webtoon-style illustration of the person in this ' +
      'photo, strictly maintaining 100% identical and recognizable facial features, hairstyle, and ' +
      'friendly expression in an anime/manhwa aesthetic. The subject is depicted in a lively, candid ' +
      "office scenario for 'Novo Nordisk Digital Week'. Wearing a stylish, relaxed-fit navy blue " +
      'corporate-casual shirt with a tiny brand emblem on the chest, carrying a modern digital tablet ' +
      'and a keycard lanyard. Naturally looking at the camera with a cheerful, energetic Gen-Z smile. ' +
      "Set in a colorful, hand-drawn anime office lobby filled with digital screens, 'DIGITAL WEEK " +
      "20/10' and 'HAPPY WOMEN'S DAY!' banner decorations, playful tech icons, balloons, confetti, and " +
      'comic-style background staff. The artwork features crisp cel-shading, rich pastel and navy blue ' +
      'palettes, expressive action lines, and soft overlay glows. A cinematic Webtoon/Manhwa panel ' +
      'composition with colorful sparkles and digital particles.'
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

function normaliseCode(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
}

function isValidCode(code) {
  if (!EVENT_CODE) return true; // feature disabled when no code configured
  return typeof code === 'string' && normaliseCode(code) === normaliseCode(EVENT_CODE);
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

app.get('/api/gallery', async (req, res) => {
  if (!ADMIN_TOKEN || (req.query.token || '').trim() !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const items = await storage.listImages(getBaseUrl(req));
    return res.json({ count: items.length, items });
  } catch (err) {
    console.error('[gallery] Error:', err.message || err);
    return res.status(502).json({ error: 'Kh\u00f4ng th\u1ec3 t\u1ea3i danh s\u00e1ch \u1ea3nh.' });
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
