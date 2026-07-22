(() => {
  'use strict';
  const C = window.SURVEY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const views = ['loadingView','loginView','setupView','surveyView','closingView','doneView','blockedView'];
  const encoder = new TextEncoder();

  const state = {
    db: null,
    clientId: crypto.randomUUID(),
    deviceInstallId: '',
    deviceProfileId: '',
    visitId: '',
    visitToken: '',
    profile: {},
    token: '',
    sessionId: '',
    questions: [],
    answers: {},
    revisions: {},
    index: 0,
    stream: null,
    audioContext: null,
    analyser: null,
    monitorTimer: null,
    noiseFloor: 0.004,
    calibrationUntil: 0,
    lastVoiceAt: Date.now(),
    configured: false,
    aesKey: null,
    wrappedKeyB64: '',
    questionRecorder: null,
    questionContext: null,
    questionChain: Promise.resolve(),
    questionSegmentTimer: null,
    fullRecorder: null,
    fullChain: Promise.resolve(),
    fullRecordingActive: false,
    fullSegmentTimer: null,
    fullSequence: 0,
    queueRunning: false,
    throughputBps: 0,
    uploadFailures: 0,
    requiredOpsCreated: 0,
    requiredOpsDone: 0,
    fullOpsDone: 0,
    closing: false,
    completed: false,
    closingStartedAt: 0,
    backupOffered: false,
    location: null
  };

  function showView(id) {
    views.forEach((name) => $(name).classList.toggle('active', name === id));
  }

  function setMessage(el, text, kind = '') {
    el.textContent = text || '';
    el.className = `message ${kind}`.trim();
  }

  function apiConfigured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(String(C.API_URL || ''));
  }

  function b64u(bytes) {
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < array.length; i += 0x8000) binary += String.fromCharCode(...array.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64uToBytes(value) {
    let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4) text += '=';
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function getOrCreateInstallId() {
    try {
      const key = 'encuesta_device_install_id_v3';
      let value = localStorage.getItem(key);
      if (!value) {
        value = 'dev_' + crypto.randomUUID().replace(/-/g, '');
        localStorage.setItem(key, value);
      }
      return value;
    } catch (_) {
      return 'ephemeral_' + crypto.randomUUID().replace(/-/g, '');
    }
  }

  async function collectProfile() {
    let uaData = {};
    try {
      if (navigator.userAgentData?.getHighEntropyValues) {
        uaData = await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']);
        uaData.mobile = navigator.userAgentData.mobile;
        uaData.platform = navigator.userAgentData.platform;
      }
    } catch (_) {}
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let battery = {};
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        battery = { charging: Boolean(b.charging), level: Number(b.level), chargingTime: Number(b.chargingTime), dischargingTime: Number(b.dischargingTime) };
      }
    } catch (_) {}
    const profile = {
      userAgent: navigator.userAgent || '',
      uaFamily: navigator.userAgentData?.brands?.map((x) => x.brand).join(',') || navigator.appName || '',
      uaData,
      platform: navigator.userAgentData?.platform || navigator.platform || '',
      vendor: navigator.vendor || '',
      product: navigator.product || '',
      mobile: Boolean(navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')),
      language: navigator.language || '',
      languages: navigator.languages || [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      timezoneOffset: new Date().getTimezoneOffset(),
      screen: `${screen.width}x${screen.height}|${screen.availWidth}x${screen.availHeight}|${screen.colorDepth}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio || 1,
      touchPoints: navigator.maxTouchPoints || 0,
      cores: navigator.hardwareConcurrency || '',
      deviceMemory: navigator.deviceMemory || '',
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack || '',
      webdriver: Boolean(navigator.webdriver),
      online: navigator.onLine,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      battery,
      referrer: document.referrer || '',
      pageOrigin: location.origin || '',
      pagePath: location.pathname || '/',
      indexedDbSupported: Boolean(window.indexedDB),
      webCryptoSupported: Boolean(window.crypto?.subtle),
      mediaRecorderSupported: Boolean(window.MediaRecorder),
      getUserMediaSupported: Boolean(navigator.mediaDevices?.getUserMedia),
      storageStatus: 'NO_PROBADO',
      network: connection ? {
        effectiveType: connection.effectiveType || '',
        downlink: connection.downlink || '',
        rtt: connection.rtt || '',
        saveData: Boolean(connection.saveData),
        type: connection.type || ''
      } : {},
      capabilities: {
        secureContext: window.isSecureContext,
        webShare: Boolean(navigator.share),
        fileSystemAccess: Boolean(window.showSaveFilePicker),
        visibilityApi: typeof document.hidden === 'boolean',
        screenOrientation: screen.orientation?.type || '',
        pdfViewerEnabled: navigator.pdfViewerEnabled
      }
    };
    state.profile = profile;
    return profile;
  }

  function queryParams() {
    return new URLSearchParams(location.search);
  }

  async function apiRequest(action, payload = {}, token = '', options = {}) {
    if (!apiConfigured()) throw new Error('Falta configurar API_URL en config.js con la dirección /exec de Apps Script.');
    const request = {
      action,
      token: token || '',
      clientId: state.clientId,
      requestId: crypto.randomUUID(),
      payload
    };
    const body = JSON.stringify(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
    const started = performance.now();
    try {
      const response = await fetch(C.API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit'
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error('El servidor no devolvió una respuesta válida.'); }
      if (!data.ok) throw new Error(data.error || 'La solicitud fue rechazada.');
      const elapsed = Math.max(0.05, (performance.now() - started) / 1000);
      if (options.measure !== false) {
        const sentBytes = encoder.encode(body).length;
        const sample = sentBytes / elapsed;
        state.throughputBps = state.throughputBps ? state.throughputBps * 0.72 + sample * 0.28 : sample;
        state.uploadFailures = Math.max(0, state.uploadFailures - 0.25);
        persistMetrics();
      }
      return data;
    } catch (error) {
      state.uploadFailures += 1;
      if (error.name === 'AbortError') throw new Error('La conexión tardó demasiado.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeAccess() {
    state.deviceInstallId = getOrCreateInstallId();
    const normalizePageBase = (value) => {
      const text = String(value || '').split('#')[0].split('?')[0].replace(/\/index\.html$/i, '/').replace(/\/+$/, '/');
      return text && !text.endsWith('/') ? text + '/' : text;
    };
    const official = normalizePageBase(C.OFFICIAL_SITE_URL);
    const current = normalizePageBase(location.origin + location.pathname);
    const accidentalClone = Boolean(official && !current.startsWith(official));
    state.profile = await collectProfile();
    const params = queryParams();
    const incomingToken = params.get('vt') || ''; // Solo compatibilidad con enlaces antiguos; GitHub directo es el flujo normal.
    try {
      const result = await apiRequest('registerClientVisit', {
        visitToken: incomingToken,
        deviceInstallId: state.deviceInstallId,
        campaignId: params.get('campaign') || C.CAMPAIGN_ID,
        clientTime: new Date().toISOString(),
        profile: state.profile
      }, '', { measure: false });
      state.visitId = result.visitId;
      state.visitToken = result.visitToken;
      state.deviceProfileId = result.deviceProfileId;
      showView('loginView');
      if (accidentalClone) setMessage($('loginMsg'), 'Este sitio no corresponde al enlace oficial de la encuesta.', 'error');
    } catch (error) {
      showView('loginView');
      setMessage($('loginMsg'), error.message, 'error');
    }
  }

  function openDb() {
    if (state.db) return Promise.resolve(state.db);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('INDEXEDDB_UNAVAILABLE'));
      const req = indexedDB.open('encuesta-control-seguro-v3', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('queue')) {
          const store = db.createObjectStore('queue', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('encrypted')) {
          const store = db.createObjectStore('encrypted', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('answers')) {
          const store = db.createObjectStore('answers', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
      };
      req.onsuccess = () => { state.db = req.result; resolve(state.db); };
      req.onerror = () => reject(req.error || new Error('INDEXEDDB_ERROR'));
      req.onblocked = () => reject(new Error('INDEXEDDB_BLOCKED'));
    });
  }

  async function dbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IDB_ABORT'));
    });
  }

  async function dbGet(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbClear(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function persistMetrics() {
    try {
      await dbPut('meta', { key: 'metrics', throughputBps: state.throughputBps, uploadFailures: state.uploadFailures, requiredOpsCreated: state.requiredOpsCreated, requiredOpsDone: state.requiredOpsDone, fullOpsDone: state.fullOpsDone });
    } catch (_) {}
  }

  async function restoreMetrics() {
    try {
      const item = await dbGet('meta', 'metrics');
      if (item) {
        state.throughputBps = Number(item.throughputBps || 0);
        state.uploadFailures = Number(item.uploadFailures || 0);
        state.requiredOpsCreated = Number(item.requiredOpsCreated || 0);
        state.requiredOpsDone = Number(item.requiredOpsDone || 0);
        state.fullOpsDone = Number(item.fullOpsDone || 0);
      }
    } catch (_) {}
  }

  async function login() {
    const code = String($('accessCode').value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
    $('accessCode').value = code;
    if (!/^(?=.*[a-z])(?=.*\d)[a-z0-9]{4}$/.test(code)) {
      setMessage($('loginMsg'), 'Ingrese un código de cuatro caracteres que contenga letras y números.', 'error');
      return;
    }
    $('loginBtn').disabled = true;
    setMessage($('loginMsg'), 'Validando acceso…');
    try {
      const result = await apiRequest('login', {
        code,
        visitToken: state.visitToken,
        deviceProfileId: state.deviceProfileId,
        profile: state.profile
      });
      if (result.policy?.audioMode !== 'DIRECT_REPRODUCIBLE') {
        throw new Error('La página y Apps Script no tienen la misma versión. Actualice la implementación de Apps Script y vuelva a abrir la encuesta.');
      }
      state.token = result.token;
      state.sessionId = result.sessionId;
      state.questions = result.questions || [];
      state.answers = {};
      state.revisions = {};
      (result.answers || []).forEach((item) => {
        state.answers[item.questionId] = item.answer;
        state.revisions[item.questionId] = Number(item.revision || 0);
      });
      state.index = Math.max(0, state.questions.findIndex((q) => !(q.id in state.answers)));
      if (state.index < 0) state.index = 0;
      await openDb();
      await restoreMetrics();
      await dbPut('meta', { key: 'session', sessionId: state.sessionId, token: state.token, visitId: state.visitId, deviceProfileId: state.deviceProfileId });
      showView('setupView');
    } catch (error) {
      setMessage($('loginMsg'), error.message, 'error');
    } finally {
      $('loginBtn').disabled = false;
    }
  }

  function environmentBlocked(detail) {
    $('blockedDetail').textContent = detail || '';
    showView('blockedView');
  }

  async function checkStorageEnvironment() {
    try {
      await openDb();
      const key = 'storage-test-' + crypto.randomUUID();
      await dbPut('meta', { key, value: 'ok', when: Date.now() });
      const read = await dbGet('meta', key);
      if (!read || read.value !== 'ok') throw new Error('READ_TEST_FAILED');
      await dbDelete('meta', key);
      let quota = 0, usage = 0, persisted = false;
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        quota = Number(estimate.quota || 0); usage = Number(estimate.usage || 0);
      }
      if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
      if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
      const audioMb = (C.AUDIO_BITS_PER_SECOND * C.EXPECTED_MAX_HOURS * 3600 / 8) / 1024 / 1024;
      const requiredMb = audioMb * 2.4 + C.STORAGE_SAFETY_MB;
      const availableMb = quota ? Math.max(0, quota - usage) / 1024 / 1024 : requiredMb;
      if (quota && availableMb < requiredMb) throw new Error(`Espacio estimado insuficiente: ${availableMb.toFixed(0)} MB disponibles y ${requiredMb.toFixed(0)} MB recomendados.`);
      state.profile.storageStatus = persisted ? 'PERSISTENTE' : 'DISPONIBLE_NO_PERSISTENTE';
      return { persisted, availableMb, requiredMb };
    } catch (error) {
      throw new Error(error.message || 'LOCAL_STORAGE_UNAVAILABLE');
    }
  }

  function supportedMime() {
    const candidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
    return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
  }

  function recorderOptions() {
    const mimeType = supportedMime();
    return { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: C.AUDIO_BITS_PER_SECOND };
  }

  async function requestLocation() {
    if (!C.REQUIRE_GEOLOCATION) return null;
    if (!navigator.geolocation) throw new Error('Este navegador no permite obtener la ubicación requerida.');
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          speed: position.coords.speed,
          heading: position.coords.heading,
          timestamp: position.timestamp
        }),
        (error) => {
          const messages = {
            1: 'El permiso de ubicación fue rechazado. Revise los permisos del navegador.',
            2: 'El dispositivo no pudo determinar la ubicación. Active la ubicación e intente nuevamente.',
            3: 'La ubicación tardó demasiado. Verifique la señal GPS o de datos.'
          };
          reject(new Error(messages[error?.code] || 'No fue posible autorizar la ubicación requerida.'));
        },
        { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 }
      );
    });
  }

  async function saveLocationSnapshot(type, options = {}) {
    if (!C.REQUIRE_GEOLOCATION || !state.token) return null;
    const locationValue = options.fresh ? await requestLocation() : state.location;
    if (!locationValue) {
      if (options.required) throw new Error('No se obtuvo la ubicación requerida.');
      return null;
    }
    const locationId = `${state.sessionId}:${type}`;
    try {
      await apiRequest('saveLocation', {
        locationId,
        type,
        location: locationValue,
        permissionState: 'GRANTED',
        source: 'BROWSER_GEOLOCATION',
        observation: options.observation || '',
        clientTime: new Date().toISOString()
      }, state.token, { measure: false });
      state.location = locationValue;
      return locationValue;
    } catch (error) {
      if (options.required) throw error;
      await recordEvent('LOCATION_SAVE_WARNING', 'MEDIUM', `${type}: ${error.message}`);
      return null;
    }
  }

  async function configureEnvironment() {
    if (!$('consentCheck').checked) {
      setMessage($('setupMsg'), 'Debe aceptar la autorización antes de configurar el entorno.', 'error');
      return;
    }
    $('configureBtn').disabled = true;
    setMessage($('setupMsg'), 'Verificando almacenamiento, ubicación y micrófono…');
    $('setupDetails').classList.remove('hidden');
    try {
      if (!window.isSecureContext || !crypto?.subtle || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('El navegador no ofrece las capacidades de seguridad y grabación requeridas.');
      const storage = await checkStorageEnvironment();
      $('storageText').textContent = `${storage.availableMb.toFixed(0)} MB disponibles estimados${storage.persisted ? ', persistencia concedida' : ''}`;
      state.location = await requestLocation();
      $('locationText').textContent = state.location ? `Autorizada, precisión aproximada ${Math.round(state.location.accuracy)} m` : 'No requerida';
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      const track = state.stream.getAudioTracks()[0];
      if (!track) throw new Error('No se encontró un micrófono disponible.');
      track.addEventListener('ended', () => {
        if (!state.completed) {
          stopAllRecorders();
          environmentBlocked('El micrófono dejó de estar disponible durante la sesión.');
        }
      });
      $('microphoneText').textContent = track.label || 'Micrófono autorizado';
      await createOrRestoreSessionKey();
      await saveLocationSnapshot('CONFIGURACION_ENTORNO', { required: true, observation: 'Ubicación registrada durante la configuración obligatoria.' });
      await startAudioMonitor();
      $('testArea').classList.remove('hidden');
      $('startBtn').classList.remove('hidden');
      state.configured = true;
      setMessage($('setupMsg'), 'Entorno configurado correctamente. Puede hacer una prueba para escucharse antes de iniciar.', 'success');
      const settings = track.getSettings ? track.getSettings() : {};
      await recordEvent('ENVIRONMENT_CONFIGURED', 'INFO', JSON.stringify({ storage, location: state.location, microphone: { label: track.label, settings } }).slice(0, 1100));
    } catch (error) {
      state.configured = false;
      environmentBlocked(error.message);
    } finally {
      $('configureBtn').disabled = false;
    }
  }

  async function createOrRestoreSessionKey() {
    const stored = await dbGet('meta', 'crypto:' + state.sessionId);
    if (stored?.cryptoKey && stored?.wrappedKeyB64 && stored?.keyId === C.PUBLIC_KEY_JWK.kid) {
      state.aesKey = stored.cryptoKey;
      state.wrappedKeyB64 = stored.wrappedKeyB64;
    } else {
      const publicKey = await crypto.subtle.importKey('jwk', C.PUBLIC_KEY_JWK, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt','decrypt']);
      const raw = await crypto.subtle.exportKey('raw', extractable);
      const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw);
      state.aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
      state.wrappedKeyB64 = b64u(wrapped);
      await dbPut('meta', { key: 'crypto:' + state.sessionId, sessionId: state.sessionId, cryptoKey: state.aesKey, wrappedKeyB64: state.wrappedKeyB64, keyId: C.PUBLIC_KEY_JWK.kid });
    }
    await apiRequest('saveSessionCrypto', { wrappedKeyB64: state.wrappedKeyB64, keyId: C.PUBLIC_KEY_JWK.kid }, state.token);
  }

  async function startAudioMonitor() {
    if (state.audioContext) return;
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioContext.state === 'suspended') await state.audioContext.resume();
    const source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    source.connect(state.analyser);
    state.calibrationUntil = Date.now() + 2500;
    state.lastVoiceAt = Date.now();
    const data = new Float32Array(state.analyser.fftSize);
    state.monitorTimer = setInterval(() => {
      state.analyser.getFloatTimeDomainData(data);
      let sum = 0, peak = 0, crossings = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i]; sum += v * v; peak = Math.max(peak, Math.abs(v));
        if (i && ((data[i - 1] < 0 && v >= 0) || (data[i - 1] >= 0 && v < 0))) crossings++;
      }
      const rms = Math.sqrt(sum / data.length);
      if (Date.now() < state.calibrationUntil) state.noiseFloor = state.noiseFloor * 0.8 + rms * 0.2;
      const voiceThreshold = Math.max(0.018, state.noiseFloor * 2.5);
      const likelyVoice = rms > voiceThreshold && crossings > 8;
      if (likelyVoice) state.lastVoiceAt = Date.now();
      const silentFor = (Date.now() - state.lastVoiceAt) / 1000;
      updateAudioUi(rms, peak, likelyVoice, silentFor);
    }, 250);
  }

  function updateAudioUi(rms, peak, voice, silentFor) {
    const level = Math.min(100, Math.max(2, rms * 650));
    const meters = [$('setupMeter'), $('surveyMeter')].filter(Boolean);
    meters.forEach((meter) => { meter.style.width = `${level}%`; meter.className = ''; });
    let text = 'Escuchando…', advice = '', cls = 'pause';
    if (peak > 0.985) {
      text = 'El sonido está muy fuerte'; advice = 'Aleje un poco el celular de la boca.'; cls = 'bad';
    } else if (voice) {
      text = 'Señal de voz recibida'; advice = ''; cls = 'good';
    } else if (silentFor < 3) {
      text = 'Escuchando…'; cls = 'good';
    } else if (silentFor < 7) {
      text = 'Pausa detectada'; cls = 'pause';
    } else if (rms < Math.max(0.005, state.noiseFloor * 1.15)) {
      text = 'No se recibe sonido'; advice = 'Acerque el celular a la boca y verifique que el micrófono no esté cubierto.'; cls = 'bad';
    } else if (rms > state.noiseFloor * 2 && !voice) {
      text = 'Hay ruido alrededor'; advice = 'Acerque el celular a la persona que responde o busque un lugar más tranquilo.'; cls = 'bad';
    } else {
      text = 'No se escucha una voz con claridad'; advice = 'Acerque un poco el celular.'; cls = 'pause';
    }
    meters.forEach((meter) => meter.classList.add(cls));
    if ($('setupVoiceText')) $('setupVoiceText').textContent = text;
    if ($('voiceText')) $('voiceText').textContent = text;
    if ($('audioAdvice')) $('audioAdvice').textContent = advice;
  }

  async function testMicrophone() {
    $('testMicBtn').disabled = true;
    setMessage($('setupMsg'), 'Hable durante cinco segundos…');
    try {
      const chunks = [];
      const testStream = state.stream.clone();
      const recorder = new MediaRecorder(testStream, recorderOptions());
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error('No fue posible realizar la prueba.'));
      });
      recorder.start(1000);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      recorder.stop();
      await stopped;
      testStream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || supportedMime() || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const player = $('testPlayback');
      if (player.src) URL.revokeObjectURL(player.src);
      player.src = url;
      player.classList.remove('hidden');
      await player.play().catch(() => {});
      setMessage($('setupMsg'), 'Prueba lista. Escuche el audio y repítala si lo necesita.', 'success');
    } catch (error) {
      setMessage($('setupMsg'), error.message, 'error');
    } finally {
      $('testMicBtn').disabled = false;
    }
  }

  async function encryptBlob(blob, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = await blob.arrayBuffer();
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, state.aesKey, plaintext);
    return { blob: new Blob([ciphertext], { type: 'application/octet-stream' }), ivB64: b64u(iv), aad, bytes: ciphertext.byteLength, plainBytes: plaintext.byteLength, mimeOriginal: blob.type || 'audio/webm' };
  }

  async function startSurvey() {
    if (!state.configured || !state.aesKey) return;
    $('startBtn').disabled = true;
    setMessage($('setupMsg'), 'Iniciando la dinámica…');
    try {
      await saveLocationSnapshot('INICIO_ENCUESTA', { fresh: true, required: true, observation: 'Ubicación registrada al iniciar la encuesta.' });
      showView('surveyView');
      state.closing = false;
      await startFullRecorder();
      renderQuestion();
      processQueue();
    } catch (error) {
      $('startBtn').disabled = false;
      setMessage($('setupMsg'), error.message, 'error');
    }
  }

  function renderQuestion() {
    const q = state.questions[state.index];
    const position = state.index + 1;
    const progress = Math.round((position / Math.max(1, state.questions.length)) * 100);
    $('questionCount').textContent = `${position} de ${state.questions.length}`;
    if ($('questionProgressBar')) $('questionProgressBar').style.width = `${progress}%`;
    if ($('questionBadge')) $('questionBadge').textContent = `Pregunta ${position}`;
    $('questionText').textContent = q.text;
    $('backBtn').disabled = state.index === 0;
    $('nextBtn').innerHTML = state.index === state.questions.length - 1 ? '<span>Finalizar</span><span aria-hidden="true">✓</span>' : '<span>Siguiente</span><span aria-hidden="true">→</span>';

    const card = $('questionCard');
    const theme = ['institucional','experiencia','comunidad','mejora','cierre','neutral'].includes(q.theme) ? q.theme : 'institucional';
    card.className = `question-card theme-${theme}`;
    const textLength = String(q.text || '').length;
    if (textLength > 300) card.classList.add('question-very-long');
    else if (textLength > 175) card.classList.add('question-long');

    const contextBox = $('questionContextBox');
    const recommendationBox = $('recommendationBox');
    $('questionContext').textContent = q.context || '';
    $('questionRecommendation').textContent = q.recommendation || '';
    contextBox.classList.toggle('hidden', !String(q.context || '').trim());
    recommendationBox.classList.toggle('hidden', !String(q.recommendation || '').trim());

    const area = $('answerArea');
    area.innerHTML = '';
    const current = state.answers[q.id] ?? '';
    if (q.type === 'radio' || q.type === 'select') {
      q.options.forEach((option, optionIndex) => {
        const label = document.createElement('label');
        label.className = 'choice';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'answer';
        input.value = option;
        input.id = `option-${state.index}-${optionIndex}`;
        input.checked = current === option;
        const span = document.createElement('span');
        span.textContent = option;
        label.setAttribute('for', input.id);
        label.append(input, span);
        area.appendChild(label);
      });
    } else if (q.type === 'number') {
      const input = document.createElement('input');
      input.id = 'answerInput';
      input.type = 'number';
      input.inputMode = 'decimal';
      input.value = current;
      input.placeholder = 'Ingrese el valor';
      area.appendChild(input);
    } else {
      const textarea = document.createElement('textarea');
      textarea.id = 'answerInput';
      textarea.value = current;
      textarea.placeholder = 'Registre aquí la respuesta…';
      textarea.setAttribute('aria-label', 'Respuesta de la entrevista');
      area.appendChild(textarea);
    }
    startQuestionRecorder(q.id, Number(state.revisions[q.id] || 0) + 1);
    updateQueueUi();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function currentAnswerValue() {
    const q = state.questions[state.index];
    if (q.type === 'radio' || q.type === 'select') return document.querySelector('input[name="answer"]:checked')?.value || '';
    return $('answerInput')?.value || '';
  }

  async function storeQuestionSegment_(context, audioBlob) {
    if (!audioBlob || !audioBlob.size) return;
    const part = ++context.sequence;
    const aad = `${state.sessionId}|question|${context.questionId}|${context.revision}|${part}`;
    const encrypted = await encryptBlob(audioBlob, aad);
    const id = `q|${state.sessionId}|${context.questionId}|${context.revision}|${part}`;
    await dbPut('encrypted', {
      id,
      sessionId: state.sessionId,
      kind: 'question',
      questionId: context.questionId,
      revision: context.revision,
      part,
      totalParts: 0,
      uploaded: false,
      queued: false,
      ...encrypted,
      createdAt: Date.now()
    });
    context.parts.push(id);
  }

  async function startQuestionSegment_(context) {
    if (!context?.active) return;
    const recorderStream = state.stream.clone();
    const recorder = new MediaRecorder(recorderStream, recorderOptions());
    const chunks = [];
    recorder._sourceStream = recorderStream;
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = () => recordEvent('QUESTION_RECORDER_ERROR', 'HIGH', context.questionId).catch(() => {});
    recorder.onstop = () => {
      if (state.questionSegmentTimer) {
        clearTimeout(state.questionSegmentTimer);
        state.questionSegmentTimer = null;
      }
      recorderStream.getTracks().forEach((track) => track.stop());
      const audioBlob = new Blob(chunks, { type: recorder.mimeType || context.mime || supportedMime() || 'audio/webm' });
      state.questionChain = state.questionChain.then(() => storeQuestionSegment_(context, audioBlob));
      if (context.active) state.questionChain = state.questionChain.then(() => startQuestionSegment_(context));
    };
    state.questionRecorder = recorder;
    recorder.start();
    state.questionSegmentTimer = setTimeout(() => {
      if (context.active && recorder.state === 'recording') recorder.stop();
    }, Number(C.QUESTION_AUDIO_SEGMENT_MS || 30000));
  }

  async function startQuestionRecorder(questionId, revision) {
    if (state.questionRecorder?.state !== 'inactive' || state.questionContext) await stopQuestionRecorder();
    const context = { questionId, revision, parts: [], sequence: 0, mime: supportedMime() || 'audio/webm', active: true };
    state.questionContext = context;
    state.questionChain = Promise.resolve();
    await startQuestionSegment_(context);
  }

  async function stopQuestionRecorder() {
    const recorder = state.questionRecorder;
    const context = state.questionContext;
    if (!context) return null;
    context.active = false;
    if (state.questionSegmentTimer) {
      clearTimeout(state.questionSegmentTimer);
      state.questionSegmentTimer = null;
    }
    if (recorder && recorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
      recorder.stop();
      await stopped;
    }
    await state.questionChain;
    const total = context.parts.length;
    for (const id of context.parts) {
      const item = await dbGet('encrypted', id);
      if (item) {
        item.totalParts = total;
        await dbPut('encrypted', item);
      }
    }
    state.questionRecorder = null;
    state.questionContext = null;
    return context;
  }

  async function storeFullSegment_(audioBlob) {
    if (!audioBlob || !audioBlob.size) return;
    const sequence = ++state.fullSequence;
    const aad = `${state.sessionId}|full|${sequence}`;
    const encrypted = await encryptBlob(audioBlob, aad);
    const id = `f|${state.sessionId}|${sequence}`;
    await dbPut('encrypted', {
      id,
      sessionId: state.sessionId,
      kind: 'full',
      sequence,
      uploaded: false,
      queued: false,
      ...encrypted,
      createdAt: Date.now()
    });
    queueEligibleFullItems();
  }

  async function startFullSegment_() {
    if (!state.fullRecordingActive) return;
    const fullStream = state.stream.clone();
    const recorder = new MediaRecorder(fullStream, recorderOptions());
    const chunks = [];
    recorder._sourceStream = fullStream;
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = () => recordEvent('FULL_RECORDER_ERROR', 'HIGH', 'Grabación completa no disponible').catch(() => {});
    recorder.onstop = () => {
      if (state.fullSegmentTimer) {
        clearTimeout(state.fullSegmentTimer);
        state.fullSegmentTimer = null;
      }
      fullStream.getTracks().forEach((track) => track.stop());
      const audioBlob = new Blob(chunks, { type: recorder.mimeType || supportedMime() || 'audio/webm' });
      state.fullChain = state.fullChain.then(() => storeFullSegment_(audioBlob));
      if (state.fullRecordingActive) state.fullChain = state.fullChain.then(() => startFullSegment_());
    };
    state.fullRecorder = recorder;
    recorder.start();
    state.fullSegmentTimer = setTimeout(() => {
      if (state.fullRecordingActive && recorder.state === 'recording') recorder.stop();
    }, Number(C.FULL_TIMESLICE_MS || 60000));
  }

  async function startFullRecorder() {
    if (state.fullRecordingActive) return;
    state.fullRecordingActive = true;
    state.fullChain = Promise.resolve();
    await startFullSegment_();
  }

  async function stopFullRecorder() {
    state.fullRecordingActive = false;
    if (state.fullSegmentTimer) {
      clearTimeout(state.fullSegmentTimer);
      state.fullSegmentTimer = null;
    }
    const recorder = state.fullRecorder;
    if (recorder && recorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
      recorder.stop();
      await stopped;
    }
    await state.fullChain;
    state.fullRecorder = null;
  }

  async function saveAndMove(direction) {
    $('nextBtn').disabled = true; $('backBtn').disabled = true;
    try {
      const q = state.questions[state.index];
      const answer = currentAnswerValue();
      if (q.required && !String(answer).trim()) throw new Error('Esta pregunta requiere una respuesta.');
      const context = await stopQuestionRecorder();
      const revision = context.revision;
      state.answers[q.id] = answer;
      state.revisions[q.id] = revision;
      await dbPut('answers', { id: `${state.sessionId}|${q.id}|${revision}`, sessionId: state.sessionId, questionId: q.id, revision, answer, clientTime: new Date().toISOString() });
      await enqueue({ action: 'submitAnswer', priority: 1, required: true, bytes: 1200 + String(answer).length, payload: { questionId: q.id, revision, answer, clientTime: new Date().toISOString() } });
      for (const id of context.parts) {
        const item = await dbGet('encrypted', id);
        await enqueue({ action: 'uploadQuestionAudioPart', priority: 1, required: true, bytes: item.plainBytes || item.bytes, encryptedId: id, payload: { questionId: q.id, revision, part: item.part, totalParts: item.totalParts, mimeOriginal: item.mimeOriginal, bytes: item.plainBytes || item.bytes, clientTime: new Date().toISOString() } });
      }
      processQueue();
      if (direction === 'finish') {
        await beginClosing();
        return;
      }
      await adaptivePauseIfNeeded();
      state.index += direction === 'back' ? -1 : 1;
      renderQuestion();
    } catch (error) {
      setMessage($('syncText'), error.message, 'error');
      if (!state.questionRecorder && !state.closing) {
        const q = state.questions[state.index];
        startQuestionRecorder(q.id, Number(state.revisions[q.id] || 0) + 1);
      }
    } finally {
      $('nextBtn').disabled = false; $('backBtn').disabled = state.index === 0;
    }
  }

  async function enqueue(item) {
    const record = { id: crypto.randomUUID(), sessionId: state.sessionId, createdAt: Date.now(), tries: 0, ...item };
    await dbPut('queue', record);
    if (record.required) state.requiredOpsCreated++;
    if (record.encryptedId) {
      const encrypted = await dbGet('encrypted', record.encryptedId);
      if (encrypted) { encrypted.queued = true; await dbPut('encrypted', encrypted); }
    }
    await persistMetrics();
    updateQueueUi();
    return record.id;
  }

  async function serializeQueueItem(item) {
    const payload = { ...item.payload };
    if (item.encryptedId) {
      const encrypted = await dbGet('encrypted', item.encryptedId);
      if (!encrypted) throw new Error('No se encontró el audio protegido local.');
      const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: b64uToBytes(encrypted.ivB64),
        additionalData: encoder.encode(encrypted.aad),
        tagLength: 128
      }, state.aesKey, await encrypted.blob.arrayBuffer());
      if (Number(encrypted.plainBytes || 0) && Number(encrypted.plainBytes) !== plaintext.byteLength) {
        throw new Error('El tamaño del audio local no coincide.');
      }
      payload.audioB64 = b64u(plaintext);
      payload.mimeOriginal = encrypted.mimeOriginal || payload.mimeOriginal || 'audio/webm';
      payload.bytes = plaintext.byteLength;
    }
    return payload;
  }

  async function processQueue() {
    if (state.queueRunning || !navigator.onLine || !state.token) return;
    state.queueRunning = true;
    try {
      while (navigator.onLine) {
        let items = (await dbGetAll('queue')).filter((x) => x.sessionId === state.sessionId).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
        if (!items.length) {
          const queued = await queueEligibleFullItems();
          if (!queued) break;
          items = (await dbGetAll('queue')).filter((x) => x.sessionId === state.sessionId).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
          if (!items.length) break;
        }
        const item = items[0];
        try {
          const payload = await serializeQueueItem(item);
          await apiRequest(item.action, payload, state.token);
          await dbDelete('queue', item.id);
          if (item.encryptedId) {
            const encrypted = await dbGet('encrypted', item.encryptedId);
            if (encrypted) { encrypted.uploaded = true; encrypted.queued = false; await dbPut('encrypted', encrypted); }
          }
          if (item.required) state.requiredOpsDone++; else state.fullOpsDone++;
          await persistMetrics();
        } catch (error) {
          item.tries = Number(item.tries || 0) + 1;
          item.lastError = String(error.message || error).slice(0, 250);
          await dbPut('queue', item);
          if (!navigator.onLine || item.tries >= 4) break;
          await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** item.tries)));
        }
        updateQueueUi();
        updateClosingProgress();
      }
    } finally {
      state.queueRunning = false;
      updateQueueUi();
    }
  }

  async function queueEligibleFullItems() {
    if (!state.sessionId || !navigator.onLine) return false;
    const queue = (await dbGetAll('queue')).filter((x) => x.sessionId === state.sessionId);
    if (queue.some((x) => x.required)) return false;
    const items = (await dbGetAll('encrypted')).filter((x) => x.sessionId === state.sessionId && x.kind === 'full' && !x.uploaded && !x.queued).sort((a, b) => a.sequence - b.sequence);
    if (!items.length) return false;
    const pendingBytes = items.reduce((sum, x) => sum + Number(x.bytes || 0), 0);
    const eta = state.throughputBps > 0 ? pendingBytes / (state.throughputBps * 0.7) : Infinity;
    if (eta > C.FULL_AUDIO_UPLOAD_LIMIT_MINUTES * 60 || state.uploadFailures >= 4) return false;
    const item = items[0];
    await enqueue({ action: 'uploadFullAudioPart', priority: 2, required: false, bytes: item.plainBytes || item.bytes, encryptedId: item.id, payload: { sequence: item.sequence, mimeOriginal: item.mimeOriginal, bytes: item.plainBytes || item.bytes, clientTime: new Date().toISOString() } });
    return true;
  }

  async function requiredQueueStats() {
    const queue = (await dbGetAll('queue')).filter((x) => x.sessionId === state.sessionId && x.required);
    return { count: queue.length, bytes: queue.reduce((sum, x) => sum + Number(x.bytes || 0), 0) };
  }

  async function fullLocalStats() {
    const items = (await dbGetAll('encrypted')).filter((x) => x.sessionId === state.sessionId && x.kind === 'full');
    return {
      count: items.length,
      uploaded: items.filter((x) => x.uploaded).length,
      pendingBytes: items.filter((x) => !x.uploaded).reduce((sum, x) => sum + Number(x.bytes || 0), 0)
    };
  }

  async function updateQueueUi() {
    if (!state.sessionId) return;
    const required = await requiredQueueStats().catch(() => ({ count: 0, bytes: 0 }));
    const eta = state.throughputBps > 0 ? required.bytes / Math.max(1, state.throughputBps * 0.7) : 0;
    if ($('syncText')) {
      const card = $('syncCard');
      card?.classList.remove('is-pending','is-offline');
      if (!navigator.onLine) {
        $('syncText').textContent = 'Sin conexión. El avance permanece protegido en este dispositivo.';
        card?.classList.add('is-offline');
      } else if (required.count) {
        $('syncText').textContent = `Guardando el avance… ${required.count} elemento(s) pendiente(s)${eta > 1 ? `, aproximadamente ${Math.ceil(eta)} s` : ''}.`;
        card?.classList.add('is-pending');
      } else {
        $('syncText').textContent = 'Avance actualizado.';
      }
    }
  }

  async function adaptivePauseIfNeeded() {
    const completedIndex = state.index + 1;
    if (completedIndex / state.questions.length < 0.9) return;
    const stats = await requiredQueueStats();
    const eta = state.throughputBps > 0 ? stats.bytes / Math.max(1, state.throughputBps * 0.7) : stats.count ? 6 : 0;
    if (eta < C.LAST_TEN_PERCENT_ETA_SECONDS) return;
    $('adaptivePause').classList.remove('hidden');
    const limit = Date.now() + Math.min(8000, Math.max(2500, eta * 1000));
    while (Date.now() < limit) {
      processQueue();
      const current = await requiredQueueStats();
      if (!current.count) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    $('adaptivePause').classList.add('hidden');
  }

  async function beginClosing() {
    state.closing = true;
    state.closingStartedAt = Date.now();
    showView('closingView');
    await stopFullRecorder();
    await saveLocationSnapshot('FINAL_ENCUESTA', { fresh: true, required: false, observation: 'Ubicación registrada durante el cierre de la encuesta.' });
    processQueue();
    closingLoop();
  }

  async function closingLoop() {
    while (!state.completed) {
      await processQueue();
      const required = await requiredQueueStats();
      updateClosingProgress();
      if (required.count === 0) {
        const full = await fullLocalStats();
        const eta = state.throughputBps > 0 ? full.pendingBytes / Math.max(1, state.throughputBps * 0.7) : Infinity;
        if (full.pendingBytes && eta <= C.FULL_AUDIO_UPLOAD_LIMIT_MINUTES * 60 && state.uploadFailures < 4) {
          setMessage($('closingMsg'), 'Estamos terminando de guardar la información. Mantenga esta ventana abierta.');
          const queued = await queueEligibleFullItems();
          const queue = (await dbGetAll('queue')).filter((x) => x.sessionId === state.sessionId && !x.required);
          if (queued || queue.length) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
        }
        const finalFull = await fullLocalStats();
        let status = 'SKIPPED_NETWORK_POLICY';
        if (finalFull.count && finalFull.uploaded === finalFull.count) status = 'UPLOADED';
        else if (finalFull.uploaded > 0) status = 'PARTIAL_SKIPPED_NETWORK';
        try {
          await apiRequest('completeSession', { fullAudioStatus: status, fullAudioExpectedParts: finalFull.count }, state.token);
          state.completed = true;
          state.closing = false;
          updateClosingProgress(100);
          showView('doneView');
          return;
        } catch (error) {
          setMessage($('closingMsg'), error.message, 'warning');
        }
      }
      const elapsedMinutes = (Date.now() - state.closingStartedAt) / 60000;
      if (elapsedMinutes >= C.FINAL_WAIT_LIMIT_MINUTES) {
        state.backupOffered = true;
        $('backupBtn').classList.remove('hidden');
        setMessage($('closingMsg'), 'La conexión actual no permitió completar el cierre. Descargue el respaldo protegido y compártalo con su líder más cercano.', 'warning');
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function updateClosingProgress(force) {
    if (!$('closingProgress')) return;
    let percent = force;
    if (percent === undefined) {
      const created = Math.max(1, state.requiredOpsCreated);
      percent = Math.min(96, Math.round((state.requiredOpsDone / created) * 92));
      const required = await requiredQueueStats().catch(() => ({ count: 1 }));
      if (!required.count) percent = Math.max(percent, 94);
    }
    $('closingProgress').style.width = `${percent}%`;
    $('closingPercent').textContent = `${percent} %`;
  }

  async function recordEvent(type, severity, detail) {
    if (!state.token) return;
    try { await apiRequest('recordEvent', { type, severity, detail: String(detail || '').slice(0, 1100), clientTime: new Date().toISOString() }, state.token, { measure: false }); } catch (_) {}
  }

  async function buildProtectedBackup() {
    $('backupBtn').disabled = true;
    setMessage($('closingMsg'), 'Preparando respaldo protegido…');
    try {
      const answers = (await dbGetAll('answers')).filter((x) => x.sessionId === state.sessionId);
      const encryptedItems = (await dbGetAll('encrypted')).filter((x) => x.sessionId === state.sessionId).sort((a, b) => a.createdAt - b.createdAt);
      const metadataPlain = encoder.encode(JSON.stringify({ sessionId: state.sessionId, visitId: state.visitId, createdAt: new Date().toISOString(), answers, location: state.location, profile: state.profile }));
      const metadataIv = crypto.getRandomValues(new Uint8Array(12));
      const metadataAad = `${state.sessionId}|metadata|1`;
      const metadataCipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metadataIv, additionalData: encoder.encode(metadataAad), tagLength: 128 }, state.aesKey, metadataPlain);
      const parts = [new Blob([metadataCipher], { type: 'application/octet-stream' }), ...encryptedItems.map((x) => x.blob)];
      const descriptors = [{ kind: 'metadata', id: 'metadata', bytes: metadataCipher.byteLength, ivB64: b64u(metadataIv), aad: metadataAad, mimeOriginal: 'application/json' }].concat(encryptedItems.map((x) => ({ kind: x.kind, id: x.id, bytes: x.blob.size, ivB64: x.ivB64, aad: x.aad, mimeOriginal: x.mimeOriginal, questionId: x.questionId || '', revision: x.revision || 0, part: x.part || 0, totalParts: x.totalParts || 0, sequence: x.sequence || 0 })));
      const manifest = encoder.encode(JSON.stringify({ format: 'ENCUESTA-SEGURA-V3', version: 1, sessionId: state.sessionId, keyId: C.PUBLIC_KEY_JWK.kid, wrappedKeyB64: state.wrappedKeyB64, createdAt: new Date().toISOString(), items: descriptors }));
      const header = new Uint8Array(8);
      header.set([69,83,86,51], 0);
      new DataView(header.buffer).setUint32(4, manifest.length, false);
      const filename = `${state.sessionId}.encuesta`;
      if (window.showSaveFilePicker) {
        const handle = await showSaveFilePicker({ suggestedName: filename, types: [{ description: 'Respaldo cifrado de encuesta', accept: { 'application/octet-stream': ['.encuesta'] } }] });
        const writable = await handle.createWritable();
        await writable.write(header); await writable.write(manifest);
        for (const part of parts) await writable.write(part);
        await writable.close();
      } else {
        const blob = new Blob([header, manifest, ...parts], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      await recordEvent('BACKUP_DOWNLOADED', 'HIGH', filename);
      setMessage($('closingMsg'), 'Respaldo protegido descargado. Compártalo únicamente con su líder autorizado.', 'success');
    } catch (error) {
      setMessage($('closingMsg'), 'No fue posible crear el respaldo: ' + error.message, 'error');
    } finally {
      $('backupBtn').disabled = false;
    }
  }

  function setConnectionUi() {
    const online = navigator.onLine;
    $('connectionDot').className = `dot ${online ? 'online' : 'offline'}`;
    $('connectionText').textContent = online ? 'Con conexión' : 'Sin conexión';
    if (online) processQueue();
    updateQueueUi();
  }

  async function stopAllRecorders() {
    try { await stopQuestionRecorder(); } catch (_) {}
    try { await stopFullRecorder(); } catch (_) {}
  }

  function beforeUnload(event) {
    if ((state.sessionId && !state.completed) || state.closing) {
      event.preventDefault(); event.returnValue = '';
    }
  }

  function bindEvents() {
    $('accessCode').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4); });
    $('accessCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    $('loginBtn').addEventListener('click', login);
    $('configureBtn').addEventListener('click', configureEnvironment);
    $('testMicBtn').addEventListener('click', testMicrophone);
    $('startBtn').addEventListener('click', startSurvey);
    $('nextBtn').addEventListener('click', () => saveAndMove(state.index === state.questions.length - 1 ? 'finish' : 'next'));
    $('backBtn').addEventListener('click', () => saveAndMove('back'));
    $('backupBtn').addEventListener('click', buildProtectedBackup);
    window.addEventListener('online', setConnectionUi);
    window.addEventListener('offline', setConnectionUi);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', () => {
      if (state.sessionId) recordEvent(document.hidden ? 'PAGE_HIDDEN' : 'PAGE_VISIBLE', 'INFO', document.visibilityState);
    });
  }

  async function boot() {
    bindEvents();
    setConnectionUi();
    try {
      if (!apiConfigured()) throw new Error('Configure API_URL en config.js antes de publicar el demo.');
      await initializeAccess();
    } catch (error) {
      showView('loginView');
      setMessage($('loginMsg'), error.message, 'error');
    }
  }

  boot();
})();
