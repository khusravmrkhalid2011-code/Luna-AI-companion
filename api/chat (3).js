// Vercel Edge Function: checks the user's Firebase sign-in, then asks a "brain" for the reply.
// Brains are tried in this order and Luna switches automatically when one is out of credit, busy or down:
//   1. Google Gemini Flash   (GEMINI_API_KEY)      - main brain
//   2. Groq Cloud            (GROQ_API_KEY)
//   3. OpenRouter            (OPENROUTER_API_KEY)
//   4. Ollama Cloud          (OLLAMA_API_KEY)      - optional, last
// The chat history is sent with every request, so the conversation simply continues on whichever brain answers.
export const config = { runtime: 'edge' };
const seen = new Map();
async function verify(token) {
  const hit = seen.get(token); if (hit && hit > Date.now()) return true;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  if (!r.ok) return false;
  const u = ((await r.json()).users || [])[0]; if (!u || u.disabled) return false;
  if (seen.size > 500) seen.clear(); seen.set(token, Date.now() + 300000); return true;
}
function same(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const E = (k) => (process.env[k] || '').trim();
function brains() {
  const L = [];
  if (E('GEMINI_API_KEY')) L.push({ name: 'gemini', key: E('GEMINI_API_KEY'), url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: E('GEMINI_MODEL') || 'gemini-2.5-flash', vision: E('GEMINI_MODEL') || 'gemini-2.5-flash' });
  if (E('GROQ_API_KEY')) L.push({ name: 'groq', key: E('GROQ_API_KEY'), url: 'https://api.groq.com/openai/v1/chat/completions', model: E('GROQ_MODEL') || 'llama-3.3-70b-versatile', vision: E('GROQ_VISION_MODEL') || 'meta-llama/llama-4-scout-17b-16e-instruct' });
  if (E('OPENROUTER_API_KEY')) L.push({ name: 'openrouter', key: E('OPENROUTER_API_KEY'), url: 'https://openrouter.ai/api/v1/chat/completions', model: E('OPENROUTER_MODEL') || 'meta-llama/llama-3.3-70b-instruct:free', vision: E('OPENROUTER_VISION_MODEL') || 'google/gemma-3-27b-it:free', extra: { models: (E('OPENROUTER_FALLBACKS') || 'openai/gpt-oss-20b:free,google/gemma-3-27b-it:free').split(',').map((s) => s.trim()).filter(Boolean) } });
  return L;
}
function toOpenAI(msgs, withImages) {
  const out = [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', text = String(m.content == null ? '' : m.content), imgs = withImages && Array.isArray(m.images) ? m.images : [];
    if (imgs.length) out.push({ role, content: [{ type: 'text', text: text || 'Look at this image.' }].concat(imgs.map((b) => ({ type: 'image_url', image_url: { url: /^data:/.test(b) ? b : 'data:image/jpeg;base64,' + b } }))) });
    else if (text.trim()) out.push({ role, content: text });
  }
  return out;
}
// OpenAI-style server-sent events in, Luna's line-by-line JSON out
function translate(up, name) {
  const dec = new TextDecoder(), enc = new TextEncoder(), rd = up.body.getReader(); let buf = '', sent = false;
  return new ReadableStream({
    async pull(ctl) {
      for (;;) {
        const { value, done } = await rd.read();
        if (done) { if (!sent) ctl.enqueue(enc.encode(JSON.stringify({ error: 'The ' + name + ' brain sent an empty answer. Ask again.' }) + '\n')); else ctl.enqueue(enc.encode(JSON.stringify({ done: true }) + '\n')); return ctl.close(); }
        buf += dec.decode(value, { stream: true }); let i, any = false;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln.indexOf('data:') !== 0) continue; const d = ln.slice(5).trim(); if (!d || d === '[DONE]') continue;
          try { const j = JSON.parse(d), c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (j.error) { ctl.enqueue(enc.encode(JSON.stringify({ error: String(j.error.message || j.error) }) + '\n')); any = true; } else if (c) { sent = true; any = true; ctl.enqueue(enc.encode(JSON.stringify({ message: { role: 'assistant', content: c }, done: false }) + '\n')); } } catch (e) { }
        }
        if (any) return;
      }
    },
    cancel() { try { rd.cancel(); } catch (e) { } }
  });
}
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !(same(token, process.env.LUNA_DEVICE_TOKEN || '') || await verify(token))) return new Response('Unauthorized', { status: 401 });
  let b; try { b = await req.json(); } catch (e) { return new Response('Bad request', { status: 400 }); }
  const history = (b.messages || []).slice(-40), temp = Math.min(1.5, Math.max(0, +(b.options && b.options.temperature) || 0.8)), wantsImg = history.some((m) => Array.isArray(m.images) && m.images.length);
  if (JSON.stringify(history).length > 6000000) return new Response('Too large', { status: 413 });
  const tried = [];
  for (const br of brains()) {
    try {
      const body = JSON.stringify(Object.assign({ model: wantsImg ? br.vision : br.model, messages: toOpenAI(history, wantsImg), stream: true, temperature: temp }, br.extra || {}));
      const up = await fetch(br.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + br.key }, body });
      if (!up.ok || !up.body) { tried.push(br.name + ' ' + up.status); try { await up.text(); } catch (e) { } continue; }
      return new Response(translate(up, br.name), { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Luna-Brain': br.name } });
    } catch (e) { tried.push(br.name + ' unreachable'); }
  }
  const ok = E('OLLAMA_API_KEY') && (process.env.ALLOWED_MODELS || 'gpt-oss:120b').split(',').map((s) => s.trim()).includes(b.model);
  if (ok) {
    try {
      const up = await fetch('https://ollama.com/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E('OLLAMA_API_KEY') }, body: JSON.stringify({ model: b.model, messages: history, stream: true, options: { temperature: temp } }) });
      if (up.ok && up.body) return new Response(up.body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Luna-Brain': 'ollama' } });
      tried.push('ollama ' + up.status);
    } catch (e) { tried.push('ollama unreachable'); }
  }
  const none = !brains().length && !ok;
  return new Response(JSON.stringify({ error: none ? 'No brain is set up. Add GEMINI_API_KEY in Vercel and redeploy.' : 'All my brains are busy or out of credit (' + tried.join(', ') + '). Try again in a minute.' }), { status: none ? 501 : 503, headers: { 'Content-Type': 'application/json' } });
}
