// ---------------------------------------------------------------------------
// Per-user generation limit: caps how many images each INITIAL can create for
// the whole event. Counts are keyed by the (normalised) INITIAL and persisted
// to a small JSON file so they survive server restarts.
//
// This is a soft, cooperative limit: the INITIAL is user-entered, so someone
// could change it to reset their quota. That trade-off is accepted by design.
// Writes are atomic (temp + rename); load/save never throw.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USAGE_FILE = path.join(DATA_DIR, 'user-usage.json');

let usage = {}; // { "<INITIAL>": count }

// Stable key: strip control chars, trim, cap length, uppercase.
function normalizeKey(initial) {
  if (typeof initial !== 'string') return '';
  return initial.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40).toUpperCase();
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') usage = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[userLimit] load failed, starting empty:', err.message || err);
    }
  }
  return usage;
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
    fs.renameSync(tmp, USAGE_FILE);
  } catch (err) {
    console.error('[userLimit] save failed:', err.message || err);
  }
}

function getCount(initial) {
  const key = normalizeKey(initial);
  if (!key) return 0;
  return usage[key] || 0;
}

// True when this initial has reached the cap. limit <= 0 means unlimited.
// An empty/untrackable initial is never blocked (can't attribute usage).
function isAtLimit(initial, limit) {
  if (!(limit > 0)) return false;
  const key = normalizeKey(initial);
  if (!key) return false;
  return (usage[key] || 0) >= limit;
}

function increment(initial) {
  const key = normalizeKey(initial);
  if (!key) return 0;
  usage[key] = (usage[key] || 0) + 1;
  save();
  return usage[key];
}

module.exports = { load, save, getCount, isAtLimit, increment, normalizeKey };
