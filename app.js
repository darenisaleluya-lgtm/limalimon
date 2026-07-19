"use strict";

(() => {
  const C = window.APP_CONFIG;
  const DB_NAME = "encuesta-simple-segura-v1";
  const DB_VERSION = 1;

  const $ = (id) => document.getElementById(id);
  const views = ["loginView", "setupView", "surveyView", "finishView"];

  const state = {
    clientId: localStorage.getItem("surveyClientId") || crypto.randomUUID(),
    token: localStorage.getItem("surveyToken") || "",
    sessionId: localStorage.getItem("surveySessionId") || "",
    questions: [],
    answers: {},
    index: 0,
    stream: null,
    audioContext: null,
    analyser: null,
    monitorSource: null,
    monitorTimer: null,
    questionRecorder: null,
    questionParts: [],
    sessionRecorder: null,
    sessionChunkSequence: Number(localStorage.getItem("sessionChunkSequence") || "0"),
    sessionSegment: Number(localStorage.getItem("sessionSegment") || "0"),
    wakeLock: null,
    configured: false,
    sending: false,
    completed: false
  };
  localStorage.setItem("surveyClientId", state.clientId);

  let dbPromise;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("pending")) {
          const store = db.createObjectStore("pending", { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("fullChunks")) {
          const store = db.createObjectStore("fullChunks", { keyPath: "key" });
          store.createIndex("sessionId", "sessionId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetSessionChunks(sessionId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const index = db.transaction("fullChunks", "readonly").objectStore("fullChunks").index("sessionId");
      const req = index.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.order - b.order));
      req.onerror = () => reject(req.error);
    });
  }

  function showView(id) {
    views.forEach((viewId) => $(viewId).classList.toggle("active", viewId === id));
  }

  function setMessage(el, text, kind = "") {
    el.textContent = text || "";
    el.className = `message ${kind}`.trim();
  }

  function cleanCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
  }

  function apiConfigured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(C.API_URL);
  }

  async function apiRequest(action, payload = {}, token = state.token) {
    if (!apiConfigured()) {
      throw new Error("Falta configurar API_URL en config.js con la dirección /exec de Apps Script.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(C.API_URL, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action,
          token: token || "",
          clientId: state.clientId,
          requestId: crypto.randomUUID(),
          payload
        }),
        signal: controller.signal
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Apps Script no devolvió JSON válido. Revise la implementación /exec y sus permisos.");
      }
      if (!data.ok) throw new Error(data.error || "La solicitud fue rechazada.");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("La conexión tardó demasiado.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const size = 0x8000;
    for (let i = 0; i < bytes.length; i += size) {
      binary += String.fromCharCode(...bytes.subarray(i, i + size));
    }
    return btoa(binary);
  }

  async function addPending(action, payload) {
    const item = {
      id: crypto.randomUUID(),
      action,
      payload,
      createdAt: Date.now(),
      tries: 0
    };
    await idbPut("pending", item);
    updatePendingStatus();
    processQueue();
    return item.id;
  }

  async function serializePayload(payload) {
    const result = { ...payload };
    if (payload.audioBlob instanceof Blob) {
      result.audioBase64 = await blobToBase64(payload.audioBlob);
      result.audioMime = payload.audioBlob.type || "audio/webm";
      result.audioBytes = payload.audioBlob.size;
      delete result.audioBlob;
    }
    return result;
  }

  async function processQueue() {
    if (state.sending || !navigator.onLine || !state.token) return;
    state.sending = true;
    try {
      let items = (await idbGetAll("pending")).sort((a, b) => a.createdAt - b.createdAt);
      for (const item of items) {
        try {
          const payload = await serializePayload(item.payload);
          await apiRequest(item.action, payload);
          await idbDelete("pending", item.id);
        } catch (error) {
          item.tries += 1;
          item.lastError = String(error.message || error).slice(0, 250);
          await idbPut("pending", item);
          if (!navigator.onLine || item.tries >= 3) break;
          await new Promise((r) => setTimeout(r, Math.min(5000, 500 * (2 ** item.tries))));
        }
      }
    } finally {
      state.sending = false;
      updatePendingStatus();
    }
  }

  async function updatePendingStatus() {
    const count = (await idbGetAll("pending")).length;
    if ($("saveStatus")) {
      setMessage($("saveStatus"), count ? `${count} envío(s) pendiente(s). Se reintentará automáticamente.` : "Información sincronizada.", count ? "warning" : "success");
    }
    if ($("finishSummary") && state.completed) {
      $("finishSummary").textContent = count ? `La encuesta terminó. Quedan ${count} envío(s) pendientes.` : "Todas las respuestas y cortes de audio fueron enviados.";
    }
    return count;
  }

  function setConnectionUi() {
    const online = navigator.onLine;
    $("connectionDot").className = `dot ${online ? "online" : "offline"}`;
    $("connectionText").textContent = online ? "Con conexión" : "Sin conexión";
    if (online) processQueue();
  }

  function supportedMime() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus"
    ];
    return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
  }

  function recorderOptions() {
    const mimeType = supportedMime();
    return {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: C.AUDIO_BITS_PER_SECOND
    };
  }

  async function configureEnvironment() {
    setMessage($("setupMsg"), "Solicitando permisos...");
    $("configureBtn").disabled = true;
    try {
      if (!window.isSecureContext) throw new Error("La página debe abrirse mediante HTTPS.");
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error("Este navegador no permite la grabación requerida.");
      }

      const storage = await checkStorage();
      $("setupStatus").classList.remove("hidden");
      $("storageStatus").textContent = storage.persisted ? "Persistente" : "Disponible, sin garantía de persistencia";
      $("storageEstimate").textContent = `${storage.availableMb.toFixed(0)} MB disponibles estimados; ${storage.requiredMb.toFixed(0)} MB recomendados.`;

      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      const track = state.stream.getAudioTracks()[0];
      if (!track) throw new Error("No se encontró un micrófono activo.");
      track.addEventListener("ended", () => handleMicEnded());
      $("micSetupStatus").textContent = `Autorizado${track.label ? `: ${track.label}` : ""}`;

      await startAudioMonitor();
      $("audioMonitor").classList.remove("hidden");
      $("testControls").classList.remove("hidden");
      $("startSurveyBtn").classList.remove("hidden");
      state.configured = true;
      setMessage($("setupMsg"), "Entorno configurado. La prueba para escucharse es opcional.", "success");
    } catch (error) {
      state.configured = false;
      setMessage($("setupMsg"), microphoneHelp(error), "error");
    } finally {
      $("configureBtn").disabled = false;
    }
  }

  function microphoneHelp(error) {
    const name = error?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "El micrófono fue bloqueado. Abra los permisos del sitio en el navegador, permita el micrófono y vuelva a pulsar Configurar entorno.";
    }
    if (name === "NotFoundError") return "El teléfono no informó ningún micrófono disponible.";
    if (name === "NotReadableError") return "El micrófono está ocupado o no puede abrirse. Cierre otras aplicaciones que lo estén usando.";
    return error?.message || "No se pudo configurar el micrófono.";
  }

  async function checkStorage() {
    await openDb();
    const testKey = `test-${crypto.randomUUID()}`;
    await idbPut("pending", { id: testKey, action: "test", payload: {}, createdAt: Date.now(), tries: 0 });
    await idbDelete("pending", testKey);

    let quota = 0;
    let usage = 0;
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      quota = Number(estimate.quota || 0);
      usage = Number(estimate.usage || 0);
    }
    let persisted = false;
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();

    const audioMb = (C.AUDIO_BITS_PER_SECOND * C.EXPECTED_MAX_HOURS * 3600) / 8 / 1024 / 1024;
    const requiredMb = audioMb * 2.2 + C.STORAGE_SAFETY_MB;
    const availableMb = quota ? Math.max(0, quota - usage) / 1024 / 1024 : requiredMb;
    if (quota && availableMb < requiredMb) {
      throw new Error(`Espacio insuficiente. Se recomiendan ${requiredMb.toFixed(0)} MB y el navegador informa aproximadamente ${availableMb.toFixed(0)} MB.`);
    }
    return { persisted, availableMb, requiredMb };
  }

  async function startAudioMonitor() {
    if (state.audioContext) return;
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await state.audioContext.resume();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.25;
    state.monitorSource = state.audioContext.createMediaStreamSource(state.stream);
    state.monitorSource.connect(state.analyser);
    const samples = new Float32Array(state.analyser.fftSize);
    const history = [];

    const loop = () => {
      state.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      let peak = 0;
      let crossings = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
        if (i > 0 && ((samples[i - 1] < 0 && v >= 0) || (samples[i - 1] >= 0 && v < 0))) crossings++;
      }
      const rms = Math.sqrt(sum / samples.length);
      const zcr = crossings / samples.length;
      history.push(rms);
      if (history.length > 30) history.shift();
      const mean = history.reduce((a, b) => a + b, 0) / history.length;
      const variation = Math.sqrt(history.reduce((a, b) => a + ((b - mean) ** 2), 0) / history.length);
      const level = Math.min(100, Math.round(rms * 500));
      $("audioBar").style.width = `${level}%`;
      $("liveMeterBar").style.width = `${level}%`;

      let advice = "Audio recibido.";
      let kind = "success";
      if (peak > 0.98) {
        advice = "El sonido está saturado. Aleje un poco el celular de la boca.";
        kind = "warning";
      } else if (rms < 0.008) {
        advice = "No se detecta sonido. Acerque el celular a la boca y hable con claridad.";
        kind = "error";
      } else if (rms < 0.018) {
        advice = "El sonido está bajo. Acerque un poco más el celular a la boca.";
        kind = "warning";
      } else if ((variation < 0.0025 && rms > 0.02) || zcr > 0.32) {
        advice = "Se detecta ruido constante. Busque un lugar más silencioso y acerque el celular a la boca.";
        kind = "warning";
      } else if (zcr >= 0.01 && zcr <= 0.30) {
        advice = "Señal compatible con voz recibida correctamente.";
      }
      $("audioAdvice").textContent = advice;
      $("audioAdvice").className = `message ${kind}`;
      $("liveAdvice").textContent = advice;
      $("liveAdvice").className = `advice ${kind}`;
      $("micDot").className = `dot ${rms >= 0.008 ? "online" : "offline"}`;
      $("micText").textContent = rms >= 0.008 ? "Audio activo" : "Sin señal";
      state.monitorTimer = requestAnimationFrame(loop);
    };
    loop();
  }

  function handleMicEnded() {
    $("micDot").className = "dot offline";
    $("micText").textContent = "Micrófono interrumpido";
    setMessage($("saveStatus"), "El micrófono se desconectó. No continúe hasta volver a configurar el entorno.", "error");
    if (state.questionRecorder?.state === "recording") state.questionRecorder.stop();
    if (state.sessionRecorder?.state === "recording") state.sessionRecorder.stop();
  }

  async function runAudioTest() {
    if (!state.stream) return;
    $("testAudioBtn").disabled = true;
    setMessage($("setupMsg"), "Hable durante cinco segundos...");
    const parts = [];
    const recorder = new MediaRecorder(state.stream, recorderOptions());
    recorder.ondataavailable = (event) => { if (event.data?.size) parts.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 5000);
    await stopped;
    const blob = new Blob(parts, { type: recorder.mimeType || parts[0]?.type || "audio/webm" });
    const player = $("testPlayer");
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(blob);
    player.classList.remove("hidden");
    await player.play().catch(() => {});
    setMessage($("setupMsg"), "Escuche la prueba. Puede repetirla o iniciar la encuesta.", "success");
    $("testAudioBtn").disabled = false;
  }

  async function login() {
    const code = cleanCode($("accessCode").value);
    $("accessCode").value = code;
    if (code.length < 12) {
      setMessage($("loginMsg"), "El código no es válido. Comuníquese con su líder más cercano.", "error");
      return;
    }
    $("loginBtn").disabled = true;
    setMessage($("loginMsg"), "Validando código...");
    try {
      const result = await apiRequest("login", {
        code,
        userAgent: navigator.userAgent.slice(0, 300)
      }, "");
      state.token = result.token;
      state.sessionId = result.sessionId;
      state.questions = result.questions || [];
      state.answers = result.answers || {};
      localStorage.setItem("surveyToken", state.token);
      localStorage.setItem("surveySessionId", state.sessionId);
      if (!state.questions.length) throw new Error("La encuesta no tiene preguntas activas.");
      showView("setupView");
    } catch (error) {
      setMessage($("loginMsg"), error.message.includes("código") ? error.message : "No se pudo validar el código. Comuníquese con su líder más cercano.", "error");
    } finally {
      $("loginBtn").disabled = false;
    }
  }

  async function startSurvey() {
    if (!state.configured || !state.stream) {
      setMessage($("setupMsg"), "Primero debe configurar el entorno.", "error");
      return;
    }
    await requestWakeLock();
    state.sessionSegment += 1;
    localStorage.setItem("sessionSegment", String(state.sessionSegment));
    startSessionRecorder();
    state.index = 0;
    showView("surveyView");
    renderQuestion();
    setConnectionUi();
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) state.wakeLock = await navigator.wakeLock.request("screen");
    } catch { /* El sistema puede rechazarlo. */ }
  }

  function startSessionRecorder() {
    state.sessionRecorder = new MediaRecorder(state.stream, recorderOptions());
    state.sessionRecorder.ondataavailable = async (event) => {
      if (!event.data?.size) return;
      state.sessionChunkSequence += 1;
      localStorage.setItem("sessionChunkSequence", String(state.sessionChunkSequence));
      const order = state.sessionSegment * 1000000 + state.sessionChunkSequence;
      await idbPut("fullChunks", {
        key: `${state.sessionId}:${order}`,
        sessionId: state.sessionId,
        order,
        segment: state.sessionSegment,
        sequence: state.sessionChunkSequence,
        mime: event.data.type || state.sessionRecorder.mimeType,
        blob: event.data,
        createdAt: Date.now()
      });
      await addPending("uploadSessionChunk", {
        segment: state.sessionSegment,
        sequence: state.sessionChunkSequence,
        capturedAt: new Date().toISOString(),
        audioBlob: event.data
      });
    };
    state.sessionRecorder.onerror = () => setMessage($("saveStatus"), "La grabación general presentó un error. Los fragmentos anteriores permanecen guardados.", "error");
    state.sessionRecorder.start(C.SESSION_CHUNK_MS);
  }

  function startQuestionRecorder() {
    state.questionParts = [];
    state.questionRecorder = new MediaRecorder(state.stream, recorderOptions());
    state.questionRecorder.ondataavailable = (event) => {
      if (event.data?.size) state.questionParts.push(event.data);
    };
    state.questionRecorder.start(60000);
  }

  async function stopQuestionRecorder() {
    const recorder = state.questionRecorder;
    if (!recorder) return [];
    if (recorder.state !== "inactive") {
      await new Promise((resolve) => {
        const old = recorder.onstop;
        recorder.onstop = (event) => { if (old) old(event); resolve(); };
        recorder.stop();
      });
    }
    state.questionRecorder = null;
    return state.questionParts.slice();
  }

  function renderQuestion() {
    const q = state.questions[state.index];
    if (!q) return;
    $("progressText").textContent = `${state.index + 1} / ${state.questions.length}`;
    $("questionText").textContent = q.text;
    $("backBtn").disabled = state.index === 0;
    $("nextBtn").textContent = state.index === state.questions.length - 1 ? "Finalizar" : "Siguiente";
    renderAnswerInput(q);
    startQuestionRecorder();
  }

  function renderAnswerInput(q) {
    const container = $("answerContainer");
    container.innerHTML = "";
    const saved = state.answers[q.id] ?? "";
    let input;
    if (q.type === "textarea") {
      input = document.createElement("textarea");
      input.value = saved;
      input.placeholder = "Escriba su respuesta";
    } else if (q.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.value = saved;
    } else if (q.type === "select") {
      input = document.createElement("select");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Seleccione una opción";
      input.appendChild(empty);
      (q.options || []).forEach((option) => {
        const el = document.createElement("option");
        el.value = option;
        el.textContent = option;
        input.appendChild(el);
      });
      input.value = saved;
    } else if (q.type === "radio") {
      const list = document.createElement("div");
      list.className = "choiceList";
      (q.options || []).forEach((option) => {
        const label = document.createElement("label");
        label.className = "choiceItem";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "answer";
        radio.value = option;
        radio.checked = saved === option;
        label.append(radio, document.createTextNode(option));
        list.appendChild(label);
      });
      container.appendChild(list);
      return;
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = saved;
      input.placeholder = "Escriba su respuesta";
    }
    input.id = "currentAnswer";
    input.maxLength = q.maxLength || 2000;
    container.appendChild(input);
    setTimeout(() => input.focus(), 50);
  }

  function getCurrentAnswer(q) {
    if (q.type === "radio") return document.querySelector('input[name="answer"]:checked')?.value || "";
    return $("currentAnswer")?.value?.trim() || "";
  }

  async function saveCurrentAndMove(direction) {
    const q = state.questions[state.index];
    const answer = getCurrentAnswer(q);
    if (direction > 0 && q.required && !answer) {
      setMessage($("saveStatus"), "Debe responder esta pregunta antes de continuar.", "error");
      return;
    }
    $("backBtn").disabled = true;
    $("nextBtn").disabled = true;
    setMessage($("saveStatus"), "Guardando respuesta y nota de voz...");

    const parts = await stopQuestionRecorder();
    state.answers[q.id] = answer;
    const submissionId = crypto.randomUUID();
    await addPending("submitAnswer", {
      questionId: q.id,
      answer,
      submissionId,
      answeredAt: new Date().toISOString()
    });
    for (let i = 0; i < parts.length; i++) {
      await addPending("uploadQuestionAudio", {
        questionId: q.id,
        submissionId,
        part: i + 1,
        totalParts: parts.length,
        capturedAt: new Date().toISOString(),
        audioBlob: parts[i]
      });
    }

    if (direction < 0) {
      state.index -= 1;
      renderQuestion();
    } else if (state.index < state.questions.length - 1) {
      state.index += 1;
      renderQuestion();
    } else {
      await finishSurvey();
      return;
    }
    $("backBtn").disabled = state.index === 0;
    $("nextBtn").disabled = false;
  }

  async function stopSessionRecorder() {
    if (!state.sessionRecorder || state.sessionRecorder.state === "inactive") return;
    await new Promise((resolve) => {
      const recorder = state.sessionRecorder;
      const old = recorder.onstop;
      recorder.onstop = (event) => { if (old) old(event); resolve(); };
      recorder.stop();
    });
  }

  async function flushQueue(maxWaitMs = 90000) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      if (!state.sending) await processQueue();
      const pending = (await idbGetAll("pending")).length;
      if (!pending) return 0;
      if (!navigator.onLine) return pending;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return (await idbGetAll("pending")).length;
  }

  async function tryCompleteServer() {
    const pending = (await idbGetAll("pending")).length;
    if (pending) return { completed: false, error: `Quedan ${pending} envío(s) pendientes.` };
    try {
      await apiRequest("completeSession", { completedAt: new Date().toISOString() });
      return { completed: true, error: "" };
    } catch (error) {
      return { completed: false, error: error.message };
    }
  }

  async function finishSurvey() {
    setMessage($("saveStatus"), "Cerrando grabación...");
    await stopSessionRecorder();
    await flushQueue();
    const completion = await tryCompleteServer();
    const completeError = completion.error;
    state.completed = true;
    showView("finishView");
    const pending = await updatePendingStatus();
    if (completeError) setMessage($("finishMsg"), `La grabación local está disponible. El servidor informó: ${completeError}`, "warning");
    else if (pending) setMessage($("finishMsg"), "Descargue la grabación y conserve el archivo hasta que todos los envíos terminen.", "warning");
    else setMessage($("finishMsg"), "Proceso completado.", "success");
    if (state.wakeLock) await state.wakeLock.release().catch(() => {});
  }

  async function downloadFullRecording() {
    $("downloadFullBtn").disabled = true;
    setMessage($("finishMsg"), "Preparando la grabación completa. En sesiones largas puede tardar...");
    try {
      const chunks = await idbGetSessionChunks(state.sessionId);
      if (!chunks.length) throw new Error("No se encontraron fragmentos locales.");
      const mime = chunks[0].mime || "audio/webm";
      const blob = new Blob(chunks.map((item) => item.blob), { type: mime });
      const extension = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `grabacion-completa-${state.sessionId}.${extension}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage($("finishMsg"), `Grabación preparada: ${(blob.size / 1024 / 1024).toFixed(1)} MB. No borre los datos del navegador hasta verificar el archivo.`, "success");
    } catch (error) {
      setMessage($("finishMsg"), error.message, "error");
    } finally {
      $("downloadFullBtn").disabled = false;
    }
  }

  async function retryPending() {
    $("retryPendingBtn").disabled = true;
    await flushQueue();
    const count = await updatePendingStatus();
    if (count) {
      setMessage($("finishMsg"), `Todavía quedan ${count} envío(s). Verifique la conexión.`, "warning");
    } else {
      const completion = await tryCompleteServer();
      setMessage($("finishMsg"), completion.completed ? "Todos los envíos terminaron y la sesión quedó cerrada." : completion.error, completion.completed ? "success" : "warning");
    }
    $("retryPendingBtn").disabled = false;
  }

  async function restoreWakeLock() {
    if (document.visibilityState === "visible" && state.completed === false && $("surveyView").classList.contains("active")) {
      await requestWakeLock();
    }
  }

  function bindEvents() {
    $("accessCode").addEventListener("input", (e) => { e.target.value = cleanCode(e.target.value); });
    $("accessCode").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
    $("loginBtn").addEventListener("click", login);
    $("configureBtn").addEventListener("click", configureEnvironment);
    $("testAudioBtn").addEventListener("click", runAudioTest);
    $("startSurveyBtn").addEventListener("click", startSurvey);
    $("backBtn").addEventListener("click", () => saveCurrentAndMove(-1));
    $("nextBtn").addEventListener("click", () => saveCurrentAndMove(1));
    $("downloadFullBtn").addEventListener("click", downloadFullRecording);
    $("retryPendingBtn").addEventListener("click", retryPending);
    window.addEventListener("online", setConnectionUi);
    window.addEventListener("offline", setConnectionUi);
    document.addEventListener("visibilitychange", restoreWakeLock);
    window.addEventListener("beforeunload", (event) => {
      if ($("surveyView").classList.contains("active") && !state.completed) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    setInterval(processQueue, 8000);
  }

  async function init() {
    bindEvents();
    setConnectionUi();
    try {
      await openDb();
    } catch {
      setMessage($("loginMsg"), "Este navegador no permite el almacenamiento local requerido.", "error");
    }
    if (!apiConfigured()) {
      setMessage($("loginMsg"), "Antes de probar, configure API_URL en el archivo config.js.", "warning");
    }
  }

  init();
})();
