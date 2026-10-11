// ---------------------------------------------------------------------------
// Discord webhook notifier
//
// Sends lightweight, fire-and-forget alerts to a Discord channel so the
// operator knows when the server is under load (requests queuing) or
// overloaded (rejecting with 503). Alerts are throttled per key so a burst of
// traffic cannot spam the channel. Fully disabled when DISCORD_WEBHOOK_URL is
// not configured.
// ---------------------------------------------------------------------------

const os = require('os');

const WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const SERVER_NAME = (process.env.SERVER_NAME || os.hostname() || 'unknown-server').trim();
const COOLDOWN_MS = Number(process.env.DISCORD_COOLDOWN_MS) || 60 * 1000;

// Tracks the last time each alert key was sent, to enforce the cooldown window.
const lastSentAt = new Map();

function withinCooldown(key) {
  const now = Date.now();
  const last = lastSentAt.get(key) || 0;
  if (now - last < COOLDOWN_MS) return true;
  lastSentAt.set(key, now);
  return false;
}

async function post(content) {
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (err) {
    console.error('[discord] notify failed:', err.message || err);
  }
}

// Fire-and-forget alert, throttled per key. Never throws, never blocks callers.
function notify(key, message) {
  if (!WEBHOOK_URL) return;
  if (withinCooldown(key)) return;
  const stamp = new Date().toISOString();
  post(`**[${SERVER_NAME}]** ${message}\n\`${stamp}\``);
}

module.exports = { notify, SERVER_NAME };
