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
// Model names change often, so Luna asks each service which models it has right now and picks good ones itself.
const cache = {};
async function list(url, key) { const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error('list ' + r.status); const j = await r.json(); return (j.data || j.models || []); }
const pick = (ids, prefs, n) => { const out = []; for (const re of prefs) for (const id of ids) if (re.test(id) && !out.includes(id)) out.push(id); return out.slice(0, n); };
const BAD = /embed|whisper|tts|speech|audio|guard|safeguard|image|imagen|veo|live|transcri|moderation|rerank|vision-preview|robotics|computer-use|learnlm|gemma-3n|aqa/i;
const ver = (id) => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(id); return m ? parseFloat(m[1]) : 0; };
const finder = {
  async gemini(key) { const ids = (await list('https://generativelanguage.googleapis.com/v1beta/openai/models', key)).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter((x) => /^gemini-/.test(x) && /flash/.test(x) && !BAD.test(x)); const stable = ids.filter((x) => !/preview|exp|lite|\d{3,}$/.test(x)).sort((a, b) => ver(b) - ver(a)), rest = ids.filter((x) => !stable.includes(x)).sort((a, b) => ver(b) - ver(a)); return { text: stable.concat(rest).slice(0, 3), vision: stable.concat(rest).slice(0, 2) }; },
  async groq(key) { const ids = (await list('https://api.groq.com/openai/v1/models', key)).filter((m) => m.active !== false).map((m) => m.id).filter((x) => !BAD.test(x)); return { text: pick(ids, [/gpt-oss-120b/, /llama-3\.3-70b/, /llama.*70b/, /qwen.*(32|72)b/, /kimi/, /gpt-oss-20b/, /llama.*(8b|instant)/, /./], 3), vision: pick(ids, [/llama-4-(scout|maverick)/, /vision/], 2) }; },
  async openrouter(key) { const all = await list('https://openrouter.ai/api/v1/models', key), fr = all.filter((m) => /:free$/.test(m.id) && !BAD.test(m.id)), ids = fr.map((m) => m.id), vis = fr.filter((m) => m.architecture && (m.architecture.input_modalities || []).includes('image')).map((m) => m.id); return { text: pick(ids, [/llama.*70b/, /gpt-oss-120b/, /qwen.*(72|235|480|32)b/, /deepseek/, /gemini.*flash/, /mistral.*(small|medium)/, /gpt-oss-20b/, /./], 4), vision: pick(vis, [/gemini/, /gemma/, /./], 2) }; }
};
const URLS = { gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', groq: 'https://api.groq.com/openai/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions' };
const ENVK = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' }, ENVM = { gemini: 'GEMINI_MODEL', groq: 'GROQ_MODEL', openrouter: 'OPENROUTER_MODEL' };
const DEF = { gemini: ['gemini-flash-latest', 'gemini-2.5-flash'], groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], openrouter: ['meta-llama/llama-3.3-70b-instruct:free'] };
async function brains() {
  const L = [];
  for (const name of ['gemini', 'groq', 'openrouter']) {
    const key = E(ENVK[name]); if (!key) continue;
    let c = cache[name]; if (!c || c.exp < Date.now()) { try { const f = await finder[name](key); c = { exp: Date.now() + 600000, text: f.text, vision: f.vision }; } catch (e) { c = { exp: Date.now() + 60000, text: [], vision: [], err: String(e.message || e) }; } cache[name] = c; }
    const mine = E(ENVM[name]);
    L.push({ name, key, url: URLS[name], models: [mine].concat(c.text.length ? c.text : DEF[name]).filter(Boolean), vmodels: c.vision.length ? c.vision : (name === 'gemini' ? DEF.gemini : []) });
  }
  return L;
}
const brief = (t) => { let m = String(t || ''); try { const j = JSON.parse(m), e = Array.isArray(j) ? j[0] : j; m = (e && e.error && (e.error.message || e.error)) || e.message || m; } catch (e) { } return String(m).replace(/["{}\[\]\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70); };
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
  const BR = await brains();
  for (const br of BR) {
    const cands = (wantsImg ? br.vmodels : br.models).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
    for (const model of cands) {
      const left = 23000 - (Date.now() - t0); if (left < 2500) { tried.push(br.name + ' skipped (time)'); break; }
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), Math.min(br.name === 'gemini' ? 13000 : 9000, left));
      try {
        const body = JSON.stringify(Object.assign({ model, messages: toOpenAI(history, wantsImg), stream: true, temperature: temp }, br.name === 'gemini' && !br.noThink ? { reasoning_effort: 'low' } : {}));
        const up = await fetch(br.url, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + br.key }, body }); clearTimeout(to);
        if (!up.ok || !up.body) { let m = ''; try { m = brief(await up.text()); } catch (e) { } if (up.status === 400 && br.name === 'gemini' && /reason/i.test(m) && !br.noThink) { br.noThink = true; tried.push('gemini retry'); cands.unshift(model); continue; } tried.push(br.name + ' ' + up.status + (up.status === 404 || up.status === 400 ? ' ' + model : '') + (m && up.status !== 429 ? ': ' + m : '')); if (up.status === 404 || up.status === 400) continue; break; }
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
  const none = !BR.length && !ok;
  return new Response(JSON.stringify({ error: none ? 'No brain is set up. Add GEMINI_API_KEY in Vercel and redeploy.' : 'All my brains are busy or out of credit (' + tried.join(', ') + '). Try again in a minute.' }), { status: none ? 501 : 503, headers: { 'Content-Type': 'application/json' } });
}
