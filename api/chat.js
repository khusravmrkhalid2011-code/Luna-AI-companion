// Vercel Edge Function: checks the user's Firebase sign-in, then asks a "brain" for the reply.
// Brains are tried in this order and Luna switches automatically when one is out of credit, busy or down:
//   1. Google Gemini Flash   (GEMINI_API_KEY)      - main brain
//   2. Groq Cloud            (GROQ_API_KEY)
//   3. OpenRouter            (OPENROUTER_API_KEY)
//   4. Ollama Cloud          (OLLAMA_API_KEY)      - optional, last
// The chat history is sent with every request, so the conversation simply continues on whichever brain answers.
// Pinned to Frankfurt: Google Gemini refuses requests that come from some regions (for example Hong Kong, where Vercel runs functions for users in Asia).
export const config = { runtime: 'edge', regions: ['fra1'] };
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
  if (E('GEMINI_API_KEY')) L.push({ name: 'gemini', key: E('GEMINI_API_KEY'), url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: [E('GEMINI_MODEL'), 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'], vmodels: [E('GEMINI_MODEL'), 'gemini-2.5-flash', 'gemini-flash-latest'] });
  if (E('GROQ_API_KEY')) L.push({ name: 'groq', key: E('GROQ_API_KEY'), url: 'https://api.groq.com/openai/v1/chat/completions', models: [E('GROQ_MODEL'), 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], vmodels: [E('GROQ_VISION_MODEL'), 'meta-llama/llama-4-scout-17b-16e-instruct'] });
  if (E('OPENROUTER_API_KEY')) L.push({ name: 'openrouter', key: E('OPENROUTER_API_KEY'), url: 'https://openrouter.ai/api/v1/chat/completions', models: [E('OPENROUTER_MODEL'), 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-20b:free', 'google/gemma-3-27b-it:free', 'mistralai/mistral-small-3.2-24b-instruct:free'], vmodels: [E('OPENROUTER_VISION_MODEL'), 'google/gemma-3-27b-it:free'] });
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
  const tried = [], t0 = Date.now();
  for (const br of brains()) {
    const cands = (wantsImg ? br.vmodels : br.models).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
    for (const model of cands.slice(0, 3)) {
      const left = 22000 - (Date.now() - t0); if (left < 2500) { tried.push(br.name + ' skipped (time)'); break; }
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), Math.min(9000, left));
      try {
        const body = JSON.stringify({ model, messages: toOpenAI(history, wantsImg), stream: true, temperature: temp });
        const up = await fetch(br.url, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + br.key }, body }); clearTimeout(to);
        if (!up.ok || !up.body) { let m = ''; try { m = (await up.text()).replace(/\s+/g, ' ').slice(0, 90); } catch (e) { } tried.push(br.name + ' ' + up.status + (up.status === 404 || up.status === 400 ? ' ' + model : '') + (m && up.status !== 429 ? ' ' + m.slice(0, 70) : '')); if (up.status === 404 || up.status === 400) continue; break; }
        return new Response(translate(up, br.name), { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Luna-Brain': br.name + ':' + model } });
      } catch (e) { clearTimeout(to); tried.push(br.name + (ac.signal.aborted ? ' too slow' : ' unreachable')); break; }
    }
  }
  const ok = Date.now() - t0 < 15000 && E('OLLAMA_API_KEY') && (process.env.ALLOWED_MODELS || 'gpt-oss:120b').split(',').map((s) => s.trim()).includes(b.model);
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
