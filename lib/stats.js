// ---------------------------------------------------------------------------
// Usage stats: lifetime counters persisted to a small JSON file so they
// survive server restarts.
//
// Two counters are tracked:
//   - totalGenerateRequests: real calls sent to Gemini
//   - totalGeneratedImages:  images returned successfully
//
// Writes are atomic (write temp + rename) to avoid a half-written file if the
// process dies mid-write. Load/save failures never throw so the request flow
// is never blocked by stats bookkeeping.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

const stats = { totalGenerateRequests: 0, totalGeneratedImages: 0 };

// Reads the counters from disk into memory. Missing/corrupt file → start at 0.
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    stats.totalGenerateRequests = Number(parsed.totalGenerateRequests) || 0;
    stats.totalGeneratedImages = Number(parsed.totalGeneratedImages) || 0;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[stats] load failed, starting from 0:', err.message || err);
    }
  }
  return stats;
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    console.error('[stats] save failed:', err.message || err);
  }
}

function recordRequest() {
  stats.totalGenerateRequests += 1;
  save();
  return stats.totalGenerateRequests;
}

function recordGenerated() {
  stats.totalGeneratedImages += 1;
  save();
  return stats.totalGeneratedImages;
}

function get() {
  return stats;
}

module.exports = { load, save, recordRequest, recordGenerated, get };
