import { demoData, stores } from "../data/demo.js";

const DB_NAME = "moroccoflow";
const DB_VERSION = 3;
const OUTBOX = "outbox";

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) {
          const objectStore = db.createObjectStore(store, { keyPath: "id" });
          if (store !== "settings") objectStore.createIndex("createdAt", "createdAt");
        }
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const outbox = db.createObjectStore(OUTBOX, { keyPath: "mutationId" });
        outbox.createIndex("createdAt", "createdAt");
      }
      if (event.oldVersion < 2) {
        for (const storeName of ["deals", "invoices", "expenses"]) {
          const cursorRequest = request.transaction.objectStore(storeName).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            cursor.update({ ...cursor.value, amount: 0 });
            cursor.continue();
          };
        }
        const notificationRequest = request.transaction.objectStore("notifications").openCursor();
        notificationRequest.onsuccess = () => {
          const cursor = notificationRequest.result;
          if (!cursor) return;
          const detail = String(cursor.value.detail || "").replace(
            /\d[\d\s.,]*\s*(?:MAD|dh)/gi,
            "0 dh",
          );
          cursor.update({ ...cursor.value, detail });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function transaction(storeName, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export const getAll = (storeName) => transaction(storeName, "readonly", (store) => store.getAll());
export const put = (storeName, value) =>
  transaction(storeName, "readwrite", (store) => store.put(value));
export const remove = (storeName, id) =>
  transaction(storeName, "readwrite", (store) => store.delete(id));

export async function replaceStore(storeName, records) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.clear();
    for (const record of records) store.put(structuredClone(record));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function replaceWorkspace(data) {
  const names = Object.keys(data).filter((name) => stores.includes(name));
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(names, "readwrite");
    for (const name of names) {
      const store = tx.objectStore(name);
      store.clear();
      for (const record of data[name]) store.put(structuredClone(record));
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}
export const enqueueMutation = (mutation) => put(OUTBOX, mutation);
export const pendingMutations = () => getAll(OUTBOX);
export const removeMutation = (mutationId) => remove(OUTBOX, mutationId);

export async function seedDatabase(force = false) {
  if (force) await clearDatabase();
  if (!force && (await getAll("clients")).length > 0) return;
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    for (const [storeName, records] of Object.entries(demoData)) {
      const store = tx.objectStore(storeName);
      for (const record of records) store.put(structuredClone(record));
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function clearDatabase() {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const names = [...stores, OUTBOX];
    const tx = db.transaction(names, "readwrite");
    for (const storeName of names) tx.objectStore(storeName).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

export async function snapshot() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const data = {};
    const tx = db.transaction(stores, "readonly");
    for (const storeName of stores) {
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => {
        data[storeName] = request.result;
      };
    }
    tx.oncomplete = () => {
      db.close();
      resolve(data);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
