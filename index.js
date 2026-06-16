/**

* Fantrove Community Worker
* Receives issue reports and forwards them to a Discord webhook.
* 
* Domain: community.nontakorn2600.workers.dev
* Endpoint: POST /report
* 
* Environment variables (set via wrangler secret):
* DISCORD_WEBHOOK_URL  — Discord webhook URL
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

if (entry.count >= RATE_LIMIT_MAX) {
return true;
}

entry.count++;
return false;
}

// ── Helpers ─────────────────────────────────────────────

function json(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: {
'Content-Type': 'application/json',
...corsHeaders(),
},
});
}

function truncate(str, max) {
if (!str) return '';
if (str.length <= max) return str;
return str.slice(0, max - 3) + '...';
}

// ── Category → emoji mapping ──────────────────────────

const CATEGORY_EMOJI = {
'🐛 Bug': '🐛',
'🌐 Translation Issue': '🌐',
'🔗 Broken Link': '🔗',
'📱 Mobile UI Issue': '📱',
'⚡ Performance Issue': '⚡',
'📄 Incorrect Information': '📄',
'💡 Suggestion': '💡',
'❓ Other': '❓',

// Thai
'🐛 บั๊ก': '🐛',
'🌐 ปัญหาการแปล': '🌐',
'🔗 ลิงก์เสีย': '🔗',
'📱 ปัญหา UI บนมือถือ': '📱',
'⚡ ปัญหาประสิทธิภาพ': '⚡',
'📄 ข้อมูลไม่ถูกต้อง': '📄',
'💡 ข้อเสนอแนะ': '💡',
'❓ อื่นๆ': '❓',
};

// ── Discord webhook ────────────────────────────────────

async function sendToDiscord(webhookUrl, data) {
const emoji = CATEGORY_EMOJI[data.category] || '🐛';

const fields = [
{
name: 'Category',
value: data.category,
inline: true,
},
{
name: 'Page',
value: data.page,
inline: true,
},
];

if (data.language) {
fields.push({
name: 'Language',
value: data.language,
inline: true,
});
}

if (data.version) {
fields.push({
name: 'Version',
value: data.version,
inline: true,
});
}

if (data.device) {
fields.push({
name: 'Device',
value: data.device,
inline: true,
});
}

if (data.browser) {
fields.push({
name: 'Browser',
value: data.browser,
inline: true,
});
}

fields.push({
name: 'Message',
value: truncate(data.message, 1024),
});

if (data.expected) {
fields.push({
name: 'Expected',
value: truncate(data.expected, 1024),
});
}

if (data.email) {
fields.push({
name: 'Contact',
value: data.email,
inline: true,
});
}

const embed = {
title: "${emoji} New Report",
color: 0x13b47f,
fields,
timestamp: new Date().toISOString(),
footer: {
text: 'Fantrove Report System',
},
};

const resp = await fetch(webhookUrl, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
},
body: JSON.stringify({
embeds: [embed],
}),
});

if (!resp.ok) {
const text = await resp.text().catch(() => '');
throw new Error(
"Discord webhook returned ${resp.status}: ${truncate(text, 200)}"
);
}
}

// ── POST /report handler ──────────────────────────────

async function handleReport(request, env, ctx) {
const ip =
request.headers.get('CF-Connecting-IP') || 'unknown';

if (isRateLimited(ip)) {
return json(
{
error: 'Too many reports. Please try again later.',
},
429
);
}

const ct = request.headers.get('Content-Type') || '';

if (!ct.includes('application/json')) {
return json(
{
error: 'Content-Type must be application/json',
},
400
);
}

let body;

try {
body = await request.json();
} catch (_) {
return json(
{
error: 'Invalid JSON body',
},
400
);
}

if (!body.category || !body.message || !body.page) {
return json(
{
error: 'Missing required fields: category, message, page',
},
400
);
}

if (body.message && body.message.length > 2000) {
return json(
{
error: 'Message too long (max 2000 characters)',
},
400
);
}

if (body.expected && body.expected.length > 2000) {
return json(
{
error: 'Expected behavior too long (max 2000 characters)',
},
400
);
}

if (
body.email &&
!/^[^\s@]+@[^\s@]+.[^\s@]+$/.test(body.email)
) {
return json(
{
error: 'Invalid email format',
},
400
);
}

const webhookUrl = env.DISCORD_WEBHOOK_URL;

if (!webhookUrl) {
console.error('DISCORD_WEBHOOK_URL is not configured');

return json(
  {
    error: 'Report service is not configured',
  },
  500
);

}

try {
await sendToDiscord(webhookUrl, body);

return json({
  success: true,
});

} catch (err) {
console.error(
'[report] Discord send failed:',
err.message
);

return json(
  {
    error:
      'Failed to submit report. Please try again later.',
  },
  500
);

}
}

// ── Main fetch handler ────────────────────────────────

export default {
async fetch(request, env, ctx) {
const url = new URL(request.url);

// CORS preflight เฉพาะ /report
if (
  request.method === 'OPTIONS' &&
  url.pathname === '/report'
) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// POST /report
if (
  request.method === 'POST' &&
  url.pathname === '/report'
) {
  return handleReport(request, env, ctx);
}

// ทุกเส้นทางที่เหลือเป็น 404
return json(
  {
    error: 'Not Found',
  },
  404
);

},
};