/* 拾光 · IndexedDB 存储层（无第三方依赖，可直接以 file:// 打开） */
(function () {
  "use strict";

  const DB_NAME = "shiguang.office.db";
  const DB_VERSION = 1;
  const DB_STORE = "workspace";
  const DB_KEY = "main";
  const OPEN_TIMEOUT = 4000;

  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB 不可用"));
        return;
      }

      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("IndexedDB 打开超时"));
      }, OPEN_TIMEOUT);

      let request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };

      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };

      request.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(request.error || new Error("IndexedDB 打开失败"));
      };

      request.onblocked = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error("IndexedDB 被其他页面占用"));
      };
    });
    return dbPromise;
  }

  async function readWorkspace() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readonly");
      const request = transaction.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("读取本地数据库失败"));
    });
  }

  async function writeWorkspace(snapshot) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(snapshot, DB_KEY);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error("写入本地数据库失败"));
      transaction.onabort = () => reject(transaction.error || new Error("写入本地数据库被中止"));
    });
  }

  window.ShiguangStorage = {
    read: readWorkspace,
    write: writeWorkspace
  };
})();
