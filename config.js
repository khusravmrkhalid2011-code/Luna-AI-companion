// Public settings (safe to be visible). Your Ollama key is NOT here; it lives in Vercel environment variables.
window.LUNA_CLOUD = {
  firebase: { apiKey: 'AIzaSyD0_DBAbshTDqZoiD7gtZFLVB4aLqNLkms', authDomain: 'luna-ec9f7.firbaseapp.com', projectId: 'luna-ec9f7', appId: '1:977170537891:web:13b1b28d2491d7fd6cce16' },
  // Keep these ids identical to the ALLOWED_MODELS environment variable. Browse names at ollama.com/search?c=cloud
  models: [
    { id: 'gpt-oss:120b', label: 'GPT-OSS 120B (smartest)' },
    { id: 'gpt-oss:20b', label: 'GPT-OSS 20B (faster)' },
    { id: 'qwen3-vl:235b', label: 'Qwen3-VL (can see images)', vision: true }
  ]
};
