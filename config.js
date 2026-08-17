window.SURVEY_CONFIG = Object.freeze({
  VERSION: '4.2.0-ultra-voice-share',

  // Debe coincidir con setGithubPagesUrl() en Apps Script.
  OFFICIAL_SITE_URL: 'https://darenisaleluya-lgtm.github.io/limalimon/',

  // REEMPLACE después de desplegar el nuevo Apps Script como Web App.
  API_URL: 'https://script.google.com/macros/s/AKfycbyeH3l1OAnEMr_r690dC2K9thc1sNQCJX73oM64vQ2n13Nc1lEzVX5qxG6DzxAsKphn/exec',

  CAMPAIGN_ID: 'demo-001',

  REQUIRE_GEOLOCATION: true,
  EXPECTED_MAX_HOURS: 3,
  // Perfil de captura de voz de alta calidad. El navegador puede ajustar los valores
  // a las capacidades reales del dispositivo; los ajustes efectivos se guardan en el expediente.
  AUDIO_BITS_PER_SECOND: 96000,
  AUDIO_SAMPLE_RATE_IDEAL: 48000,
  AUDIO_SAMPLE_SIZE_IDEAL: 16,
  AUDIO_CHANNEL_COUNT_IDEAL: 1,
  AUDIO_ECHO_CANCELLATION: true,
  AUDIO_NOISE_SUPPRESSION: true,
  AUDIO_AUTO_GAIN_CONTROL: true,
  AUDIO_CONTENT_HINT: 'speech',
  AUDIO_TEST_SECONDS: 8,
  FULL_TIMESLICE_MS: 60000,
  STORAGE_SAFETY_MB: 180,

  // V4.2: una sola grabación continua de alta calidad; no existe audio por pregunta.
  // Las respuestas pueden revisarse y editarse libremente mientras el audio sigue grabando.

  PACKAGE_FORMAT: 'ENCUESTA-OFFLINE-V4.2',
  PACKAGE_EXTENSION: '.encuesta',

  // Clave pública del proyecto funcional anterior.
  // Úsela SOLO si conserva la clave privada correspondiente.
  PUBLIC_KEY_JWK: {
    "kty": "RSA",
    "n": "tsliR6H0QBR7PvlW32Z2eh8fwXc3yCpYjjHxd-3ZhlWr0RzcBYnFOGwoNBTi7_ES51zbtN1h6CirVdYfQtvEwzMBosHSYOnLm4weJr-FcJRyU1sirx11R-6OUzOixch6CrKNlfhMEEhcCpH7w_W66kbaP3G4t_OMaFHDut3WAjHGrj8_PbYzpGoWfUgL7KhyTT4NhzmzCgJUblzJE4uSd_-dqZO4fzp-9xCdIlG_pLzsdWBBT96JSynj2mOPAwHgC8qMfEU0xwrRuT7mxdxYFn_6r-_w4nF6h_wZHc-QdfWIfc0tZ5skOe7uE0ajCsYzRGnvI-DqCGLtul27mHKqiHU5ynh-bqZv2D_6-7Gn1sMRH_R3HkqYsQ9zZgaZ0USWjtFV0rvwzzJb0-C0OTGdyS-rt5wTJ8IOrWVX1R-J1XpNXekGAIwZ36Xf4540XGFrtqyPj5D0O4O9p8aUoL2Mqqe7tyOu7Gf0dqcN6lWIyQTiq3Iw7lfHAYfrnHCyyvKRNGO8rvVo92kZsySYM6mKrIJ3bII7ibMz93QwUzuTdZoun9NB_ez_6gpdThFnzoJBNxCY-j0qh5P6jPobe81bKd9JRbwq9OdDqwn4EyIDKVDcKV03kJsvjVQgP8l3mZG49qEqXqRWNxSfx0gSyf15qoQBVg5NIjrwHHEoLMgEfVU",
    "e": "AQAB",
    "alg": "RSA-OAEP-256",
    "ext": true,
    "key_ops": ["encrypt"],
    "kid": "encuesta-demo-571f3cdad2f3497b"
  }
});
