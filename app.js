(() => {
  'use strict';

  const C = window.SURVEY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const views = ['loadingView','resumeView','loginView','setupView','surveyView','finalizingView','shareView','blockedView'];

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
    campaignId: '',
    codeLabel: '',
    questions: [],
    answers: {},
    revisions: {},
    index: 0,
    meta: null,
    resumeMode: false,
    configured: false,
    stream: null,
    audioContext: null,
    analyser: null,
    monitorTimer: null,
    noiseFloor: 0.004,
    calibrationUntil: 0,
    lastVoiceAt: Date.now(),
    aesKey: null,
    wrappedKeyB64: '',
    questionRecorder: null,
    questionContext: null,
    questionChain: Promise.resolve(),
    fullRecorder: null,
    fullChain: Promise.resolve(),
    fullSequence: 0,
    closing: false,
    packageFile: null,
    packageManifest: null,
    shareConfirmed: false,
    wakeLock: null,
    location: null
  };

  function showView(id) {
    views.forEach((name) => $(name)?.classList.toggle('active', name === id));
  }

  function setMessage(el, text, kind = '') {
    if (!el) return;
    el.textContent = text || '';
    el.className = `message ${kind}`.trim();
  }

  function apiConfigured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(String(C.API_URL || ''));
  }

  function validWhatsappPhone() {
    return /^\d{8,15}$/.test(String(C.WHATSAPP_PHONE || ''));
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

  async function sha256B64(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return b64u(await crypto.subtle.digest('SHA-256', bytes));
  }

  function randomB64(size = 16) {
    return b64u(crypto.getRandomValues(new Uint8Array(size)));
  }

  function getOrCreateInstallId() {
    try {
      const key = 'encuesta_device_install_id_v4';
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

  /** -------------------- INDEXEDDB -------------------- */

  function openDb() {
    if (state.db) return Promise.resolve(state.db);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('Este navegador no dispone de IndexedDB.'));
      const req = indexedDB.open('encuesta-offline-v4', 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('answers')) {
          const store = db.createObjectStore('answers', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('audio')) {
          const store = db.createObjectStore('audio', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('events')) {
          const store = db.createObjectStore('events', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('locations')) {
          const store = db.createObjectStore('locations', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('serverops')) {
          const store = db.createObjectStore('serverops', { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
        }
      };
      req.onsuccess = () => { state.db = req.result; resolve(state.db); };
      req.onerror = () => reject(req.error || new Error('No fue posible abrir el almacenamiento local.'));
      req.onblocked = () => reject(new Error('El almacenamiento local está bloqueado por otra pestaña.'));
    });
  }

  async function dbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Operación local cancelada.'));
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

  async function dbGetBySession(storeName, sessionId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index('sessionId');
      const req = index.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function persistSessionMeta() {
    if (!state.meta) return;
    state.meta.updatedAt = new Date().toISOString();
    await dbPut('meta', state.meta);
  }

  async function getActiveMeta() {
    const pointer = await dbGet('meta', 'activeSession');
    if (!pointer?.sessionId) return null;
    return dbGet('meta', 'session:' + pointer.sessionId);
  }

  /** -------------------- PERFIL Y API -------------------- */

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
    const profile = {
      userAgent: navigator.userAgent || '',
      uaFamily: navigator.userAgentData?.brands?.map((x) => x.brand).join(',') || navigator.appName || '',
      uaData,
      platform: navigator.userAgentData?.platform || navigator.platform || '',
      vendor: navigator.vendor || '',
      mobile: Boolean(navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')),
      language: navigator.language || '',
      languages: navigator.languages || [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      timezoneOffset: new Date().getTimezoneOffset(),
      screen: `${screen.width}x${screen.height}|${screen.availWidth}x${screen.availHeight}|${screen.colorDepth}`,
      viewport: `${innerWidth}x${innerHeight}`,
      dpr: devicePixelRatio || 1,
      touchPoints: navigator.maxTouchPoints || 0,
      cores: navigator.hardwareConcurrency || '',
      deviceMemory: navigator.deviceMemory || '',
      cookieEnabled: navigator.cookieEnabled,
      webdriver: Boolean(navigator.webdriver),
      online: navigator.onLine,
      referrer: document.referrer || '',
      pageOrigin: location.origin || '',
      pagePath: location.pathname || '/',
      indexedDbSupported: Boolean(window.indexedDB),
      webCryptoSupported: Boolean(window.crypto?.subtle),
      mediaRecorderSupported: Boolean(window.MediaRecorder),
      getUserMediaSupported: Boolean(navigator.mediaDevices?.getUserMedia),
      storageStatus: 'NO_PROBADO',
      network: connection ? {
        effectiveType: connection.effectiveType || '', downlink: connection.downlink || '', rtt: connection.rtt || '', saveData: Boolean(connection.saveData), type: connection.type || ''
      } : {},
      capabilities: {
        secureContext: window.isSecureContext,
        webShare: Boolean(navigator.share),
        fileShare: Boolean(navigator.share && navigator.canShare),
        screenWakeLock: Boolean(navigator.wakeLock),
        visibilityApi: typeof document.hidden === 'boolean',
        screenOrientation: screen.orientation?.type || ''
      }
    };
    state.profile = profile;
    return profile;
  }

  async function apiRequest(action, payload = {}, token = '', timeoutMs = 25000) {
    if (!apiConfigured()) throw new Error('Falta configurar API_URL con el nuevo /exec de Apps Script.');
    const body = JSON.stringify({ action, token: token || '', clientId: state.clientId, requestId: crypto.randomUUID(), payload });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(C.API_URL, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body,
        signal: controller.signal, cache: 'no-store', credentials: 'omit'
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error('El servidor no devolvió una respuesta válida.'); }
      if (!data.ok) throw new Error(data.error || 'La solicitud fue rechazada.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('La conexión tardó demasiado.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeOnlineAccess() {
    state.deviceInstallId = getOrCreateInstallId();
    state.profile = await collectProfile();
    const result = await apiRequest('registerClientVisit', {
      deviceInstallId: state.deviceInstallId,
      campaignId: C.CAMPAIGN_ID,
      clientTime: new Date().toISOString(),
      profile: state.profile
    }, '', 25000);
    state.visitId = result.visitId;
    state.visitToken = result.visitToken;
    state.deviceProfileId = result.deviceProfileId;
  }

  /** -------------------- COLA MINÚSCULA DE SEGURIDAD -------------------- */

  async function enqueueServerOp(action, payload) {
    if (!state.sessionId || !state.token) return;
    const existing = (await dbGetBySession('serverops', state.sessionId)).find((x) => x.action === action && !x.done);
    if (existing) return;
    await dbPut('serverops', {
      id: crypto.randomUUID(), sessionId: state.sessionId, action, payload, createdAt: Date.now(), tries: 0, done: false
    });
    processServerOps().catch(() => {});
  }

  async function processServerOps() {
    if (!navigator.onLine || !state.sessionId || !state.token) return;
    const items = (await dbGetBySession('serverops', state.sessionId)).filter((x) => !x.done).sort((a,b) => a.createdAt - b.createdAt);
    for (const item of items) {
      try {
        await apiRequest(item.action, item.payload, state.token, 15000);
        item.done = true;
        item.doneAt = Date.now();
        await dbPut('serverops', item);
      } catch (error) {
        item.tries = Number(item.tries || 0) + 1;
        item.lastError = String(error.message || error).slice(0, 250);
        await dbPut('serverops', item);
        break;
      }
    }
  }

  /** -------------------- LOGIN Y REANUDACIÓN -------------------- */

  function normalizeCode(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
  }

  async function login() {
    const code = normalizeCode($('accessCode').value);
    $('accessCode').value = code;
    if (!/^(?=.*[a-z])(?=.*\d)[a-z0-9]{4}$/.test(code)) {
      setMessage($('loginMsg'), 'Ingrese un código de cuatro caracteres con letras y números.', 'error');
      return;
    }
    if (!navigator.onLine) {
      setMessage($('loginMsg'), 'Para iniciar una sesión nueva se necesita conexión. Si ya había empezado, use la opción de reanudar.', 'error');
      return;
    }
    $('loginBtn').disabled = true;
    setMessage($('loginMsg'), 'Validando acceso…');
    try {
      if (!state.visitToken) await initializeOnlineAccess();
      const result = await apiRequest('login', { code, visitToken: state.visitToken, deviceProfileId: state.deviceProfileId, profile: state.profile });
      const active = await getActiveMeta();
      if (active && active.sessionId !== result.sessionId && active.stage !== 'shared_confirmed') {
        throw new Error('Este dispositivo conserva otra entrevista pendiente. Reanúdela o márquela como enviada antes de iniciar una nueva.');
      }

      state.token = result.token;
      state.sessionId = result.sessionId;
      state.campaignId = result.campaignId;
      state.codeLabel = result.codeLabel;
      state.questions = result.questions || [];
      state.answers = {};
      state.revisions = {};
      state.index = 0;

      let meta = await dbGet('meta', 'session:' + state.sessionId);
      if (!meta) {
        meta = {
          key: 'session:' + state.sessionId,
          sessionId: state.sessionId,
          campaignId: state.campaignId,
          codeLabel: state.codeLabel,
          visitId: state.visitId,
          deviceProfileId: state.deviceProfileId,
          token: state.token,
          questions: state.questions,
          profile: state.profile,
          stage: 'setup',
          index: 0,
          createdAt: new Date().toISOString(),
          appVersion: C.VERSION
        };
      } else {
        meta.token = state.token;
        meta.visitId = state.visitId;
        meta.deviceProfileId = state.deviceProfileId;
        meta.questions = state.questions;
        meta.profile = state.profile;
      }
      state.meta = meta;
      await createOrRestoreSessionKey(code);
      await createResumeVerifier(code);
      await storeSecretAccessCode(code);
      await persistSessionMeta();
      await dbPut('meta', { key: 'activeSession', sessionId: state.sessionId });
      await restoreAnswers();
      state.resumeMode = Boolean(result.resumed && state.meta.stage === 'survey');
      prepareSetupView();
      showView('setupView');
    } catch (error) {
      setMessage($('loginMsg'), error.message, 'error');
    } finally {
      $('loginBtn').disabled = false;
    }
  }

  async function createResumeVerifier(code) {
    if (state.meta.resumeSalt && state.meta.resumeHash) return;
    state.meta.resumeSalt = randomB64(16);
    state.meta.resumeHash = await sha256B64(encoder.encode(`${state.meta.resumeSalt}|${state.sessionId}|${code}`));
  }

  async function verifyResumeCode(code) {
    if (!state.meta?.resumeSalt || !state.meta?.resumeHash) return false;
    const test = await sha256B64(encoder.encode(`${state.meta.resumeSalt}|${state.meta.sessionId}|${code}`));
    return test === state.meta.resumeHash;
  }

  async function resumeLocalSession() {
    const code = normalizeCode($('resumeCode').value);
    $('resumeCode').value = code;
    if (!(await verifyResumeCode(code))) {
      setMessage($('resumeMsg'), 'El código no corresponde a la sesión guardada.', 'error');
      return;
    }
    try {
      state.sessionId = state.meta.sessionId;
      state.campaignId = state.meta.campaignId;
      state.codeLabel = state.meta.codeLabel;
      state.visitId = state.meta.visitId || '';
      state.deviceProfileId = state.meta.deviceProfileId || '';
      state.token = state.meta.token || '';
      state.questions = state.meta.questions || [];
      state.profile = state.meta.profile || await collectProfile();
      state.aesKey = state.meta.cryptoKey;
      state.wrappedKeyB64 = state.meta.wrappedKeyB64;
      state.index = Number(state.meta.index || 0);
      await restoreAnswers();
      await restoreFullSequence();
      await logLocalEvent('OFFLINE_RESUME', { online: navigator.onLine, stage: state.meta.stage });

      if (state.meta.stage === 'finished') {
        showView('finalizingView');
        await preparePackageAndShowShare();
        return;
      }
      state.resumeMode = state.meta.stage === 'survey';
      prepareSetupView();
      showView('setupView');
      setMessage($('setupMsg'), state.resumeMode ? 'Reautorice micrófono y ubicación para continuar desde el avance local.' : 'Sesión recuperada. Configure nuevamente el entorno.', 'warning');
    } catch (error) {
      setMessage($('resumeMsg'), error.message, 'error');
    }
  }

  async function restoreAnswers() {
    state.answers = {};
    state.revisions = {};
    const items = await dbGetBySession('answers', state.sessionId);
    items.forEach((item) => {
      const current = Number(state.revisions[item.questionId] || 0);
      if (Number(item.revision || 0) >= current) {
        state.revisions[item.questionId] = Number(item.revision || 0);
        state.answers[item.questionId] = item.answer;
      }
    });
    if (state.meta) state.index = Math.min(Math.max(0, Number(state.meta.index || 0)), Math.max(0, state.questions.length - 1));
  }

  /** -------------------- CRIPTOGRAFÍA LOCAL -------------------- */

  async function createOrRestoreSessionKey(accessCode = '') {
    if (state.meta?.cryptoKey && state.meta?.wrappedKeyB64 && state.meta?.keyId === C.PUBLIC_KEY_JWK.kid) {
      state.aesKey = state.meta.cryptoKey;
      state.wrappedKeyB64 = state.meta.wrappedKeyB64;
      return;
    }
    if (!C.PUBLIC_KEY_JWK?.kid) throw new Error('No hay clave pública configurada.');
    const publicKey = await crypto.subtle.importKey('jwk', C.PUBLIC_KEY_JWK, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt','decrypt']);
    const raw = await crypto.subtle.exportKey('raw', generated);
    const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw);
    state.aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
    state.wrappedKeyB64 = b64u(wrapped);
    state.meta.cryptoKey = state.aesKey;
    state.meta.wrappedKeyB64 = state.wrappedKeyB64;
    state.meta.keyId = C.PUBLIC_KEY_JWK.kid;
    state.meta.packageFormat = C.PACKAGE_FORMAT;
    await persistSessionMeta();
  }

  async function encryptBytes(bytes, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, state.aesKey, bytes);
    return { cipher, ivB64: b64u(iv), aad, bytes: cipher.byteLength, cipherSha256B64: await sha256B64(cipher) };
  }

  async function decryptBytes(cipher, ivB64, aad) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uToBytes(ivB64), additionalData: encoder.encode(aad), tagLength: 128 }, state.aesKey, cipher);
  }

  async function storeSecretAccessCode(code) {
    const key = 'secret:' + state.sessionId;
    if (await dbGet('meta', key)) return;
    const aad = `${state.sessionId}|secret|access-code`;
    const encrypted = await encryptBytes(encoder.encode(JSON.stringify({ accessCode: code })), aad);
    await dbPut('meta', { key, sessionId: state.sessionId, ivB64: encrypted.ivB64, aad, ciphertext: encrypted.cipher, cipherSha256B64: encrypted.cipherSha256B64 });
  }

  async function readSecretAccessCode() {
    const item = await dbGet('meta', 'secret:' + state.sessionId);
    if (!item) return '';
    const plain = await decryptBytes(item.ciphertext, item.ivB64, item.aad);
    return JSON.parse(decoder.decode(plain)).accessCode || '';
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      if (state.wakeLock && !state.wakeLock.released) return;
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (_) {}
  }

  async function releaseWakeLock() {
    try { if (state.wakeLock && !state.wakeLock.released) await state.wakeLock.release(); } catch (_) {}
    state.wakeLock = null;
  }

  /** -------------------- ENTORNO -------------------- */

  function prepareSetupView() {
    state.configured = false;
    $('startBtn').classList.add('hidden');
    $('audioTestArea').classList.add('hidden');
    $('storageText').textContent = 'Pendiente';
    $('locationText').textContent = 'Pendiente';
    $('microphoneText').textContent = 'Pendiente';
    $('consentCheck').checked = false;
  }

  async function checkStorageEnvironment() {
    await openDb();
    const key = 'storage-test-' + crypto.randomUUID();
    await dbPut('meta', { key, value: 'ok', when: Date.now() });
    const read = await dbGet('meta', key);
    if (!read || read.value !== 'ok') throw new Error('No fue posible comprobar el almacenamiento local.');
    await dbDelete('meta', key);

    let quota = 0, usage = 0, persisted = false;
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      quota = Number(estimate.quota || 0);
      usage = Number(estimate.usage || 0);
    }
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) {
      try { persisted = await navigator.storage.persist(); } catch (_) {}
    }
    const streamCount = C.RECORD_QUESTION_AUDIO ? 2 : 1;
    const audioMb = (C.AUDIO_BITS_PER_SECOND * C.EXPECTED_MAX_HOURS * 3600 / 8 / 1024 / 1024) * streamCount;
    const requiredMb = audioMb * 1.25 + C.STORAGE_SAFETY_MB;
    const availableMb = quota ? Math.max(0, quota - usage) / 1024 / 1024 : requiredMb;
    if (quota && availableMb < requiredMb) throw new Error(`Espacio local insuficiente: ${availableMb.toFixed(0)} MB disponibles; se recomiendan al menos ${requiredMb.toFixed(0)} MB.`);
    state.profile.storageStatus = persisted ? 'PERSISTENTE' : 'DISPONIBLE_NO_PERSISTENTE';
    return { persisted, quota, usage, availableMb, requiredMb, streamCount };
  }

  async function requestLocation() {
    if (!C.REQUIRE_GEOLOCATION) return null;
    if (!navigator.geolocation) throw new Error('Este navegador no permite obtener la ubicación requerida.');
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({
          latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy,
          altitude: position.coords.altitude, altitudeAccuracy: position.coords.altitudeAccuracy,
          speed: position.coords.speed, heading: position.coords.heading, timestamp: position.timestamp
        }),
        (error) => {
          const messages = { 1:'El permiso de ubicación fue rechazado.', 2:'El dispositivo no pudo determinar la ubicación.', 3:'La ubicación tardó demasiado.' };
          reject(new Error(messages[error?.code] || 'No fue posible autorizar la ubicación.'));
        },
        { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 }
      );
    });
  }

  async function saveLocationLocal(type, locationValue, observation = '') {
    if (!locationValue) return;
    const item = {
      id: `${state.sessionId}|${type}|${Date.now()}`,
      sessionId: state.sessionId,
      type,
      location: locationValue,
      observation,
      clientTime: new Date().toISOString()
    };
    await dbPut('locations', item);
  }

  function supportedMime() {
    const candidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
    return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
  }

  function recorderOptions() {
    const mimeType = supportedMime();
    return { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: C.AUDIO_BITS_PER_SECOND };
  }

  async function configureEnvironment() {
    if (!$('consentCheck').checked) {
      setMessage($('setupMsg'), 'Debe aceptar la autorización antes de continuar.', 'error');
      return;
    }
    $('configureBtn').disabled = true;
    setMessage($('setupMsg'), 'Verificando almacenamiento, ubicación y micrófono…');
    try {
      if (!window.isSecureContext || !crypto?.subtle || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error('El navegador no ofrece las capacidades de seguridad y grabación requeridas.');
      }
      const storage = await checkStorageEnvironment();
      $('storageText').textContent = `${storage.availableMb.toFixed(0)} MB disponibles${storage.persisted ? ', almacenamiento persistente' : ''}`;

      state.location = await requestLocation();
      $('locationText').textContent = state.location ? `Autorizada, precisión aproximada ${Math.round(state.location.accuracy)} m` : 'No requerida';
      await saveLocationLocal('CONFIGURACION_ENTORNO', state.location, 'Configuración obligatoria');

      if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      });
      const track = state.stream.getAudioTracks()[0];
      if (!track) throw new Error('No se encontró un micrófono disponible.');
      track.addEventListener('ended', () => {
        if (!state.closing) environmentBlocked('El micrófono dejó de estar disponible. El avance anterior permanece cifrado en el dispositivo.');
      });
      $('microphoneText').textContent = track.label || 'Micrófono autorizado';
      await startAudioMonitor();
      $('audioTestArea').classList.remove('hidden');
      state.configured = true;

      await logLocalEvent('ENVIRONMENT_CONFIGURED', { storage, microphone: track.getSettings ? track.getSettings() : {}, location: state.location });
      await enqueueServerOp('registerEnvironment', {
        profile: state.profile,
        storage: { persisted:storage.persisted, availableMb:Math.round(storage.availableMb), requiredMb:Math.round(storage.requiredMb) },
        audio: { mime:supportedMime(), bitsPerSecond:C.AUDIO_BITS_PER_SECOND, questionAudio:Boolean(C.RECORD_QUESTION_AUDIO) },
        location: state.location,
        clientTime: new Date().toISOString(),
        observation: 'Registro inicial de seguridad; respuestas y audio permanecen locales.'
      });

      if (state.resumeMode) {
        setMessage($('setupMsg'), 'Entorno reactivado. Reanudando la entrevista local…', 'success');
        await resumeSurveyAfterSetup();
      } else {
        $('startBtn').classList.remove('hidden');
        setMessage($('setupMsg'), 'Entorno configurado. Puede probar el micrófono o iniciar la encuesta.', 'success');
      }
    } catch (error) {
      state.configured = false;
      environmentBlocked(error.message);
    } finally {
      $('configureBtn').disabled = false;
    }
  }

  async function startAudioMonitor() {
    if (state.audioContext) {
      try { await state.audioContext.close(); } catch (_) {}
    }
    clearInterval(state.monitorTimer);
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
      if (!state.analyser) return;
      state.analyser.getFloatTimeDomainData(data);
      let sum = 0, peak = 0, crossings = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i]; sum += v*v; peak = Math.max(peak, Math.abs(v));
        if (i && ((data[i-1] < 0 && v >= 0) || (data[i-1] >= 0 && v < 0))) crossings++;
      }
      const rms = Math.sqrt(sum / data.length);
      if (Date.now() < state.calibrationUntil) state.noiseFloor = state.noiseFloor * .8 + rms * .2;
      const threshold = Math.max(.018, state.noiseFloor * 2.5);
      const voice = rms > threshold && crossings > 8;
      if (voice) state.lastVoiceAt = Date.now();
      updateAudioUi(rms, peak, voice, (Date.now() - state.lastVoiceAt) / 1000);
    }, 250);
  }

  function updateAudioUi(rms, peak, voice, silentFor) {
    const level = Math.min(100, Math.max(2, rms * 650));
    const meters = [$('setupMeter'), $('surveyMeter')].filter(Boolean);
    let text = 'Escuchando…', advice = 'La grabación se almacena cifrada en este dispositivo.', cls = 'pause';
    if (peak > .985) { text = 'El sonido está muy fuerte'; advice = 'Aleje un poco el celular.'; cls = 'bad'; }
    else if (voice || silentFor < 3) { text = voice ? 'Señal de voz recibida' : 'Escuchando…'; cls = 'good'; }
    else if (silentFor < 7) { text = 'Pausa detectada'; cls = 'pause'; }
    else if (rms < Math.max(.005, state.noiseFloor * 1.15)) { text = 'No se recibe sonido'; advice = 'Verifique que el micrófono no esté cubierto.'; cls = 'bad'; }
    else { text = 'No se escucha una voz con claridad'; advice = 'Acerque un poco el celular.'; cls = 'pause'; }
    meters.forEach((meter) => { meter.style.width = `${level}%`; meter.className = cls; });
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
      await new Promise((r) => setTimeout(r, 5000));
      recorder.stop();
      await stopped;
      testStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || supportedMime() || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const player = $('testPlayback');
      if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
      player.src = url; player.dataset.url = url; player.classList.remove('hidden');
      await player.play().catch(() => {});
      setMessage($('setupMsg'), 'Prueba lista. Escuche el audio antes de comenzar.', 'success');
    } catch (error) {
      setMessage($('setupMsg'), error.message, 'error');
    } finally { $('testMicBtn').disabled = false; }
  }

  /** -------------------- EVENTOS LOCALES -------------------- */

  async function logLocalEvent(type, detail = {}, severity = 'INFO') {
    if (!state.sessionId) return;
    await dbPut('events', {
      id: crypto.randomUUID(), sessionId: state.sessionId, type, severity,
      detail, clientTime: new Date().toISOString()
    });
  }

  /** -------------------- GRABACIÓN LOCAL CIFRADA -------------------- */

  async function encryptAudioBlob(blob, aad) {
    const plaintext = await blob.arrayBuffer();
    const encrypted = await encryptBytes(plaintext, aad);
    return {
      blob: new Blob([encrypted.cipher], { type: 'application/octet-stream' }),
      ivB64: encrypted.ivB64,
      aad: encrypted.aad,
      bytes: encrypted.bytes,
      cipherSha256B64: encrypted.cipherSha256B64,
      mimeOriginal: blob.type || 'audio/webm'
    };
  }

  async function restoreFullSequence() {
    if (!state.sessionId) return 0;
    const items = (await dbGetBySession('audio', state.sessionId)).filter((x) => x.kind === 'full');
    state.fullSequence = items.reduce((max, item) => Math.max(max, Number(item.sequence || 0)), 0);
    return state.fullSequence;
  }

  async function startFullRecorder() {
    if (state.fullRecorder) return;
    await restoreFullSequence();
    const runId = 'run_' + crypto.randomUUID().replace(/-/g, '');
    const fullStream = state.stream.clone();
    const recorder = new MediaRecorder(fullStream, recorderOptions());
    recorder._sourceStream = fullStream;
    recorder._runId = runId;
    state.fullRecorder = recorder;
    state.fullChain = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data?.size) return;
      const sequence = ++state.fullSequence;
      state.fullChain = state.fullChain.then(async () => {
        const aad = `${state.sessionId}|full|${runId}|${sequence}`;
        const encrypted = await encryptAudioBlob(event.data, aad);
        await dbPut('audio', {
          id: `f|${state.sessionId}|${sequence}`,
          sessionId: state.sessionId,
          kind: 'full', runId, sequence,
          createdAt: new Date().toISOString(),
          ...encrypted
        });
        updateLocalSaveText();
      });
    };
    recorder.onerror = () => logLocalEvent('FULL_RECORDER_ERROR', { runId }, 'HIGH').catch(() => {});
    recorder.start(C.FULL_TIMESLICE_MS);
  }

  async function stopFullRecorder() {
    const recorder = state.fullRecorder;
    if (!recorder) return;
    if (recorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once:true }));
      recorder.stop();
      await stopped;
    }
    await state.fullChain;
    recorder._sourceStream?.getTracks().forEach((t) => t.stop());
    state.fullRecorder = null;
  }

  async function startQuestionRecorder(questionId, revision) {
    const context = { questionId, revision, part: 0, runId: 'qrun_' + crypto.randomUUID().replace(/-/g, ''), recorderStream:null };
    state.questionContext = context;
    if (!C.RECORD_QUESTION_AUDIO) return context;

    const existing = (await dbGetBySession('audio', state.sessionId)).filter((x) => x.kind === 'question' && x.questionId === questionId && Number(x.revision) === Number(revision));
    context.part = existing.reduce((max, item) => Math.max(max, Number(item.part || 0)), 0);
    const recorderStream = state.stream.clone();
    context.recorderStream = recorderStream;
    const recorder = new MediaRecorder(recorderStream, recorderOptions());
    state.questionRecorder = recorder;
    state.questionChain = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data?.size) return;
      const part = ++context.part;
      state.questionChain = state.questionChain.then(async () => {
        const aad = `${state.sessionId}|question|${questionId}|${revision}|${context.runId}|${part}`;
        const encrypted = await encryptAudioBlob(event.data, aad);
        await dbPut('audio', {
          id: `q|${state.sessionId}|${questionId}|${revision}|${part}`,
          sessionId: state.sessionId,
          kind: 'question', questionId, revision, runId:context.runId, part, totalParts:0,
          createdAt:new Date().toISOString(),
          ...encrypted
        });
        updateLocalSaveText();
      });
    };
    recorder.onerror = () => logLocalEvent('QUESTION_RECORDER_ERROR', { questionId, revision }, 'HIGH').catch(() => {});
    recorder.start(C.QUESTION_TIMESLICE_MS);
    return context;
  }

  async function stopQuestionRecorder() {
    const recorder = state.questionRecorder;
    const context = state.questionContext;
    if (!context) return null;
    if (recorder && recorder.state !== 'inactive') {
      const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once:true }));
      recorder.stop();
      await stopped;
    }
    await state.questionChain;
    context.recorderStream?.getTracks().forEach((t) => t.stop());
    if (C.RECORD_QUESTION_AUDIO) {
      const all = (await dbGetBySession('audio', state.sessionId)).filter((x) => x.kind === 'question' && x.questionId === context.questionId && Number(x.revision) === Number(context.revision));
      const total = all.reduce((max, x) => Math.max(max, Number(x.part || 0)), 0);
      for (const item of all) {
        if (Number(item.totalParts || 0) !== total) { item.totalParts = total; await dbPut('audio', item); }
      }
    }
    state.questionRecorder = null;
    state.questionContext = null;
    return context;
  }

  /** -------------------- ENCUESTA -------------------- */

  async function startSurvey() {
    if (!state.configured || !state.aesKey) return;
    $('startBtn').disabled = true;
    setMessage($('setupMsg'), 'Iniciando captura local…');
    try {
      const startLocation = await requestLocation();
      state.location = startLocation || state.location;
      await saveLocationLocal('INICIO_ENCUESTA', state.location, 'Inicio de entrevista');
      await logLocalEvent('INTERVIEW_STARTED_LOCAL', { online:navigator.onLine, location:state.location });
      state.meta.stage = 'survey';
      state.meta.startedAt = state.meta.startedAt || new Date().toISOString();
      state.meta.index = state.index;
      await persistSessionMeta();
      await enqueueServerOp('startInterview', {
        keyId: C.PUBLIC_KEY_JWK.kid,
        location: state.location,
        clientTime: new Date().toISOString(),
        observation: 'Entrevista offline-first. No se cargan respuestas ni audio.'
      });
      showView('surveyView');
      await requestWakeLock();
      await startFullRecorder();
      await renderQuestion();
    } catch (error) {
      setMessage($('setupMsg'), error.message, 'error');
      $('startBtn').disabled = false;
    }
  }

  async function resumeSurveyAfterSetup() {
    state.meta.stage = 'survey';
    await persistSessionMeta();
    showView('surveyView');
    await requestWakeLock();
    await startFullRecorder();
    await renderQuestion();
    processServerOps().catch(() => {});
  }

  async function renderQuestion() {
    const q = state.questions[state.index];
    if (!q) throw new Error('No se encontró la pregunta actual.');
    const position = state.index + 1;
    $('questionCount').textContent = `${position} de ${state.questions.length}`;
    $('questionProgressBar').style.width = `${Math.round(position / Math.max(1,state.questions.length) * 100)}%`;
    $('questionBadge').textContent = `Pregunta ${position}`;
    $('questionText').textContent = q.text;
    $('backBtn').disabled = state.index === 0;
    $('nextBtn').textContent = state.index === state.questions.length - 1 ? 'Finalizar ✓' : 'Siguiente →';

    const card = $('questionCard');
    const theme = ['institucional','experiencia','comunidad','mejora','cierre','neutral'].includes(q.theme) ? q.theme : 'institucional';
    card.className = `question-card theme-${theme}`;
    $('questionContext').textContent = q.context || '';
    $('questionRecommendation').textContent = q.recommendation || '';
    $('questionContextBox').classList.toggle('hidden', !String(q.context || '').trim());
    $('recommendationBox').classList.toggle('hidden', !String(q.recommendation || '').trim());

    const area = $('answerArea');
    area.innerHTML = '';
    const current = state.answers[q.id] ?? '';
    if (q.type === 'radio' || q.type === 'select') {
      (q.options || []).forEach((option, idx) => {
        const label = document.createElement('label'); label.className = 'choice';
        const input = document.createElement('input'); input.type='radio'; input.name='answer'; input.value=option; input.id=`opt-${state.index}-${idx}`; input.checked=current===option;
        const span = document.createElement('span'); span.textContent=option;
        label.setAttribute('for', input.id); label.append(input,span); area.appendChild(label);
      });
    } else if (q.type === 'number') {
      const input = document.createElement('input'); input.id='answerInput'; input.type='number'; input.inputMode='decimal'; input.value=current; input.placeholder='Ingrese el valor'; area.appendChild(input);
    } else {
      const textarea = document.createElement('textarea'); textarea.id='answerInput'; textarea.value=current; textarea.placeholder='Registre aquí la respuesta…'; area.appendChild(textarea);
    }

    const revision = Number(state.revisions[q.id] || 0) + 1;
    await startQuestionRecorder(q.id, revision);
    state.meta.index = state.index;
    await persistSessionMeta();
    updateLocalSaveText();
    scrollTo({top:0,behavior:'smooth'});
  }

  function currentAnswerValue() {
    const q = state.questions[state.index];
    if (q.type === 'radio' || q.type === 'select') return document.querySelector('input[name="answer"]:checked')?.value || '';
    return $('answerInput')?.value || '';
  }

  async function saveAndMove(direction) {
    $('nextBtn').disabled = true;
    $('backBtn').disabled = true;
    try {
      const q = state.questions[state.index];
      const answer = currentAnswerValue();
      if (q.required && !String(answer).trim()) throw new Error('Esta pregunta requiere una respuesta.');
      if (q.type === 'number' && String(answer).trim() && !isFinite(Number(answer))) throw new Error('La respuesta numérica no es válida.');
      if ((q.type === 'radio' || q.type === 'select') && answer && !(q.options || []).includes(answer)) throw new Error('La opción seleccionada no es válida.');

      const context = await stopQuestionRecorder();
      const revision = Number(context?.revision || Number(state.revisions[q.id] || 0) + 1);
      state.answers[q.id] = answer;
      state.revisions[q.id] = revision;
      await dbPut('answers', {
        id:`${state.sessionId}|${q.id}|${revision}`, sessionId:state.sessionId, questionId:q.id, revision, answer,
        clientTime:new Date().toISOString(), questionOrder:q.order, questionText:q.text
      });
      await logLocalEvent('QUESTION_CONFIRMED', { questionId:q.id, revision, index:state.index });
      updateLocalSaveText();

      if (direction === 'finish') {
        await beginFinalization();
        return;
      }
      state.index += direction === 'back' ? -1 : 1;
      state.index = Math.max(0, Math.min(state.questions.length - 1, state.index));
      state.meta.index = state.index;
      await persistSessionMeta();
      await renderQuestion();
    } catch (error) {
      setMessage($('localSaveText'), error.message, 'error');
      if (!state.questionContext && !state.closing) {
        const q = state.questions[state.index];
        await startQuestionRecorder(q.id, Number(state.revisions[q.id] || 0) + 1);
      }
    } finally {
      $('nextBtn').disabled = false;
      $('backBtn').disabled = state.index === 0;
    }
  }

  async function updateLocalSaveText() {
    if (!$('localSaveText') || !state.sessionId) return;
    try {
      const audio = await dbGetBySession('audio', state.sessionId);
      const bytes = audio.reduce((sum,x) => sum + Number(x.bytes || 0), 0);
      $('localSaveText').textContent = `${state.answers ? Object.keys(state.answers).length : 0} respuesta(s) · ${(bytes/1024/1024).toFixed(1)} MB cifrados`;
    } catch (_) {}
  }

  /** -------------------- FINAL Y PAQUETE -------------------- */

  async function beginFinalization() {
    state.closing = true;
    showView('finalizingView');
    setPackageProgress(5, 'Deteniendo grabación continua…');
    try {
      await stopFullRecorder();
      await releaseWakeLock();
      setPackageProgress(15, 'Registrando cierre local…');
      try {
        const finalLocation = await requestLocation();
        if (finalLocation) {
          state.location = finalLocation;
          await saveLocationLocal('FINAL_ENCUESTA', finalLocation, 'Cierre local de entrevista');
        }
      } catch (error) {
        await logLocalEvent('FINAL_LOCATION_WARNING', { message:error.message }, 'MEDIUM');
      }
      await logLocalEvent('INTERVIEW_FINISHED_LOCAL', { online:navigator.onLine });
      state.meta.stage = 'finished';
      state.meta.finishedAt = new Date().toISOString();
      state.meta.index = state.index;
      await persistSessionMeta();
      await preparePackageAndShowShare();
    } catch (error) {
      setPackageProgress(0, 'No fue posible preparar el expediente: ' + error.message);
      state.closing = false;
    }
  }

  function setPackageProgress(percent, text) {
    if ($('packageProgress')) $('packageProgress').style.width = `${Math.max(0,Math.min(100,percent))}%`;
    if ($('packageProgressText')) $('packageProgressText').textContent = text || '';
  }

  function audioSort(a,b) {
    if (a.kind !== b.kind) return a.kind === 'full' ? -1 : 1;
    if (a.kind === 'full') return Number(a.sequence||0) - Number(b.sequence||0);
    return String(a.questionId||'').localeCompare(String(b.questionId||'')) || Number(a.revision||0)-Number(b.revision||0) || Number(a.part||0)-Number(b.part||0);
  }

  function audioDescriptor(item) {
    return {
      id:item.id, kind:item.kind, bytes:Number(item.bytes || item.blob?.size || 0), ivB64:item.ivB64, aad:item.aad,
      mimeOriginal:item.mimeOriginal || 'audio/webm', cipherSha256B64:item.cipherSha256B64 || '', createdAt:item.createdAt || '',
      runId:item.runId || '', sequence:Number(item.sequence || 0), questionId:item.questionId || '', revision:Number(item.revision || 0),
      part:Number(item.part || 0), totalParts:Number(item.totalParts || 0)
    };
  }

  function sanitizedSessionMeta(meta) {
    const clone = { ...meta };
    delete clone.cryptoKey;
    delete clone.token;
    delete clone.resumeHash;
    delete clone.resumeSalt;
    delete clone.key;
    return clone;
  }

  async function buildPackageFile() {
    if (!state.aesKey) state.aesKey = state.meta?.cryptoKey;
    if (!state.aesKey) throw new Error('No se encontró la clave local de la sesión.');
    setPackageProgress(25, 'Leyendo respuestas y audios cifrados…');

    const [answers, audioRaw, events, locations, serverOps] = await Promise.all([
      dbGetBySession('answers',state.sessionId), dbGetBySession('audio',state.sessionId), dbGetBySession('events',state.sessionId),
      dbGetBySession('locations',state.sessionId), dbGetBySession('serverops',state.sessionId)
    ]);
    const audio = audioRaw.sort(audioSort);
    const accessCode = await readSecretAccessCode();
    const latestAnswers = {};
    answers.forEach((a) => {
      if (!latestAnswers[a.questionId] || Number(a.revision) > Number(latestAnswers[a.questionId].revision)) latestAnswers[a.questionId] = a;
    });

    setPackageProgress(40, 'Construyendo índice verificable…');
    const descriptors = audio.map(audioDescriptor);
    const metadata = {
      format:C.PACKAGE_FORMAT,
      metadataVersion:1,
      createdAt:new Date().toISOString(),
      session:sanitizedSessionMeta(state.meta),
      access:{ code:accessCode, codeLabel:state.codeLabel, campaignId:state.campaignId },
      questions:state.questions,
      answersLatest:Object.values(latestAnswers).sort((a,b) => Number(a.questionOrder||0)-Number(b.questionOrder||0)),
      answerHistory:answers.sort((a,b) => String(a.questionId).localeCompare(String(b.questionId)) || Number(a.revision)-Number(b.revision)),
      locations:locations.sort((a,b) => String(a.clientTime).localeCompare(String(b.clientTime))),
      localEvents:events.sort((a,b) => String(a.clientTime).localeCompare(String(b.clientTime))),
      serverSecurityOps:serverOps.map((x) => ({ action:x.action, createdAt:x.createdAt, done:Boolean(x.done), doneAt:x.doneAt || 0, tries:x.tries || 0, lastError:x.lastError || '' })),
      profile:state.profile,
      capturePolicy:{
        audioBitsPerSecond:C.AUDIO_BITS_PER_SECOND,
        questionTimesliceMs:C.QUESTION_TIMESLICE_MS,
        fullTimesliceMs:C.FULL_TIMESLICE_MS,
        recordQuestionAudio:Boolean(C.RECORD_QUESTION_AUDIO),
        expectedMaxHours:C.EXPECTED_MAX_HOURS
      },
      audioIndex:descriptors
    };

    setPackageProgress(55, 'Cifrando metadatos de la entrevista…');
    const metadataAad = `${state.sessionId}|metadata|v4`;
    const metadataEncrypted = await encryptBytes(encoder.encode(JSON.stringify(metadata)), metadataAad);
    const metadataBlob = new Blob([metadataEncrypted.cipher], { type:'application/octet-stream' });
    const packageId = 'pkg_' + crypto.randomUUID().replace(/-/g,'');

    const items = [{
      id:'metadata', kind:'metadata', bytes:metadataEncrypted.bytes, ivB64:metadataEncrypted.ivB64, aad:metadataAad,
      mimeOriginal:'application/json', cipherSha256B64:metadataEncrypted.cipherSha256B64
    }].concat(descriptors);

    const manifest = {
      format:C.PACKAGE_FORMAT,
      version:1,
      packageId,
      createdAt:new Date().toISOString(),
      sessionId:state.sessionId,
      campaignId:state.campaignId,
      codeLabel:state.codeLabel,
      keyId:C.PUBLIC_KEY_JWK.kid,
      wrappedKeyB64:state.wrappedKeyB64,
      questionCount:state.questions.length,
      itemCount:items.length,
      items
    };

    setPackageProgress(70, 'Armando expediente cifrado…');
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const header = new Uint8Array(8);
    header.set([69,83,86,52],0); // ESV4
    new DataView(header.buffer).setUint32(4,manifestBytes.length,false);
    const parts = [header, manifestBytes, metadataBlob, ...audio.map((x) => x.blob)];
    const filename = `${state.sessionId}_${new Date().toISOString().replace(/[:.]/g,'-')}${C.PACKAGE_EXTENSION || '.encuesta'}`;
    const file = new File(parts, filename, { type:'application/octet-stream', lastModified:Date.now() });

    state.packageFile = file;
    state.packageManifest = manifest;
    state.meta.lastPackageId = packageId;
    state.meta.lastPackageName = filename;
    state.meta.lastPackageBytes = file.size;
    state.meta.lastPackageGeneratedAt = new Date().toISOString();
    await persistSessionMeta();
    setPackageProgress(100, 'Expediente listo.');
    return file;
  }

  async function preparePackageAndShowShare() {
    try {
      await buildPackageFile();
      $('packageName').textContent = state.packageFile.name;
      $('packageSize').textContent = `${(state.packageFile.size / 1024 / 1024).toFixed(1)} MB`;
      $('whatsappTarget').textContent = validWhatsappPhone() ? `Destino configurado: +${C.WHATSAPP_PHONE}` : 'Configure WHATSAPP_PHONE en config.js';
      $('whatsappBtn').disabled = !validWhatsappPhone();
      showView('shareView');
      setMessage($('shareMsg'), 'El archivo está listo en memoria. Compártalo o descargue un respaldo.', 'success');
    } catch (error) {
      showView('finalizingView');
      setPackageProgress(0, 'Error: ' + error.message);
    }
  }

  async function sharePackage() {
    if (!state.packageFile) {
      setMessage($('shareMsg'), 'El expediente debe prepararse nuevamente. Espere y vuelva a pulsar compartir.', 'warning');
      showView('finalizingView');
      await preparePackageAndShowShare();
      return;
    }
    const data = {
      files:[state.packageFile],
      title:`Encuesta ${state.codeLabel || state.sessionId}`,
      text:`Expediente cifrado ${state.sessionId}. Enviar al receptor autorizado${validWhatsappPhone() ? ' +' + C.WHATSAPP_PHONE : ''}.`
    };
    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare({files:data.files}))) {
        await navigator.share(data);
        setMessage($('shareMsg'), 'El archivo fue entregado al menú de compartir. Seleccione WhatsApp y confirme el envío al destinatario.', 'success');
      } else {
        downloadPackage();
        setMessage($('shareMsg'), 'Este navegador no permite compartir archivos directamente. Se descargó el respaldo; adjúntelo en WhatsApp.', 'warning');
      }
    } catch (error) {
      if (error.name === 'AbortError') setMessage($('shareMsg'), 'Se canceló el menú de compartir. El expediente sigue disponible.', 'warning');
      else setMessage($('shareMsg'), 'No fue posible compartir: ' + error.message, 'error');
    }
  }

  function downloadPackage() {
    if (!state.packageFile) return;
    const url = URL.createObjectURL(state.packageFile);
    const a = document.createElement('a');
    a.href = url; a.download = state.packageFile.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function openWhatsapp() {
    if (!validWhatsappPhone()) {
      setMessage($('shareMsg'), 'Configure WHATSAPP_PHONE en config.js con el número internacional, solo dígitos.', 'error');
      return;
    }
    const message = `Hola. Envío el expediente cifrado de la encuesta ${state.sessionId}, código interno ${state.codeLabel || 'sin etiqueta'}. El archivo se llama ${state.packageFile?.name || 'expediente .encuesta'}.`;
    const url = `https://wa.me/${C.WHATSAPP_PHONE}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function markSent() {
    if (state.shareConfirmed) {
      location.reload();
      return;
    }
    state.shareConfirmed = true;
    state.meta.stage = 'shared_confirmed';
    state.meta.sharedConfirmedAt = new Date().toISOString();
    await persistSessionMeta();
    await dbPut('meta', { key:'activeSession', sessionId:'' });
    setMessage($('shareMsg'), 'Sesión liberada para iniciar una nueva entrevista. La copia cifrada local se conserva para poder reenviarla.', 'success');
    $('markSentBtn').textContent = 'Iniciar nueva entrevista';
  }

  /** -------------------- UI / SEGURIDAD DEL NAVEGADOR -------------------- */

  function environmentBlocked(detail) {
    $('blockedDetail').textContent = detail || '';
    showView('blockedView');
  }

  function setConnectionUi() {
    const online = navigator.onLine;
    const badge = $('globalConnection');
    badge.textContent = online ? 'Con conexión' : 'Modo sin conexión';
    badge.classList.toggle('offline', !online);
    if ($('connectionText')) $('connectionText').textContent = online ? 'Local · con red' : 'Local · sin red';
    if (online) processServerOps().catch(() => {});
  }

  async function stopAllRecorders() {
    try { await stopQuestionRecorder(); } catch (_) {}
    try { await stopFullRecorder(); } catch (_) {}
  }

  function beforeUnload(event) {
    if (state.meta && ['survey','finished'].includes(state.meta.stage) && !state.shareConfirmed) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try { await navigator.serviceWorker.register('./sw.js', { scope:'./' }); } catch (_) {}
  }

  function bindEvents() {
    ['accessCode','resumeCode'].forEach((id) => {
      $(id).addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
    });
    $('accessCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    $('resumeCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') resumeLocalSession(); });
    $('loginBtn').addEventListener('click', login);
    $('resumeBtn').addEventListener('click', resumeLocalSession);
    $('goLoginBtn').addEventListener('click', () => showView('loginView'));
    $('configureBtn').addEventListener('click', configureEnvironment);
    $('testMicBtn').addEventListener('click', testMicrophone);
    $('startBtn').addEventListener('click', startSurvey);
    $('nextBtn').addEventListener('click', () => saveAndMove(state.index === state.questions.length - 1 ? 'finish' : 'next'));
    $('backBtn').addEventListener('click', () => saveAndMove('back'));
    $('shareBtn').addEventListener('click', sharePackage);
    $('downloadBtn').addEventListener('click', downloadPackage);
    $('whatsappBtn').addEventListener('click', openWhatsapp);
    $('markSentBtn').addEventListener('click', markSent);
    $('reloadBtn').addEventListener('click', () => location.reload());
    addEventListener('online', setConnectionUi);
    addEventListener('offline', setConnectionUi);
    addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', () => {
      if (state.sessionId) logLocalEvent(document.hidden ? 'PAGE_HIDDEN' : 'PAGE_VISIBLE', { visibilityState:document.visibilityState }).catch(() => {});
      if (!document.hidden && state.meta?.stage === 'survey') requestWakeLock().catch(() => {});
    });
  }

  async function boot() {
    bindEvents();
    setConnectionUi();
    await registerServiceWorker();
    try {
      await openDb();
      state.deviceInstallId = getOrCreateInstallId();
      const active = await getActiveMeta();
      if (active && active.sessionId && active.stage !== 'shared_confirmed') {
        state.meta = active;
        state.sessionId = active.sessionId;
        state.aesKey = active.cryptoKey;
        state.wrappedKeyB64 = active.wrappedKeyB64;
        $('resumeSessionLabel').textContent = active.codeLabel ? `Sesión ${active.codeLabel}` : active.sessionId;
        $('resumeStageText').textContent = active.stage === 'finished' ? 'Entrevista terminada: falta enviar o respaldar el expediente.' : 'Hay avance local protegido en este dispositivo.';
        showView('resumeView');
        return;
      }
      if (!apiConfigured()) {
        showView('loginView');
        setMessage($('loginMsg'), 'Antes de publicar, configure API_URL en config.js con el nuevo Web App de Apps Script.', 'error');
        return;
      }
      if (!navigator.onLine) {
        showView('loginView');
        setMessage($('loginMsg'), 'No hay una sesión local pendiente. Se necesita conexión únicamente para validar un código nuevo.', 'warning');
        return;
      }
      await initializeOnlineAccess();
      showView('loginView');
    } catch (error) {
      showView('loginView');
      setMessage($('loginMsg'), error.message, 'error');
    }
  }

  boot();
})();
