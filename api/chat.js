export const config = { runtime: 'edge' };
const seen = new Map();
const allowed = () => (process.env.ALLOWED_MODELS || 'gpt-oss:120b').split(',').map((s) => s.trim()).filter(Boolean);
async function verify(token) {
  const hit = seen.get(token); if (hit && hit > Date.now()) return true;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  if (!r.ok) return false;
  const u = ((await r.json()).users || [])[0]; if (!u || u.disabled) return false;
  if (seen.size > 500) seen.clear(); seen.set(token, Date.now() + 300000); return true;
}
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !(await verify(token))) return new Response('Unauthorized', { status: 401 });
  let b; try { b = await req.json(); } catch (e) { return new Response('Bad request', { status: 400 }); }
  if (!allowed().includes(b.model)) return new Response('Model not allowed', { status: 400 });
  const body = JSON.stringify({ model: b.model, messages: (b.messages || []).slice(-40), stream: true, options: { temperature: Math.min(1.5, Math.max(0, +(b.options && b.options.temperature) || 0.8)) } });
  if (body.length > 6000000) return new Response('Too large', { status: 413 });
  const up = await fetch('https://ollama.com/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OLLAMA_API_KEY }, body });
  return new Response(up.body, { status: up.status, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
}
