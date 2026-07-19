const DB_NAME = "encuesta-segura-demo";
const DB_VERSION = 1;
let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB falló"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Transacción IndexedDB falló"));
    transaction.onabort = () => reject(transaction.error || new Error("Transacción IndexedDB cancelada"));
  });
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "sessionId" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("answers")) {
        const store = db.createObjectStore("answers", { keyPath: ["sessionId", "questionId"] });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("syncState", "syncState", { unique: false });
      }

      if (!db.objectStoreNames.contains("audioChunks")) {
        const store = db.createObjectStore("audioChunks", { keyPath: ["sessionId", "segmentId", "chunkIndex"] });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("segment", ["sessionId", "segmentId"], { unique: false });
      }

      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", { keyPath: "localEventId" });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("syncState", "syncState", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No fue posible abrir IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB está bloqueado por otra pestaña"));
  });
  return dbPromise;
}

async function withStore(storeName, mode, callback) {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await callback(store, tx);
  await transactionDone(tx);
  return result;
}

export async function storageWriteTest(bytes = 1024 * 1024) {
  const payload = crypto.getRandomValues(new Uint8Array(bytes));
  const record = { key: "__storage_test__", value: payload.buffer, createdAt: Date.now() };
  await withStore("settings", "readwrite", async store => {
    await requestToPromise(store.put(record));
  });
  const read = await withStore("settings", "readonly", store => requestToPromise(store.get(record.key)));
  if (!read || !(read.value instanceof ArrayBuffer) || read.value.byteLength !== bytes) {
    throw new Error("La prueba de lectura del almacenamiento no coincidió");
  }
  await withStore("settings", "readwrite", async store => {
    await requestToPromise(store.delete(record.key));
  });
  return true;
}

export async function getSetting(key) {
  const record = await withStore("settings", "readonly", store => requestToPromise(store.get(key)));
  return record ? record.value : null;
}

export async function setSetting(key, value) {
  return withStore("settings", "readwrite", store => requestToPromise(store.put({ key, value, updatedAt: Date.now() })));
}

export async function putSession(session) {
  session.updatedAt = Date.now();
  return withStore("sessions", "readwrite", store => requestToPromise(store.put(session)));
}

export async function getSession(sessionId) {
  return withStore("sessions", "readonly", store => requestToPromise(store.get(sessionId)));
}

export async function getLatestIncompleteSession() {
  const db = await openDb();
  const tx = db.transaction("sessions", "readonly");
  const store = tx.objectStore("sessions");
  const all = await requestToPromise(store.getAll());
  await transactionDone(tx);
  return all
    .filter(item => !["COMPLETED", "ABANDONED"].includes(item.status))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

export async function putAnswer(answer) {
  answer.updatedAt = Date.now();
  return withStore("answers", "readwrite", store => requestToPromise(store.put(answer)));
}

export async function getAnswers(sessionId) {
  const db = await openDb();
  const tx = db.transaction("answers", "readonly");
  const index = tx.objectStore("answers").index("sessionId");
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
  await transactionDone(tx);
  return rows.sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function getPendingAnswers(sessionId) {
  const answers = await getAnswers(sessionId);
  return answers.filter(item => item.syncState !== "SYNCED");
}

export async function markAnswerSynced(sessionId, questionId, serverResult = {}) {
  const answer = await withStore("answers", "readonly", store => requestToPromise(store.get([sessionId, questionId])));
  if (!answer) return;
  answer.syncState = "SYNCED";
  answer.syncedAt = Date.now();
  answer.serverResult = serverResult;
  await putAnswer(answer);
}

export async function putAudioChunk(chunk) {
  return withStore("audioChunks", "readwrite", store => requestToPromise(store.put(chunk)));
}

export async function getAudioChunks(sessionId) {
  const db = await openDb();
  const tx = db.transaction("audioChunks", "readonly");
  const index = tx.objectStore("audioChunks").index("sessionId");
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
  await transactionDone(tx);
  return rows.sort((a, b) => {
    if (a.segmentId === b.segmentId) return a.chunkIndex - b.chunkIndex;
    return a.segmentId - b.segmentId;
  });
}

export async function countAudioChunks(sessionId) {
  const db = await openDb();
  const tx = db.transaction("audioChunks", "readonly");
  const index = tx.objectStore("audioChunks").index("sessionId");
  const count = await requestToPromise(index.count(IDBKeyRange.only(sessionId)));
  await transactionDone(tx);
  return count;
}

export async function putEvent(event) {
  return withStore("events", "readwrite", store => requestToPromise(store.put(event)));
}

export async function getEvents(sessionId) {
  const db = await openDb();
  const tx = db.transaction("events", "readonly");
  const index = tx.objectStore("events").index("sessionId");
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
  await transactionDone(tx);
  return rows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export async function getPendingEvents(sessionId) {
  const rows = await getEvents(sessionId);
  return rows.filter(item => item.syncState !== "SYNCED");
}

export async function markEventSynced(localEventId) {
  const event = await withStore("events", "readonly", store => requestToPromise(store.get(localEventId)));
  if (!event) return;
  event.syncState = "SYNCED";
  event.syncedAt = Date.now();
  await putEvent(event);
}

export async function deleteSessionData(sessionId) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "answers", "audioChunks", "events"], "readwrite");
  tx.objectStore("sessions").delete(sessionId);

  for (const [storeName, indexName] of [["answers", "sessionId"], ["audioChunks", "sessionId"], ["events", "sessionId"]]) {
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await transactionDone(tx);
}
