import {
  openDb,
  storageWriteTest,
  getSetting,
  setSetting,
  putSession,
  getLatestIncompleteSession,
  getAnswers,
  getPendingAnswers,
  putAnswer,
  markAnswerSynced,
  putAudioChunk,
  getAudioChunks,
  countAudioChunks,
  putEvent,
  getEvents,
  getPendingEvents,
  markEventSynced
} from "./db.js";
import {
  randomId,
  randomBytes,
  bytesToBase64,
  base64ToBytes,
  deriveAudioKey,
  createKeyVerifier,
  verifyKey,
  encryptAudioChunk,
  buildEncryptedPackage,
  sha256Hex
} from "./crypto.js";
import { ApiClient } from "./api.js";

const CONFIG = window.APP_CONFIG;
const $ = selector => document.querySelector(selector);
const screens = ["setup-screen", "survey-screen", "pause-screen", "finish-screen"];

const dom = {
  setupMessage: $("#setup-message"),
  configureButton: $("#configure-button"),
  resumeLocalButton: $("#resume-local-button"),
  passphrase: $("#recovery-passphrase"),
  togglePassphrase: $("#toggle-passphrase"),
  consentAudio: $("#consent-audio"),
  consentLocation: $("#consent-location"),
  consentData: $("#consent-data"),
  surveyTitle: $("#survey-title"),
  progressLabel: $("#progress-label"),
  questionText: $("#question-text"),
  questionRequired: $("#question-required"),
  answerContainer: $("#answer-container"),
  nextButton: $("#next-button"),
  networkIndicator: $("#network-indicator"),
  audioIndicator: $("#audio-indicator"),
  waveform: $("#waveform"),
  audioLevelLabel: $("#audio-level-label"),
  recordingTime: $("#recording-time"),
  localStatus: $("#local-status"),
  serverStatus: $("#server-status"),
  pauseDetail: $("#pause-detail"),
  resumeButton: $("#resume-button"),
  finishSummary: $("#finish-summary"),
  exportButton: $("#export-package-button"),
  shareButton: $("#share-package-button"),
  downloadLink: $("#download-package-link"),
  overlay: $("#blocking-overlay"),
  overlayTitle: $("#overlay-title"),
  overlayMessage: $("#overlay-message")
};

const state = {
  api: null,
  clientId: "",
  turnstileWidgetId: null,
  turnstileToken: "",
  turnstileReadyAt: 0,
  session: null,
  survey: null,
  questions: [],
  questionIndex: 0,
  selectedOption: null,
  stream: null,
  recorder: null,
  audioContext: null,
  analyser: null,
  animationFrame: null,
  audioKey: null,
  audioWriteChain: Promise.resolve(),
  syncChain: Promise.resolve(),
  segmentId: 0,
  chunkIndex: 0,
  lastChunkAt: 0,
  segmentStartedAt: 0,
  elapsedBeforeSegment: 0,
  recordingTimer: null,
  heartbeatTimer: null,
  networkTimer: null,
  wakeLock: null,
  isPausing: false,
  paused: false,
  finishing: false,
  packageFile: null,
  packageUrl: ""
};

function showScreen(id) {
  screens.forEach(screenId => $(`#${screenId}`).classList.toggle("screen-active", screenId === id));
}

function setCheck(name, status, detail) {
  const card = document.querySelector(`[data-check="${name}"]`);
  if (!card) return;
  card.dataset.state = status;
  const small = card.querySelector("small");
  if (small && detail) small.textContent = detail;
}

function setMessage(text, kind = "") {
  dom.setupMessage.textContent = text;
  dom.setupMessage.className = `message ${kind}`.trim();
}

function setOverlay(visible, title = "Procesando", message = "No cierre esta pantalla.") {
  dom.overlay.classList.toggle("hidden", !visible);
  dom.overlayTitle.textContent = title;
  dom.overlayMessage.textContent = message;
}

function setPill(element, text, type) {
  element.textContent = text;
  element.className = `pill pill-${type}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "No disponible";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index < 2 ? 0 : 2)} ${units[index]}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function createClientId() {
  return randomId("client_");
}

function isSupportedBrowser() {
  return Boolean(
    window.isSecureContext &&
    navigator.mediaDevices?.getUserMedia &&
    window.MediaRecorder &&
    window.indexedDB &&
    window.crypto?.subtle &&
    navigator.geolocation
  );
}

function validateConsentsAndPassphrase() {
  if (!dom.consentAudio.checked || !dom.consentLocation.checked || !dom.consentData.checked) {
    throw new Error("Debe aceptar las tres autorizaciones para continuar");
  }
  if (dom.passphrase.value.length < CONFIG.MIN_PASSPHRASE_LENGTH) {
    throw new Error(`La clave debe tener al menos ${CONFIG.MIN_PASSPHRASE_LENGTH} caracteres`);
  }
}

async function waitForTurnstile() {
  const deadline = Date.now() + 15000;
  while (!window.turnstile && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!window.turnstile) throw new Error("No cargó la protección Turnstile");
}

async function renderTurnstile() {
  await waitForTurnstile();
  if (state.turnstileWidgetId !== null) return;
  state.turnstileWidgetId = window.turnstile.render("#turnstile-container", {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    action: CONFIG.TURNSTILE_ACTION,
    theme: "dark",
    size: "flexible",
    callback: token => {
      state.turnstileToken = token;
      state.turnstileReadyAt = Date.now();
      setCheck("turnstile", "ok", "Validación lista");
    },
    "expired-callback": () => {
      state.turnstileToken = "";
      setCheck("turnstile", "warn", "Validación expirada");
    },
    "error-callback": code => {
      state.turnstileToken = "";
      setCheck("turnstile", "error", `Error ${String(code).slice(0, 12)}`);
      return true;
    }
  });
}

function resetTurnstile() {
  state.turnstileToken = "";
  state.turnstileReadyAt = 0;
  if (state.turnstileWidgetId !== null && window.turnstile) {
    window.turnstile.reset(state.turnstileWidgetId);
  }
}

async function ensureTurnstileToken() {
  if (state.turnstileToken && Date.now() - state.turnstileReadyAt < 4 * 60 * 1000) return state.turnstileToken;
  resetTurnstile();
  throw new Error("Complete nuevamente la validación de seguridad");
}

async function checkStorage(surveyInfo = {}) {
  if (!navigator.storage?.estimate) throw new Error("El navegador no permite estimar almacenamiento");
  const estimate = await navigator.storage.estimate();
  const quota = Number(estimate.quota || 0);
  const usage = Number(estimate.usage || 0);
  const available = Math.max(0, quota - usage);
  const durationHours = Math.max(
    Number(CONFIG.MAX_SESSION_HOURS || 0),
    Number(surveyInfo.maxDurationMinutes || 0) / 60
  );
  const minimumMb = Math.max(
    Number(CONFIG.MIN_REQUIRED_STORAGE_MB || 0),
    Number(surveyInfo.minStorageMb || 0)
  );
  const required = Math.max(
    minimumMb * 1024 * 1024,
    (CONFIG.AUDIO_BITS_PER_SECOND / 8) * durationHours * 3600 * 2.5
  );
  if (available < required) {
    setCheck("storage", "error", `${formatBytes(available)} disponibles`);
    throw new Error(`Almacenamiento insuficiente. Se estiman ${formatBytes(available)} disponibles y se requieren ${formatBytes(required)}`);
  }
  await storageWriteTest(2 * 1024 * 1024);
  setCheck("storage", "ok", `${formatBytes(available)} estimados`);

  let persistent = false;
  if (navigator.storage.persisted) persistent = await navigator.storage.persisted();
  if (!persistent && navigator.storage.persist) persistent = await navigator.storage.persist();
  setCheck("persistence", persistent ? "ok" : "warn", persistent ? "Concedida" : "No concedida");
  if (CONFIG.REQUIRE_PERSISTENT_STORAGE && !persistent) {
    throw new Error("El navegador no concedió almacenamiento persistente y esta encuesta lo exige");
  }
  return { quota, usage, available, required, persistent, durationHours, minimumMb };
}

function getLocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => {
        const result = {
          latitude: Number(position.coords.latitude.toFixed(7)),
          longitude: Number(position.coords.longitude.toFixed(7)),
          accuracy: Math.round(position.coords.accuracy),
          timestamp: new Date(position.timestamp).toISOString()
        };
        setCheck("location", "ok", `Precisión ±${result.accuracy} m`);
        resolve(result);
      },
      error => {
        setCheck("location", "error", "Permiso o señal no disponible");
        reject(new Error(`No fue posible obtener la ubicación: ${error.message}`));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

async function acquireMicrophone() {
  stopStream();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
    const track = state.stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") throw new Error("No existe una pista de audio activa");
    track.addEventListener("ended", () => {
      if (state.session && !state.finishing) pauseSurvey("MICROPHONE_ENDED", "El micrófono dejó de estar disponible");
    }, { once: true });
    return state.stream;
  } catch (error) {
    setCheck("microphone", "error", "No disponible");
    const messages = {
      NotAllowedError: "El micrófono fue rechazado o está bloqueado en el navegador",
      NotFoundError: "No se encontró un micrófono",
      NotReadableError: "El micrófono está ocupado o no puede leerse",
      SecurityError: "El navegador impidió el acceso al micrófono"
    };
    throw new Error(messages[error.name] || `No fue posible configurar el micrófono: ${error.message}`);
  }
}

async function createAnalyser(stream) {
  if (state.audioContext) await state.audioContext.close().catch(() => {});
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContextClass();
  await state.audioContext.resume();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  state.analyser.smoothingTimeConstant = 0.72;
  source.connect(state.analyser);
  return state.analyser;
}

function currentRms(analyser) {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}

async function testMicrophone(stream) {
  const analyser = await createAnalyser(stream);
  const end = Date.now() + CONFIG.AUDIO_TEST_MS;
  let maximum = 0;
  while (Date.now() < end) {
    maximum = Math.max(maximum, currentRms(analyser));
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  if (maximum < CONFIG.MIN_AUDIO_RMS) {
    setCheck("microphone", "error", "No se detectó voz");
    throw new Error("El micrófono fue autorizado, pero la prueba no detectó sonido suficiente. Hable cerca del dispositivo y repita");
  }
  setCheck("microphone", "ok", `Señal comprobada (${maximum.toFixed(3)})`);
  return maximum;
}

async function checkServer() {
  const ok = await state.api.health();
  if (!ok) throw new Error("Apps Script no respondió correctamente");
  setCheck("server", "ok", "API disponible");
  return true;
}

function environmentInfo(storage) {
  return {
    userAgent: navigator.userAgent.slice(0, 500),
    language: navigator.language,
    platform: navigator.userAgentData?.platform || navigator.platform || "unknown",
    screen: `${screen.width}x${screen.height}`,
    devicePixelRatio: window.devicePixelRatio || 1,
    storage,
    secureContext: window.isSecureContext,
    standalone: window.matchMedia?.("(display-mode: standalone)")?.matches || false
  };
}

async function startNewSession() {
  validateConsentsAndPassphrase();
  setOverlay(true, "Configurando entorno", "Se comprobarán todos los requisitos antes de iniciar.");
  dom.configureButton.disabled = true;
  try {
    if (!window.isSecureContext) throw new Error("La encuesta debe abrirse mediante HTTPS");
    setCheck("https", "ok", "HTTPS activo");
    if (!isSupportedBrowser()) throw new Error("Este navegador no ofrece todas las APIs requeridas");
    setCheck("browser", "ok", "Compatible");

    await openDb();
    await checkServer();
    const publicSurvey = await state.api.surveyInfo(CONFIG.SURVEY_ID);
    const storage = await checkStorage(publicSurvey);
    const location = await getLocation();
    const stream = await acquireMicrophone();
    await testMicrophone(stream);
    const turnstileToken = await ensureTurnstileToken();

    const result = await state.api.call("startSession", {
      surveyId: CONFIG.SURVEY_ID,
      clientId: state.clientId,
      turnstileToken,
      consent: { audio: true, location: true, data: true },
      location,
      environment: environmentInfo(storage)
    });

    state.survey = result.survey;
    state.questions = result.questions;
    if (!Array.isArray(state.questions) || state.questions.length === 0) throw new Error("La encuesta no contiene preguntas activas");

    const salt = randomBytes(16);
    state.audioKey = await deriveAudioKey(dom.passphrase.value, salt, CONFIG.PBKDF2_ITERATIONS);
    const verifier = await createKeyVerifier(state.audioKey, result.sessionId);
    state.session = {
      sessionId: result.sessionId,
      sessionToken: result.sessionToken,
      tokenExpiresAt: result.tokenExpiresAt,
      resumeKey: result.resumeKey,
      survey: result.survey,
      questions: result.questions,
      questionIndex: 0,
      status: "ACTIVE",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      recordingElapsedMs: 0,
      segmentId: 0,
      crypto: {
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: CONFIG.PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
        verifier
      }
    };
    await putSession(state.session);
    dom.passphrase.value = "";
    resetTurnstile();
    state.questionIndex = 0;
    state.elapsedBeforeSegment = 0;
    await recordEvent("SESSION_STARTED", { locationAccuracy: location.accuracy });
    await startRecordingSegment();
    startHeartbeat();
    renderQuestion();
    showScreen("survey-screen");
  } catch (error) {
    stopStream();
    await closeAudioContext();
    setMessage(error.message, "error");
  } finally {
    setOverlay(false);
    dom.configureButton.disabled = false;
  }
}

async function resumeStoredSession() {
  const saved = await getLatestIncompleteSession();
  if (!saved) {
    setMessage("No se encontró una sesión pendiente", "error");
    return;
  }
  if (dom.passphrase.value.length < CONFIG.MIN_PASSPHRASE_LENGTH) {
    setMessage("Ingrese la misma clave utilizada al iniciar la encuesta", "error");
    return;
  }
  setOverlay(true, "Recuperando sesión", "Se verificará la clave y se reconfigurará el micrófono.");
  try {
    const salt = base64ToBytes(saved.crypto.kdf.salt);
    const key = await deriveAudioKey(dom.passphrase.value, salt, saved.crypto.kdf.iterations);
    if (!(await verifyKey(key, saved.sessionId, saved.crypto.verifier))) throw new Error("La clave no corresponde a esta sesión");
    state.audioKey = key;
    state.session = saved;
    state.survey = saved.survey;
    state.questions = saved.questions;
    state.questionIndex = Number(saved.questionIndex || 0);
    state.elapsedBeforeSegment = Number(saved.recordingElapsedMs || 0);
    state.segmentId = Number(saved.segmentId || 0);

    if (!saved.sessionToken || Date.parse(saved.tokenExpiresAt || 0) < Date.now() + 60000) {
      const turnstileToken = await ensureTurnstileToken();
      const renewed = await state.api.call("resumeSession", {
        sessionId: saved.sessionId,
        resumeKey: saved.resumeKey,
        turnstileToken
      });
      state.session.sessionToken = renewed.sessionToken;
      state.session.tokenExpiresAt = renewed.tokenExpiresAt;
      state.session.questions = renewed.questions;
      state.session.survey = renewed.survey;
      state.questions = renewed.questions;
      state.survey = renewed.survey;
      resetTurnstile();
    }

    await acquireMicrophone();
    await testMicrophone(state.stream);
    dom.passphrase.value = "";
    state.session.status = "ACTIVE";
    await putSession(state.session);
    await recordEvent("SESSION_RESUMED", { source: "LOCAL_RECOVERY" });
    await startRecordingSegment();
    startHeartbeat();
    renderQuestion();
    showScreen("survey-screen");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setOverlay(false);
  }
}

function chooseMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || "";
}

async function requestWakeLock() {
  if (!navigator.wakeLock?.request || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch {
    state.wakeLock = null;
  }
}

async function startRecordingSegment() {
  if (!state.stream || !state.audioKey) throw new Error("No se ha configurado el audio");
  const mimeType = chooseMimeType();
  const options = { audioBitsPerSecond: CONFIG.AUDIO_BITS_PER_SECOND };
  if (mimeType) options.mimeType = mimeType;
  state.segmentId += 1;
  state.chunkIndex = 0;
  state.lastChunkAt = Date.now();
  state.segmentStartedAt = Date.now();
  state.session.segmentId = state.segmentId;
  state.recorder = new MediaRecorder(state.stream, options);
  const activeSegment = state.segmentId;

  state.recorder.addEventListener("dataavailable", event => {
    if (!event.data || event.data.size === 0) return;
    const endedAt = Date.now();
    const startedAt = state.lastChunkAt;
    state.lastChunkAt = endedAt;
    const chunkIndex = state.chunkIndex++;
    const metadata = {
      sessionId: state.session.sessionId,
      segmentId: activeSegment,
      chunkIndex,
      mimeType: state.recorder?.mimeType || event.data.type || mimeType || "audio/webm"
    };
    state.audioWriteChain = state.audioWriteChain.then(async () => {
      const encrypted = await encryptAudioChunk(state.audioKey, await event.data.arrayBuffer(), metadata);
      await putAudioChunk({
        ...metadata,
        startedAt,
        endedAt,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        aad: encrypted.aad,
        size: encrypted.ciphertext.byteLength,
        createdAt: Date.now()
      });
      dom.localStatus.textContent = `Audio cifrado: ${await countAudioChunks(state.session.sessionId)} fragmentos`;
    }).catch(error => {
      pauseSurvey("STORAGE_ERROR", `No se pudo guardar un fragmento: ${error.message}`);
    });
  });

  state.recorder.addEventListener("error", event => {
    pauseSurvey("RECORDER_ERROR", event.error?.message || "Error de grabación");
  });

  state.recorder.start(CONFIG.AUDIO_CHUNK_MS);
  state.paused = false;
  state.session.status = "ACTIVE";
  await putSession(state.session);
  setPill(dom.audioIndicator, "Grabando", "success");
  startWaveform();
  startRecordingTimer();
  await requestWakeLock();
}

function startWaveform() {
  cancelAnimationFrame(state.animationFrame);
  const canvas = dom.waveform;
  const context = canvas.getContext("2d");
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  const draw = () => {
    if (!state.analyser) return;
    state.analyser.getByteTimeDomainData(data);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#06101d";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 3;
    context.strokeStyle = "#38bdf8";
    context.beginPath();
    const slice = canvas.width / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i += 1) {
      const y = (data[i] / 128) * (canvas.height / 2);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
      x += slice;
    }
    context.stroke();
    const rms = currentRms(state.analyser);
    dom.audioLevelLabel.textContent = rms >= CONFIG.MIN_AUDIO_RMS ? `Audio detectado ${rms.toFixed(3)}` : `Audio débil ${rms.toFixed(3)}`;
    setPill(dom.audioIndicator, rms >= CONFIG.MIN_AUDIO_RMS ? "Grabando" : "Audio débil", rms >= CONFIG.MIN_AUDIO_RMS ? "success" : "warning");
    state.animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function startRecordingTimer() {
  clearInterval(state.recordingTimer);
  const update = () => {
    const running = state.recorder?.state === "recording" ? Date.now() - state.segmentStartedAt : 0;
    dom.recordingTime.textContent = formatDuration(state.elapsedBeforeSegment + running);
  };
  update();
  state.recordingTimer = setInterval(update, 1000);
}

async function stopRecorder() {
  clearInterval(state.recordingTimer);
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
  if (!state.recorder || state.recorder.state === "inactive") {
    await state.audioWriteChain;
    return;
  }
  const recorder = state.recorder;
  const stopped = new Promise(resolve => recorder.addEventListener("stop", resolve, { once: true }));
  try { recorder.requestData(); } catch {}
  recorder.stop();
  await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 5000))]);
  state.elapsedBeforeSegment += Math.max(0, Date.now() - state.segmentStartedAt);
  state.session.recordingElapsedMs = state.elapsedBeforeSegment;
  await state.audioWriteChain;
  state.recorder = null;
}

function stopStream() {
  if (state.stream) state.stream.getTracks().forEach(track => track.stop());
  state.stream = null;
}

async function closeAudioContext() {
  state.analyser = null;
  if (state.audioContext) await state.audioContext.close().catch(() => {});
  state.audioContext = null;
}

async function pauseSurvey(reason, detail = "") {
  if (!state.session || state.paused || state.isPausing || state.finishing) return;
  state.isPausing = true;
  try {
    await stopRecorder();
    stopStream();
    await closeAudioContext();
    if (state.wakeLock) await state.wakeLock.release().catch(() => {});
    state.paused = true;
    state.session.status = "PAUSED";
    state.session.questionIndex = state.questionIndex;
    await putSession(state.session);
    await recordEvent("SESSION_PAUSED", { reason, detail: String(detail).slice(0, 300) });
    setPill(dom.audioIndicator, "Pausado", "danger");
    dom.pauseDetail.textContent = detail || `Motivo registrado: ${reason}`;
    if (document.visibilityState === "visible") showScreen("pause-screen");
  } finally {
    state.isPausing = false;
  }
}

async function resumePausedSurvey() {
  dom.resumeButton.disabled = true;
  setOverlay(true, "Reconfigurando micrófono", "La encuesta continuará únicamente después de comprobar el audio.");
  try {
    await acquireMicrophone();
    await testMicrophone(state.stream);
    await startRecordingSegment();
    await recordEvent("SESSION_RESUMED", { source: "PAUSE_SCREEN" });
    renderQuestion();
    showScreen("survey-screen");
  } catch (error) {
    dom.pauseDetail.textContent = error.message;
  } finally {
    setOverlay(false);
    dom.resumeButton.disabled = false;
  }
}

function renderQuestion() {
  const question = state.questions[state.questionIndex];
  if (!question) return;
  state.session.questionIndex = state.questionIndex;
  putSession(state.session).catch(() => {});
  dom.surveyTitle.textContent = state.survey?.title || "Encuesta";
  dom.progressLabel.textContent = `Pregunta ${state.questionIndex + 1} de ${state.questions.length}`;
  dom.questionText.textContent = question.text;
  dom.questionRequired.textContent = question.required ? "Respuesta obligatoria" : "Respuesta opcional";
  dom.nextButton.textContent = state.questionIndex === state.questions.length - 1 ? "Finalizar encuesta" : "Siguiente";
  dom.answerContainer.replaceChildren();
  state.selectedOption = null;

  if (question.type === "textarea" || question.type === "text") {
    const input = document.createElement(question.type === "textarea" ? "textarea" : "input");
    input.id = "current-answer";
    input.maxLength = question.maxLength || 2000;
    input.placeholder = question.placeholder || "Escriba su respuesta";
    input.autocomplete = "off";
    dom.answerContainer.appendChild(input);
  } else if (question.type === "number") {
    const input = document.createElement("input");
    input.id = "current-answer";
    input.type = "number";
    if (Number.isFinite(question.min)) input.min = question.min;
    if (Number.isFinite(question.max)) input.max = question.max;
    input.inputMode = "decimal";
    dom.answerContainer.appendChild(input);
  } else if (["single", "yesno"].includes(question.type)) {
    const options = question.type === "yesno" ? ["Sí", "No"] : question.options;
    for (const option of options || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option-button";
      button.textContent = String(option);
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        dom.answerContainer.querySelectorAll(".option-button").forEach(item => item.setAttribute("aria-pressed", "false"));
        button.setAttribute("aria-pressed", "true");
        state.selectedOption = String(option);
      });
      dom.answerContainer.appendChild(button);
    }
  } else {
    const input = document.createElement("input");
    input.id = "current-answer";
    input.placeholder = "Respuesta";
    dom.answerContainer.appendChild(input);
  }

  dom.localStatus.textContent = "Listo para responder";
}

function readCurrentAnswer(question) {
  let answer;
  if (["single", "yesno"].includes(question.type)) answer = state.selectedOption;
  else answer = $("#current-answer")?.value?.trim() ?? "";

  if (question.required && (answer === null || answer === undefined || answer === "")) {
    throw new Error("Debe responder esta pregunta");
  }
  if (question.type === "number" && answer !== "") {
    const number = Number(answer);
    if (!Number.isFinite(number)) throw new Error("Ingrese un número válido");
    if (Number.isFinite(question.min) && number < question.min) throw new Error(`El valor mínimo es ${question.min}`);
    if (Number.isFinite(question.max) && number > question.max) throw new Error(`El valor máximo es ${question.max}`);
    answer = number;
  }
  if (typeof answer === "string" && answer.length > (question.maxLength || 5000)) {
    throw new Error("La respuesta supera la longitud permitida");
  }
  return answer;
}

async function handleNext() {
  if (state.paused || state.finishing) return;
  const question = state.questions[state.questionIndex];
  try {
    const answerValue = readCurrentAnswer(question);
    const answer = {
      sessionId: state.session.sessionId,
      questionId: question.id,
      order: question.order,
      sequence: state.questionIndex + 1,
      answer: answerValue,
      clientTimestamp: new Date().toISOString(),
      requestId: crypto.randomUUID ? crypto.randomUUID() : randomId("req_"),
      syncState: "PENDING"
    };
    await putAnswer(answer);
    dom.localStatus.textContent = "Respuesta guardada localmente ✓";
    queueAnswerSync(answer);

    if (state.questionIndex < state.questions.length - 1) {
      state.questionIndex += 1;
      renderQuestion();
      window.scrollTo({ top: 0, behavior: "instant" });
    } else {
      await finishSurvey();
    }
  } catch (error) {
    dom.localStatus.textContent = error.message;
  }
}

function queueAnswerSync(answer) {
  state.syncChain = state.syncChain.then(async () => {
    if (!navigator.onLine) throw new Error("Sin conexión");
    dom.serverStatus.textContent = `Sincronizando pregunta ${answer.sequence}…`;
    const result = await state.api.call("saveAnswer", {
      questionId: answer.questionId,
      sequence: answer.sequence,
      answer: answer.answer,
      clientTimestamp: answer.clientTimestamp
    }, state.session.sessionToken, answer.requestId);
    await markAnswerSynced(answer.sessionId, answer.questionId, result);
    dom.serverStatus.textContent = `Pregunta ${answer.sequence} confirmada ✓`;
  }).catch(error => {
    dom.serverStatus.textContent = `Pendiente: ${error.message}`;
  });
  return state.syncChain;
}

async function recordEvent(type, detail = {}) {
  if (!state.session) return;
  const event = {
    localEventId: crypto.randomUUID ? crypto.randomUUID() : randomId("evt_"),
    sessionId: state.session.sessionId,
    type,
    detail,
    timestamp: Date.now(),
    clientTimestamp: new Date().toISOString(),
    syncState: "PENDING"
  };
  await putEvent(event);
  state.syncChain = state.syncChain.then(async () => {
    if (!navigator.onLine) throw new Error("Sin conexión");
    await state.api.call("event", {
      type: event.type,
      detail: event.detail,
      clientTimestamp: event.clientTimestamp
    }, state.session.sessionToken, event.localEventId);
    await markEventSynced(event.localEventId);
  }).catch(() => {});
}

async function syncPending() {
  if (!state.session || !navigator.onLine) return;
  const answers = await getPendingAnswers(state.session.sessionId);
  for (const answer of answers) await queueAnswerSync(answer);
  const events = await getPendingEvents(state.session.sessionId);
  for (const event of events) {
    try {
      await state.api.call("event", {
        type: event.type,
        detail: event.detail,
        clientTimestamp: event.clientTimestamp
      }, state.session.sessionToken, event.localEventId);
      await markEventSynced(event.localEventId);
    } catch {}
  }
}

async function finishSurvey() {
  state.finishing = true;
  dom.nextButton.disabled = true;
  setOverlay(true, "Finalizando encuesta", "Se cerrará el audio y se comprobarán las respuestas.");
  try {
    await stopRecorder();
    stopStream();
    await closeAudioContext();
    if (state.wakeLock) await state.wakeLock.release().catch(() => {});
    state.session.status = "COMPLETED";
    state.session.completedAt = Date.now();
    state.session.questionIndex = state.questions.length;
    await putSession(state.session);
    await recordEvent("SESSION_COMPLETED", { questionCount: state.questions.length });
    await syncPending();
    await state.syncChain;

    let serverMessage = "Las respuestas permanecen guardadas localmente y se intentó sincronizarlas con Google Sheets.";
    try {
      const answerRows = await getAnswers(state.session.sessionId);
      const audioCount = await countAudioChunks(state.session.sessionId);
      const result = await state.api.call("finishSession", {
        answerCount: answerRows.length,
        audioChunkCount: audioCount,
        recordingElapsedMs: state.session.recordingElapsedMs
      }, state.session.sessionToken);
      serverMessage = result.message || "Google Sheets confirmó el cierre de la sesión.";
    } catch (error) {
      serverMessage = `El cierre remoto quedó pendiente: ${error.message}. Cree el respaldo cifrado.`;
    }
    dom.finishSummary.textContent = serverMessage;
    showScreen("finish-screen");
  } finally {
    setOverlay(false);
    dom.nextButton.disabled = false;
  }
}

async function createPackage() {
  if (!state.session || !state.audioKey) return;
  dom.exportButton.disabled = true;
  setOverlay(true, "Creando respaldo cifrado", "Se empaquetan respuestas, eventos y fragmentos AES-256-GCM.");
  try {
    const [answers, events, chunks] = await Promise.all([
      getAnswers(state.session.sessionId),
      getEvents(state.session.sessionId),
      getAudioChunks(state.session.sessionId)
    ]);
    const blob = await buildEncryptedPackage({
      session: state.session,
      answers,
      events,
      audioChunks: chunks,
      key: state.audioKey,
      onProgress: progress => {
        dom.overlayMessage.textContent = `Empaquetando fragmento ${progress.current} de ${progress.total}`;
      }
    });
    // Web Crypto no ofrece SHA-256 incremental. Leer un respaldo de varias horas
    // completo en RAM puede cerrar el navegador móvil. AES-GCM ya autentica cada
    // registro; el SHA-256 exterior se calcula solo para paquetes moderados.
    const checksumLimitBytes = 64 * 1024 * 1024;
    const checksum = blob.size <= checksumLimitBytes
      ? await sha256Hex(await blob.arrayBuffer())
      : "OMITIDO_ARCHIVO_GRANDE_AES_GCM_AUTENTICADO";
    state.session.packageSha256 = checksum;
    await putSession(state.session);
    const fileName = `encuesta_${state.session.sessionId}.encuesta`;
    state.packageFile = new File([blob], fileName, { type: "application/octet-stream", lastModified: Date.now() });
    if (state.packageUrl) URL.revokeObjectURL(state.packageUrl);
    state.packageUrl = URL.createObjectURL(state.packageFile);
    dom.downloadLink.href = state.packageUrl;
    dom.downloadLink.download = fileName;
    dom.downloadLink.classList.remove("hidden");
    dom.exportButton.textContent = checksum.startsWith("OMITIDO_")
      ? "Respaldo listo · autenticado con AES-GCM"
      : `Respaldo listo · SHA-256 ${checksum.slice(0, 12)}…`;
    if (navigator.canShare?.({ files: [state.packageFile] })) dom.shareButton.classList.remove("hidden");
    await recordEvent("PACKAGE_EXPORTED", { sha256: checksum, bytes: blob.size });
  } catch (error) {
    dom.finishSummary.textContent = `No se pudo crear el respaldo: ${error.message}`;
  } finally {
    setOverlay(false);
    dom.exportButton.disabled = false;
  }
}

async function sharePackage() {
  if (!state.packageFile) return;
  try {
    await navigator.share({
      files: [state.packageFile],
      title: "Respaldo cifrado de encuesta",
      text: "Archivo cifrado. La clave debe enviarse por un canal separado."
    });
  } catch (error) {
    if (error.name !== "AbortError") dom.finishSummary.textContent = `No se pudo compartir: ${error.message}`;
  }
}

function startHeartbeat() {
  clearInterval(state.heartbeatTimer);
  clearInterval(state.networkTimer);
  const heartbeat = async () => {
    if (!state.session || state.paused || state.finishing) return;
    try {
      const result = await state.api.call("heartbeat", {
        questionIndex: state.questionIndex,
        recording: state.recorder?.state === "recording"
      }, state.session.sessionToken);
      setPill(dom.networkIndicator, "Conectado", "success");
      dom.serverStatus.textContent = `Servidor ${new Date(result.serverTime).toLocaleTimeString()}`;
      await syncPending();
    } catch {
      setPill(dom.networkIndicator, navigator.onLine ? "Servidor sin confirmar" : "Sin conexión", "warning");
    }
  };
  heartbeat();
  state.heartbeatTimer = setInterval(heartbeat, CONFIG.HEARTBEAT_MS);
  state.networkTimer = setInterval(() => {
    if (!navigator.onLine) setPill(dom.networkIndicator, "Sin conexión", "danger");
  }, 5000);
}

async function initialize() {
  setCheck("https", window.isSecureContext ? "ok" : "error", window.isSecureContext ? "HTTPS activo" : "HTTPS requerido");
  setCheck("browser", isSupportedBrowser() ? "ok" : "error", isSupportedBrowser() ? "Compatible" : "No compatible");
  state.clientId = await getSetting("clientId") || createClientId();
  await setSetting("clientId", state.clientId);
  state.api = new ApiClient();
  state.api.onPendingChange(pending => {
    if (pending > 0) dom.serverStatus.textContent = `${pending} operación(es) en curso`;
  });

  const incomplete = await getLatestIncompleteSession();
  if (incomplete) {
    dom.resumeLocalButton.classList.remove("hidden");
    dom.resumeLocalButton.textContent = `Recuperar sesión ${incomplete.sessionId.slice(-8)}`;
  }

  renderTurnstile().catch(error => {
    setCheck("turnstile", "error", error.message);
  });

  if (CONFIG.SERVICE_WORKER_ENABLED && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  dom.configureButton.addEventListener("click", startNewSession);
  dom.resumeLocalButton.addEventListener("click", resumeStoredSession);
  dom.resumeButton.addEventListener("click", resumePausedSurvey);
  dom.nextButton.addEventListener("click", handleNext);
  dom.exportButton.addEventListener("click", createPackage);
  dom.shareButton.addEventListener("click", sharePackage);
  dom.togglePassphrase.addEventListener("click", () => {
    dom.passphrase.type = dom.passphrase.type === "password" ? "text" : "password";
    dom.togglePassphrase.textContent = dom.passphrase.type === "password" ? "Ver" : "Ocultar";
  });

  window.addEventListener("online", () => {
    setPill(dom.networkIndicator, "Reconectando", "warning");
    syncPending().catch(() => {});
  });
  window.addEventListener("offline", () => setPill(dom.networkIndicator, "Sin conexión", "danger"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pauseSurvey("PAGE_HIDDEN", "La pantalla se bloqueó o la aplicación pasó a segundo plano");
    } else if (state.paused && state.session && !state.finishing) {
      showScreen("pause-screen");
    }
  });
  window.addEventListener("pagehide", () => {
    pauseSurvey("PAGE_HIDE", "La página fue cerrada o suspendida");
  });
}

bindEvents();
initialize().catch(error => setMessage(error.message, "error"));
