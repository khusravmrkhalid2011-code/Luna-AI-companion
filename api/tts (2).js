// Vercel function: Luna's realistic voices (ElevenLabs). Needs ELEVENLABS_API_KEY.
import { authed, VOICES, voiceId, H } from './_el.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!process.env.ELEVENLABS_API_KEY) return res.status(501).json({ error: 'ELEVENLABS_API_KEY is not set' });
  if (!(await authed(req))) return res.status(401).json({ error: 'Unauthorized' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const key = VOICES[b.voice] ? b.voice : 'default', text = String(b.text || '').slice(0, 700).trim();
  if (!text && !b.warm) return res.status(400).json({ error: 'No text' });
  try {
    const id = await voiceId(key);
    if (b.warm) return res.status(200).json({ ok: true });
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + id + '?output_format=mp3_44100_128', { method: 'POST', headers: H(), body: JSON.stringify({ text, model_id: 'eleven_v3', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }) });
    if (!r.ok) return res.status(r.status).json({ error: (await r.text()).slice(0, 300) });
    res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
}
