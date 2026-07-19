import { decryptPackage } from "./crypto.js";
import { ApiClient } from "./api.js";

const CONFIG = window.APP_CONFIG;
const $ = selector => document.querySelector(selector);
const dom = {
  file: $("#package-file"),
  passphrase: $("#package-passphrase"),
  decryptButton: $("#decrypt-button"),
  message: $("#recover-message"),
  content: $("#recovered-content"),
  summary: $("#manifest-summary"),
  segments: $("#segments-container"),
  syncButton: $("#sync-answers-button"),
  overlay: $("#recover-overlay"),
  overlayMessage: $("#recover-overlay-message")
};

const state = {
  result: null,
  api: null,
  turnstileWidgetId: null,
  turnstileToken: "",
  urls: []
};

function setMessage(text, kind = "") {
  dom.message.textContent = text;
  dom.message.className = `message ${kind}`.trim();
}

function setOverlay(show, message = "No cierre esta pantalla.") {
  dom.overlay.classList.toggle("hidden", !show);
  dom.overlayMessage.textContent = message;
}

async function waitForTurnstile() {
  const deadline = Date.now() + 15000;
  while (!window.turnstile && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
  if (!window.turnstile) throw new Error("No cargó Turnstile");
}

async function renderTurnstile() {
  await waitForTurnstile();
  state.turnstileWidgetId = window.turnstile.render("#recover-turnstile", {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    action: CONFIG.TURNSTILE_ACTION,
    theme: "dark",
    size: "flexible",
    callback: token => { state.turnstileToken = token; },
    "expired-callback": () => { state.turnstileToken = ""; },
    "error-callback": () => { state.turnstileToken = ""; return true; }
  });
}

function resetTurnstile() {
  state.turnstileToken = "";
  if (state.turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(state.turnstileWidgetId);
}

function addSummary(term, description) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = String(description);
  dom.summary.append(dt, dd);
}

function renderRecovered(result) {
  state.urls.forEach(url => URL.revokeObjectURL(url));
  state.urls = [];
  dom.summary.replaceChildren();
  dom.segments.replaceChildren();
  const session = result.manifest.session;
  addSummary("Sesión", session.sessionId);
  addSummary("Encuesta", session.survey?.title || session.survey?.surveyId || "Sin título");
  addSummary("Estado", session.status);
  addSummary("Respuestas", result.manifest.answers.length);
  addSummary("Eventos", result.manifest.events.length);
  addSummary("Segmentos", result.segments.length);
  addSummary("Exportación", result.manifest.exportedAt);

  for (const segment of result.segments) {
    const card = document.createElement("article");
    card.className = "segment-card";
    const title = document.createElement("h3");
    title.textContent = `Segmento ${segment.segmentId}`;
    const detail = document.createElement("p");
    detail.textContent = `${segment.chunkCount} fragmento(s) · ${segment.mimeType}`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    const url = URL.createObjectURL(segment.blob);
    state.urls.push(url);
    audio.src = url;
    const link = document.createElement("a");
    link.className = "secondary-button";
    link.href = url;
    const extension = segment.mimeType.includes("mp4") ? "m4a" : segment.mimeType.includes("ogg") ? "ogg" : "webm";
    link.download = `${session.sessionId}_segmento_${segment.segmentId}.${extension}`;
    link.textContent = "Guardar segmento descifrado";
    card.append(title, detail, audio, link);
    dom.segments.appendChild(card);
  }
  dom.content.classList.remove("hidden");
}

async function decryptSelected() {
  const file = dom.file.files?.[0];
  const passphrase = dom.passphrase.value;
  if (!file) return setMessage("Seleccione un archivo .encuesta", "error");
  if (passphrase.length < CONFIG.MIN_PASSPHRASE_LENGTH) return setMessage("Ingrese la clave completa", "error");
  dom.decryptButton.disabled = true;
  setOverlay(true, "Leyendo y verificando el paquete cifrado.");
  try {
    state.result = await decryptPackage(file, passphrase, progress => {
      dom.overlayMessage.textContent = `Descifrando registro ${progress.current} de ${progress.total}`;
    });
    renderRecovered(state.result);
    dom.passphrase.value = "";
    setMessage("Integridad y clave verificadas correctamente.", "success");
  } catch (error) {
    state.result = null;
    dom.content.classList.add("hidden");
    setMessage(`No se pudo recuperar: ${error.message}`, "error");
  } finally {
    setOverlay(false);
    dom.decryptButton.disabled = false;
  }
}

async function syncAnswers() {
  if (!state.result) return;
  if (!state.turnstileToken) return setMessage("Complete la validación de seguridad para sincronizar", "error");
  const session = state.result.manifest.session;
  if (!session.resumeKey) return setMessage("El paquete no contiene una credencial de recuperación", "error");
  dom.syncButton.disabled = true;
  setOverlay(true, "Obteniendo una sesión segura de Apps Script.");
  try {
    const renewed = await state.api.call("resumeSession", {
      sessionId: session.sessionId,
      resumeKey: session.resumeKey,
      turnstileToken: state.turnstileToken,
      recoveryImport: true
    });
    resetTurnstile();
    let completed = 0;
    for (const answer of state.result.manifest.answers) {
      dom.overlayMessage.textContent = `Sincronizando respuesta ${completed + 1} de ${state.result.manifest.answers.length}`;
      await state.api.call("saveAnswer", {
        questionId: answer.questionId,
        sequence: answer.sequence,
        answer: answer.answer,
        clientTimestamp: answer.clientTimestamp,
        recoveryImport: true
      }, renewed.sessionToken, answer.requestId || "");
      completed += 1;
    }
    await state.api.call("event", {
      type: "RECOVERY_IMPORTED",
      detail: { answerCount: completed, segmentCount: state.result.segments.length },
      clientTimestamp: new Date().toISOString()
    }, renewed.sessionToken);
    await state.api.call("finishSession", {
      answerCount: completed,
      audioChunkCount: state.result.header.recordCount - 1,
      recordingElapsedMs: session.recordingElapsedMs || 0,
      recoveryImport: true
    }, renewed.sessionToken);
    setMessage(`${completed} respuestas fueron verificadas y sincronizadas con Google Sheets. El audio se mantiene local para evitar los límites de Apps Script.`, "success");
  } catch (error) {
    setMessage(`La sincronización falló: ${error.message}`, "error");
  } finally {
    setOverlay(false);
    dom.syncButton.disabled = false;
  }
}

async function initialize() {
  state.api = new ApiClient();
  await renderTurnstile();
}

dom.decryptButton.addEventListener("click", decryptSelected);
dom.syncButton.addEventListener("click", syncAnswers);
initialize().catch(error => setMessage(error.message, "error"));
