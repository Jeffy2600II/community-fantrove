/**
 * Fantrove Community Worker
 * Receives issue reports and forwards them to a Discord webhook.
 *
 * Domain: community.nontakorn2600.workers.dev
 * Endpoint: POST /report
 *
 * Environment variables (set via wrangler secret):
 *   DISCORD_WEBHOOK_URL  — Discord webhook URL
 */

// ── CORS ────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': 'https://fantrove.pages.dev',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── Rate limiter (per-IP, in-memory) ───────────────────

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 3; // 3 reports per window

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.first > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, first: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

// ── Helpers ─────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ── Category → emoji mapping ──────────────────────────

const CATEGORY_EMOJI = {
  '\u{1F41B} Bug': '\u{1F41B}',
  '\u{1F310} Translation Issue': '\u{1F310}',
  '\u{1F517} Broken Link': '\u{1F517}',
  '\u{1F4F1} Mobile UI Issue': '\u{1F4F1}',
  '\u{26A1} Performance Issue': '\u{26A1}',
  '\u{1F4C4} Incorrect Information': '\u{1F4C4}',
  '\u{1F4A1} Suggestion': '\u{1F4A1}',
  '\u{2753} Other': '\u{2753}',
  // Thai
  '\u{1F41B} \u0E1A\u0E31\u0E4A\u0E01': '\u{1F41B}',
  '\u{1F310} \u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E01\u0E32\u0E23\u0E41\u0E1B\u0E25': '\u{1F310}',
  '\u{1F517} \u0E25\u0E34\u0E07\u0E01\u0E4C\u0E40\u0E2A\u0E35\u0E22': '\u{1F517}',
  '\u{1F4F1} \u0E1B\u0E31\u0E0D\u0E2B\u0E32 UI \u0E1A\u0E19\u0E21\u0E37\u0E2D\u0E16\u0E37\u0E2D': '\u{1F4F1}',
  '\u{26A1} \u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E1B\u0E23\u0E30\u0E2A\u0E34\u0E17\u0E18\u0E34\u0E20\u0E32\u0E1E': '\u{26A1}',
  '\u{1F4C4} \u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07': '\u{1F4C4}',
  '\u{1F4A1} \u0E02\u0E49\u0E2D\u0E40\u0E2A\u0E19\u0E2D\u0E41\u0E19\u0E30': '\u{1F4A1}',
  '\u{2753} \u0E2D\u0E37\u0E48\u0E19\u0E46': '\u{2753}',
};

// ── Discord webhook ────────────────────────────────────

async function sendToDiscord(webhookUrl, data) {
  const emoji = CATEGORY_EMOJI[data.category] || '\u{1F41B}';
  
  const fields = [
    { name: 'Category', value: data.category, inline: true },
    { name: 'Page', value: data.page, inline: true },
  ];
  
  if (data.language) fields.push({ name: 'Language', value: data.language, inline: true });
  if (data.version) fields.push({ name: 'Version', value: data.version, inline: true });
  if (data.device) fields.push({ name: 'Device', value: data.device, inline: true });
  if (data.browser) fields.push({ name: 'Browser', value: data.browser, inline: true });
  
  fields.push({ name: 'Message', value: truncate(data.message, 1024) });
  
  if (data.expected) {
    fields.push({ name: 'Expected', value: truncate(data.expected, 1024) });
  }
  
  if (data.email) {
    fields.push({ name: 'Contact', value: data.email, inline: true });
  }
  
  const embed = {
    title: emoji + ' New Report',
    color: 0x13b47f,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'Fantrove Report System' },
  };
  
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('Discord webhook returned ' + resp.status + ': ' + truncate(text, 200));
  }
}

// ── POST /report handler ──────────────────────────────

async function handleReport(request, env, ctx) {
  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return json({ error: 'Too many reports. Please try again later.' }, 429);
  }
  
  // Validate content type
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    return json({ error: 'Content-Type must be application/json' }, 400);
  }
  
  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  
  // Validate required fields
  if (!body.category || !body.message || !body.page) {
    return json({ error: 'Missing required fields: category, message, page' }, 400);
  }
  
  // Length limits
  if (body.message && body.message.length > 2000) {
    return json({ error: 'Message too long (max 2000 characters)' }, 400);
  }
  if (body.expected && body.expected.length > 2000) {
    return json({ error: 'Expected behavior too long (max 2000 characters)' }, 400);
  }
  
  // Validate email format if provided
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return json({ error: 'Invalid email format' }, 400);
  }
  
  // Send to Discord
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('DISCORD_WEBHOOK_URL is not configured');
    return json({ error: 'Report service is not configured' }, 500);
  }
  
  try {
    await sendToDiscord(webhookUrl, body);
    return json({ success: true });
  } catch (err) {
    console.error('[report] Discord send failed:', err.message);
    return json({ error: 'Failed to submit report. Please try again later.' }, 500);
  }
}

// ── Main fetch handler ────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    
    // POST /report
    if (url.pathname === '/report' && request.method === 'POST') {
      return handleReport(request, env, ctx);
    }
    
    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ status: 'ok', service: 'fantrove-community', version: '1.0.0' });
    }
    
    return json({ error: 'Not Found' }, 404);
  },
};