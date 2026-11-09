// Vercel function: Luna sings an ORIGINAL song (ElevenLabs Music, needs a paid ElevenLabs plan). Needs ELEVENLABS_API_KEY.
import { authed, H } from './_el.js';
const VOCAL = { default: 'bright, playful, high-pitched cute vocals with a light electronic shimmer', guide: 'deep, calm, ethereal female vocals', santa: 'deep, booming, jolly male vocals', bear: 'very deep, gruff, warm male vocals', cool: 'young, energetic male vocals', gent: 'refined, smooth British male crooner vocals', moon: 'ethereal, celestial female vocals with lush reverb', sakura: 'soft, gentle, sweet female vocals' };
const clean = (s, n) => String(s || '').replace(/[^\w\s,.'\-&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!process.env.ELEVENLABS_API_KEY) return res.status(501).json({ error: 'ELEVENLABS_API_KEY is not set' });
  if (!(await authed(req))) return res.status(401).json({ error: 'Unauthorized' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const vocal = VOCAL[b.voice] || VOCAL.default, style = clean(b.style, 60) || 'pop', topic = clean(b.topic, 120) || 'a night under the stars';
  const prompt = 'An original ' + style + ' song with ' + vocal + ', clear sung English lyrics about ' + topic + '. A complete short song with a verse, a catchy chorus and a satisfying ending.';
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', { method: 'POST', headers: H(), body: JSON.stringify({ prompt, music_length_ms: 30000 }) });
    if (!r.ok) return res.status(r.status).json({ error: (await r.text()).slice(0, 400) });
    res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { return res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
}
