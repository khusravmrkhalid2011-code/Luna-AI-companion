// Public settings (safe to be visible). Your Ollama key is NOT here; it lives in Vercel environment variables.
window.LUNA_CLOUD = {
  firebase: { apiKey: 'PASTE_FIREBASE_API_KEY', authDomain: 'PASTE_PROJECT.firebaseapp.com', projectId: 'PASTE_PROJECT_ID', appId: 'PASTE_APP_ID' },
  // Keep these ids identical to the ALLOWED_MODELS environment variable. Browse names at ollama.com/search?c=cloud
  models: [
    { id: 'gpt-oss:120b', label: 'GPT-OSS 120B (smartest)' },
    { id: 'gpt-oss:20b', label: 'GPT-OSS 20B (faster)' },
    { id: 'qwen3-vl:235b', label: 'Qwen3-VL (can see images)', vision: true }
  ]
};
