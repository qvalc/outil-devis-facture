// Portail BastCompta - script principal

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyDK3VeC-TOfXliPrY9IrHN0tFPf7KEm_j0",
  authDomain: "bastcompta-3aa41.firebaseapp.com",
  projectId: "bastcompta-3aa41",
  storageBucket: "bastcompta-3aa41.firebasestorage.app",
  messagingSenderId: "724620573737",
  appId: "1:724620573737:web:b44e0d3f8b1cbf382b3038"
};

const GOOGLE_CLIENT_ID = '533118350621-ov27k8jd0ki944rc773j4gr8a3l7vfpk.apps.googleusercontent.com';
const GOOGLE_API_KEY = 'AIzaSyC88moDvAWg7LFeJAgUSxXJV4nhAigSOKU';
const DRIVE_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email profile';

const GOOGLE_WAS_CONNECTED_KEY = 'bastcompta_google_was_connected';
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

let googleTokenClient = null;
let googleAccessToken = null;
let googleTokenExpiresAt = 0;
let googleDriveReady = false;
let googleRequestInFlight = null;
let silentReconnectAttempted = false;
let hiddenDriveFilesCache = [];
let hiddenDriveActiveCategory = 'all';
let googleLoginFlowActive = false;

const authScreen = document.getElementById('authScreen');
const portalScreen = document.getElementById('portalScreen');
const authMessage = document.getElementById('authMessage');
const currentUserEl = document.getElementById('currentUser');
const globalSaveBtn = document.getElementById('globalSaveBtn');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
const googleLoginBtn = document.getElementById('googleLoginBtn');
const sendVerificationBtn = document.getElementById('sendVerificationBtn');
const logoutBtn = document.getElementById('logoutBtn');
const connectDriveBtn = document.getElementById('connectDriveBtn');
const disconnectDriveBtn = document.getElementById('disconnectDriveBtn');
const settingsMenu = document.getElementById('settingsMenu');
const settingsMenuBtn = document.getElementById('settingsMenuBtn');
const hiddenDriveBtn = document.getElementById('hiddenDriveBtn');
const hiddenDriveModal = document.getElementById('hiddenDriveModal');
const closeHiddenDriveBtn = document.getElementById('closeHiddenDriveBtn');
const refreshHiddenDriveBtn = document.getElementById('refreshHiddenDriveBtn');
const hiddenDriveStatus = document.getElementById('hiddenDriveStatus');
const hiddenDriveList = document.getElementById('hiddenDriveList');
const hiddenDriveTabs = document.getElementById('hiddenDriveTabs');
const fullBackupBtn = document.getElementById('fullBackupBtn');
const fullRestoreBtn = document.getElementById('fullRestoreBtn');
const fullRestoreInput = document.getElementById('fullRestoreInput');
const backupOverlay = document.getElementById('backupOverlay');
const backupOverlayTitle = document.getElementById('backupOverlayTitle');
const backupOverlayText = document.getElementById('backupOverlayText');
const devisFrame = document.getElementById('devisFrame');
const comptaFrame = document.getElementById('comptaFrame');
const chantierFrame = document.getElementById('chantierFrame');
const impotsFrame = document.getElementById('impotsFrame');
const subscriptionModal = document.getElementById('subscriptionModal');
const subscriptionModalTitle = document.getElementById('subscriptionModalTitle');
const subscriptionModalText = document.getElementById('subscriptionModalText');
const subscriptionCommunication = document.getElementById('subscriptionCommunication');
const closeSubscriptionModalBtn = document.getElementById('closeSubscriptionModalBtn');
const authTabs = Array.from(document.querySelectorAll('.auth-tab'));
const mainTabs = Array.from(document.querySelectorAll('.main-tab'));

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function setMessage(text, type = '') {
  authMessage.textContent = text;
  authMessage.className = 'message' + (type ? ' ' + type : '');
}

function switchAuthTab(tabName) {
  authTabs.forEach(btn => btn.classList.toggle('active', btn.dataset.authTab === tabName));
  loginForm?.classList.toggle('hidden', tabName !== 'login');
  registerForm?.classList.toggle('hidden', tabName !== 'register');
  setMessage('');
}

function switchMainTab(tabName) {
  mainTabs.forEach(btn => btn.classList.toggle('active', btn.dataset.mainTab === tabName));
  document.getElementById('panel-devis').classList.toggle('active', tabName === 'devis');
  document.getElementById('panel-compta').classList.toggle('active', tabName === 'compta');
  document.getElementById('panel-chantier').classList.toggle('active', tabName === 'chantier');
  document.getElementById('panel-impots').classList.toggle('active', tabName === 'impots');
}

function humanizeAuthError(error) {
  const code = error?.code || '';
  const map = {
    'auth/email-already-in-use': 'Cette adresse mail est déjà utilisée.',
    'auth/invalid-email': 'Adresse mail invalide.',
    'auth/missing-password': 'Merci de saisir un mot de passe.',
    'auth/weak-password': 'Le mot de passe est trop faible.',
    'auth/invalid-credential': 'Adresse mail ou mot de passe incorrect.',
    'auth/user-not-found': 'Adresse mail ou mot de passe incorrect.',
    'auth/wrong-password': 'Adresse mail ou mot de passe incorrect.',
    'auth/too-many-requests': 'Trop de tentatives. Réessaie plus tard.',
    'auth/network-request-failed': 'Erreur réseau. Vérifie ta connexion.',
    'auth/missing-email': 'Merci de saisir une adresse mail.',
    'auth/user-disabled': 'Ce compte a été désactivé.',
    'auth/configuration-not-found': 'La configuration Firebase est incomplète ou le domaine n’est pas autorisé.',
    'auth/popup-closed-by-user': 'La fenêtre Google a été fermée avant la fin de la connexion.',
    'auth/popup-blocked': 'Le navigateur a bloqué la fenêtre Google. Autorise les pop-ups pour ce site.',
    'auth/account-exists-with-different-credential': 'Un compte existe déjà avec une autre méthode de connexion.'
  };
  return map[code] || 'Une erreur est survenue. Vérifie la configuration Firebase.';
}

function isTokenFresh() {
  return !!googleAccessToken && Date.now() < (googleTokenExpiresAt - TOKEN_EXPIRY_SAFETY_MS);
}

function getDriveConnectionKey() {
  const userKey = normalizeEmail(auth?.currentUser?.email || 'anonymous');
  return GOOGLE_WAS_CONNECTED_KEY + '_' + userKey;
}

function markDriveConnected() {
  localStorage.setItem(getDriveConnectionKey(), '1');
}

function clearDriveConnectionFlag() {
  localStorage.removeItem(getDriveConnectionKey());
}

function wasDrivePreviouslyConnected() {
  return localStorage.getItem(getDriveConnectionKey()) === '1';
}

function updateDriveButtons() {
  const connected = isTokenFresh();
  connectDriveBtn.textContent = connected ? 'Google Drive connecté' : 'Connecter Google Drive';
  connectDriveBtn.disabled = connected || !googleDriveReady;
  disconnectDriveBtn.disabled = !connected && !wasDrivePreviouslyConnected();
}


function clearGoogleDriveTokenOnly() {
  googleAccessToken = null;
  googleTokenExpiresAt = 0;
  googleRequestInFlight = null;
  if (window.gapi?.client) gapi.client.setToken(null);
}

async function getGoogleTokenEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });

  if (!res.ok) {
    throw new Error('Impossible de vérifier le compte Google Drive utilisé.');
  }

  const profile = await res.json();
  return normalizeEmail(profile?.email || '');
}

async function validateDriveAccountMatchesFirebase(accessToken) {
  const appEmail = normalizeEmail(auth?.currentUser?.email || '');
  const driveEmail = await getGoogleTokenEmail(accessToken);

  if (!appEmail) {
    throw new Error('Aucun utilisateur BastCompta connecté.');
  }

  if (!driveEmail) {
    throw new Error('Adresse Gmail du compte Drive introuvable.');
  }

  if (driveEmail !== appEmail) {
    try {
      google.accounts.oauth2.revoke(accessToken);
    } catch (error) {
      console.warn('Révocation du token Drive impossible.', error);
    }

    throw new Error(
      'Compte Google Drive refusé. Vous êtes connecté à BastCompta avec ' +
      appEmail +
      ', mais le Drive sélectionné est ' +
      driveEmail +
      '. Utilisez le même compte Google pour la connexion et les sauvegardes.'
    );
  }

  return driveEmail;
}

async function acceptGoogleDriveToken(tokenResponse) {
  if (!tokenResponse?.access_token) {
    throw new Error('Autorisation Google Drive refusée.');
  }

  const accessToken = tokenResponse.access_token;
  await validateDriveAccountMatchesFirebase(accessToken);

  googleAccessToken = accessToken;
  googleTokenExpiresAt = Date.now() + (Number(tokenResponse.expires_in || 3600) * 1000);
  gapi.client.setToken({ access_token: googleAccessToken });
  markDriveConnected();
  updateDriveButtons();
  broadcastDriveConnected();
  return googleAccessToken;
}

async function acceptFirebaseGoogleDriveAccessToken(accessToken) {
  if (!accessToken) {
    throw new Error('Firebase n’a pas renvoyé de jeton Google Drive.');
  }

  return acceptGoogleDriveToken({
    access_token: accessToken,
    expires_in: 3600
  });
}

function grantPortalModuleAccess() {
  try {
    sessionStorage.setItem('bastcompta_portal_access', 'granted');
  } catch (error) {
    console.warn('SessionStorage indisponible pour BastCompta.', error);
  }
}

function revokePortalModuleAccess() {
  try {
    sessionStorage.removeItem('bastcompta_portal_access');
  } catch (error) {
    console.warn('SessionStorage indisponible pour BastCompta.', error);
  }
}

function loadProtectedFrames() {
  [devisFrame, comptaFrame, chantierFrame, impotsFrame].forEach(frame => {
    if (!frame) return;
    const targetSrc = frame.dataset.src || '';
    if (targetSrc && (!frame.getAttribute('src') || frame.getAttribute('src') === 'about:blank')) {
      frame.setAttribute('src', targetSrc);
    }
  });
}

function unloadProtectedFrames() {
  [devisFrame, comptaFrame, chantierFrame, impotsFrame].forEach(frame => {
    if (!frame) return;
    frame.setAttribute('src', 'about:blank');
  });
}

function showPortal(user) {
  grantPortalModuleAccess();
  authScreen.classList.add('hidden');
  portalScreen.classList.remove('hidden');
  currentUserEl.innerHTML = '🟢 Connecté';
  showTrialInfo(user);
  if (sendVerificationBtn) sendVerificationBtn.style.display = 'none';
  updateDriveButtons();

  const openModules = () => {
    loadProtectedFrames();
    if (isTokenFresh()) broadcastDriveConnected();
  };

  if (isTokenFresh()) {
    openModules();
    return;
  }

  // Pendant le clic de connexion Google, on attend que le token Drive récupéré
  // par Firebase soit accepté avant de charger les modules.
  if (googleLoginFlowActive) {
    setMessage('Préparation de Google Drive…', 'warning');
    return;
  }

  // Au rechargement de la page, Firebase peut rester connecté alors que le token
  // Drive, lui, n’est plus présent en mémoire. On tente une reconnexion silencieuse.
  // Si elle échoue, on ne charge pas les iframes pour éviter les alertes Drive
  // dans Devis/Compta/Suivi client.
  if (wasDrivePreviouslyConnected()) {
    maybeRestoreDriveConnection().then(() => {
      if (isTokenFresh()) {
        openModules();
      } else {
        currentUserEl.innerHTML = '🟠 Drive à reconnecter';
        updateDriveButtons();
      }
    });
    return;
  }

  currentUserEl.innerHTML = '🟠 Drive à connecter';
  updateDriveButtons();
}

function showAuth() {
  revokePortalModuleAccess();
  unloadProtectedFrames();
  portalScreen.classList.add('hidden');
  authScreen.classList.remove('hidden');
  loginForm?.reset();
  registerForm?.reset();
}

function getFrameOrigin(frame) {
  try {
    const origin = new URL(frame?.src || '', window.location.href).origin;
    if (!origin || origin === 'null') return window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*';
    return origin;
  } catch {
    return window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*';
  }
}

function postToFrame(frame, message) {
  try {
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(message, getFrameOrigin(frame));
  } catch (error) {
    console.warn('Message module ignoré.', error);
  }
}

function getFrameApi(frame, functionName) {
  try {
    const directApi = frame?.contentWindow?.[functionName];
    if (typeof directApi === 'function') return directApi;

    const moduleApi = frame?.contentWindow?.BastComptaModule?.[functionName];
    return typeof moduleApi === 'function' ? moduleApi : null;
  } catch (error) {
    console.warn('Accès iframe impossible :', error);
    return null;
  }
}

function getFrameModuleSaveApi(frame) {
  try {
    const moduleSave = frame?.contentWindow?.BastComptaModule?.save;
    if (typeof moduleSave === 'function') return moduleSave;

    const legacySave = frame?.contentWindow?.saveData;
    return typeof legacySave === 'function' ? legacySave : null;
  } catch (error) {
    console.warn('Accès sauvegarde iframe impossible :', error);
    return null;
  }
}

function getLoadedModuleFrames() {
  return [
    { key: 'devis-facture', label: 'Devis & Facture', frame: devisFrame },
    { key: 'comptabilite', label: 'Comptabilité', frame: comptaFrame },
    { key: 'suivi-client', label: 'Suivi client', frame: chantierFrame },
    { key: 'impots', label: 'Impôts IPP', frame: impotsFrame }
  ];
}

function waitForFrameLoad(frame, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!frame) return resolve(false);
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (doc && doc.readyState === 'complete' && frame.getAttribute('src') !== 'about:blank') return resolve(true);
    } catch { }

    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      frame.removeEventListener('load', onLoad);
      clearTimeout(timer);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    frame.addEventListener('load', onLoad, { once: true });
  });
}

async function waitForModuleSaveApi(frame, timeoutMs = 12000) {
  await waitForFrameLoad(frame, timeoutMs);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const saveApi = getFrameModuleSaveApi(frame);
    if (saveApi) return saveApi;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return null;
}

async function saveSingleModuleFromPortal(moduleInfo) {
  const { label, frame } = moduleInfo;
  if (!frame) return { label, ok: false, message: 'iframe introuvable' };

  const targetSrc = frame.dataset.src || '';
  if (targetSrc && (!frame.getAttribute('src') || frame.getAttribute('src') === 'about:blank')) {
    frame.setAttribute('src', targetSrc);
  }

  const saveFn = await waitForModuleSaveApi(frame);
  if (!saveFn) return { label, ok: false, message: 'fonction de sauvegarde indisponible' };

  const suppressedAlerts = [];
  let originalAlert = null;
  try {
    if (frame.contentWindow && typeof frame.contentWindow.alert === 'function') {
      originalAlert = frame.contentWindow.alert;
      frame.contentWindow.alert = message => {
        suppressedAlerts.push(String(message || ''));
        console.info('Alerte module interceptée pendant la sauvegarde globale:', label, message);
      };
    }
  } catch (error) {
    console.warn('Impossible d’intercepter les alertes du module :', label, error);
  }

  try {
    const hasModuleApi = typeof frame?.contentWindow?.BastComptaModule?.save === 'function';
    const result = hasModuleApi
      ? await saveFn({ silent: true, source: 'portal' })
      : await saveFn(false);

    if (result === false || result?.ok === false) {
      return {
        label,
        ok: false,
        message: result?.message || suppressedAlerts.join(' | ') || 'échec signalé par le module',
        result,
        suppressedAlerts
      };
    }

    return { label, ok: true, result, suppressedAlerts };
  } catch (error) {
    console.error('Sauvegarde module impossible :', label, error);
    return { label, ok: false, message: error?.message || 'erreur inconnue', suppressedAlerts };
  } finally {
    if (originalAlert) {
      try { frame.contentWindow.alert = originalAlert; } catch { }
    }
  }
}

function formatModuleSaveLine(item) {
  const result = item.result || {};
  if (!item.ok) return `✖ ${item.label} : ERREUR — ${item.message || 'erreur inconnue'}`;

  const details = [];
  if (result.local) details.push('local OK');
  if (typeof result.drive === 'boolean') details.push(result.drive ? 'Drive OK' : 'Drive non utilisé / non connecté');
  if (result.chantierLinked || result.chantierSynced) details.push('suivi/chantiers OK');
  if (typeof result.exportedDocumentsCount === 'number') details.push(`${result.exportedDocumentsCount} document(s) Drive`);
  else if (Array.isArray(result.exportedDocuments)) details.push(`${result.exportedDocuments.length} document(s) Drive`);
  if (Array.isArray(result.warnings) && result.warnings.length) details.push(`avertissement(s): ${result.warnings.join(' ; ')}`);
  if (result.alertsIntercepted) details.push(`${result.alertsIntercepted} message(s) module intercepté(s)`);
  return `✔ ${item.label} : ${details.length ? details.join(', ') : 'OK'}`;
}

async function saveAllModulesFromPortal() {
  const previousLabel = globalSaveBtn?.textContent || 'Sauvegarder';
  if (globalSaveBtn) {
    globalSaveBtn.disabled = true;
    globalSaveBtn.textContent = 'Sauvegarde…';
  }

  showBlockingProgress('Sauvegarde complète', 'Sauvegarde des modules en cours…');

  try {
    const results = [];
    for (const moduleInfo of getLoadedModuleFrames()) {
      backupStatus('Sauvegarde : ' + moduleInfo.label + '…', 'warning');
      results.push(await saveSingleModuleFromPortal(moduleInfo));
    }

    const failed = results.filter(item => !item.ok);
    const lines = results.map(formatModuleSaveLine).join('\n');
    const intercepted = results.flatMap(item => (item.suppressedAlerts || []).filter(Boolean));
    const interceptedText = intercepted.length
      ? '\n\nMessages internes interceptés :\n- ' + intercepted.join('\n- ')
      : '';

    if (failed.length) {
      alert('Sauvegarde partielle : problème détecté.\n\n' + lines + interceptedText);
      return false;
    }

    alert('Sauvegarde complète réussie.\n\n' + lines + interceptedText);
    return true;
  } finally {
    hideBlockingProgress();
    if (globalSaveBtn) {
      globalSaveBtn.disabled = false;
      globalSaveBtn.textContent = previousLabel;
    }
  }
}

async function sendInvoiceToAccounting() {
  const getRows = getFrameApi(devisFrame, 'getInvoiceAccountingRowsForComptabilite');
  const importRows = getFrameApi(comptaFrame, 'importInvoiceSalesRowsFromPortal');

  if (!getRows || !importRows) {
    alert('Les modules Devis/Facture et Comptabilité ne sont pas encore prêts.');
    return;
  }

  const payload = getRows() || {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const action = payload.action || 'upsert';

  if (action !== 'cancel' && !rows.length) {
    alert(payload.message || 'Aucune ligne de facture valide à envoyer en comptabilité.');
    return;
  }

  const invoiceNumber = payload.invoiceNumber || 'sans numéro';
  const docType = payload.documentType === 'credit_note'
    ? 'note de crédit'
    : (action === 'cancel' ? 'annulation de facture' : 'facture');

  let confirmText = '';
  if (action === 'cancel') {
    confirmText = 'Traiter l’annulation de la facture ' + invoiceNumber + ' en comptabilité ?\n\nLes lignes existantes avec ce numéro seront retirées, sauf si la période TVA est clôturée.';
  } else {
    const totalTvac = rows.reduce((sum, row) => sum + (Number(row.tvac) || 0), 0);
    const totalText = totalTvac.toLocaleString('fr-BE', { style: 'currency', currency: 'EUR' });
    confirmText = 'Envoyer la ' + docType + ' ' + invoiceNumber + ' en comptabilité ?\n\n' + rows.length + ' ligne(s) de vente seront créée(s) ou remplacée(s).\nTotal TVAC : ' + totalText;
  }

  if (!confirm(confirmText)) return;

  let result;
  try {
    result = await importRows(payload);
  } catch (error) {
    console.error(error);
    alert('Erreur lors de l’envoi vers la comptabilité.');
    return;
  }

  if (result && result.ok === false) {
    alert(result.message || 'Envoi refusé par la comptabilité.');
    return;
  }

  switchMainTab('compta');

  const openSales = getFrameApi(comptaFrame, 'goToPage');
  if (openSales) openSales('sales');

  setTimeout(() => resizeIframeToContent(comptaFrame), 100);
  alert(result?.message || 'Document envoyé en comptabilité.');
}

window.sendInvoiceToAccounting = sendInvoiceToAccounting;
window.BastComptaPortal = Object.assign(window.BastComptaPortal || {}, { sendInvoiceToAccounting });

async function openInvoicePrintPreviewFromAccounting(invoiceNumber, invoiceFileId = '') {
  switchMainTab('devis');

  await new Promise(resolve => setTimeout(resolve, 150));

  const openPreview = getFrameApi(devisFrame, 'openInvoicePreviewByNumberFromDrive');
  if (!openPreview) {
    alert('Le module Devis & Facture n’est pas encore prêt.');
    return false;
  }

  return await openPreview(invoiceNumber, invoiceFileId);
}

window.openInvoicePrintPreviewFromAccounting = openInvoicePrintPreviewFromAccounting;


const BAST_BACKUP_VERSION = 5;
const LOCAL_DEVIS_KEY = 'devis-facture-style-vrai-document';
const LOCAL_COMPTA_KEY = 'comptabilite-local-v1';
const LOCAL_CHANTIERS_KEY = 'bastcompta-chantiers-v1';
const LOCAL_IMPOTS_KEY = 'bastcompta-impots-belgique-v1';

function backupStatus(text, type = '') {
  setMessage(text || '', type);
  if (backupOverlayText && backupOverlay?.classList.contains('active') && text) {
    backupOverlayText.textContent = text;
  }
}

function showBlockingProgress(title, text) {
  if (backupOverlayTitle) backupOverlayTitle.textContent = title || 'Traitement en cours';
  if (backupOverlayText) backupOverlayText.textContent = text || 'Veuillez patienter…';
  if (backupOverlay) backupOverlay.classList.add('active');
}

function hideBlockingProgress() {
  if (backupOverlay) backupOverlay.classList.remove('active');
}

function safeJsonParse(raw, fallback = null) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function sanitizePathPart(value, fallback = 'Sans nom') {
  return String(value || fallback)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|#%{}~&]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || fallback;
}


function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const HIDDEN_DRIVE_CATEGORIES = [
  { key: 'all', label: 'Tous' },
  { key: 'devis', label: 'Devis' },
  { key: 'factures', label: 'Factures' },
  { key: 'rappels', label: 'Rappels' },
  { key: 'comptabilite', label: 'Comptabilité' },
  { key: 'clients', label: 'Clients / chantiers' },
  { key: 'impots', label: 'Impôts' },
  { key: 'sauvegardes', label: 'Sauvegardes' },
  { key: 'autres', label: 'Autres' }
];

function detectHiddenDriveCategory(file = {}) {
  const name = normalizeSearchText(file.name || '');
  const mime = normalizeSearchText(file.mimeType || '');

  if (name.endsWith(' zip') || name.includes(' sauvegarde ') || name.includes(' backup ') || mime.includes(' zip')) return 'sauvegardes';
  if (name.startsWith('devis ') || name.includes(' devis ') || name.includes(' quote ')) return 'devis';
  if (name.startsWith('facture ') || name.includes(' facture ') || name.includes(' invoice ')) return 'factures';
  if (name.startsWith('rappel ') || name.includes(' rappel ') || name.includes(' reminder ')) return 'rappels';
  if (name.includes('comptabilite') || name.includes(' compta ') || name.includes(' achat ') || name.includes(' achats ') || name.includes(' vente ') || name.includes(' ventes ') || name.includes(' frais ')) return 'comptabilite';
  if (name.includes('suivi client') || name.includes('suivi-client') || name.includes(' chantier ') || name.includes(' chantiers ') || name.includes(' client ') || name.includes(' crm ')) return 'clients';
  if (name.includes('impot') || name.includes('impots') || name.includes(' ipp ') || name.includes(' fiscal ') || name.includes(' taxe ') || name.includes(' taxes ')) return 'impots';
  return 'autres';
}

function getHiddenDriveCategoryLabel(categoryKey) {
  return HIDDEN_DRIVE_CATEGORIES.find(category => category.key === categoryKey)?.label || 'Autres';
}

function hiddenDriveCategoryCounts(files = []) {
  const counts = Object.fromEntries(HIDDEN_DRIVE_CATEGORIES.map(category => [category.key, 0]));
  counts.all = files.length;
  files.forEach(file => {
    const category = detectHiddenDriveCategory(file);
    counts[category] = (counts[category] || 0) + 1;
  });
  return counts;
}

function updateHiddenDriveTabs(files = []) {
  if (!hiddenDriveTabs) return;
  const counts = hiddenDriveCategoryCounts(files);
  hiddenDriveTabs.querySelectorAll('[data-drive-category]').forEach(button => {
    const category = button.dataset.driveCategory || 'all';
    button.classList.toggle('active', category === hiddenDriveActiveCategory);
    const label = getHiddenDriveCategoryLabel(category);
    const count = counts[category] || 0;
    button.innerHTML = '<span>' + escapeHtml(label) + '</span><strong>' + count + '</strong>';
  });
}

function filteredHiddenDriveFiles() {
  if (hiddenDriveActiveCategory === 'all') return hiddenDriveFilesCache;
  return hiddenDriveFilesCache.filter(file => detectHiddenDriveCategory(file) === hiddenDriveActiveCategory);
}

function renderHiddenDriveList() {
  if (!hiddenDriveStatus || !hiddenDriveList) return;
  updateHiddenDriveTabs(hiddenDriveFilesCache);

  const files = filteredHiddenDriveFiles();
  const categoryLabel = getHiddenDriveCategoryLabel(hiddenDriveActiveCategory);

  if (!hiddenDriveFilesCache.length) {
    hiddenDriveStatus.textContent = 'Aucun fichier caché trouvé dans appDataFolder.';
    hiddenDriveList.innerHTML = '';
    return;
  }

  if (!files.length) {
    hiddenDriveStatus.textContent = 'Aucun fichier dans l’onglet « ' + categoryLabel + ' ». Total Drive caché : ' + hiddenDriveFilesCache.length + ' fichier(s).';
    hiddenDriveList.innerHTML = '<div class="hidden-drive-empty">Aucun fichier dans cette catégorie.</div>';
    return;
  }

  hiddenDriveStatus.textContent = files.length + ' fichier(s) affiché(s) dans « ' + categoryLabel + ' » · Total Drive caché : ' + hiddenDriveFilesCache.length + '.';
  hiddenDriveList.innerHTML = files.map(file => {
    const name = escapeHtml(file.name || 'Sans nom');
    const category = detectHiddenDriveCategory(file);
    const categoryLabel = escapeHtml(getHiddenDriveCategoryLabel(category));
    const meta = [
      file.mimeType || '',
      file.size ? (Math.round(Number(file.size) / 1024) + ' Ko') : '',
      file.modifiedTime ? ('modifié le ' + new Date(file.modifiedTime).toLocaleString('fr-BE')) : ''
    ].filter(Boolean).map(escapeHtml).join(' · ');

    return '<div class="hidden-drive-item" data-drive-file-category="' + category + '">'
      + '<div><div class="hidden-drive-name">' + name + '</div><div class="hidden-drive-meta"><span class="hidden-drive-category-badge">' + categoryLabel + '</span>' + (meta ? '<span>' + meta + '</span>' : '') + '</div></div>'
      + '<div class="hidden-drive-actions">'
      + (isLikelyPreviewableDriveDocument(file) ? '<button class="small primary" type="button" data-preview-drive-file="' + escapeHtml(file.id) + '">Aperçu PDF</button>' : '')
      + '<button class="small" type="button" data-download-drive-file="' + escapeHtml(file.id) + '">Télécharger</button>'
      + '<button class="small danger" type="button" data-delete-drive-file="' + escapeHtml(file.id) + '" data-drive-file-name="' + name + '">Supprimer</button>'
      + '</div>'
      + '</div>';
  }).join('');

  bindHiddenDriveFileButtons();
}

function bindHiddenDriveFileButtons() {
  if (!hiddenDriveList) return;

  hiddenDriveList.querySelectorAll('[data-preview-drive-file]').forEach(button => {
    button.addEventListener('click', async () => {
      const file = hiddenDriveFilesCache.find(item => item.id === button.dataset.previewDriveFile);
      if (!file) return;
      await previewHiddenDriveDocumentPdf(file, button);
    });
  });

  hiddenDriveList.querySelectorAll('[data-download-drive-file]').forEach(button => {
    button.addEventListener('click', async () => {
      const file = hiddenDriveFilesCache.find(item => item.id === button.dataset.downloadDriveFile);
      if (!file) return;
      try {
        button.disabled = true;
        button.textContent = 'Téléchargement…';
        const blob = await downloadDriveFileBlob(file);
        downloadBlob(blob, file.name || 'fichier-drive-cache');
      } catch (error) {
        console.error(error);
        alert('Impossible de télécharger ce fichier Drive caché.');
      } finally {
        button.disabled = false;
        button.textContent = 'Télécharger';
      }
    });
  });

  hiddenDriveList.querySelectorAll('[data-delete-drive-file]').forEach(button => {
    button.addEventListener('click', async () => {
      const file = hiddenDriveFilesCache.find(item => item.id === button.dataset.deleteDriveFile);
      if (!file) return;
      const label = file.name || 'ce fichier';
      const confirmed = confirm('Supprimer définitivement du Drive caché : "' + label + '" ?\n\nCette action ne peut pas être annulée. Pense à télécharger une sauvegarde avant de supprimer.');
      if (!confirmed) return;

      try {
        button.disabled = true;
        button.textContent = 'Suppression…';
        await deleteHiddenDriveFile(file);
        hiddenDriveStatus.textContent = 'Fichier supprimé : ' + label;
        await refreshHiddenDriveList();
      } catch (error) {
        console.error(error);
        alert('Impossible de supprimer ce fichier Drive caché. Vérifie la connexion Google Drive puis réessaie.');
      } finally {
        button.disabled = false;
        button.textContent = 'Supprimer';
      }
    });
  });
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameIdentityKey(value) {
  const tokens = normalizeSearchText(value).split(' ').filter(Boolean);
  if (!tokens.length) return '';
  return 'name:' + tokens.sort().join('|');
}

function clientKeys(client = {}) {
  const keys = [];
  const number = normalizeSearchText(client.clientNumber || client.number || '');
  const email = normalizeSearchText(client.email || client.clientEmail || '');
  const vat = normalizeSearchText(client.vat || client.clientVat || '');
  const name = nameIdentityKey(client.name || client.clientName || client.client || '');
  if (number) keys.push('number:' + number);
  if (email) keys.push('email:' + email);
  if (vat) keys.push('vat:' + vat);
  if (name) keys.push(name);
  return keys;
}

function buildClientRegistry(...clientLists) {
  const byKey = new Map();
  const clients = [];
  const remember = (client = {}) => {
    const name = String(client.name || client.clientName || '').trim();
    const keys = clientKeys(client);
    if (!name || !keys.length) return null;

    let existing = null;
    for (const key of keys) {
      if (byKey.has(key)) {
        existing = byKey.get(key);
        break;
      }
    }

    if (!existing) {
      existing = {
        ...client,
        name,
        canonicalName: name,
        id: client.id || '',
        email: client.email || client.clientEmail || '',
        clientNumber: client.clientNumber || '',
        vat: client.vat || client.clientVat || '',
        address: client.address || ''
      };
      clients.push(existing);
    } else {
      existing.email = existing.email || client.email || client.clientEmail || '';
      existing.clientNumber = existing.clientNumber || client.clientNumber || '';
      existing.vat = existing.vat || client.vat || client.clientVat || '';
      existing.address = existing.address || client.address || '';
      existing.id = existing.id || client.id || '';
    }

    for (const key of keys) byKey.set(key, existing);
    return existing;
  };

  clientLists.flat().filter(Boolean).forEach(remember);
  return { byKey, clients, remember };
}

function resolveClientForDocument(doc = {}, registry) {
  const candidates = [
    { id: doc.clientId || '', name: doc.clientName || '', email: doc.clientEmail || '', clientNumber: doc.clientNumber || '', vat: doc.clientVat || '', address: doc.address || '' },
    { name: doc.clientName || doc.client || '', email: doc.clientEmail || '', clientNumber: doc.clientNumber || '', vat: doc.clientVat || '' }
  ];

  for (const candidate of candidates) {
    for (const key of clientKeys(candidate)) {
      if (registry?.byKey?.has(key)) return registry.byKey.get(key);
    }
  }

  const fallbackName = String(doc.clientName || doc.client || '').trim();
  if (fallbackName && registry) return registry.remember({ name: fallbackName, email: doc.clientEmail || '', clientNumber: doc.clientNumber || '', vat: doc.clientVat || '', address: doc.address || '' });
  return null;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getLocalBackupData() {
  return {
    devisFacture: safeJsonParse(localStorage.getItem(LOCAL_DEVIS_KEY), {}),
    comptabilite: safeJsonParse(localStorage.getItem(LOCAL_COMPTA_KEY), {}),
    chantiers: safeJsonParse(localStorage.getItem(LOCAL_CHANTIERS_KEY), { version: 1, projects: [] }),
    impots: safeJsonParse(localStorage.getItem(LOCAL_IMPOTS_KEY), {})
  };
}

function detectDocumentInfo(fileName, parsed, registry) {
  const lower = String(fileName || '').toLowerCase();
  let docKey = '', folder = 'Autres', label = 'document';
  if (lower.startsWith('devis-')) { docKey = 'quote'; folder = 'Devis'; label = 'devis'; }
  else if (lower.startsWith('facture-')) { docKey = 'invoice'; folder = 'Factures'; label = 'facture'; }
  else if (lower.startsWith('rappel-')) { docKey = 'reminder'; folder = 'Rappels'; label = 'rappel'; }
  else if (lower.startsWith('comptabilite-') || lower.includes('comptabilite')) { folder = 'Comptabilite/Donnees'; label = 'comptabilite'; }
  else if (lower.includes('suivi-client') || lower.includes('suivi client') || lower.includes('chantier') || lower.includes('chantiers')) { folder = 'Suivi-client/Donnees'; label = 'suivi-client'; }

  const doc = docKey && parsed ? (parsed[docKey] || {}) : {};
  if (docKey && doc.clientId && Array.isArray(parsed?.clients)) {
    const found = parsed.clients.find(client => String(client.id || '') === String(doc.clientId || ''));
    if (found && registry) registry.remember(found);
  }

  const resolvedClient = docKey ? resolveClientForDocument(doc, registry) : null;
  const clientName = sanitizePathPart(resolvedClient?.canonicalName || resolvedClient?.name || doc.clientName || 'Sans client');
  const rawNumber = doc.documentNumber || String(fileName || '').replace(/\.json$/i, '');
  return { docKey, folder, label, clientName, documentNumber: sanitizePathPart(rawNumber, 'sans-numero'), doc, resolvedClient };
}

function euro(value) {
  return Number(value || 0).toLocaleString('fr-BE', { style: 'currency', currency: 'EUR' });
}

function makeComptaReportPdfBlob(comptaData) {
  if (!window.jspdf?.jsPDF) return null;
  const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const d = comptaData || {};
  const sum = (arr, key) => (Array.isArray(arr) ? arr : []).reduce((s, row) => s + Number(row?.[key] || 0), 0);
  const salesHt = sum(d.sales, 'htva'), purchasesHt = sum(d.purchases, 'htva');
  const vatSales = sum(d.sales, 'vat'), vatPurchases = sum(d.purchases, 'vat');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(18); pdf.text('Rapport comptable BastCompta', 14, 18);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.text('Période : ' + String(d.company?.period || new Date().getFullYear()), 14, 28);
  let y = 42;
  [['Ventes HTVA', salesHt], ['Achats HTVA', purchasesHt], ['TVA ventes', vatSales], ['TVA achats', vatPurchases], ['TVA nette', vatSales - vatPurchases], ['Résultat estimé', salesHt - purchasesHt]].forEach(([label, value]) => {
    pdf.setFont('helvetica', 'bold'); pdf.text(label, 14, y);
    pdf.setFont('helvetica', 'normal'); pdf.text(euro(value), 80, y);
    y += 8;
  });
  return pdf.output('blob');
}

async function waitForFrameReady(frame, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (frame?.contentWindow && frame.contentDocument?.readyState === 'complete') return true;
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return false;
}

async function makeRenderedDocumentPdfBlob(parsed, docKey) {
  if (!window.html2canvas || !window.jspdf?.jsPDF) return null;

  // Important : html2canvas ne capture pas correctement une iframe cachée.
  // Comme la sauvegarde se lance depuis l’onglet Sauvegarde, on affiche temporairement
  // l’onglet Devis & Facture avant de capturer le document PDF.
  const previousTab = document.querySelector(".main-tab.active")?.dataset.mainTab || "backup";
  if (previousTab !== "devis") {
    switchMainTab("devis");
    await new Promise(resolve => setTimeout(resolve, 450));
  }

  await waitForFrameReady(devisFrame);
  const prepare = getFrameApi(devisFrame, "prepareBastComptaDocumentForBackupPdf");
  const restore = getFrameApi(devisFrame, "restoreBastComptaAfterBackupPdf");
  if (!prepare) {
    if (previousTab !== "devis") switchMainTab(previousTab);
    return null;
  }

  try {
    await prepare(parsed, docKey);
    await new Promise(resolve => setTimeout(resolve, 350));

    const doc = devisFrame.contentDocument;
    const body = doc?.body;
    if (body) body.classList.add("backup-pdf-capture");

    const page = doc?.querySelector(".page[data-page=\"" + docKey + "\"].active") || doc?.querySelector(".page.active");
    const sheet = page?.querySelector(".sheet");
    if (!sheet) return null;

    sheet.scrollIntoView({ block: "start", inline: "nearest" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const canvas = await window.html2canvas(sheet, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: Math.max(sheet.scrollWidth, 1100),
      windowHeight: Math.max(sheet.scrollHeight, 1500)
    });

    const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = canvas.height * imgWidth / canvas.width;

    if (imgHeight <= pageHeight - margin * 2) {
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.96), 'JPEG', margin, margin, imgWidth, imgHeight);
    } else {
      const pageCanvas = document.createElement('canvas');
      const ctx = pageCanvas.getContext('2d');
      const sliceHeight = Math.floor((pageHeight - margin * 2) * canvas.width / imgWidth);
      pageCanvas.width = canvas.width;
      pageCanvas.height = sliceHeight;
      let y = 0;
      let pageIndex = 0;
      while (y < canvas.height) {
        const currentSliceHeight = Math.min(sliceHeight, canvas.height - y);
        pageCanvas.height = currentSliceHeight;
        ctx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(canvas, 0, y, canvas.width, currentSliceHeight, 0, 0, canvas.width, currentSliceHeight);
        if (pageIndex > 0) pdf.addPage();
        const h = currentSliceHeight * imgWidth / canvas.width;
        pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.96), 'JPEG', margin, margin, imgWidth, h);
        y += currentSliceHeight;
        pageIndex += 1;
      }
    }

    return pdf.output('blob');
  } finally {
    try {
      const doc = devisFrame.contentDocument;
      doc?.body?.classList.remove("backup-pdf-capture");
      if (restore) await restore();
    } catch (error) {
      console.warn("Restauration après capture PDF impossible.", error);
    }
    if (previousTab !== "devis") switchMainTab(previousTab);
  }
}

function isRenderableBusinessDocument(file, parsed = null) {
  const name = String(file?.name || '').toLowerCase();
  if (!name.endsWith('.json')) return false;
  if (name.startsWith('devis-') || name.startsWith('facture-') || name.startsWith('rappel-')) return true;
  return !!(parsed?.quote || parsed?.invoice || parsed?.reminder);
}

async function makePdfForDriveJsonFile(file, parsed) {
  const name = String(file?.name || '').toLowerCase();
  if (name.startsWith('devis-') || parsed?.quote) return makeRenderedDocumentPdfBlob(parsed, 'quote');
  if (name.startsWith('facture-') || parsed?.invoice) return makeRenderedDocumentPdfBlob(parsed, 'invoice');
  if (name.startsWith('rappel-') || parsed?.reminder) return makeRenderedDocumentPdfBlob(parsed, 'reminder');
  if (name.includes('comptabilite')) return makeComptaReportPdfBlob(parsed);
  return null;
}

async function ensureBackupLibraries() {
  if (!window.JSZip || !window.jspdf?.jsPDF || !window.html2canvas) {
    throw new Error('Bibliothèques de sauvegarde incomplètes. Vérifie JSZip, jsPDF et html2canvas dans index.html.');
  }
}

async function driveRequest(path, options = {}) {
  const token = await ensureGoogleAccessToken(false);
  const res = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error('Drive API error ' + res.status);
  return res;
}

async function listDriveAppDataFiles() {
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)',
      pageSize: '100',
      orderBy: 'modifiedTime desc'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveRequest('files?' + params.toString());
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function downloadDriveFileBlob(file) {
  const token = await ensureGoogleAccessToken(false);
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Téléchargement Drive impossible: ' + res.status);
  return await res.blob();
}

async function readDriveJsonFile(file) {
  const blob = await downloadDriveFileBlob(file);
  const text = await blob.text();
  return JSON.parse(text);
}

async function deleteHiddenDriveFile(file) {
  const token = await ensureGoogleAccessToken(false);
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok && res.status !== 204) throw new Error('Suppression Drive impossible: ' + res.status);
  return true;
}

function isLikelyPreviewableDriveDocument(file) {
  const name = String(file?.name || '').toLowerCase();
  return name.endsWith('.json') && (name.startsWith('devis-') || name.startsWith('facture-') || name.startsWith('rappel-') || name.includes('comptabilite'));
}

async function previewHiddenDriveDocumentPdf(file, button = null) {
  const previousText = button?.textContent;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = 'Aperçu…';
    }

    const parsed = await readDriveJsonFile(file);
    const pdfBlob = await makePdfForDriveJsonFile(file, parsed);
    if (!pdfBlob) {
      alert('Aperçu PDF indisponible pour ce fichier.');
      return;
    }

    const url = URL.createObjectURL(pdfBlob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    alert('Impossible de générer l’aperçu PDF depuis ce fichier Drive caché.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText || 'Aperçu PDF';
    }
  }
}

async function openHiddenDriveModal() {
  settingsMenu?.classList.remove('open');
  hiddenDriveModal?.classList.add('open');
  hiddenDriveModal?.setAttribute('aria-hidden', 'false');
  await refreshHiddenDriveList();
}

function closeHiddenDriveModal() {
  hiddenDriveModal?.classList.remove('open');
  hiddenDriveModal?.setAttribute('aria-hidden', 'true');
}

async function refreshHiddenDriveList() {
  if (!hiddenDriveStatus || !hiddenDriveList) return;
  hiddenDriveStatus.textContent = 'Chargement des fichiers Drive cachés…';
  hiddenDriveList.innerHTML = '';

  try {
    await ensureGoogleAccessToken(false);
    hiddenDriveFilesCache = await listDriveAppDataFiles();
    renderHiddenDriveList();
  } catch (error) {
    console.error(error);
    hiddenDriveStatus.textContent = 'Impossible de charger les fichiers cachés Drive. Connecte Google Drive puis réessaie.';
  }
}

function backupZipPathForDriveFile(file, parsed = null, registry = null) {
  const name = sanitizePathPart(file.name || 'fichier-drive');
  const lower = name.toLowerCase();
  if (lower.endsWith('.json') && parsed) {
    const info = detectDocumentInfo(name, parsed, registry);
    if (info.docKey) return 'Clients/' + info.clientName + '/' + info.folder + '/' + name;
    if (info.label === 'comptabilite') return 'Comptabilite/Donnees/' + name;
    if (info.label === 'suivi-client' || info.label === 'chantier') return 'Suivi-client/Donnees/' + name;
  }
  if (lower.endsWith('.pdf')) {
    if (lower.includes('achat') || lower.includes('fournisseur')) return 'Comptabilite/Achats-PDF/' + name;
    if (lower.startsWith('devis-')) return 'Clients/Sans client/Devis/' + name;
    if (lower.startsWith('facture-')) return 'Clients/Sans client/Factures/' + name;
    if (lower.startsWith('rappel-')) return 'Clients/Sans client/Rappels/' + name;
  }
  return 'Google-Drive-AppData/' + name;
}

async function addApplicationSourceFiles(zip) {
  for (const fileName of ['index.html', 'devis-facture.html', 'comptabilite.html', 'suivi-client.html']) {
    try {
      const res = await fetch(fileName, { cache: 'no-store' });
      if (res.ok) zip.file('Application/' + fileName, await res.text());
    } catch (error) {
      console.warn('Impossible d’ajouter le fichier application :', fileName, error);
    }
  }
}

async function createFullBackupZip() {
  await ensureBackupLibraries();
  await waitForFrameReady(devisFrame);
  await waitForFrameReady(comptaFrame);
  await waitForFrameReady(chantierFrame);
  await waitForFrameReady(impotsFrame);

  const zip = new JSZip();
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const localData = getLocalBackupData();
  const localDevis = localData.devisFacture || {};
  const localCompta = localData.comptabilite || {};
  const localChantiers = localData.chantiers || { version: 1, projects: [] };
  const localImpots = localData.impots || {};
  const registry = buildClientRegistry(Array.isArray(localDevis.clients) ? localDevis.clients : []);
  const driveFilesManifest = [];

  const manifest = {
    app: 'BastCompta',
    version: BAST_BACKUP_VERSION,
    createdAt: now.toISOString(),
    backupType: 'complete-local-drive-pdf-crm-suivi-client-faithful',
    modules: ['devis-facture', 'comptabilite', 'suivi-client', 'impots'],
    restore: { localStorage: true, googleDrive: true, pdfFiles: true, clients: true, crm: true, mode: 'complete-reconstruction' },
    restoreHints: { localStorage: { devisFacture: LOCAL_DEVIS_KEY, comptabilite: LOCAL_COMPTA_KEY, suiviClient: LOCAL_CHANTIERS_KEY, chantiers: LOCAL_CHANTIERS_KEY, impots: LOCAL_IMPOTS_KEY }, driveSpace: 'appDataFolder', conflictPolicy: 'replace-existing-by-name-after-confirmation' },
    crm: { clients: [], count: 0, exports: [] },
    clients: [],
    files: []
  };

  const addFile = (path, category, meta = {}) => manifest.files.push({ path, category, ...meta });
  const addClientDoc = (info, type, jsonPath = '', pdfPath = '', source = 'local') => {
    const clientName = sanitizePathPart(info?.clientName || 'Sans client');
    let client = manifest.clients.find(item => item.name === clientName);
    if (!client) { client = { name: clientName, documents: [] }; manifest.clients.push(client); }
    client.documents.push({ type, documentNumber: info?.documentNumber || '', json: jsonPath, pdf: pdfPath, source });
  };

  backupStatus('Préparation de la sauvegarde complète fidèle…', 'warning');
  zip.file('01-donnees-locales/devis-facture-local.json', JSON.stringify(localDevis, null, 2));
  zip.file('01-donnees-locales/comptabilite-local.json', JSON.stringify(localCompta, null, 2));
  zip.file('01-donnees-locales/suivi-client-local.json', JSON.stringify(localChantiers, null, 2));
  zip.file('01-donnees-locales/impots-ipp-local.json', JSON.stringify(localImpots, null, 2));
  addFile('01-donnees-locales/devis-facture-local.json', 'localStorage', { module: 'devis-facture' });
  addFile('01-donnees-locales/comptabilite-local.json', 'localStorage', { module: 'comptabilite' });
  addFile('01-donnees-locales/suivi-client-local.json', 'localStorage', { module: 'suivi-client' });
  addFile('01-donnees-locales/impots-ipp-local.json', 'localStorage', { module: 'impots' });

  const crmClients = registry.clients;
  manifest.crm.clients = crmClients.map(client => ({ id: client.id || '', name: client.canonicalName || client.name || '', email: client.email || '', phone: client.phone || '', vat: client.vat || client.clientVat || '', address: client.address || '', clientNumber: client.clientNumber || '' }));
  manifest.crm.count = crmClients.length;

  const crmJsonPath = 'CRM/clients-complet.json';
  zip.file(crmJsonPath, JSON.stringify(manifest.crm.clients, null, 2));
  addFile(crmJsonPath, 'crm-json', { module: 'devis-facture', clientCount: crmClients.length });
  manifest.crm.exports.push(crmJsonPath);

  const crmCsvPath = 'CRM/clients.csv';
  const csvRows = [['Nom', 'Email', 'Téléphone', 'TVA', 'N° client', 'Adresse']].concat(manifest.crm.clients.map(c => [c.name, c.email, c.phone, c.vat, c.clientNumber, c.address]));
  zip.file(crmCsvPath, csvRows.map(row => row.map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(';')).join('\n'));
  addFile(crmCsvPath, 'crm-csv', { module: 'devis-facture', clientCount: crmClients.length });
  manifest.crm.exports.push(crmCsvPath);

  for (const client of crmClients) {
    const clientName = sanitizePathPart(client.canonicalName || client.name || 'Sans client');
    const ficheJsonPath = 'Clients/' + clientName + '/00-CRM/fiche-client.json';
    const ficheTxtPath = 'Clients/' + clientName + '/00-CRM/fiche-client.txt';
    zip.file(ficheJsonPath, JSON.stringify(client, null, 2));
    zip.file(ficheTxtPath, ['Client : ' + (client.canonicalName || client.name || ''), 'N° client : ' + (client.clientNumber || ''), 'Email : ' + (client.email || ''), 'Téléphone : ' + (client.phone || ''), 'TVA : ' + (client.vat || client.clientVat || ''), 'Adresse : ' + (client.address || ''), 'Notes : ' + (client.notes || '')].join('\n'));
    addFile(ficheJsonPath, 'crm-client-json', { module: 'devis-facture', client: clientName });
    addFile(ficheTxtPath, 'crm-client-fiche', { module: 'devis-facture', client: clientName });
    let manifestClient = manifest.clients.find(item => item.name === clientName);
    if (!manifestClient) { manifestClient = { name: clientName, crm: ficheJsonPath, documents: [] }; manifest.clients.push(manifestClient); }
  }

  const docCollections = [
    { key: 'quotes', type: 'devis', docKey: 'quote', folder: 'Devis' },
    { key: 'invoices', type: 'facture', docKey: 'invoice', folder: 'Factures' },
    { key: 'reminders', type: 'rappel', docKey: 'reminder', folder: 'Rappels' }
  ];

  for (const collection of docCollections) {
    const list = Array.isArray(localDevis[collection.key]) ? localDevis[collection.key] : [];
    for (const doc of list) {
      const resolvedClient = resolveClientForDocument(doc, registry);
      const clientName = sanitizePathPart(resolvedClient?.canonicalName || resolvedClient?.name || doc.clientName || 'Sans client');
      const number = sanitizePathPart(doc.documentNumber || doc.id || collection.type, 'sans-numero');
      const path = 'Clients/' + clientName + '/' + collection.folder + '/' + collection.type + '-' + number + '.json';
      const wrapped = { [collection.docKey]: doc, clients: localDevis.clients || [] };
      zip.file(path, JSON.stringify(wrapped, null, 2));
      addFile(path, collection.type + '-json', { module: 'devis-facture', client: clientName, documentNumber: number });

      let pdfPath = '';
      const pdfBlob = await makeRenderedDocumentPdfBlob(wrapped, collection.docKey);
      if (pdfBlob) {
        pdfPath = 'Clients/' + clientName + '/' + collection.folder + '/' + collection.type + '-' + number + '.pdf';
        zip.file(pdfPath, pdfBlob);
        addFile(pdfPath, collection.type + '-pdf', { module: 'devis-facture', client: clientName, documentNumber: number });
      }

      addClientDoc({ clientName, documentNumber: number }, collection.type, path, pdfPath, 'localStorage');
    }
  }

  const comptaPdf = makeComptaReportPdfBlob(localCompta);
  if (comptaPdf) {
    zip.file('Comptabilite/Rapport-comptable.pdf', comptaPdf);
    addFile('Comptabilite/Rapport-comptable.pdf', 'compta-pdf', { module: 'comptabilite' });
  }

  if (isTokenFresh() || wasDrivePreviouslyConnected()) {
    try {
      backupStatus('Ajout des fichiers Google Drive cachés…', 'warning');
      await ensureGoogleAccessToken(false);
      const driveFiles = await listDriveAppDataFiles();
      for (const file of driveFiles) {
        let parsed = null;
        let blob = null;
        try {
          blob = await downloadDriveFileBlob(file);
          if (String(file.name || '').toLowerCase().endsWith('.json')) parsed = JSON.parse(await blob.text());
          if (!blob) blob = await downloadDriveFileBlob(file);
        } catch (error) {
          console.warn('Fichier Drive ignoré :', file.name, error);
          continue;
        }

        const zipPath = backupZipPathForDriveFile(file, parsed, registry);
        zip.file(zipPath, blob);
        addFile(zipPath, 'googleDriveAppData', { module: 'drive', name: file.name, id: file.id });
        driveFilesManifest.push({ id: file.id, name: file.name, path: zipPath, mimeType: file.mimeType, modifiedTime: file.modifiedTime });

        if (parsed && isRenderableBusinessDocument(file, parsed)) {
          const info = detectDocumentInfo(file.name, parsed, registry);
          const pdfBlob = await makePdfForDriveJsonFile(file, parsed);
          if (pdfBlob) {
            const pdfPath = zipPath.replace(/\.json$/i, '.pdf').replace('/Donnees/', '/PDF/');
            zip.file(pdfPath, pdfBlob);
            addFile(pdfPath, 'pdf-fidele-drive', { module: 'drive', name: file.name, client: info.clientName, documentNumber: info.documentNumber });
            addClientDoc(info, info.label, zipPath, pdfPath, 'googleDriveAppData');
          } else if (info.docKey) {
            addClientDoc(info, info.label, zipPath, '', 'googleDriveAppData');
          }
        }
      }
    } catch (error) {
      console.warn('Sauvegarde Drive ignorée :', error);
      manifest.driveWarning = error?.message || 'Drive indisponible';
    }
  }

  manifest.driveFiles = driveFilesManifest;
  manifest.clients.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  manifest.files.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
  zip.file('manifest-bastcompta.json', JSON.stringify(manifest, null, 2));

  await addApplicationSourceFiles(zip);

  backupStatus('Création du fichier ZIP…', 'warning');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, 'Sauvegarde-BastCompta-complete-' + stamp + '.zip');
  return true;
}

async function handleFullBackupClick() {
  showBlockingProgress('Sauvegarde complète', 'Préparation des données…');
  try {
    await saveAllModulesFromPortal();
    await createFullBackupZip();
    backupStatus('Sauvegarde ZIP complète créée.', 'success');
  } catch (error) {
    console.error(error);
    alert('Impossible de créer la sauvegarde complète : ' + (error?.message || 'erreur inconnue'));
    backupStatus('Erreur sauvegarde complète.', 'error');
  } finally {
    hideBlockingProgress();
  }
}

function handleFullRestoreClick() {
  settingsMenu?.classList.remove('open');
  fullRestoreInput?.click();
}

async function handleFullRestoreFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  const confirmed = confirm('Restaurer cette sauvegarde complète ?\n\nLes données locales actuelles seront remplacées. Si la sauvegarde contient des fichiers Drive, ils pourront être renvoyés vers le Drive caché après confirmation.');
  if (!confirmed) return;

  showBlockingProgress('Restauration complète', 'Lecture du fichier ZIP…');
  try {
    await ensureBackupLibraries();
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file('manifest-bastcompta.json');
    const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : null;

    const readJsonFromZip = async (path, fallback) => {
      const item = zip.file(path);
      if (!item) return fallback;
      return JSON.parse(await item.async('string'));
    };

    const devisData = await readJsonFromZip('01-donnees-locales/devis-facture-local.json', null);
    const comptaData = await readJsonFromZip('01-donnees-locales/comptabilite-local.json', null);
    const suiviData = await readJsonFromZip('01-donnees-locales/suivi-client-local.json', null);
    const impotsData = await readJsonFromZip('01-donnees-locales/impots-ipp-local.json', null);

    if (devisData) localStorage.setItem(LOCAL_DEVIS_KEY, JSON.stringify(devisData));
    if (comptaData) localStorage.setItem(LOCAL_COMPTA_KEY, JSON.stringify(comptaData));
    if (suiviData) localStorage.setItem(LOCAL_CHANTIERS_KEY, JSON.stringify(suiviData));
    if (impotsData) localStorage.setItem(LOCAL_IMPOTS_KEY, JSON.stringify(impotsData));

    const driveFiles = [];
    if (manifest?.files) {
      for (const entry of manifest.files) {
        if (entry.category === 'googleDriveAppData' && entry.path && zip.file(entry.path)) driveFiles.push(entry);
      }
    }

    if (driveFiles.length && confirm(driveFiles.length + ' fichier(s) Drive caché(s) sont présents dans la sauvegarde. Les renvoyer vers Google Drive appDataFolder ?')) {
      await ensureGoogleAccessToken(false);
      for (const entry of driveFiles) {
        const zipItem = zip.file(entry.path);
        const blob = await zipItem.async('blob');
        await uploadBlobToDriveAppData(blob, entry.name || entry.path.split('/').pop(), 'application/json');
      }
    }

    alert('Restauration terminée. La page va être rechargée.');
    location.reload();
  } catch (error) {
    console.error(error);
    alert('Impossible de restaurer la sauvegarde : ' + (error?.message || 'erreur inconnue'));
  } finally {
    hideBlockingProgress();
  }
}

async function uploadBlobToDriveAppData(blob, name, mimeType = 'application/json') {
  const token = await ensureGoogleAccessToken(false);
  const metadata = { name, parents: ['appDataFolder'] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob, name);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form
  });
  if (!res.ok) throw new Error('Upload Drive impossible: ' + res.status);
  return await res.json();
}

async function waitForGoogleApi(timeoutMs = 10000) {
  const startedAt = Date.now();
  while ((!window.gapi || !window.google?.accounts?.oauth2) && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!window.gapi || !window.google?.accounts?.oauth2) {
    throw new Error('Bibliothèques Google non chargées.');
  }
}

async function initGoogleDrive() {
  try {
    await waitForGoogleApi();
    await new Promise((resolve, reject) => {
      gapi.load('client', {
        callback: resolve,
        onerror: reject
      });
    });
    await gapi.client.init({
      apiKey: GOOGLE_API_KEY,
      discoveryDocs: [DRIVE_DISCOVERY_DOC]
    });

    googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPES,
      prompt: '',
      callback: async tokenResponse => {
        googleRequestInFlight = null;
        try {
          await acceptGoogleDriveToken(tokenResponse);
        } catch (error) {
          clearGoogleDriveTokenOnly();
          updateDriveButtons();
          setMessage(error?.message || 'Connexion Google Drive refusée.', 'error');
        }
      },
      error_callback: error => {
        googleRequestInFlight = null;
        console.warn('Google token refusé.', error);
        updateDriveButtons();
      }
    });

    googleDriveReady = true;
    updateDriveButtons();
  } catch (error) {
    console.error(error);
    googleDriveReady = false;
    updateDriveButtons();
    setMessage('Google Drive indisponible pour le moment. La connexion au portail reste possible.', 'warning');
  }
}

async function ensureGoogleAccessToken(interactive = true) {
  if (isTokenFresh()) return googleAccessToken;
  if (!googleTokenClient) throw new Error('Google Drive n’est pas initialisé.');
  if (googleRequestInFlight) return googleRequestInFlight;

  googleRequestInFlight = new Promise((resolve, reject) => {
    const previousCallback = googleTokenClient.callback;
    googleTokenClient.callback = async tokenResponse => {
      googleTokenClient.callback = previousCallback;
      googleRequestInFlight = null;

      try {
        const token = await acceptGoogleDriveToken(tokenResponse);
        resolve(token);
      } catch (error) {
        clearGoogleDriveTokenOnly();
        updateDriveButtons();
        reject(error);
      }
    };

    try {
      googleTokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (error) {
      googleTokenClient.callback = previousCallback;
      googleRequestInFlight = null;
      reject(error);
    }
  });

  return googleRequestInFlight;
}

async function connectGoogleDrive() {
  try {
    await ensureGoogleAccessToken(true);
    setMessage('Google Drive connecté.', 'success');
  } catch (error) {
    console.error(error);
    setMessage(error?.message || 'Connexion Google Drive refusée ou impossible.', 'error');
  }
}

async function maybeRestoreDriveConnection() {
  if (silentReconnectAttempted || isTokenFresh() || !googleTokenClient || !wasDrivePreviouslyConnected()) return;
  silentReconnectAttempted = true;
  try {
    await ensureGoogleAccessToken(false);
  } catch (error) {
    console.warn('Reconnexion silencieuse Drive impossible.', error);
    updateDriveButtons();
  }
}

function disconnectGoogleDrive(clearRemembered = true) {
  if (googleAccessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(googleAccessToken); } catch (error) { console.warn(error); }
  }
  googleAccessToken = null;
  googleTokenExpiresAt = 0;
  googleRequestInFlight = null;
  if (window.gapi?.client) gapi.client.setToken(null);
  if (clearRemembered) clearDriveConnectionFlag();
  updateDriveButtons();
  broadcastDriveDisconnected();
}

function broadcastDriveConnected() {
  const payload = {
    type: 'BASTCOMPTA_GOOGLE_TOKEN',
    accessToken: googleAccessToken,
    expiresAt: googleTokenExpiresAt
  };

  [devisFrame, comptaFrame, chantierFrame, impotsFrame].forEach(frame => {
    postToFrame(frame, payload);
  });
}

function broadcastDriveDisconnected() {
  const payload = {
    type: 'BASTCOMPTA_GOOGLE_LOGOUT'
  };

  [devisFrame, comptaFrame, chantierFrame, impotsFrame].forEach(frame => {
    postToFrame(frame, payload);
  });
}

function bindIframeMessaging() {
  [devisFrame, comptaFrame, chantierFrame].forEach(frame => {
    frame?.addEventListener('load', () => {
      if (isTokenFresh()) broadcastDriveConnected();
      else broadcastDriveDisconnected();
    });
  });
}

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return;
  if (
    event.data?.type === 'BASTCOMPTA_DRIVE_REQUEST_TOKEN' ||
    event.data?.type === 'BASTCOMPTA_REFRESH_TOKEN' ||
    event.data?.type === 'BASTCOMPTA_DRIVE_STATUS_REQUEST'
  ) {
    ensureGoogleAccessToken(true)
      .then(() => broadcastDriveConnected())
      .catch(() => broadcastDriveDisconnected());
  }
  if (event.data?.type === 'BASTCOMPTA_DRIVE_DISCONNECT') {
    disconnectGoogleDrive(true);
  }
  if (event.data?.type === 'BASTCOMPTA_SEND_INVOICE_TO_ACCOUNTING') {
    sendInvoiceToAccounting();
  }

  if (event.data?.type === 'BASTCOMPTA_OPEN_DEVIS_DOCUMENT') {
    openDevisDocumentFromSuiviClient(event.data.docKey || event.data.pageKey || 'invoice');
  }
});

async function openDevisDocumentFromSuiviClient(docKey = 'invoice') {

  const pageKey = ['quote', 'invoice', 'reminder'].includes(docKey)
    ? docKey
    : 'invoice';

  switchMainTab('devis');

  const targetSrc = devisFrame?.dataset?.src || '';

  if (
    devisFrame &&
    targetSrc &&
    (!devisFrame.getAttribute('src') ||
      devisFrame.getAttribute('src') === 'about:blank')
  ) {
    devisFrame.setAttribute('src', targetSrc);
  }

  await waitForFrameLoad(devisFrame, 8000);

  await new Promise(resolve => setTimeout(resolve, 120));

  const setPageApi =
    getFrameApi(devisFrame, 'goToPage') ||
    getFrameApi(devisFrame, 'setActivePage');

  if (setPageApi) {
    try {
      setPageApi(pageKey);
    } catch (error) {
      console.warn('Ouverture document impossible.', error);
    }
  } else {
    postToFrame(devisFrame, {
      type: 'BASTCOMPTA_SET_ACTIVE_PAGE',
      pageKey
    });
  }

  requestAnimationFrame(() => {
    resizeIframeToContent(devisFrame);
  });

  return true;
}

window.openDevisDocumentFromSuiviClient = openDevisDocumentFromSuiviClient;

async function createUserDocument(user) {
  if (!user?.uid) return null;

  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);

  if (snap.exists()) {
    return snap.data();
  }

  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(now.getDate() + 14);

  const isOwner = (user.email || '').toLowerCase() === 'seb-n@hotmail.com';

  const userData = {
    email: user.email || '',
    createdAt: now.toISOString(),

    subscriptionStatus: isOwner ? 'owner' : 'trial',
    subscriptionActive: true,

    trialStartedAt: isOwner ? null : now.toISOString(),
    trialEndsAt: isOwner ? null : trialEnd.toISOString(),

    role: isOwner ? 'admin' : 'user',
    plan: isOwner ? 'owner' : 'monthly',

    monthlyPrice: isOwner ? 0 : 4.99,
    currency: 'EUR',

    stripeCustomerId: null,
    stripeSubscriptionId: null,

    updatedAt: now.toISOString()
  };

  await setDoc(userRef, userData);
  return userData;
}

async function checkSubscription(user) {
  if (!user?.uid) {
    return { allowed: false, reason: 'not_connected' };
  }

  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    return { allowed: false, reason: 'no_user_document' };
  }

  const data = snap.data() || {};

  if (data.subscriptionStatus === 'owner' && data.subscriptionActive === true) {
    return { allowed: true, status: 'owner', data };
  }

  if (data.subscriptionStatus === 'active' && data.subscriptionActive === true) {

    const now = new Date();

    const subscriptionEndsAt = new Date(
      data.subscriptionEndsAt || 0
    );

    if (
      Number.isNaN(subscriptionEndsAt.getTime()) ||
      now > subscriptionEndsAt
    ) {

      await updateDoc(userRef, {
        subscriptionStatus: 'expired',
        subscriptionActive: false,
        updatedAt: now.toISOString()
      }).catch(error =>
        console.warn(
          'Impossible de mettre à jour le statut abonnement expiré.',
          error
        )
      );

      return {
        allowed: false,
        reason: 'subscription_expired',
        data
      };
    }

    return {
      allowed: true,
      status: 'active',
      data
    };
  }

  if (data.subscriptionStatus === 'trial' && data.subscriptionActive === true) {
    const now = new Date();
    const trialEndsAt = new Date(data.trialEndsAt || 0);

    if (Number.isNaN(trialEndsAt.getTime()) || now > trialEndsAt) {
      await updateDoc(userRef, {
        subscriptionStatus: 'expired',
        subscriptionActive: false,
        updatedAt: now.toISOString()
      }).catch(error => console.warn('Impossible de mettre à jour le statut expiré.', error));

      return { allowed: false, reason: 'trial_expired', data };
    }

    return { allowed: true, status: 'trial', data };
  }

  return { allowed: false, reason: data.subscriptionStatus || 'inactive', data };
}

function subscriptionMessageFromResult(result) {
  const email = result?.data?.email || auth.currentUser?.email || '';

  if (result?.reason === 'trial_expired') {
    return `Votre période d’essai gratuite de 14 jours est terminée.

Pour continuer à utiliser BastCompta, merci d’effectuer un virement bancaire :

Compte : BE62 0013 1811 9761
Communication : bastcompta ${email}

Formules disponibles :
- Mensuel : 4,99 €
- Trimestriel : 12,99 €
- Annuel : 49,99 €

Votre accès sera réactivé après validation du paiement.`;
  }

  if (
    result?.reason === 'subscription_expired' ||
    result?.reason === 'inactive' ||
    result?.reason === 'expired'
  ) {
    return `Votre abonnement BastCompta est expiré.

Merci d’effectuer un virement bancaire :

Compte : BE62 0013 1811 9761
Communication : bastcompta ${email}

Formules disponibles :
- Mensuel : 4,99 €
- Trimestriel : 12,99 €
- Annuel : 49,99 €

Votre accès sera réactivé après validation du paiement.`;
  }

  return 'Accès BastCompta non autorisé pour ce compte.';
}

function showSubscriptionModal(result) {
  const email = result?.data?.email || auth.currentUser?.email || '';

  if (!subscriptionModal) return;

  subscriptionModalTitle.textContent =
    result?.reason === 'trial_expired'
      ? 'Votre essai gratuit est terminé'
      : 'Votre abonnement est expiré';

  subscriptionModalText.textContent =
    'Pour continuer à utiliser BastCompta, choisissez une formule et effectuez le virement bancaire.';

  subscriptionCommunication.textContent = `bastcompta ${email}`;

  subscriptionModal.classList.add('open');
  subscriptionModal.setAttribute('aria-hidden', 'false');
}

closeSubscriptionModalBtn?.addEventListener('click', () => {
  subscriptionModal?.classList.remove('open');
  subscriptionModal?.setAttribute('aria-hidden', 'true');
});

authTabs.forEach(btn => {
  btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
});

mainTabs.forEach(btn => {
  btn.addEventListener('click', () => switchMainTab(btn.dataset.mainTab));
});

settingsMenuBtn?.addEventListener('click', event => {
  event.stopPropagation();
  settingsMenu?.classList.toggle('open');
});

document.addEventListener('click', event => {
  if (settingsMenu && !settingsMenu.contains(event.target)) settingsMenu.classList.remove('open');
});

globalSaveBtn?.addEventListener('click', saveAllModulesFromPortal);
hiddenDriveBtn?.addEventListener('click', openHiddenDriveModal);
closeHiddenDriveBtn?.addEventListener('click', closeHiddenDriveModal);
refreshHiddenDriveBtn?.addEventListener('click', refreshHiddenDriveList);

hiddenDriveTabs?.addEventListener('click', event => {
  const button = event.target.closest('[data-drive-category]');
  if (!button) return;
  hiddenDriveActiveCategory = button.dataset.driveCategory || 'all';
  renderHiddenDriveList();
});
hiddenDriveModal?.addEventListener('click', event => {
  if (event.target === hiddenDriveModal) closeHiddenDriveModal();
});

connectDriveBtn.addEventListener('click', () => { settingsMenu?.classList.remove('open'); connectGoogleDrive(); });
disconnectDriveBtn.addEventListener('click', () => { settingsMenu?.classList.remove('open'); disconnectGoogleDrive(true); });
if (fullBackupBtn) fullBackupBtn.addEventListener('click', () => { settingsMenu?.classList.remove('open'); handleFullBackupClick(); });
if (fullRestoreBtn) fullRestoreBtn.addEventListener('click', () => { settingsMenu?.classList.remove('open'); handleFullRestoreClick(); });
if (fullRestoreInput) fullRestoreInput.addEventListener('change', handleFullRestoreFile);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
await setPersistence(auth, browserLocalPersistence);
await initGoogleDrive();
bindIframeMessaging();

const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/drive.appdata');
googleProvider.addScope('openid');
googleProvider.addScope('email');
googleProvider.addScope('profile');
googleProvider.setCustomParameters({
  prompt: 'select_account consent'
});

googleLoginBtn?.addEventListener('click', async () => {
  googleLoginFlowActive = true;
  try {
    setMessage('Connexion Google en cours…', 'warning');
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    await acceptFirebaseGoogleDriveAccessToken(credential?.accessToken);
    loadProtectedFrames();
    broadcastDriveConnected();
    setMessage('Connexion réussie. Google Drive est connecté avec le même compte.', 'success');
  } catch (error) {
    setMessage(humanizeAuthError(error), 'error');
  } finally {
    googleLoginFlowActive = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  settingsMenu?.classList.remove('open');
  try {
    disconnectGoogleDrive(true);
    await signOut(auth);
  } catch (error) {
    setMessage(humanizeAuthError(error), 'error');
  }
});

sendVerificationBtn?.addEventListener('click', async () => {
  const user = auth.currentUser;
  if (!user) return;

  try {
    await sendEmailVerification(user);
    currentUserEl.textContent = `Connecté : ${user.email} · email non vérifié`;
    setMessage('Email de vérification renvoyé.', 'success');
  } catch (error) {
    setMessage(humanizeAuthError(error), 'error');
  }
});

function resizeIframeToContent(frame) {
  if (!frame) return;
  frame.style.height = '3000px';
}

function bindIframeAutoResize(frame) {
  if (!frame) return;

  frame.addEventListener('load', () => {
    resizeIframeToContent(frame);
  });
}

bindIframeAutoResize(devisFrame);
bindIframeAutoResize(comptaFrame);
bindIframeAutoResize(chantierFrame);
bindIframeAutoResize(impotsFrame);

async function showTrialInfo(user) {
  try {
    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);

    if (!snap.exists()) return;

    const data = snap.data();

    if (data.subscriptionStatus === 'owner') {
      currentUserEl.innerHTML = '👑 Propriétaire';
      return;
    }

    if (data.subscriptionStatus === 'active') {
      currentUserEl.innerHTML = '🟢 Abonnement actif';
      return;
    }

    if (data.subscriptionStatus !== 'trial') return;

    const end = new Date(data.trialEndsAt);
    const now = new Date();

    const diffMs = end - now;
    const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

    currentUserEl.innerHTML =
      `🟢 Essai gratuit : ${daysLeft} jour${daysLeft > 1 ? 's' : ''} restant${daysLeft > 1 ? 's' : ''}`;

  } catch (error) {
    console.warn('Impossible d’afficher l’essai gratuit.', error);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      await user.reload().catch(() => { });
      const freshUser = auth.currentUser || user;

      await createUserDocument(freshUser);
      const subscription = await checkSubscription(freshUser);

      if (!subscription.allowed) {
        revokePortalModuleAccess();
        unloadProtectedFrames();
        portalScreen.classList.add('hidden');
        authScreen.classList.remove('hidden');
        setMessage(subscriptionMessageFromResult(subscription), 'warning');
        showSubscriptionModal(subscription);
        return;
      }

      showPortal(freshUser);
    } catch (error) {
      console.error('Vérification abonnement impossible :', error);
      revokePortalModuleAccess();
      unloadProtectedFrames();
      portalScreen.classList.add('hidden');
      authScreen.classList.remove('hidden');
      setMessage('Impossible de vérifier votre abonnement. Vérifiez votre connexion puis réessayez.', 'error');
    }
  } else {
    disconnectGoogleDrive(false);
    showAuth();
  }
});
