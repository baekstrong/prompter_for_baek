/**
 * Durable, append-only recording storage. listRecordings() returns lightweight
 * metadata; getRecording(id) constructs the Blob only when explicitly requested.
 * Incomplete sessions remain available after a tab closes. No take is evicted.
 * All methods reject when IndexedDB is unavailable, blocked, or out of space.
 */
const DATABASE_NAME = 'prompter-recordings';
const DATABASE_VERSION = 1;
let databasePromise;

function storageError(message) {
  const error = new Error(message);
  error.name = 'StorageUnavailableError';
  return error;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) return Promise.reject(storageError('이 브라우저에서는 영상 보관함을 사용할 수 없습니다.'));
  databasePromise = new Promise((resolve, reject) => {
    let settled = false;
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const timeout = setTimeout(() => fail(storageError('영상 보관함을 여는 시간이 초과되었습니다.')), 5000);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) {
        const chunks = db.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] });
        chunks.createIndex('recordingId', 'recordingId', { unique: false });
      }
    };
    request.onerror = () => fail(request.error || storageError('영상 보관함을 열지 못했습니다.'));
    request.onblocked = () => fail(storageError('다른 탭이 영상 보관함 갱신을 막고 있습니다. 다른 탭을 닫아 주세요.'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timeout);
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      db.onclose = () => { databasePromise = undefined; };
      resolve(db);
    };
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(storageError('영상 보관함이 응답하지 않아 저장을 중단했습니다.'));
      try { transaction.abort(); } catch { /* It may have finished as the timer fired. */ }
    }, 30000);
    transaction.oncomplete = () => { clearTimeout(timeout); resolve(); };
    transaction.onerror = () => { clearTimeout(timeout); reject(transaction.error || storageError('영상 저장 중 오류가 발생했습니다.')); };
    transaction.onabort = () => { clearTimeout(timeout); reject(transaction.error || storageError('영상 저장이 중단되었습니다.')); };
  });
}

function metadataOf(recording) {
  const { blob, ...metadata } = recording;
  return { ...metadata, size: blob?.size ?? metadata.size ?? 0 };
}

/** CameraEngine-internal API. A session is recoverable from its first chunk. */
export async function beginRecordingSession(recording) {
  const db = await openDatabase();
  const transaction = db.transaction('recordings', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('recordings').add({
    ...metadataOf(recording), complete: false, reason: 'interrupted', size: 0, chunkCount: 0,
  });
  await done;
}

/** Atomically persist one chunk and its recovery metadata. */
export async function appendRecordingChunk(id, index, blob, durationMs) {
  const db = await openDatabase();
  const transaction = db.transaction(['recordings', 'chunks'], 'readwrite');
  const done = transactionDone(transaction);
  const recordings = transaction.objectStore('recordings');
  const request = recordings.get(id);
  request.onsuccess = () => {
    const metadata = request.result;
    if (!metadata) { transaction.abort(); return; }
    transaction.objectStore('chunks').add({ recordingId: id, index, blob });
    recordings.put({ ...metadata, size: metadata.size + blob.size, chunkCount: metadata.chunkCount + 1, durationMs });
  };
  await done;
}

export async function finishRecordingSession(id, changes) {
  const db = await openDatabase();
  const transaction = db.transaction('recordings', 'readwrite');
  const done = transactionDone(transaction);
  const recordings = transaction.objectStore('recordings');
  const request = recordings.get(id);
  request.onsuccess = () => {
    if (request.result) recordings.put({ ...request.result, ...changes });
  };
  await done;
}

/** Metadata only: loading the library never reads video bytes into memory. */
export async function listRecordings() {
  const db = await openDatabase();
  const transaction = db.transaction('recordings', 'readonly');
  const done = transactionDone(transaction);
  const [records] = await Promise.all([requestValue(transaction.objectStore('recordings').getAll()), done]);
  return records.filter(recording => recording.size > 0).map(metadataOf)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Returns a full take, or null. An incomplete take contains every saved chunk. */
export async function getRecording(id) {
  const db = await openDatabase();
  const transaction = db.transaction(['recordings', 'chunks'], 'readonly');
  const done = transactionDone(transaction);
  const metadataRequest = requestValue(transaction.objectStore('recordings').get(id));
  const chunksRequest = requestValue(transaction.objectStore('chunks').index('recordingId').getAll(id));
  const [metadata, chunks] = await Promise.all([metadataRequest, chunksRequest, done]);
  if (!metadata) return null;
  const blob = metadata.blob || new Blob(chunks.sort((a, b) => a.index - b.index).map(chunk => chunk.blob), { type: metadata.mimeType });
  return { ...metadataOf(metadata), blob, persisted: true };
}

/** Explicit user deletion is the only operation that removes a saved take. */
export async function deleteRecording(id) {
  const db = await openDatabase();
  const transaction = db.transaction(['recordings', 'chunks'], 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('recordings').delete(id);
  const cursor = transaction.objectStore('chunks').index('recordingId').openCursor(id);
  cursor.onsuccess = () => {
    if (cursor.result) { cursor.result.delete(); cursor.result.continue(); }
  };
  await done;
}

/** Save or replace an explicitly supplied Blob, e.g. a take held in memory. */
export async function saveRecording(recording) {
  if (!(recording?.blob instanceof Blob) || !recording.id) throw new TypeError('A recording id and Blob are required.');
  const db = await openDatabase();
  const transaction = db.transaction(['recordings', 'chunks'], 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('recordings').put({ ...metadataOf(recording), blob: recording.blob, chunkCount: 0, persisted: true });
  const cursor = transaction.objectStore('chunks').index('recordingId').openCursor(recording.id);
  cursor.onsuccess = () => {
    if (cursor.result) { cursor.result.delete(); cursor.result.continue(); }
  };
  await done;
  return { ...metadataOf(recording), persisted: true };
}
