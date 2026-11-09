// Shared helpers for the ElevenLabs endpoints. The ElevenLabs key lives only in the Vercel environment variable ELEVENLABS_API_KEY.
const seen = new Map();
export async function authed(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  if (process.env.LUNA_DEVICE_TOKEN && token === process.env.LUNA_DEVICE_TOKEN) return true;
  const hit = seen.get(token); if (hit && hit > Date.now()) return true;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  if (!r.ok) return false;
  const u = ((await r.json()).users || [])[0]; if (!u || u.disabled) return false;
  if (seen.size > 500) seen.clear(); seen.set(token, Date.now() + 300000); return true;
}
// One designed voice per character. The descriptions are the prompts for ElevenLabs Voice Design.
export const VOICES = {
  default: { name: 'Luna - Default (Emo robot)', prompt: 'High-pitched, energetic, cute mini-robot character voice. Pitch is high and semi-robotic, expressive with rapid delivery, playful tone, light electronic chime resonance.' },
  guide: { name: 'Luna - Guide', prompt: 'Deep, smooth, serene female voice. Calm, authoritative, steady pace, wise cosmic guardian persona with low pitch and soothing intonation.' },
  santa: { name: 'Luna - Santa', prompt: 'Booming, deep male voice with a thick jolly tone. Cheerful, warm, hearty, expressive belly-laugh timbre with cozy pacing.' },
  bear: { name: 'Luna - Bear', prompt: 'Very deep, gruff male character voice. Warm, sleepy, low-register, relaxed pacing, gentle giant persona with heavy bass.' },
  cool: { name: 'Luna - Cool Guy', prompt: 'Young adult male voice, confident, fast-paced, highly energetic, animated youth cadence, upbeat and casual.' },
  gent: { name: 'Luna - Gentleman', prompt: 'Refined British male voice with standard Received Pronunciation. Polished, articulate, formal, polite, medium-low pitch, immaculate phrasing.' },
  moon: { name: 'Luna - Full Moon', prompt: 'Deep, ethereal, mystical female voice. Celestial and steady, calm authoritative tone, smooth resonant delivery.' },
  sakura: { name: 'Luna - Sakura', prompt: 'Soft, sweet, gentle young female voice. Warm, polite and airy, light and tender, calm unhurried pacing.' }
};
const pend = {};
const H = () => ({ 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' });
export function voiceId(key) {
  const env = process.env['EL_VOICE_' + key.toUpperCase()]; if (env) return Promise.resolve(env);
  if (pend[key]) return pend[key];
  pend[key] = (async () => {
    const v = VOICES[key];
    try { const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100&search=' + encodeURIComponent(v.name), { headers: H() }); if (r.ok) { const j = await r.json(); const hit = (j.voices || []).find((x) => x.name === v.name); if (hit) return hit.voice_id; } } catch (e) { }
    const d = await fetch('https://api.elevenlabs.io/v1/text-to-voice/design', { method: 'POST', headers: H(), body: JSON.stringify({ voice_description: v.prompt, model_id: 'eleven_ttv_v3', auto_generate_text: true }) });
    if (!d.ok) throw new Error('design ' + d.status + ' ' + (await d.text()).slice(0, 200));
    const gid = ((await d.json()).previews || [])[0]; if (!gid) throw new Error('design returned no preview');
    const c = await fetch('https://api.elevenlabs.io/v1/text-to-voice', { method: 'POST', headers: H(), body: JSON.stringify({ voice_name: v.name, voice_description: v.prompt, generated_voice_id: gid.generated_voice_id }) });
    if (!c.ok) throw new Error('create ' + c.status + ' ' + (await c.text()).slice(0, 200));
    return (await c.json()).voice_id;
  })().catch((e) => { delete pend[key]; throw e; });
  return pend[key];
}
export { H };
