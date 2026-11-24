// Vercel Edge Function: finds songs for Luna.
// 1) Spotify (needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET; a Spotify developer app in development mode needs its owner to have Premium).
// 2) If Spotify is not set up or refuses, it falls back to Apple's free iTunes search (no key): 30-second previews + artwork.
export const config = { runtime: 'edge', regions: ['fra1'] };
const seen = new Map();
async function verify(token) {
  const hit = seen.get(token); if (hit && hit > Date.now()) return true;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  if (!r.ok) return false; const u = ((await r.json()).users || [])[0]; if (!u || u.disabled) return false;
  if (seen.size > 500) seen.clear(); seen.set(token, Date.now() + 300000); return true;
}
function same(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const E = (k) => (process.env[k] || '').trim();
let tok = { v: '', exp: 0 };
async function spotifyToken() {
  if (tok.v && tok.exp > Date.now() + 30000) return tok.v;
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(E('SPOTIFY_CLIENT_ID') + ':' + E('SPOTIFY_CLIENT_SECRET')) }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('token ' + r.status); const j = await r.json(); tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return tok.v;
}
async function spotify(q) {
  const t = await spotifyToken();
  const r = await fetch('https://api.spotify.com/v1/search?type=track&limit=10&q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) { if (r.status === 401) tok = { v: '', exp: 0 }; throw new Error('search ' + r.status); }
  const items = ((await r.json()).tracks || {}).items || [];
  return items.filter((x) => x && x.id).slice(0, 6).map((x) => ({ id: x.id, uri: x.uri, name: x.name, artists: (x.artists || []).map((a) => a.name).join(', '), album: (x.album || {}).name || '', image: ((x.album || {}).images || [])[1] ? x.album.images[1].url : ((x.album || {}).images || [])[0] ? x.album.images[0].url : '', url: (x.external_urls || {}).spotify || ('https://open.spotify.com/track/' + x.id) }));
}
async function itunes(q) {
  const r = await fetch('https://itunes.apple.com/search?media=music&entity=song&limit=8&term=' + encodeURIComponent(q), { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('itunes ' + r.status); const j = await r.json();
  return (j.results || []).filter((x) => x.previewUrl).slice(0, 6).map((x) => ({ name: x.trackName, artists: x.artistName, album: x.collectionName || '', image: String(x.artworkUrl100 || '').replace('100x100', '300x300'), preview: x.previewUrl, url: x.trackViewUrl || '' }));
}
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !(same(token, process.env.LUNA_DEVICE_TOKEN || '') || await verify(token))) return new Response('Unauthorized', { status: 401 });
  let b; try { b = await req.json(); } catch (e) { return new Response('Bad request', { status: 400 }); }
  const q = String(b.q || '').replace(/\s+/g, ' ').trim().slice(0, 120); if (!q) return Response.json({ error: 'Nothing to search for' }, { status: 400 });
  const spotifySearch = 'https://open.spotify.com/search/' + encodeURIComponent(q), why = [];
  if (E('SPOTIFY_CLIENT_ID') && E('SPOTIFY_CLIENT_SECRET')) { try { const tracks = await spotify(q); if (tracks.length) return Response.json({ source: 'spotify', q, tracks, spotifySearch }); why.push('spotify no results'); } catch (e) { why.push('spotify ' + String(e.message || e).slice(0, 60)); } } else why.push('spotify not set up');
  try { const tracks = await itunes(q); if (tracks.length) return Response.json({ source: 'itunes', q, tracks, spotifySearch, why }); why.push('itunes no results'); } catch (e) { why.push('itunes ' + String(e.message || e).slice(0, 60)); }
  return Response.json({ source: 'none', q, tracks: [], spotifySearch, why });
}
