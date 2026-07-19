window.APP_CONFIG = Object.freeze({
  // Reemplace con la URL /exec de su implementación de Apps Script.
  API_URL: "PEGA_AQUI_LA_URL_EXEC_DE_APPS_SCRIPT",

  // Un fragmento de la grabación general se envía cada 60 segundos.
  SESSION_CHUNK_MS: 60000,

  // Límite para la nota de voz de una sola pregunta.
  MAX_QUESTION_AUDIO_MB: 6,

  // Tasa orientativa para voz. El navegador puede elegir otra.
  AUDIO_BITS_PER_SECOND: 32000,

  // Duración usada para calcular espacio recomendado en la configuración.
  EXPECTED_MAX_HOURS: 3,

  // Espacio mínimo adicional de seguridad.
  STORAGE_SAFETY_MB: 150
});
