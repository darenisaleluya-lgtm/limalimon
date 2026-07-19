const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAGIC = "SURVPKG1";
const FORMAT_VERSION = 1;

export function randomId(prefix = "") {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${value}`;
}

export function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function deriveAudioKey(passphrase, salt, iterations = 600000) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new Error("La clave debe tener al menos 12 caracteres");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createKeyVerifier(key, sessionId) {
  const iv = randomBytes(12);
  const aad = encoder.encode("survey-key-verifier:v1");
  const plaintext = encoder.encode(`SURVEY-KEY-CHECK:${sessionId}`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
}

export async function verifyKey(key, sessionId, verifier) {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(verifier.iv),
        additionalData: encoder.encode("survey-key-verifier:v1")
      },
      key,
      base64ToBytes(verifier.ciphertext)
    );
    return decoder.decode(plaintext) === `SURVEY-KEY-CHECK:${sessionId}`;
  } catch {
    return false;
  }
}

export function audioAad(metadata) {
  return [
    "audio:v1",
    metadata.sessionId,
    metadata.segmentId,
    metadata.chunkIndex,
    metadata.mimeType
  ].join("|");
}

export async function encryptAudioChunk(key, buffer, metadata) {
  const iv = randomBytes(12);
  const aad = audioAad(metadata);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    buffer
  );
  return { iv: iv.buffer, ciphertext, aad };
}

export async function decryptAudioChunk(key, chunk) {
  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: chunk.iv instanceof ArrayBuffer ? new Uint8Array(chunk.iv) : chunk.iv,
      additionalData: encoder.encode(chunk.aad)
    },
    key,
    chunk.ciphertext
  );
}

async function encryptManifest(key, manifest) {
  const iv = randomBytes(12);
  const aad = "manifest:v1";
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(manifest))
  );
  return { iv, aad, ciphertext };
}

function uint32(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, value, false);
  return buffer;
}

function safeSessionForManifest(session) {
  const copy = { ...session };
  delete copy.turnstileToken;
  delete copy.passphrase;
  delete copy.sessionToken;
  return copy;
}

export async function buildEncryptedPackage({ session, answers, events, audioChunks, key, onProgress }) {
  const manifest = {
    format: "encuesta-segura-manifest",
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    session: safeSessionForManifest(session),
    answers,
    events
  };
  const encryptedManifest = await encryptManifest(key, manifest);
  const publicHeader = {
    format: MAGIC,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    kdf: session.crypto.kdf,
    verifier: session.crypto.verifier,
    recordCount: audioChunks.length + 1
  };

  const parts = [];
  const magicBytes = encoder.encode(MAGIC);
  const headerBytes = encoder.encode(JSON.stringify(publicHeader));
  parts.push(magicBytes, uint32(headerBytes.byteLength), headerBytes);

  const manifestMeta = {
    type: "manifest",
    iv: bytesToBase64(encryptedManifest.iv),
    aad: encryptedManifest.aad,
    cipherLength: encryptedManifest.ciphertext.byteLength
  };
  const manifestMetaBytes = encoder.encode(JSON.stringify(manifestMeta));
  parts.push(uint32(manifestMetaBytes.byteLength), manifestMetaBytes, encryptedManifest.ciphertext);

  for (let i = 0; i < audioChunks.length; i += 1) {
    const chunk = audioChunks[i];
    const meta = {
      type: "audio",
      segmentId: chunk.segmentId,
      chunkIndex: chunk.chunkIndex,
      mimeType: chunk.mimeType,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      iv: bytesToBase64(chunk.iv),
      aad: chunk.aad,
      cipherLength: chunk.ciphertext.byteLength
    };
    const metaBytes = encoder.encode(JSON.stringify(meta));
    parts.push(uint32(metaBytes.byteLength), metaBytes, chunk.ciphertext);
    if (onProgress && (i % 10 === 0 || i === audioChunks.length - 1)) {
      onProgress({ current: i + 1, total: audioChunks.length });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return new Blob(parts, { type: "application/octet-stream" });
}

async function readUint32(blob, offset) {
  if (offset + 4 > blob.size) throw new Error("Archivo incompleto");
  const buffer = await blob.slice(offset, offset + 4).arrayBuffer();
  return new DataView(buffer).getUint32(0, false);
}

async function readBytes(blob, offset, length) {
  if (length < 0 || offset + length > blob.size) throw new Error("Longitud inválida en el paquete");
  return blob.slice(offset, offset + length).arrayBuffer();
}

export async function inspectPackage(blob) {
  if (!(blob instanceof Blob) || blob.size < 20) throw new Error("El archivo no es válido");
  const magic = decoder.decode(await readBytes(blob, 0, 8));
  if (magic !== MAGIC) throw new Error("Formato de respaldo no reconocido");
  const headerLength = await readUint32(blob, 8);
  if (headerLength > 20000) throw new Error("Cabecera excesivamente grande");
  const header = JSON.parse(decoder.decode(await readBytes(blob, 12, headerLength)));
  if (header.format !== MAGIC || header.version !== FORMAT_VERSION) {
    throw new Error("Versión de respaldo no compatible");
  }
  if (!Number.isInteger(header.recordCount) || header.recordCount < 1 || header.recordCount > 200000) {
    throw new Error("Cantidad de registros inválida");
  }
  const iterations = Number(header.kdf?.iterations);
  if (header.kdf?.name !== "PBKDF2" || header.kdf?.hash !== "SHA-256" || !Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) {
    throw new Error("Parámetros de derivación de clave no permitidos");
  }
  const salt = base64ToBytes(String(header.kdf?.salt || ""));
  if (salt.byteLength < 16 || salt.byteLength > 64) throw new Error("Salt de cifrado inválido");
  if (!header.verifier || typeof header.verifier.iv !== "string" || typeof header.verifier.ciphertext !== "string") {
    throw new Error("Verificador de clave inválido");
  }
  return { header, nextOffset: 12 + headerLength };
}

export async function decryptPackage(blob, passphrase, onProgress) {
  const inspected = await inspectPackage(blob);
  const { header } = inspected;
  const salt = base64ToBytes(header.kdf.salt);
  const key = await deriveAudioKey(passphrase, salt, header.kdf.iterations);

  let offset = inspected.nextOffset;
  let manifest = null;
  const segments = new Map();
  const audioRecordIds = new Set();
  let recordNumber = 0;

  while (offset < blob.size) {
    const metaLength = await readUint32(blob, offset);
    offset += 4;
    if (metaLength < 2 || metaLength > 50000) throw new Error("Metadatos dañados");
    const meta = JSON.parse(decoder.decode(await readBytes(blob, offset, metaLength)));
    offset += metaLength;
    if (!Number.isInteger(meta.cipherLength) || meta.cipherLength < 16 || meta.cipherLength > 50 * 1024 * 1024) {
      throw new Error("Longitud cifrada inválida");
    }
    const ciphertext = await readBytes(blob, offset, meta.cipherLength);
    offset += meta.cipherLength;

    if (meta.type === "manifest") {
      if (manifest) throw new Error("El paquete contiene más de un manifiesto");
      if (meta.aad !== "manifest:v1") throw new Error("Metadatos de manifiesto inválidos");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(meta.iv),
          additionalData: encoder.encode(meta.aad)
        },
        key,
        ciphertext
      );
      manifest = JSON.parse(decoder.decode(plaintext));
      const valid = await verifyKey(key, manifest.session.sessionId, header.verifier);
      if (!valid) throw new Error("La clave de recuperación es incorrecta");
    } else if (meta.type === "audio") {
      if (!manifest) throw new Error("El manifiesto debe aparecer antes del audio");
      if (!Number.isInteger(meta.segmentId) || meta.segmentId < 1 || !Number.isInteger(meta.chunkIndex) || meta.chunkIndex < 0) {
        throw new Error("Índice de audio inválido");
      }
      if (typeof meta.mimeType !== "string" || meta.mimeType.length > 100 || !/^audio\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=.,+ -]+)?$/.test(meta.mimeType)) {
        throw new Error("Tipo de audio inválido");
      }
      const expectedAad = audioAad({
        sessionId: manifest.session.sessionId,
        segmentId: meta.segmentId,
        chunkIndex: meta.chunkIndex,
        mimeType: meta.mimeType
      });
      if (meta.aad !== expectedAad) throw new Error("Metadatos de audio alterados");
      const recordId = `${meta.segmentId}:${meta.chunkIndex}`;
      if (audioRecordIds.has(recordId)) throw new Error("Fragmento de audio duplicado");
      audioRecordIds.add(recordId);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(meta.iv),
          additionalData: encoder.encode(meta.aad)
        },
        key,
        ciphertext
      );
      const segmentKey = String(meta.segmentId);
      if (!segments.has(segmentKey)) segments.set(segmentKey, { mimeType: meta.mimeType, chunks: [] });
      segments.get(segmentKey).chunks.push({ index: meta.chunkIndex, buffer: plaintext });
    } else {
      throw new Error("Tipo de registro desconocido");
    }

    recordNumber += 1;
    if (onProgress) onProgress({ current: recordNumber, total: header.recordCount });
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  if (!manifest) throw new Error("El paquete no contiene manifiesto");
  if (recordNumber !== header.recordCount) throw new Error("El paquete está incompleto o contiene registros adicionales");
  const decodedSegments = Array.from(segments.entries()).map(([segmentId, value]) => {
    value.chunks.sort((a, b) => a.index - b.index);
    return {
      segmentId: Number(segmentId),
      mimeType: value.mimeType,
      blob: new Blob(value.chunks.map(chunk => chunk.buffer), { type: value.mimeType }),
      chunkCount: value.chunks.length
    };
  }).sort((a, b) => a.segmentId - b.segmentId);

  return { header, manifest, segments: decodedSegments };
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
