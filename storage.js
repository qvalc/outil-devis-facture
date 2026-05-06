/* BastCompta - couche de stockage IndexedDB compatible localStorage
   Objectif : ajouter IndexedDB sans casser l'existant.
   - Les anciennes lectures localStorage continuent de fonctionner.
   - Chaque écriture localStorage est recopiée automatiquement dans IndexedDB.
   - Si localStorage est vide mais qu'IndexedDB contient les données, elles sont restaurées puis la page est rechargée une seule fois.
*/
(function () {
  'use strict';

  const DB_NAME = 'BastComptaDB';
  const DB_VERSION = 2;
  const MIRROR_STORE = 'localStorageMirror';
  const META_STORE = 'meta';
  const RESTORE_FLAG = 'bastcompta_indexeddb_restore_done';

  const IMPORTANT_KEYS = [
    'devis-facture-style-vrai-document',
    'devis-facture-style-vrai-document-last-save',
    'comptabilite-local-v1',
    'bastcompta-chantiers-v1',
    'bastcompta-chantiers-v1-last-save',
    'bastcompta-crm-deleted-clients-v1',
    'bastcompta-google-was-connected'
  ];

  let dbPromise = null;
  const pendingWrites = [];

  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB indisponible'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(MIRROR_STORE)) {
          db.createObjectStore(MIRROR_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Ouverture IndexedDB impossible'));
    });

    return dbPromise;
  }

  async function idbPut(storeName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Écriture IndexedDB impossible'));
    });
  }

  async function idbGet(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Lecture IndexedDB impossible'));
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Suppression IndexedDB impossible'));
    });
  }

  function mirrorSetItem(key, value) {
    const task = idbPut(MIRROR_STORE, {
      key: String(key),
      value: String(value),
      updatedAt: new Date().toISOString(),
      source: 'localStorage'
    }).catch(error => console.warn('[BastStorage] Miroir IndexedDB non écrit :', error));

    pendingWrites.push(task);
    task.finally(() => {
      const index = pendingWrites.indexOf(task);
      if (index >= 0) pendingWrites.splice(index, 1);
    });

    return task;
  }

  function mirrorRemoveItem(key) {
    return idbDelete(MIRROR_STORE, String(key)).catch(error => {
      console.warn('[BastStorage] Suppression miroir IndexedDB non effectuée :', error);
    });
  }

  function installLocalStorageMirror() {
    try {
      const nativeSetItem = Storage.prototype.setItem;
      const nativeRemoveItem = Storage.prototype.removeItem;
      const nativeClear = Storage.prototype.clear;

      if (Storage.prototype.__bastComptaIndexedDBInstalled) return;

      Object.defineProperty(Storage.prototype, '__bastComptaIndexedDBInstalled', {
        value: true,
        configurable: false
      });

      Storage.prototype.setItem = function (key, value) {
        const result = nativeSetItem.apply(this, arguments);
        if (this === window.localStorage) mirrorSetItem(key, value);
        return result;
      };

      Storage.prototype.removeItem = function (key) {
        const result = nativeRemoveItem.apply(this, arguments);
        if (this === window.localStorage) mirrorRemoveItem(key);
        return result;
      };

      Storage.prototype.clear = function () {
        const result = nativeClear.apply(this, arguments);
        if (this === window.localStorage) {
          IMPORTANT_KEYS.forEach(key => mirrorRemoveItem(key));
        }
        return result;
      };
    } catch (error) {
      console.warn('[BastStorage] Installation du miroir localStorage impossible :', error);
    }
  }

  async function mirrorExistingLocalStorage() {
    try {
      for (const key of IMPORTANT_KEYS) {
        const value = window.localStorage.getItem(key);
        if (value !== null) await mirrorSetItem(key, value);
      }
      await idbPut(META_STORE, {
        key: 'lastLocalStorageMirror',
        value: new Date().toISOString()
      });
    } catch (error) {
      console.warn('[BastStorage] Migration localStorage → IndexedDB incomplète :', error);
    }
  }

  async function restoreMissingLocalStorageFromIndexedDB() {
    try {
      let restored = false;

      for (const key of IMPORTANT_KEYS) {
        if (window.localStorage.getItem(key) !== null) continue;
        const entry = await idbGet(MIRROR_STORE, key);
        if (!entry || typeof entry.value !== 'string') continue;
        window.localStorage.setItem(key, entry.value);
        restored = true;
      }

      if (restored && window.sessionStorage.getItem(RESTORE_FLAG) !== '1') {
        window.sessionStorage.setItem(RESTORE_FLAG, '1');
        window.location.reload();
      }
    } catch (error) {
      console.warn('[BastStorage] Restauration IndexedDB → localStorage incomplète :', error);
    }
  }


  async function getPrimary(key, fallback = null) {
    try {
      const entry = await idbGet(MIRROR_STORE, String(key));
      if (entry && typeof entry.value === 'string') {
        try {
          if (window.localStorage.getItem(key) !== entry.value) {
            window.localStorage.setItem(key, entry.value);
          }
        } catch (error) {
          console.warn('[BastStorage] Recopie IndexedDB → localStorage impossible :', error);
        }
        return entry.value;
      }
    } catch (error) {
      console.warn('[BastStorage] Lecture prioritaire IndexedDB impossible, fallback localStorage :', error);
    }

    const localValue = window.localStorage.getItem(key);
    if (localValue !== null) {
      await mirrorSetItem(key, localValue);
      return localValue;
    }

    return fallback;
  }

  async function setPrimary(key, value) {
    const stringValue = String(value);
    await idbPut(MIRROR_STORE, {
      key: String(key),
      value: stringValue,
      updatedAt: new Date().toISOString(),
      source: 'indexedDB-primary'
    });
    try {
      window.localStorage.setItem(key, stringValue);
    } catch (error) {
      console.warn('[BastStorage] Copie de secours localStorage impossible :', error);
    }
    return true;
  }

  async function getJsonPrimary(key, fallback = null) {
    const raw = await getPrimary(key, null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[BastStorage] JSON prioritaire IndexedDB invalide pour', key, error);
      return fallback;
    }
  }

  async function setJsonPrimary(key, value, pretty = false) {
    return setPrimary(key, JSON.stringify(value, null, pretty ? 2 : 0));
  }

  async function get(key, fallback = null) {
    const localValue = window.localStorage.getItem(key);
    if (localValue !== null) return localValue;
    const entry = await idbGet(MIRROR_STORE, key);
    return entry && typeof entry.value === 'string' ? entry.value : fallback;
  }

  async function set(key, value) {
    window.localStorage.setItem(key, value);
    await mirrorSetItem(key, value);
    return true;
  }

  async function getJson(key, fallback = null) {
    const raw = await get(key, null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[BastStorage] JSON invalide pour', key, error);
      return fallback;
    }
  }

  async function setJson(key, value, pretty = false) {
    return set(key, JSON.stringify(value, null, pretty ? 2 : 0));
  }

  async function flush() {
    await Promise.allSettled(pendingWrites.slice());
  }

  window.BastStorage = {
    dbName: DB_NAME,
    version: DB_VERSION,
    importantKeys: IMPORTANT_KEYS.slice(),
    get,
    set,
    getPrimary,
    setPrimary,
    getJson,
    setJson,
    getJsonPrimary,
    setJsonPrimary,
    remove: async key => {
      window.localStorage.removeItem(key);
      await mirrorRemoveItem(key);
      return true;
    },
    mirrorExistingLocalStorage,
    restoreMissingLocalStorageFromIndexedDB,
    flush
  };

  installLocalStorageMirror();
  window.BastStorage.ready = restoreMissingLocalStorageFromIndexedDB().then(mirrorExistingLocalStorage);
  window.BastStorage.primaryMode = true;

  window.addEventListener('beforeunload', () => {
    // Les écritures sont déjà lancées à chaque setItem ; ce hook sert surtout de point d'extension.
  });
})();
