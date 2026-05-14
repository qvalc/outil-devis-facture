// BastCompta - module Comptabilité

const STORAGE_KEY = 'comptabilite-local-v1';
const DRIVE_SYNC_FILE_NAME = 'bastcompta-comptabilite-sync.json';

let googleAccessToken = null;
let googleDriveFiles = [];
let invoiceDriveFiles = [];
let purchasePdfDriveFiles = [];
let selectedDriveFileId = '';
let selectedDriveFileIds = [];
let selectedPurchasePdfRowIndex = null;

function notifyParentToRefreshGoogleToken() {
  try {
    window.parent.postMessage({
      type: 'BASTCOMPTA_REFRESH_TOKEN'
    }, window.location.origin);
  } catch (error) {
    console.error('Impossible de demander un refresh du token Google.', error);
  }
}

function resetGoogleDriveSession() {
  googleAccessToken = null;
  googleDriveFiles = [];
  invoiceDriveFiles = [];
  purchasePdfDriveFiles = [];
  selectedDriveFileId = '';
  selectedDriveFileIds = [];
  selectedPurchasePdfRowIndex = null;
  if (window.gapi?.client) {
    gapi.client.setToken(null);
  }
}

async function handleGoogleDriveAuthError(status, showAlert = true) {
  if (status === 401) {
    resetGoogleDriveSession();
    notifyParentToRefreshGoogleToken();

    if (showAlert) {
      alert('La session Google Drive a expiré. Reconnexion en cours...');
    }

    return true;
  }

  return false;
}

function extractGoogleDriveErrorStatus(error) {
  return error?.status || error?.result?.error?.code || error?.code || null;
}

async function handleGoogleDriveException(error, showAlert = true) {
  const status = extractGoogleDriveErrorStatus(error);
  return handleGoogleDriveAuthError(status, showAlert);
}

async function driveFilesList(params, showAlert401 = true) {
  try {
    return await gapi.client.drive.files.list(params);
  } catch (error) {
    if (await handleGoogleDriveException(error, showAlert401)) {
      return null;
    }
    throw error;
  }
}

async function googleDriveFetch(url, options = {}, showAlert401 = true) {
  const response = await fetch(url, options);
  if (await handleGoogleDriveAuthError(response.status, showAlert401)) {
    return null;
  }
  return response;
}


const defaultData = {
  company: {
    name: '',
    period: '',
    notes: ''
  },
  purchases: [],
  sales: [],
  investments: [],
  assets: [],
  stock: [],
  losses: [],
  km: [],
  vat: {
    declarations: []
  },
  settings: {
    vatCarryover: 0,
    bankBalance: 0,
    cashBalance: 0,
    capitalStart: 0,
    retainedEarnings: 0,
    socialExemptionThreshold: 1881.76,
    socialContributionRate: 20.5,
    socialContributionFeeRate: 3.5
  }
};

const pageDefs = [
  { key: 'dashboard', label: 'Tableau de bord' },
  { key: 'sales', label: 'Ventes' },
  { key: 'purchases', label: 'Achats' },
  { key: 'investments', label: 'Investissements' },
  { key: 'assets', label: 'Immobilisations' },
  { key: 'losses', label: 'Pertes & charges' },
  { key: 'stock', label: 'Stock' },
  { key: 'km', label: 'Kilomètres' },
  { key: 'result', label: 'Compte de résultat' },
  { key: 'balance', label: 'Bilan simplifié' },
  { key: 'vat', label: 'TVA' },
];

let data = loadData();
let activePage = 'dashboard';
let expandedVatDeclarationId = '';

function goToPage(pageKey) {
  activePage = pageKey;
  render();
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultData);
    return mergeDeep(structuredClone(defaultData), JSON.parse(raw));
  } catch {
    return structuredClone(defaultData);
  }
}

function mergeDeep(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      target[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function getSyncDriveFileName() {
  return DRIVE_SYNC_FILE_NAME;
}

async function saveSyncToDrive(showErrorAlert = false) {
  if (!googleAccessToken) return false;

  try {
    const fileName = getSyncDriveFileName();
    const syncPayload = mergeDeep(structuredClone(defaultData), data || {});
    const content = JSON.stringify(syncPayload, null, 2);

    const existing = await driveFilesList({
      spaces: 'appDataFolder',
      q: `name='${fileName.replace(/'/g, "\'")}' and trashed=false`,
      fields: 'files(id, name)'
    });

    if (!existing) return false;
    const files = existing.result.files || [];
    const isUpdate = files.length > 0;
    const metadata = isUpdate
      ? { name: fileName }
      : { name: fileName, parents: ['appDataFolder'] };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
    let method = 'POST';

    if (isUpdate) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart&fields=id,name`;
      method = 'PATCH';
    }

    const res = await googleDriveFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      },
      body: form
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(errorText);
    }

    return true;
  } catch (error) {
    console.error(error);
    if (showErrorAlert) {
      alert('La sauvegarde Google Drive automatique a échoué.');
    }
    return false;
  }
}

async function loadSyncDataFromDriveIfAvailable() {
  if (!googleAccessToken) return false;

  try {
    const fileName = getSyncDriveFileName();
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `name='${fileName.replace(/'/g, "\'")}' and trashed=false`,
      orderBy: 'modifiedTime desc',
      pageSize: 1,
      fields: 'files(id, name, modifiedTime)'
    });

    if (!list) return false;
    const file = (list.result.files || [])[0];
    if (!file) return false;

    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      }
    });

    if (!res) return false;

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const parsed = await res.json();
    data = mergeDeep(structuredClone(defaultData), parsed || {});
    ensureVatStructures();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function loadCurrentYearJsonFromDriveIfAvailable() {
  if (!googleAccessToken) return false;

  try {
    const currentYear = String(new Date().getFullYear());

    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `mimeType='application/json' and trashed=false and name contains 'comptabilite-' and name contains '${currentYear}'`,
      orderBy: 'modifiedTime desc',
      pageSize: 20,
      fields: 'files(id, name, modifiedTime)'
    });

    if (!list) return false;
    const files = (list.result.files || []).filter(file => {
      const name = String(file.name || '');
      const hiddenSyncNames = [DRIVE_SYNC_FILE_NAME, 'bastcompta-comptabilite-sync.json'];
      return !hiddenSyncNames.includes(name) && name.endsWith('.json');
    });

    if (!files.length) return false;

    const exactYearFiles = files.filter(file =>
      new RegExp(`(^|-)${currentYear}\\.json$`).test(String(file.name || ''))
    );

    const fileToLoad = exactYearFiles[0] || files[0];
    selectedDriveFileId = fileToLoad.id;

    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileToLoad.id}?alt=media`, {
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      }
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const parsed = await res.json();
    data = mergeDeep(structuredClone(defaultData), parsed || {});
    ensureVatStructures();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function saveCurrentYearJsonToDrive(showErrorAlert = false) {
  if (!googleAccessToken) return false;

  try {
    const fileName = getDriveFileName();
    const content = JSON.stringify(data, null, 2);

    let targetFileId = '';

    if (selectedDriveFileId) {
      targetFileId = selectedDriveFileId;
    }

    if (!targetFileId) {
      const existing = await driveFilesList({
        spaces: 'appDataFolder',
        q: `name='${fileName.replace(/'/g, "\'")}' and trashed=false`,
        fields: 'files(id, name)'
      });

      if (!existing) return false;
      const files = existing.result.files || [];
      if (files.length) {
        targetFileId = files[0].id;
      }
    }

    const metadata = targetFileId
      ? { name: fileName }
      : { name: fileName, parents: ['appDataFolder'] };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
    let method = 'POST';

    if (targetFileId) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${targetFileId}?uploadType=multipart&fields=id,name`;
      method = 'PATCH';
    }

    const res = await googleDriveFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      },
      body: form
    });

    if (!res) return false;

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const saved = await res.json();
    selectedDriveFileId = saved.id;
    await loadDriveFiles();
    return true;
  } catch (error) {
    console.error(error);
    if (showErrorAlert) {
      alert("La sauvegarde Google Drive a échoué.");
    }
    return false;
  }
}

async function saveData(showAlert = true) {
  ensureVatStructures();
  ensurePurchaseRowIds();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  const chantierSynced = await syncPurchasesToChantiers(showAlert && !!googleAccessToken);

  if (showAlert) {
    if (googleAccessToken) {
      const synced = await saveCurrentYearJsonToDrive(true);
      alert(synced
        ? `Données sauvegardées localement et sur Google Drive${chantierSynced ? ' + chantiers mis à jour' : ''}.`
        : `Données sauvegardées localement${chantierSynced ? ' + chantiers mis à jour' : ''}.`);
    } else {
      alert(`Données sauvegardées localement${chantierSynced ? ' + chantiers mis à jour' : ''}.`);
    }
  }

  render();
}

function toggleFileMenu(event) {
  event.stopPropagation();
  const dropdown = event.currentTarget.closest('.dropdown');
  if (!dropdown) return;
  document.querySelectorAll('.dropdown.open').forEach(el => {
    if (el !== dropdown) el.classList.remove('open');
  });
  dropdown.classList.toggle('open');
}

function closeFileMenu() {
  document.querySelectorAll('.dropdown.open').forEach(el => el.classList.remove('open'));
}

function exportDataLocal() {
  const fileName = getDriveFileName();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importDataLocal() {
  const input = document.getElementById('localJsonImportInput');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handleLocalJsonImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const content = await file.text();
    const parsed = JSON.parse(content);
    data = mergeDeep(structuredClone(defaultData), parsed);
    saveData(false);
    alert(`Import réussi : ${file.name}`);
  } catch (error) {
    console.error(error);
    alert("Le fichier sélectionné n'est pas un JSON valide.");
  }
}

async function importDataFromDriveMenu() {
  activePage = 'gdrive';
  render();
  await importJsonFromDrive();
}

async function openDriveDownloadManager() {
  activePage = 'gdrive';
  render();
  await loadDriveFiles();
}

function isDriveFileChecked(fileId) {
  return selectedDriveFileIds.includes(fileId);
}

function toggleDriveFileSelection(fileId, checked) {
  if (checked) {
    if (!selectedDriveFileIds.includes(fileId)) {
      selectedDriveFileIds.push(fileId);
    }
  } else {
    selectedDriveFileIds = selectedDriveFileIds.filter(id => id !== fileId);
  }
  render();
}

function selectDriveFileForImport(fileId) {
  selectedDriveFileId = fileId || '';
  render();
}

function selectAllDriveFiles() {
  selectedDriveFileIds = googleDriveFiles.map(file => file.id);
  render();
}

function clearDriveFileSelection() {
  selectedDriveFileIds = [];
  render();
}

function normalizeInvoiceNumberForDrive(value) {
  return String(value || '').trim();
}

function getInvoiceDriveFileForNumber(invoiceNumber) {
  const wanted = normalizeInvoiceNumberForDrive(invoiceNumber).toLowerCase();
  if (!wanted) return null;

  return invoiceDriveFiles.find(file => {
    const fileName = String(file.name || '').toLowerCase();
    if (!fileName.startsWith('facture-')) return false;
    const fileNumber = fileName
      .replace(/^facture-/i, '')
      .replace(/\.json$/i, '')
      .trim();
    return fileNumber === wanted;
  }) || null;
}

async function findInvoiceDriveFileForNumber(invoiceNumber, showAlert401 = false) {
  const normalized = normalizeInvoiceNumberForDrive(invoiceNumber);
  if (!normalized || !googleAccessToken || !window.gapi?.client) return null;

  const cached = getInvoiceDriveFileForNumber(normalized);
  if (cached) return cached;

  try {
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `mimeType='application/json' and trashed=false and name contains 'facture-' and name contains '${normalized.replace(/'/g, "\'")}'`,
      orderBy: 'modifiedTime desc',
      pageSize: 20,
      fields: 'files(id, name, modifiedTime)'
    }, showAlert401);

    if (!list) return null;
    const files = list.result.files || [];
    invoiceDriveFiles = [...invoiceDriveFiles, ...files].filter((file, index, all) =>
      all.findIndex(item => item.id === file.id) === index
    );
    return getInvoiceDriveFileForNumber(normalized);
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function loadInvoiceDriveFiles(showAlert401 = false) {
  if (!googleAccessToken || !window.gapi?.client) return [];

  try {
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `mimeType='application/json' and trashed=false and name contains 'facture-'`,
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      fields: 'files(id, name, modifiedTime)'
    }, showAlert401);

    if (!list) return invoiceDriveFiles;
    invoiceDriveFiles = (list.result.files || []).filter(file => String(file.name || '').toLowerCase().endsWith('.json'));
    return invoiceDriveFiles;
  } catch (error) {
    console.error(error);
    return invoiceDriveFiles;
  }
}

async function openSalesInvoicePreview(invoiceNumber) {
  const normalized = normalizeInvoiceNumberForDrive(invoiceNumber);
  if (!normalized) {
    alert('Aucun numéro de facture sur cette ligne.');
    return;
  }

  if (!getInvoiceDriveFileForNumber(normalized)) {
    await findInvoiceDriveFileForNumber(normalized, true);
  }

  if (!getInvoiceDriveFileForNumber(normalized)) {
    alert(`Aucune facture trouvée dans Google Drive pour le numéro ${normalized}.`);
    render();
    return;
  }

  const invoiceFile = getInvoiceDriveFileForNumber(normalized);
  const opener = window.parent?.openInvoicePrintPreviewFromAccounting;
  if (typeof opener === 'function') {
    await opener(normalized, invoiceFile?.id || '');
    return;
  }

  alert('Ouvre le fichier via le portail BastCompta pour afficher l’aperçu d’impression de la facture.');
}

window.openSalesInvoicePreview = openSalesInvoicePreview;

function sanitizeDriveFileNamePart(value, fallback = 'sans-reference') {
  const cleaned = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function getPurchasePdfFileName(row, originalName = 'facture.pdf') {
  const invoice = sanitizeDriveFileNamePart(row?.invoiceNumber, 'sans-numero');
  const supplier = sanitizeDriveFileNamePart(row?.supplier, 'fournisseur');
  const date = sanitizeDriveFileNamePart(row?.date, 'sans-date');
  const baseName = String(originalName || 'facture.pdf').replace(/\.pdf$/i, '');
  const shortOriginal = sanitizeDriveFileNamePart(baseName, 'document');
  return `achat-${date}-${supplier}-${invoice}-${shortOriginal}.pdf`;
}

function getPurchasePdfFileById(fileId) {
  if (!fileId) return null;
  return purchasePdfDriveFiles.find(file => file.id === fileId) || null;
}

async function loadPurchasePdfDriveFiles(showAlert401 = false) {
  if (!googleAccessToken || !window.gapi?.client) return [];

  try {
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `mimeType='application/pdf' and trashed=false and name contains 'achat-'`,
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      fields: 'files(id, name, modifiedTime, size)'
    }, showAlert401);

    if (!list) return purchasePdfDriveFiles;
    purchasePdfDriveFiles = list.result.files || [];
    return purchasePdfDriveFiles;
  } catch (error) {
    console.error(error);
    return purchasePdfDriveFiles;
  }
}

function pickPurchasePdf(rowIndex) {
  const lockedDec = getClosedVatDeclarationForDate(data.purchases?.[rowIndex]?.date || '');
  if (lockedDec) {
    alert(getVatLockMessage(lockedDec));
    return;
  }

  if (!googleAccessToken) {
    alert('Connecte Google Drive depuis le portail BastCompta.');
    return;
  }

  selectedPurchasePdfRowIndex = rowIndex;
  const input = document.getElementById('purchasePdfUploadInput');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handlePurchasePdfUpload(event) {
  const file = event.target.files?.[0];
  const rowIndex = selectedPurchasePdfRowIndex;
  selectedPurchasePdfRowIndex = null;

  if (!file || rowIndex === null || rowIndex === undefined) return;
  if (file.type !== 'application/pdf' && !String(file.name || '').toLowerCase().endsWith('.pdf')) {
    alert('Sélectionne un fichier PDF.');
    return;
  }

  if (!googleAccessToken) {
    alert('Connecte Google Drive depuis le portail BastCompta.');
    return;
  }

  try {
    const row = data.purchases[rowIndex] || {};
    const lockedDec = getClosedVatDeclarationForDate(row.date || '');
    if (lockedDec) {
      alert(getVatLockMessage(lockedDec));
      return;
    }
    const fileName = getPurchasePdfFileName(row, file.name);
    const metadata = { name: fileName, parents: ['appDataFolder'] };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);

    const res = await googleDriveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size', {
      method: 'POST',
      headers: { Authorization: `Bearer ${googleAccessToken}` },
      body: form
    });

    if (!res) return;
    if (!res.ok) throw new Error(await res.text());

    const saved = await res.json();
    data.purchases[rowIndex].pdfFileId = saved.id;
    data.purchases[rowIndex].pdfFileName = saved.name;
    data.purchases[rowIndex].pdfModifiedTime = saved.modifiedTime || '';

    await saveData(false);
    await saveCurrentYearJsonToDrive(false);
    await loadPurchasePdfDriveFiles(false);
    render();
    alert('Facture PDF ajoutée à Google Drive.');
  } catch (error) {
    console.error(error);
    alert("Échec de l'envoi de la facture PDF vers Google Drive.");
  }
}

async function openPurchasePdf(fileId) {
  if (!googleAccessToken) {
    alert('Connecte Google Drive depuis le portail BastCompta.');
    return;
  }

  if (!fileId) {
    alert('Aucun PDF lié à cette ligne.');
    return;
  }

  try {
    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${googleAccessToken}` }
    });

    if (!res) return;
    if (!res.ok) throw new Error(await res.text());

    const blob = await res.blob();
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    alert('Impossible d’ouvrir ce PDF.');
  }
}

async function deletePurchasePdf(fileId) {
  if (!googleAccessToken) {
    alert('Connecte Google Drive depuis le portail BastCompta.');
    return;
  }

  if (!fileId) return;
  if (!confirm('Supprimer définitivement cette facture PDF de Google Drive ?')) return;

  try {
    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${googleAccessToken}` }
    });

    if (!res) return;
    if (!res.ok) throw new Error(await res.text());

    data.purchases.forEach(row => {
      if (row.pdfFileId === fileId) {
        row.pdfFileId = '';
        row.pdfFileName = '';
        row.pdfModifiedTime = '';
      }
    });

    await saveData(false);
    await saveCurrentYearJsonToDrive(false);
    await loadPurchasePdfDriveFiles(false);
    render();
    alert('Facture PDF supprimée.');
  } catch (error) {
    console.error(error);
    alert('Erreur lors de la suppression du PDF.');
  }
}

function renderPurchasePdfList() {
  if (!googleAccessToken) {
    return '<div class="muted-box">Connecte Google Drive pour afficher les factures PDF d’achat.</div>';
  }

  if (!purchasePdfDriveFiles.length) {
    return '<div class="muted-box">Aucune facture PDF d’achat trouvée sur Google Drive.</div>';
  }

  return `
    <div style="overflow:auto; margin-top:12px;">
      <table class="table-purchases" style="table-layout:fixed; width:100%;">
        <colgroup>
          <col style="width: 45%;">
          <col style="width: 160px;">
          <col style="width: 220px;">
        </colgroup>
        <thead>
          <tr>
            <th>Fichier PDF</th>
            <th>Modifié le</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${purchasePdfDriveFiles.map(file => {
    const modified = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString('fr-BE') : '—';
    return `
              <tr>
                <td>${escapeHtml(file.name || 'facture.pdf')}</td>
                <td>${escapeHtml(modified)}</td>
                <td>
                  <div class="inline-actions">
                    <button type="button" onclick='openPurchasePdf(${JSON.stringify(file.id)})'>Consulter</button>
                    <button type="button" class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" onclick='deletePurchasePdf(${JSON.stringify(file.id)})'>×</button>
                  </div>
                </td>
              </tr>
            `;
  }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

window.pickPurchasePdf = pickPurchasePdf;
window.handlePurchasePdfUpload = handlePurchasePdfUpload;
window.openPurchasePdf = openPurchasePdf;
window.deletePurchasePdf = deletePurchasePdf;

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) return;

  const message = event.data || {};

  if (message.type === 'BASTCOMPTA_GOOGLE_TOKEN') {
    googleAccessToken = message.accessToken || null;

    if (!googleAccessToken) {
      resetGoogleDriveSession();
      render();
      return;
    }

    if (googleAccessToken && window.gapi?.client) {
      try {
        gapi.client.setToken({ access_token: googleAccessToken });
        await loadCurrentYearJsonFromDriveIfAvailable();
        await loadDriveFiles();
        await loadPurchasePdfDriveFiles(false);
      } catch (error) {
        console.error(error);
      }
    }

    render();
  }

  if (message.type === 'BASTCOMPTA_GOOGLE_LOGOUT') {
    resetGoogleDriveSession();
    render();
  }

  if (message.type === 'BASTCOMPTA_CHANTIERS_UPDATED') {
    // Rafraîchit les listes déroulantes de chantiers dans les achats sans attendre un rechargement complet.
    render();
  }
});

async function initDriveClientOnly() {
  try {
    await new Promise((resolve) => gapi.load('client', resolve));

    await gapi.client.init({
      apiKey: 'AIzaSyC88moDvAWg7LFeJAgUSxXJV4nhAigSOKU',
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
    });

    if (googleAccessToken) {
      gapi.client.setToken({ access_token: googleAccessToken });
    }
  } catch (error) {
    console.error(error);
    alert("Erreur lors de l'initialisation du client Google Drive.");
  }
}

function getDriveFileName() {
  const period = String(data.company.period || '').trim();
  const company = String(data.company.name || '').trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  if (period && company) return `comptabilite-${company}-${period}.json`;
  if (period) return `comptabilite-${period}.json`;
  if (company) return `comptabilite-${company}.json`;
  return 'comptabilite-export.json';
}

function getDriveFileNameFromData(sourceData) {
  const safeData = sourceData || {};
  const period = String(safeData.company?.period || '').trim();
  const company = String(safeData.company?.name || '').trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  if (period && company) return `comptabilite-${company}-${period}.json`;
  if (period) return `comptabilite-${period}.json`;
  if (company) return `comptabilite-${company}.json`;
  return 'comptabilite-export.json';
}

function openIntervat() {
  window.open('https://finances.belgium.be/fr/E-services/Intervat', '_blank', 'noopener');
}

function commitPendingInputChanges() {
  const activeEl = document.activeElement;
  if (activeEl && typeof activeEl.blur === 'function') {
    activeEl.blur();
  }
}

function buildNextExerciseData(targetYear) {
  const year = String(targetYear || '').trim();
  if (!/^\d{4}$/.test(year)) {
    throw new Error('Année invalide.');
  }

  const t = totals();
  const nextData = structuredClone(defaultData);
  const preservedSettings = mergeDeep(structuredClone(defaultData.settings), structuredClone(data.settings || {}));

  nextData.company = {
    name: data.company?.name || '',
    period: year,
    notes: data.company?.notes || ''
  };

  nextData.stock = structuredClone(Array.isArray(data.stock) ? data.stock : []);
  nextData.assets = structuredClone(Array.isArray(data.assets) ? data.assets : []);
  nextData.investments = structuredClone(Array.isArray(data.investments) ? data.investments : []);

  nextData.settings = preservedSettings;
  nextData.settings.retainedEarnings = round2(
    toNumber(preservedSettings.retainedEarnings)
    + toNumber(t.estimatedProfit)
  );
  nextData.settings.vatCarryover = Math.max(0, round2(toNumber(t.receivableVat)));

  nextData.purchases = [];
  nextData.sales = [];
  nextData.losses = [];
  nextData.km = [];
  nextData.vat = { declarations: [] };

  return nextData;
}

function downloadJsonFile(sourceData, fileName = '') {
  const finalFileName = fileName || getDriveFileNameFromData(sourceData);
  const blob = new Blob([JSON.stringify(sourceData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = finalFileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function uploadJsonObjectToDrive(sourceData, fileName = '') {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return false;
  }

  const finalFileName = fileName || getDriveFileNameFromData(sourceData);
  const content = JSON.stringify(sourceData, null, 2);

  const existing = await driveFilesList({
    spaces: 'appDataFolder',
    q: `name='${finalFileName.replace(/'/g, "\\'")}' and trashed=false`,
    fields: 'files(id, name)'
  });

  const files = existing.result.files || [];
  const metadata = {
    name: finalFileName,
    parents: ['appDataFolder']
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'application/json' }));

  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
  let method = 'POST';

  if (files.length) {
    url = `https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart&fields=id,name`;
    method = 'PATCH';
  }

  const res = await googleDriveFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${googleAccessToken}`
    },
    body: form
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const saved = await res.json();
  selectedDriveFileId = saved.id;
  await loadDriveFiles();
  return saved;
}

async function createNextExerciseFile() {
  commitPendingInputChanges();
  await saveData(false);

  const currentYear = parseInt(data.company.period, 10) || new Date().getFullYear();
  const suggestedYear = currentYear + 1;
  const answer = prompt("Année du nouvel exercice :", suggestedYear);
  if (answer === null) return;

  const targetYear = String(answer).trim();
  const destinationDefault = googleAccessToken ? 'drive' : 'pc';
  const destinationAnswer = prompt("Destination du nouveau fichier : pc ou drive ?", destinationDefault);
  if (destinationAnswer === null) return;

  const destination = String(destinationAnswer).trim().toLowerCase();

  try {
    const nextData = buildNextExerciseData(targetYear);
    const fileName = getDriveFileNameFromData(nextData);

    if (destination === 'drive') {
      const saved = await uploadJsonObjectToDrive(nextData, fileName);
      alert(`Le fichier de l'exercice ${targetYear} a été envoyé sur Google Drive : ${saved.name}`);
      return;
    }

    if (destination !== 'pc') {
      throw new Error('Destination invalide.');
    }

    downloadJsonFile(nextData, fileName);
    alert(`Le fichier de l'exercice ${targetYear} a été téléchargé sur ce PC.`);
  } catch (error) {
    console.error(error);
    alert("Impossible de créer le nouvel exercice. Vérifie l'année ou la destination choisie.");
  }
}

async function loadDriveFiles() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  try {
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `mimeType='application/json' and trashed=false and name contains 'comptabilite-'`,
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      fields: 'files(id, name, modifiedTime)'
    });

    if (!list) return;

    googleDriveFiles = (list.result.files || []).filter(file => {
      const hiddenSyncNames = [DRIVE_SYNC_FILE_NAME, 'bastcompta-comptabilite-sync.json'];
      return !hiddenSyncNames.includes(String(file.name || ''));
    });
    const validIds = new Set(googleDriveFiles.map(file => file.id));
    selectedDriveFileIds = selectedDriveFileIds.filter(id => validIds.has(id));

    if (selectedDriveFileId && !validIds.has(selectedDriveFileId)) {
      selectedDriveFileId = '';
    }

    if (!selectedDriveFileId && googleDriveFiles.length) {
      selectedDriveFileId = googleDriveFiles[0].id;
    }

    render();
  } catch (error) {
    console.error(error);

    alert("Impossible de charger la liste des sauvegardes Drive. Vérifie la connexion Google Drive dans le portail.");
  }
}

async function importSelectedJsonFromDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  if (!selectedDriveFileId) {
    alert('Sélectionne d’abord une sauvegarde Google Drive.');
    return;
  }

  try {
    const file = googleDriveFiles.find(f => f.id === selectedDriveFileId);

    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${selectedDriveFileId}?alt=media`, {
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      }
    });

    if (!res) return;

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const parsed = await res.json();
    data = mergeDeep(structuredClone(defaultData), parsed);
    ensureVatStructures();
    saveData(false);
    alert(`Import réussi : ${file ? file.name : 'fichier sélectionné'}`);
  } catch (error) {
    console.error(error);
    alert("Échec de l'import depuis Google Drive.");
  }
}

async function downloadSelectedJsonFromDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  const fileIds = selectedDriveFileIds.length ? [...selectedDriveFileIds] : (selectedDriveFileId ? [selectedDriveFileId] : []);

  if (!fileIds.length) {
    activePage = 'gdrive';
    render();
    alert('Choisis au moins une sauvegarde Google Drive.');
    return;
  }

  try {
    for (const fileId of fileIds) {
      const file = googleDriveFiles.find(f => f.id === fileId);

      const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: {
          Authorization: `Bearer ${googleAccessToken}`
        }
      });

      if (!res) return;

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const content = await res.text();
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file?.name || 'sauvegarde-drive.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    alert(fileIds.length === 1
      ? 'Téléchargement terminé.'
      : `${fileIds.length} fichiers ont été téléchargés vers ce PC.`);
  } catch (error) {
    console.error(error);
    alert("Échec du téléchargement depuis Google Drive.");
  }
}

async function deleteSelectedJsonFromDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  const fileIds = selectedDriveFileIds.length ? [...selectedDriveFileIds] : (selectedDriveFileId ? [selectedDriveFileId] : []);

  if (!fileIds.length) {
    alert('Coche au moins une sauvegarde à supprimer.');
    return;
  }

  if (!confirm(fileIds.length === 1
    ? 'Supprimer cette sauvegarde définitivement ?'
    : `Supprimer définitivement ces ${fileIds.length} sauvegardes ?`)) return;

  try {
    for (const fileId of fileIds) {
      const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${googleAccessToken}`
        }
      });
      if (!res) return;
      if (!res.ok) throw new Error(await res.text());
    }

    selectedDriveFileIds = [];
    if (fileIds.includes(selectedDriveFileId)) {
      selectedDriveFileId = '';
    }

    await loadDriveFiles();
    alert(fileIds.length === 1 ? 'Sauvegarde supprimée.' : `${fileIds.length} sauvegardes supprimées.`);
  } catch (error) {
    console.error(error);
    alert('Erreur lors de la suppression.');
  }
}

function pickLocalJsonForDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  const input = document.getElementById('localJsonToDriveInput');
  if (!input) return;

  input.value = '';
  input.click();
}

async function uploadLocalJsonToDrive(event) {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  const pickedFiles = Array.from(event.target.files || []);
  if (!pickedFiles.length) return;

  try {
    let importedCount = 0;

    for (const file of pickedFiles) {
      const content = await file.text();

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        alert(`Le fichier ${file.name} n'est pas un JSON valide.`);
        continue;
      }

      const metadata = {
        name: file.name,
        parents: ['appDataFolder']
      };

      const existing = await driveFilesList({
        spaces: 'appDataFolder',
        q: `name='${file.name.replace(/'/g, "\'")}' and trashed=false`,
        fields: 'files(id, name)'
      });

      if (!existing) return;
      const files = existing.result.files || [];

      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' }));

      let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
      let method = 'POST';

      if (files.length) {
        url = `https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart&fields=id,name`;
        method = 'PATCH';
      }

      const res = await googleDriveFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${googleAccessToken}`
        },
        body: form
      });

      if (!res) return;

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const saved = await res.json();
      selectedDriveFileId = saved.id;
      importedCount += 1;
    }

    await loadDriveFiles();

    alert(importedCount <= 1
      ? 'Fichier local envoyé vers Google Drive.'
      : `${importedCount} fichiers locaux ont été envoyés vers Google Drive.`);
  } catch (error) {
    console.error(error);
    alert("Échec de l'envoi du fichier local vers Google Drive.");
  }
}

async function exportJsonToDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  const saved = await saveCurrentYearJsonToDrive(false);
  if (saved) {
    alert(`Export Google Drive réussi : ${getDriveFileName()}`);
  } else {
    alert("Échec de l'export vers Google Drive.");
  }
}

async function importJsonFromDrive() {
  await loadDriveFiles();

  if (!googleDriveFiles.length) {
    alert('Aucune sauvegarde JSON trouvée sur Google Drive.');
    return;
  }

  if (!selectedDriveFileId) {
    selectedDriveFileId = googleDriveFiles[0].id;
  }

  render();
}

function renderGoogleDrive() {
  const fileItems = googleDriveFiles.map(file => {
    const isImportSelected = selectedDriveFileId === file.id;
    const isChecked = isDriveFileChecked(file.id);
    const dateLabel = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString('fr-BE') : 'Date inconnue';

    return `
          <div class="drive-file-item ${isImportSelected ? 'active' : ''}">
            <input type="radio" name="driveImportFile" ${isImportSelected ? 'checked' : ''} onchange="selectDriveFileForImport('${escapeAttr(file.id)}')"
              title="Choisir ce fichier pour le charger dans l’application">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleDriveFileSelection('${escapeAttr(file.id)}', this.checked)"
              title="Ajouter ce fichier à la sélection pour téléchargement ou suppression">
            <div>
              <div class="drive-file-name">${escapeHtml(file.name)}</div>
              <div class="hint">Radio = charger dans l’application. Case = télécharger ou supprimer un ou plusieurs fichiers.</div>
            </div>
            <div class="drive-file-date">${escapeHtml(dateLabel)}</div>
          </div>
        `;
  }).join('');

  const checkedCount = selectedDriveFileIds.length;

  return `
        <section class="page ${activePage === 'gdrive' ? 'active' : ''}">
          <div class="card">
            <div class="section-head">
              <div>
                <h2>Google Drive</h2>
              </div>
              <div class="inline-actions">
                <button onclick="loadDriveFiles()">Actualiser la liste</button>
              </div>
            </div>

            <div class="muted-box" style="margin-bottom:16px; line-height:1.7;">
              La connexion Google Drive se fait depuis le portail principal BastCompta.<br>
              Les actions rapides sont aussi disponibles dans le menu <strong>Fichier</strong> en haut de l’écran.
            </div>

            <div class="grid-2">
              <div class="muted-box">
                <strong>Nom qui sera utilisé pour le prochain export du document actuel :</strong><br>
                ${escapeHtml(getDriveFileName())}
                <br><br>
                Les sauvegardes sont créées sous forme de fichiers JSON distincts dans l’espace privé appDataFolder.
              <br>La sauvegarde automatique interne de la comptabilité/TVA reste masquée dans cette liste pour éviter toute suppression accidentelle.
              </div>

              <div class="muted-box">
                <strong>Conseil</strong><br>
                Renseigne au minimum le nom de l’entreprise et la période avant export.<br>
                Même nom de fichier = mise à jour du même JSON.<br>
                Nouveau nom = nouveau fichier.
              </div>
            </div>

            <div style="margin-top:16px;" class="card">
              <div class="section-head">
                <div>
                  <h3>Fichiers disponibles sur Google Drive</h3>
                  <div class="hint">Choisis un fichier à charger dans l’application, et coche un ou plusieurs fichiers pour les rapatrier vers ce PC ou les supprimer.</div>
                </div>
                <div class="inline-actions">
                  <button onclick="selectAllDriveFiles()">Tout cocher</button>
                  <button onclick="clearDriveFileSelection()">Tout décocher</button>
                </div>
              </div>

              <div class="inline-actions" style="margin-top:12px;">
                <button onclick="importSelectedJsonFromDrive()">Charger dans l’application</button>
                <button onclick="downloadSelectedJsonFromDrive()">Télécharger vers ce PC${checkedCount ? ` (${checkedCount})` : ''}</button>
                <button onclick="pickLocalJsonForDrive()">Importer des fichiers du PC vers Drive</button>
                <button class="danger" onclick="deleteSelectedJsonFromDrive()">Supprimer${checkedCount ? ` (${checkedCount})` : ''}</button>
              </div>

              <div class="drive-file-list">
                ${fileItems || '<div class="muted-box">Aucune sauvegarde JSON trouvée sur Google Drive.</div>'}
              </div>
            </div>
          </div>
        </section>
      `;
}

function money(value) {
  return new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

function num(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function rowNetFromTvac(tvac, rate) {
  return toNumber(tvac) / (1 + toNumber(rate) / 100);
}

function rowVatFromTvac(tvac, rate) {
  return toNumber(tvac) - rowNetFromTvac(tvac, rate);
}


function isCreditNoteSalesRow(row) {
  return String(row?.documentType || '').toLowerCase() === 'credit_note'
    || String(row?.documentStatus || '').toLowerCase() === 'credit_note'
    || /note\s+de\s+cr[eé]dit/i.test(String(row?.description || ''));
}

function salesRowTvac(row) {
  const value = toNumber(row?.tvac);
  return isCreditNoteSalesRow(row) ? -Math.abs(value) : value;
}

function salesRowNet(row) {
  return rowNetFromTvac(salesRowTvac(row), row?.rate);
}

function salesRowVat(row) {
  return rowVatFromTvac(salesRowTvac(row), row?.rate);
}

function rowHtvaToVat(htva, rate) {
  return toNumber(htva) * (toNumber(rate) / 100);
}

function rowHtvaToTvac(htva, rate) {
  return toNumber(htva) + rowHtvaToVat(htva, rate);
}

function round2(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}


const CHANTIERS_STORAGE_KEY = 'bastcompta-chantiers-v1';
const CHANTIERS_DRIVE_SYNC_FILE_NAME = 'bastcompta-chantiers-sync.json';

function chantierSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'chantier';
}

function loadChantiersLocalData() {
  try {
    const raw = localStorage.getItem(CHANTIERS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      version: parsed.version || 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    };
  } catch (error) {
    console.error('Impossible de lire les chantiers locaux.', error);
    return { version: 1, projects: [] };
  }
}

function saveChantiersLocalData(chantiersData) {
  localStorage.setItem(CHANTIERS_STORAGE_KEY, JSON.stringify(chantiersData, null, 2));
  try {
    window.parent?.postMessage({ type: 'BASTCOMPTA_CHANTIERS_UPDATED' }, window.location.origin);
  } catch (error) {
    console.error(error);
  }
}

function ensurePurchaseRowIds() {
  let changed = false;
  (data.purchases || []).forEach(row => {
    if (!row._id) {
      row._id = `purchase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      changed = true;
    }
  });
  return changed;
}

function getChantierProjectsForPurchaseSelect() {
  const chantiersData = loadChantiersLocalData();
  return (chantiersData.projects || []).slice().sort((a, b) => {
    const aLabel = `${a.clientName || ''} ${a.title || ''}`;
    const bLabel = `${b.clientName || ''} ${b.title || ''}`;
    return aLabel.localeCompare(bLabel, 'fr', { sensitivity: 'base' });
  });
}

function makeChantierPurchaseLabel(project) {
  return `${project.clientName || 'Client'} — ${project.title || 'Chantier'}`;
}

function setPurchaseChantierFromSelect(index, value) {
  const row = data.purchases[index];
  if (!row) return;
  const chantiersData = loadChantiersLocalData();
  const project = (chantiersData.projects || []).find(item => String(item.id || '') === String(value || ''));

  if (project) {
    row.chantierId = project.id || '';
    row.chantierClientId = project.clientId || '';
    row.chantierClientName = project.clientName || '';
    row.chantierSiteName = project.title || '';
  } else {
    row.chantierId = '';
    row.chantierClientId = '';
    row.chantierClientName = '';
    row.chantierSiteName = '';
  }

  updateAccountingRowField('purchases', index, 'chantierSiteName', row.chantierSiteName);
}

function findOrCreateChantierForPurchase(chantiersData, row) {
  const title = String(row.chantierSiteName || '').trim();
  if (!title) return null;

  const clientName = String(row.chantierClientName || '').trim();
  const titleKey = chantierSlug(title);
  const clientKey = chantierSlug(clientName);

  let project = row.chantierId
    ? (chantiersData.projects || []).find(project => String(project.id || '') === String(row.chantierId))
    : null;

  let candidates = (chantiersData.projects || []).filter(project => chantierSlug(project.title) === titleKey);
  if (!project) {
    project = clientName
      ? candidates.find(project => chantierSlug(project.clientName || project.clientRef) === clientKey)
      : (candidates.length === 1 ? candidates[0] : null);
  }

  if (!project) {
    project = {
      id: `chantier-${clientKey || 'client'}-${titleKey}-${Date.now().toString(36)}`,
      title,
      clientId: row.chantierClientId || '',
      clientName,
      clientRef: '',
      address: '',
      description: '',
      status: 'active',
      startDate: row.date || '',
      endDate: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      quoteAmount: 0,
      linkedQuotes: [],
      linkedInvoices: [],
      linkedReminders: [],
      costs: [],
      documents: [],
      tasks: [],
      notes: [],
      timeline: []
    };
    chantiersData.projects.unshift(project);
  }

  if (!Array.isArray(project.costs)) project.costs = [];
  if (!Array.isArray(project.timeline)) project.timeline = [];
  if (!Array.isArray(project.documents)) project.documents = [];
  project.clientId = project.clientId || row.chantierClientId || '';
  project.clientName = project.clientName || clientName;
  row.chantierId = project.id;
  return project;
}

function upsertChantierCost(project, row) {
  const rowId = row._id || `${row.date || ''}-${row.supplier || ''}-${row.invoiceNumber || ''}-${row.htva || 0}`;
  const costId = `purchase-${rowId}`;
  let item = project.costs.find(cost => String(cost.id || '') === costId);
  if (!item) {
    item = { id: costId };
    project.costs.push(item);
  }

  const htva = round2(row.htva);
  const vat = row.deductible ? round2(rowHtvaToVat(row.htva, row.rate)) : 0;
  const tvac = round2(rowHtvaToTvac(row.htva, row.rate));

  Object.assign(item, {
    date: row.date || '',
    ref: row.invoiceNumber || row.supplier || 'Achat',
    description: `${row.supplier || 'Achat'}${row.invoiceNumber ? ' • ' + row.invoiceNumber : ''}`,
    amount: htva,
    htva,
    vat,
    tvac,
    category: row.category || 'frais_generaux',
    supplier: row.supplier || '',
    source: 'comptabilite',
    purchaseId: rowId,
    chantierId: project.id,
    clientId: row.chantierClientId || project.clientId || '',
    pdfFileId: row.pdfFileId || '',
    pdfFileName: row.pdfFileName || ''
  });
}

function addChantierTimeline(project, text) {
  if (!Array.isArray(project.timeline)) project.timeline = [];
  if (!project.timeline.some(event => event.text === text)) {
    project.timeline.unshift({
      id: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      date: new Date().toISOString(),
      text
    });
  }
  project.timeline = project.timeline.slice(0, 100);
}

async function syncPurchasesToChantiers(saveDrive = false) {
  ensurePurchaseRowIds();
  const chantiersData = loadChantiersLocalData();
  let changed = false;
  const activePurchaseIds = new Set((data.purchases || []).map(row => row._id).filter(Boolean).map(id => `purchase-${id}`));

  (chantiersData.projects || []).forEach(project => {
    if (!Array.isArray(project.costs)) project.costs = [];
    const before = project.costs.length;
    project.costs = project.costs.filter(cost => cost.source !== 'comptabilite' || activePurchaseIds.has(String(cost.id || '')));
    if (project.costs.length !== before) changed = true;
  });

  (data.purchases || []).forEach(row => {
    if (!String(row.chantierSiteName || '').trim()) return;
    const project = findOrCreateChantierForPurchase(chantiersData, row);
    if (!project) return;
    upsertChantierCost(project, row);
    project.updatedAt = new Date().toISOString();
    addChantierTimeline(project, `Achat ${row.invoiceNumber || row.supplier || ''} synchronisé depuis Comptabilité.`);
    changed = true;
  });

  if (changed) {
    saveChantiersLocalData(chantiersData);
    if (saveDrive && googleAccessToken) {
      await saveChantiersSyncToDrive(false);
    }
  }
  return changed;
}

async function saveChantiersSyncToDrive(showErrorAlert = false) {
  if (!googleAccessToken) return false;
  try {
    const chantiersData = loadChantiersLocalData();
    const content = JSON.stringify(chantiersData, null, 2);
    const existing = await driveFilesList({
      spaces: 'appDataFolder',
      q: `name='${CHANTIERS_DRIVE_SYNC_FILE_NAME}' and trashed=false`,
      fields: 'files(id, name)'
    }, false);
    if (!existing) return false;
    const files = existing.result.files || [];
    const isUpdate = files.length > 0;
    const metadata = isUpdate
      ? { name: CHANTIERS_DRIVE_SYNC_FILE_NAME }
      : { name: CHANTIERS_DRIVE_SYNC_FILE_NAME, parents: ['appDataFolder'] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));
    const url = isUpdate
      ? `https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart&fields=id,name`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
    const res = await googleDriveFetch(url, {
      method: isUpdate ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${googleAccessToken}` },
      body: form
    }, false);
    return !!res && res.ok;
  } catch (error) {
    console.error(error);
    if (showErrorAlert) alert('La synchronisation des chantiers vers Google Drive a échoué.');
    return false;
  }
}

function purchaseVatDisplay(index) {
  const row = data.purchases[index];
  if (!row || !row.deductible) return 0;

  const key = [
    row.supplier || '',
    row.invoiceNumber || '',
    toNumber(row.rate),
    row.deductible ? '1' : '0'
  ].join('||');

  const groupIndexes = data.purchases
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => {
      const itemKey = [
        item.supplier || '',
        item.invoiceNumber || '',
        toNumber(item.rate),
        item.deductible ? '1' : '0'
      ].join('||');
      return itemKey === key;
    })
    .map(({ i }) => i);

  // Une seule ligne ou pas de numéro de facture : TVA simple
  if (groupIndexes.length <= 1 || !row.invoiceNumber) {
    return round2(rowHtvaToVat(row.htva, row.rate));
  }

  // Total HTVA du groupe
  const groupHtva = groupIndexes.reduce(
    (sum, i) => sum + toNumber(data.purchases[i].htva),
    0
  );

  const groupVat = round2(rowHtvaToVat(groupHtva, row.rate));

  let allocatedBefore = 0;

  for (let pos = 0; pos < groupIndexes.length; pos++) {
    const i = groupIndexes[pos];
    const lineHtva = toNumber(data.purchases[i].htva);

    if (pos === groupIndexes.length - 1) {
      const lastValue = round2(groupVat - allocatedBefore);
      if (i === index) return lastValue;
    } else {
      const proportional = groupHtva === 0
        ? 0
        : round2(groupVat * (lineHtva / groupHtva));

      if (i === index) return proportional;
      allocatedBefore += proportional;
    }
  }

  return 0;
}

function purchaseVatAllocated(index) {
  const row = data.purchases[index];
  if (!row || !row.deductible) return 0;

  const key = [
    row.supplier || '',
    row.invoiceNumber || '',
    toNumber(row.rate),
    row.deductible ? '1' : '0'
  ].join('||');

  const groupIndexes = data.purchases
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => {
      const itemKey = [
        item.supplier || '',
        item.invoiceNumber || '',
        toNumber(item.rate),
        item.deductible ? '1' : '0'
      ].join('||');
      return itemKey === key;
    })
    .map(({ i }) => i);

  if (groupIndexes.length <= 1 || !row.invoiceNumber) {
    return round2(rowHtvaToVat(row.htva, row.rate));
  }

  const groupHtva = groupIndexes.reduce(
    (sum, i) => sum + toNumber(data.purchases[i].htva),
    0
  );

  const groupVat = round2(rowHtvaToVat(groupHtva, row.rate));

  let allocatedBefore = 0;

  for (let pos = 0; pos < groupIndexes.length; pos++) {
    const i = groupIndexes[pos];
    const lineHtva = toNumber(data.purchases[i].htva);

    if (pos === groupIndexes.length - 1) {
      const lastValue = round2(groupVat - allocatedBefore);
      if (i === index) return lastValue;
    } else {
      const proportional = groupHtva === 0
        ? 0
        : round2(groupVat * (lineHtva / groupHtva));

      if (i === index) return proportional;
      allocatedBefore += proportional;
    }
  }

  return 0;
}

function computeAmortization(amount, startDate, durationMonths, currentYear) {
  const safeAmount = toNumber(amount);
  const safeDuration = Math.max(1, parseInt(durationMonths || 0, 10) || 1);
  const monthlyAmort = safeAmount / safeDuration;
  let amortYear = 0;
  let amortTotal = 0;

  if (!startDate) {
    return {
      amortYear: 0,
      amortTotal: 0,
      netValue: safeAmount,
      monthlyAmort
    };
  }

  const d = new Date(startDate + 'T00:00:00');
  if (isNaN(d)) {
    return {
      amortYear: 0,
      amortTotal: 0,
      netValue: safeAmount,
      monthlyAmort
    };
  }

  const purchaseYear = d.getFullYear();
  const purchaseMonth = d.getMonth() + 1;

  const firstDeductionYear = purchaseMonth === 12 ? purchaseYear + 1 : purchaseYear;
  const firstDeductionMonth = purchaseMonth === 12 ? 1 : purchaseMonth + 1;

  if (currentYear >= firstDeductionYear) {
    const monthsFromStartToEndOfCurrentYear =
      (currentYear - firstDeductionYear) * 12 + (12 - firstDeductionMonth + 1);

    const totalMonthsUsed = Math.max(
      0,
      Math.min(safeDuration, monthsFromStartToEndOfCurrentYear)
    );

    amortTotal = Math.min(safeAmount, monthlyAmort * totalMonthsUsed);

    if (currentYear === firstDeductionYear) {
      amortYear = Math.min(
        safeAmount,
        monthlyAmort * Math.min(safeDuration, 12 - firstDeductionMonth + 1)
      );
    } else {
      const monthsBeforeCurrentYear = Math.max(
        0,
        Math.min(
          safeDuration,
          (currentYear - firstDeductionYear - 1) * 12 + (12 - firstDeductionMonth + 1)
        )
      );
      const remainingAtStart = Math.max(0, safeDuration - monthsBeforeCurrentYear);
      amortYear = Math.min(safeAmount, monthlyAmort * Math.min(12, remainingAtStart));
    }
  }

  return {
    amortYear,
    amortTotal,
    netValue: Math.max(0, safeAmount - amortTotal),
    monthlyAmort
  };
}


function formatDateLocal(dateObj) {
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getQuarterBounds(year, quarter) {
  const q = Math.min(4, Math.max(1, parseInt(quarter || 1, 10) || 1));
  const y = parseInt(year || new Date().getFullYear(), 10) || new Date().getFullYear();
  const startMonth = (q - 1) * 3;
  const start = new Date(y, startMonth, 1);
  const end = new Date(y, startMonth + 3, 0);
  return {
    start: formatDateLocal(start),
    end: formatDateLocal(end)
  };
}

function nextBusinessDay(dateObj) {
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function defaultQuarterDueDate(year, quarter) {
  const y = parseInt(year || new Date().getFullYear(), 10) || new Date().getFullYear();
  const q = Math.min(4, Math.max(1, parseInt(quarter || 1, 10) || 1));
  const targetMonth = q * 3;
  const base = new Date(y, targetMonth, 25);
  return formatDateLocal(nextBusinessDay(base));
}

function quarterLabel(year, quarter) {
  return `T${quarter || 1} ${year || ''}`.trim();
}

function vatDeclarationTemplate(year = null, quarter = 1) {
  const currentYear = parseInt(year || data.company.period, 10) || new Date().getFullYear();
  const q = Math.min(4, Math.max(1, parseInt(quarter || 1, 10) || 1));
  const bounds = getQuarterBounds(currentYear, q);
  return {
    id: `vat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    regime: 'quarterly',
    year: currentYear,
    quarter: q,
    dueDate: defaultQuarterDueDate(currentYear, q),
    startDate: bounds.start,
    endDate: bounds.end,
    filed: false,
    filedDate: '',
    paid: false,
    paidDate: '',
    paymentAmount: 0,
    reimbursementRequested: false,
    closed: false,
    notes: '',
    manualBoxes: {
      '44': 0,
      '46': 0,
      '47': 0,
      '48': 0,
      '49': 0,
      '55': 0,
      '56': 0,
      '57': 0,
      '61': 0,
      '62': 0,
      '63': 0,
      '83': 0,
      '91': 0
    }
  };
}

function ensureDefaultVatQuarters(year) {
  if (!data.vat || !Array.isArray(data.vat.declarations)) return;
  const targetYear = parseInt(year || data.company.period, 10) || new Date().getFullYear();
  for (let q = 1; q <= 4; q += 1) {
    const exists = data.vat.declarations.some(dec => parseInt(dec.year, 10) === targetYear && parseInt(dec.quarter, 10) === q);
    if (!exists) {
      data.vat.declarations.push(vatDeclarationTemplate(targetYear, q));
    }
  }
}

function ensureVatStructures() {
  if (!data.vat || typeof data.vat !== 'object') data.vat = { declarations: [] };
  if (!Array.isArray(data.vat.declarations)) data.vat.declarations = [];
  ensureDefaultVatQuarters();
  data.vat.declarations.forEach(dec => {
    if (!dec.manualBoxes || typeof dec.manualBoxes !== 'object') {
      dec.manualBoxes = {};
    }
    ['44', '46', '47', '48', '49', '55', '56', '57', '61', '62', '63', '83', '91'].forEach(code => {
      if (typeof dec.manualBoxes[code] === 'undefined') dec.manualBoxes[code] = 0;
    });
    if (typeof dec.closed === 'undefined') dec.closed = false;
    if (typeof dec.filed === 'undefined') dec.filed = false;
    if (typeof dec.paid === 'undefined') dec.paid = false;
    if (typeof dec.paymentAmount === 'undefined') dec.paymentAmount = 0;
    if (typeof dec.reimbursementRequested === 'undefined') dec.reimbursementRequested = false;
    const bounds = getQuarterBounds(dec.year, dec.quarter);
    dec.startDate = bounds.start;
    dec.endDate = bounds.end;
    if (!dec.dueDate) dec.dueDate = defaultQuarterDueDate(dec.year, dec.quarter);
  });
}

function addVatDeclaration() {
  ensureVatStructures();
  const currentYear = parseInt(data.company.period, 10) || new Date().getFullYear();
  const existingQuarters = data.vat.declarations
    .filter(dec => parseInt(dec.year, 10) === currentYear)
    .map(dec => parseInt(dec.quarter, 10))
    .filter(Number.isFinite);
  const nextQuarter = [1, 2, 3, 4].find(q => !existingQuarters.includes(q)) || 1;
  data.vat.declarations.push(vatDeclarationTemplate(currentYear, nextQuarter));
  expandedVatDeclarationId = data.vat.declarations[data.vat.declarations.length - 1].id;
  sortVatDeclarations();
  saveData(false);
}

function sortVatDeclarations() {
  ensureVatStructures();
  data.vat.declarations.sort((a, b) => {
    const aDate = `${a.startDate || ''}`;
    const bDate = `${b.startDate || ''}`;
    return aDate.localeCompare(bDate);
  });
}

function syncVatDeclarationPeriod(index) {
  const row = data.vat.declarations[index];
  if (!row) return;
  const bounds = getQuarterBounds(row.year, row.quarter);
  row.startDate = bounds.start;
  row.endDate = bounds.end;
  if (!row.dueDate) row.dueDate = defaultQuarterDueDate(row.year, row.quarter);
  sortVatDeclarations();
  saveData(false);
}

function deleteVatDeclaration(index) {
  if (!confirm('Supprimer cette déclaration TVA ?')) return;
  data.vat.declarations.splice(index, 1);
  saveData(false);
}


function toggleVatDeclarationExpanded(id) {
  expandedVatDeclarationId = expandedVatDeclarationId === id ? '' : id;
  render();
}

function toggleVatExtraCodes(id) {
  const dec = (data.vat?.declarations || []).find(item => item.id === id);
  if (!dec || dec.closed) return;
  dec.showExtraCodes = !dec.showExtraCodes;
  saveData(false);
}

function setVatClosed(index, checked) {
  const dec = data.vat.declarations[index];
  if (!dec) return;
  dec.closed = !!checked;
  if (dec.closed) {
    dec.showExtraCodes = false;
  }
  saveData(false);
}

function isDateInRange(value, startDate, endDate) {
  if (!value) return false;
  return value >= startDate && value <= endDate;
}

function getClosedVatDeclarationForDate(value) {
  if (!value || !data.vat || !Array.isArray(data.vat.declarations)) return null;
  return data.vat.declarations.find(dec => {
    if (!dec || !dec.closed) return false;
    const bounds = getQuarterBounds(dec.year, dec.quarter);
    return isDateInRange(value, dec.startDate || bounds.start, dec.endDate || bounds.end);
  }) || null;
}

function getVatLockMessage(dec) {
  return `Cette ligne appartient à la période TVA ${quarterLabel(dec.year, dec.quarter)} clôturée. Décoche « Clôturé » dans l’onglet TVA pour modifier les ventes ou achats de cette période.`;
}

function updateAccountingRowField(collection, index, field, value, options = {}) {
  const row = data[collection]?.[index];
  if (!row) return false;

  const currentLockedDec = getClosedVatDeclarationForDate(row.date || '');
  if (currentLockedDec) {
    alert(getVatLockMessage(currentLockedDec));
    render();
    return false;
  }

  if (field === 'date') {
    const targetLockedDec = getClosedVatDeclarationForDate(value || '');
    if (targetLockedDec) {
      alert(getVatLockMessage(targetLockedDec));
      render();
      return false;
    }
  }

  if (options.type === 'number') {
    row[field] = parseFloat(value) || 0;
  } else if (options.type === 'boolean') {
    row[field] = value === true || value === 'true';
  } else {
    row[field] = value;
  }

  if (options.sort) sortByDate(data[collection]);
  saveData(false);
  if (collection === 'purchases') syncPurchasesToChantiers(false);
  return true;
}

function deleteAccountingRow(collection, index) {
  const row = data[collection]?.[index];
  const lockedDec = getClosedVatDeclarationForDate(row?.date || '');
  if (lockedDec) {
    alert(getVatLockMessage(lockedDec));
    return;
  }
  if (!confirm('Supprimer cette ligne ?')) return;
  data[collection].splice(index, 1);
  saveData(false);
  if (collection === 'purchases') syncPurchasesToChantiers(false);
}

function getPeriodSales(startDate, endDate) {
  return data.sales.filter(row => isDateInRange(row.date, startDate, endDate));
}

function getPeriodPurchases(startDate, endDate) {
  return data.purchases.filter(row => isDateInRange(row.date, startDate, endDate));
}

function computeVatDeclaration(dec, previousCredit = 0) {
  const startDate = dec.startDate || getQuarterBounds(dec.year, dec.quarter).start;
  const endDate = dec.endDate || getQuarterBounds(dec.year, dec.quarter).end;
  const salesRows = getPeriodSales(startDate, endDate);
  const purchaseRows = getPeriodPurchases(startDate, endDate);

  const baseByRate = { '01': 0, '02': 0, '03': 0 };
  const vatByRate = { '54': 0 };

  salesRows.forEach(row => {
    const rate = round2(row.rate);
    const base = round2(salesRowNet(row));
    const vat = round2(salesRowVat(row));
    if (rate === 6) baseByRate['01'] += base;
    else if (rate === 12) baseByRate['02'] += base;
    else if (rate === 21) baseByRate['03'] += base;
    vatByRate['54'] += vat;
  });

  const purchases81 = purchaseRows.reduce((sum, row) => sum + (row.category === 'marchandise' ? toNumber(row.htva) : 0), 0);
  const purchases82 = purchaseRows.reduce((sum, row) => sum + ((row.category || 'frais_generaux') !== 'marchandise' ? toNumber(row.htva) : 0), 0);
  const deductibleVat = data.purchases
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => isDateInRange(row.date, startDate, endDate) && row.deductible)
    .reduce((sum, { i }) => sum + purchaseVatDisplay(i), 0);

  const boxes = {
    '01': round2(baseByRate['01']),
    '02': round2(baseByRate['02']),
    '03': round2(baseByRate['03']),
    '44': round2(dec.manualBoxes?.['44']),
    '46': round2(dec.manualBoxes?.['46']),
    '47': round2(dec.manualBoxes?.['47']),
    '48': round2(dec.manualBoxes?.['48']),
    '49': round2(dec.manualBoxes?.['49']),
    '54': round2(vatByRate['54']),
    '55': round2(dec.manualBoxes?.['55']),
    '56': round2(dec.manualBoxes?.['56']),
    '57': round2(dec.manualBoxes?.['57']),
    '59': round2(deductibleVat),
    '61': round2(dec.manualBoxes?.['61']),
    '62': round2(dec.manualBoxes?.['62']),
    '63': round2(dec.manualBoxes?.['63']),
    '71': 0,
    '72': 0,
    '81': round2(purchases81),
    '82': round2(purchases82),
    '83': round2(dec.manualBoxes?.['83']),
    '91': round2(dec.manualBoxes?.['91'])
  };

  const taxDue = boxes['54'] + boxes['55'] + boxes['56'] + boxes['57'] + boxes['61'];
  const deductibleTotal = boxes['59'] + boxes['62'] + boxes['63'] + previousCredit;
  const net = round2(taxDue - deductibleTotal);
  boxes['71'] = net > 0 ? net : 0;
  boxes['72'] = net < 0 ? Math.abs(net) : 0;

  return {
    startDate,
    endDate,
    previousCredit: round2(previousCredit),
    boxes,
    salesCount: salesRows.length,
    purchaseCount: purchaseRows.length,
    salesVat: round2(vatByRate['54']),
    deductibleVat: round2(deductibleVat),
    dueAmount: boxes['71'],
    creditAmount: boxes['72']
  };
}

function getVatSituationText(dec, computed, outstanding) {
  const parts = [];
  if (computed.dueAmount > 0) {
    if (dec.paid && outstanding <= 0.009) {
      parts.push(`TVA payée : ${money(toNumber(dec.paymentAmount) || computed.dueAmount)}`);
    } else if (dec.paid && outstanding > 0.009) {
      parts.push(`TVA partiellement payée : ${money(dec.paymentAmount)} / solde ${money(outstanding)}`);
    } else {
      parts.push(`TVA à payer : ${money(computed.dueAmount)}`);
    }
  }
  if (computed.creditAmount > 0) {
    parts.push(dec.reimbursementRequested
      ? `Crédit TVA avec remboursement demandé : ${money(computed.creditAmount)}`
      : `Crédit TVA à reporter : ${money(computed.creditAmount)}`);
  }
  if (!parts.length) parts.push('TVA équilibrée');
  return parts.join(' · ');
}

function computeVatLedger() {
  ensureVatStructures();
  sortVatDeclarations();
  let carryCredit = toNumber(data.settings.vatCarryover);
  const rows = data.vat.declarations.map(dec => {
    const computed = computeVatDeclaration(dec, carryCredit);
    carryCredit = computed.creditAmount;
    const paymentAmount = round2(dec.paymentAmount);
    const outstanding = computed.dueAmount > 0 ? round2(Math.max(0, computed.dueAmount - paymentAmount)) : 0;
    return {
      declaration: dec,
      computed,
      outstanding
    };
  });

  const unfiled = rows.filter(row => !row.declaration.filed);
  const filedUnpaid = rows.filter(row => row.declaration.filed && row.outstanding > 0.009);

  return {
    rows,
    totalDueOpen: round2(rows.reduce((sum, row) => sum + row.outstanding, 0)),
    totalUnfiledDue: round2(unfiled.reduce((sum, row) => sum + row.computed.dueAmount, 0)),
    totalUnfiledCredit: round2(unfiled.reduce((sum, row) => sum + row.computed.creditAmount, 0)),
    totalFiledUnpaid: round2(filedUnpaid.reduce((sum, row) => sum + row.outstanding, 0))
  };
}

function totals() {
  const salesNet = data.sales.reduce((sum, row) => sum + salesRowNet(row), 0);
  const salesVat = data.sales.reduce((sum, row) => sum + salesRowVat(row), 0);
  const currentYear = parseInt(data.company.period, 10) || new Date().getFullYear();

  const purchasesNet = data.purchases.reduce(
    (sum, row) => sum + toNumber(row.htva),
    0
  );

  const purchasesVat = (() => {
    const groups = {};

    data.purchases.forEach(row => {
      if (!row.deductible) return;

      const key = [
        row.supplier || '',
        row.invoiceNumber || '',
        toNumber(row.rate)
      ].join('||');

      if (!groups[key]) {
        groups[key] = {
          htva: 0,
          rate: toNumber(row.rate)
        };
      }

      groups[key].htva += toNumber(row.htva);
    });

    return Object.values(groups).reduce((sum, g) => {
      return sum + round2(rowHtvaToVat(g.htva, g.rate));
    }, 0);
  })();

  const purchasesMerchandiseNet = data.purchases.reduce(
    (sum, row) => sum + (row.category === 'marchandise' ? toNumber(row.htva) : 0),
    0
  );

  const purchasesGeneralNet = data.purchases.reduce(
    (sum, row) => sum + (row.category === 'frais_generaux' ? toNumber(row.htva) : 0),
    0
  );

  const investmentComputed = data.investments.map((row) => {
    const amount = toNumber(row.amount);
    const durationMonths = Math.max(1, parseInt(row.durationMonths || 60, 10));
    const amort = computeAmortization(amount, row.date, durationMonths, currentYear);

    return {
      date: row.date || '',
      supplier: row.supplier || '',
      invoiceNumber: row.invoiceNumber || '',
      description: row.description || '',
      amount,
      durationMonths,
      amortYear: amort.amortYear,
      amortTotal: amort.amortTotal,
      netValue: amort.netValue
    };
  });

  const assetsComputed = data.assets.map((row) => {
    const amount = toNumber(row.amount);
    const durationMonths = Math.max(1, parseInt(row.durationMonths || 60, 10));
    const amort = computeAmortization(amount, row.date, durationMonths, currentYear);

    return {
      date: row.date || '',
      supplier: row.supplier || '',
      invoiceNumber: row.invoiceNumber || '',
      description: row.description || '',
      label: row.label || '',
      amount,
      durationMonths,
      amortYear: amort.amortYear,
      amortTotal: amort.amortTotal,
      netValue: amort.netValue
    };
  });

  const assetsGross = assetsComputed.reduce((sum, row) => sum + row.amount, 0);

  const yearlyAmort = investmentComputed.reduce((sum, row) => sum + row.amortYear, 0);

  const totalAmortized =
    assetsComputed.reduce((sum, row) => sum + row.amortTotal, 0);

  const stockValue = data.stock.reduce((sum, row) => sum + toNumber(row.quantity) * toNumber(row.unitPrice), 0);
  const lossesTotal = data.losses.reduce((sum, row) => sum + toNumber(row.quantity) * toNumber(row.unitPrice), 0);
  const kmTotal = data.km.reduce((sum, row) => sum + toNumber(row.km) * toNumber(row.trips || 1), 0);

  const carryover = toNumber(data.settings.vatCarryover);

  const totalCharges = purchasesNet + yearlyAmort + lossesTotal;
  const estimatedProfit = salesNet - totalCharges;
  const netVat = salesVat - purchasesVat - carryover;

  const totalVatPaid = data.vat.declarations
    .reduce((sum, dec) => sum + (dec.paymentAmount || 0), 0);

  const realVat = netVat - totalVatPaid;

  const netFixedAssets = assetsGross - totalAmortized;

  const liquidities =
    toNumber(data.settings.bankBalance) +
    toNumber(data.settings.cashBalance);

  const receivableVat = realVat < 0 ? Math.abs(realVat) : 0;
  const payableVat = realVat > 0 ? realVat : 0;
  const resultRetained = estimatedProfit;

  const assetsSide = netFixedAssets + stockValue + receivableVat + liquidities;
  const liabilitiesSide =
    toNumber(data.settings.capitalStart) +
    toNumber(data.settings.retainedEarnings) +
    resultRetained +
    payableVat;

  return {
    salesNet,
    salesVat,
    purchasesNet,
    purchasesVat,
    purchasesMerchandiseNet,
    purchasesGeneralNet,
    investmentComputed,
    assetsComputed,
    assetsGross,
    yearlyAmort,
    totalAmortized,
    stockValue,
    lossesTotal,
    kmTotal,
    totalCharges,
    estimatedProfit,
    netVat,
    realVat,
    netFixedAssets,
    liquidities,
    receivableVat,
    payableVat,
    assetsSide,
    liabilitiesSide
  };
}

function setField(path, value) {
  const keys = path.split('.');
  let ref = data;
  for (let i = 0; i < keys.length - 1; i++) ref = ref[keys[i]];
  ref[keys[keys.length - 1]] = value;
  saveData(false);
}

function sortByDate(array) {
  array.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date); // + récent en haut
  });
}

function addRow(key, row) {
  if (key === 'purchases' && row && !row._id) {
    row._id = `purchase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    row.chantierClientName = row.chantierClientName || '';
    row.chantierSiteName = row.chantierSiteName || '';
  }
  data[key].push(row);

  // Tri automatique
  if (key === 'purchases' || key === 'sales') {
    sortByDate(data[key]);
  }

  saveData(false);
  if (key === 'purchases') syncPurchasesToChantiers(false);
}

function deleteRow(key, index) {
  if ((key === 'sales' || key === 'purchases') && getClosedVatDeclarationForDate(data[key]?.[index]?.date || '')) {
    alert(getVatLockMessage(getClosedVatDeclarationForDate(data[key]?.[index]?.date || '')));
    return;
  }
  if (!confirm('Supprimer cette ligne ?')) return;
  data[key].splice(index, 1);
  saveData(false);
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = pageDefs.map(page => `
        <button class="tab ${activePage === page.key ? 'active' : ''}" onclick="activePage='${page.key}'; render()">${page.label}</button>
      `).join('');
}

function renderPages() {
  const wrap = document.getElementById('pages');
  wrap.innerHTML = `
        ${renderDashboard()}
        ${renderSales()}
        ${renderPurchases()}
        ${renderVat()}
        ${renderInvestments()}
        ${renderAssets()}
        ${renderStock()}
        ${renderLosses()}
        ${renderKm()}
        ${renderResult()}
        ${renderBalance()}
        ${renderGoogleDrive()}
        ${renderSettings()}
      `;
}

function renderDashboard() {
  const t = totals();
  return `
        <section class="page two-cols ${activePage === 'dashboard' ? 'active' : ''}">
          <div class="card">
            <div class="section-head">
              <div>
                <h2>Vue d'ensemble</h2>
              </div>
            </div>
            <div class="grid-2">
              <div class="muted-box">
                <strong>Société :</strong> ${escapeHtml(data.company.name || '—')}<br>
                <strong>Période :</strong> ${escapeHtml(data.company.period)}<br>
                <strong>Lignes achats :</strong> ${data.purchases.length}<br>
                <strong>Lignes ventes :</strong> ${data.sales.length}<br>
                <strong>Investissements :</strong> ${t.investmentComputed.length}<br>
                <strong>Immobilisations manuelles :</strong> ${data.assets.length}<br>
                <strong>Km encodés :</strong> ${num(t.kmTotal, 0)} km
              </div>
              <div class="muted-box">
                <strong>TVA ventes :</strong> ${money(t.salesVat)}<br>
                <strong>TVA achats récupérable :</strong> ${money(t.purchasesVat)}<br>
                <strong>Report TVA :</strong> ${money(data.settings.vatCarryover)}<br>
                <strong>Stock estimé :</strong> ${money(t.stockValue)}
              </div>
            </div>
          </div>
          <div class="card">
            <div class="section-head"><h3>Contrôle rapide</h3></div>
            <div class="kv"><span>TVA nette</span><span class="${t.netVat > 0 ? 'status-bad' : 'status-good'}">${money(t.netVat)}</span></div>
            <div class="kv"><span>Actif simplifié</span><span>${money(t.assetsSide)}</span></div>
            <div class="kv"><span>Passif simplifié</span><span>${money(t.liabilitiesSide)}</span></div>
            <div class="kv"><span>Écart bilan</span><span class="${Math.abs(t.assetsSide - t.liabilitiesSide) < 0.01 ? 'status-good' : 'status-bad'}">${money(t.assetsSide - t.liabilitiesSide)}</span></div>
            <div class="kv"><span>Résultat estimé</span><span class="${t.estimatedProfit >= 0 ? 'status-good' : 'status-bad'}">${money(t.estimatedProfit)}</span></div>
          </div>
        </section>
      `;
}

function renderSales() {
  const t = totals();
  return renderTablePage({
    key: 'sales',
    title: 'Journal des ventes',
    hint: '',
    addLabel: 'Ajouter une vente',
    onAdd: `addRow('sales', { date: '', client: '', invoiceNumber: '', rate: 21, tvac: 0, documentType: 'invoice', documentStatus: 'sent' })`,
    tableAttrs: `class="table-sales"`,
    headers: ['Date', 'Client', 'N° Facture', 'Type', 'Taux TVA', 'TVAC', 'HTVA', 'TVA', 'Facture', ''],
    rows: data.sales.map((row, i) => {
      const hasInvoiceNumber = String(row.invoiceNumber || '').trim();
      const invoiceButton = hasInvoiceNumber
        ? `<button type="button" class="invoice-preview-btn" onclick="openSalesInvoicePreview('${escapeAttr(row.invoiceNumber || '')}')">Aperçu</button>`
        : '<span class="hint">&mdash;</span>';
      const lockedDec = getClosedVatDeclarationForDate(row.date || '');
      const locked = !!lockedDec;
      const lockAttr = locked ? 'disabled title="Période TVA clôturée"' : '';
      return `
  <tr ${locked ? 'title="Période TVA clôturée : ligne verrouillée"' : ''}>
    <td><input type="date" value="${escapeAttr(row.date)}" ${lockAttr} onchange="updateAccountingRowField('sales', ${i}, 'date', this.value, { sort: true })"></td>
    <td><input value="${escapeAttr(row.client)}" ${lockAttr} onchange="updateAccountingRowField('sales', ${i}, 'client', this.value)"></td>
    <td><input value="${escapeAttr(row.invoiceNumber || '')}" ${lockAttr} onchange="updateAccountingRowField('sales', ${i}, 'invoiceNumber', this.value)"></td>
    <td>${escapeHtml(getInvoiceImportTypeLabel(row))}</td>
    <td><input type="number" step="0.01" value="${num(row.rate)}" ${lockAttr} onchange="updateAccountingRowField('sales', ${i}, 'rate', this.value, { type: 'number' })"></td>
    <td><input type="number" step="0.01" value="${num(salesRowTvac(row))}" ${lockAttr} onchange="updateAccountingRowField('sales', ${i}, 'tvac', this.value, { type: 'number' })"></td>
    <td>${money(salesRowNet(row))}</td>
    <td>${money(salesRowVat(row))}</td>
    <td>${invoiceButton}</td>
    <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" ${locked ? 'disabled' : ''} onclick="deleteAccountingRow('sales', ${i})">×</button></td>
  </tr>
`}).join(''),
    footer: `
  <div class="kv"><span>Total ventes HTVA</span><span>${money(t.salesNet)}</span></div>
  <div class="kv"><span>Total TVA ventes</span><span>${money(t.salesVat)}</span></div>
`
  });
}

function renderPurchases() {
  const t = totals();
  return `
    <section class="page ${activePage === 'purchases' ? 'active' : ''}">
      <div class="card">
        <div class="section-head">
          <div>
            <h2>Journal des achats</h2>
            <div class="hint">Chaque ligne garde le montant HTVA, le taux, le caractère déductible de la TVA et le PDF de la facture si disponible.</div>
          </div>
          <div class="inline-actions">
            <button class="primary" onclick="addRow('purchases', { date: '', supplier: '', invoiceNumber: '', rate: 21, htva: 0, category: 'frais_generaux', deductible: true, pdfFileId: '', pdfFileName: '' })">Ajouter un achat</button>
            <button type="button" onclick="loadPurchasePdfDriveFiles(true).then(() => render())">Actualiser les PDF</button>
          </div>
        </div>

        <div style="overflow:auto;">
          <table class="table-purchases" style="table-layout:fixed; width:100%;">
            <colgroup>
  <col style="width: 115px;">
  <col style="width: 160px;">
  <col style="width: 135px;">
  <col style="width: 95px;">
  <col style="width: 85px;">
  <col style="width: 100px;">
  <col style="width: 90px;">
  <col style="width: 90px;">
  <col style="width: 90px;">
  <col style="width: 150px;">
  <col style="width: 55px;">
</colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Fournisseur</th>
                <th>N° Facture</th>
                <th>Type</th>
                <th>Taux TVA</th>
                <th>HTVA</th>
                <th>Déductible TVA</th>
                <th>TVA récup.</th>
                <th>TVAC</th>
                <th>Facture PDF</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${data.purchases.map((row, i) => {
    const linkedPdf = getPurchasePdfFileById(row.pdfFileId) || (row.pdfFileId ? { id: row.pdfFileId, name: row.pdfFileName || 'PDF lié' } : null);
    const lockedDec = getClosedVatDeclarationForDate(row.date || '');
    const locked = !!lockedDec;
    const lockAttr = locked ? 'disabled title="Période TVA clôturée"' : '';
    return `
                <tr ${locked ? 'title="Période TVA clôturée : ligne verrouillée"' : ''}>
                  <td><input type="date" value="${escapeAttr(row.date)}" ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'date', this.value, { sort: true })"></td>
                  <td><input value="${escapeAttr(row.supplier)}" ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'supplier', this.value)"></td>
                  <td><input value="${escapeAttr(row.invoiceNumber || '')}" ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'invoiceNumber', this.value)"></td>
                  <td>
                    <select ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'category', this.value)">
                      <option value="marchandise" ${row.category === 'marchandise' ? 'selected' : ''}>Marchandise</option>
                      <option value="frais_generaux" ${(row.category || 'frais_generaux') === 'frais_generaux' ? 'selected' : ''}>Frais généraux</option>
                    </select>
                  </td>
                  <td><input type="number" step="0.01" value="${num(row.rate)}" ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'rate', this.value, { type: 'number' })"></td>
                  <td><input type="number" step="0.01" value="${num(row.htva)}" ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'htva', this.value, { type: 'number' })"></td>
                  <td>
                    <select ${lockAttr} onchange="updateAccountingRowField('purchases', ${i}, 'deductible', this.value, { type: 'boolean' })">
                      <option value="true" ${row.deductible ? 'selected' : ''}>Oui</option>
                      <option value="false" ${!row.deductible ? 'selected' : ''}>Non</option>
                    </select>
                  </td>
                  <td>${money(row.deductible ? purchaseVatDisplay(i) : 0)}</td>
                  <td>${money(rowHtvaToTvac(row.htva, row.rate))}</td>
                  <td>
                    <div class="inline-actions">
                      <button type="button" ${locked ? 'disabled' : ''} onclick="pickPurchasePdf(${i})">Ajouter</button>
                      ${linkedPdf ? `<button type="button" onclick='openPurchasePdf(${JSON.stringify(linkedPdf.id)})'>Voir</button>` : '<span class="hint">—</span>'}
                    </div>
                  </td>
                  <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" ${locked ? 'disabled' : ''} onclick="deleteAccountingRow('purchases', ${i})">×</button></td>
                </tr>
              `}).join('')}
            </tbody>
          </table>
        </div>

        <div style="margin-top: 14px;">
          <div class="kv"><span>Total achats en charges</span><span>${money(t.purchasesNet)}</span></div>
          <div class="kv"><span>dont frais généraux</span><span>${money(t.purchasesGeneralNet)}</span></div>
          <div class="kv"><span>dont marchandises</span><span>${money(t.purchasesMerchandiseNet)}</span></div>
          <div class="kv"><span>Total TVA récupérable</span><span>${money(t.purchasesVat)}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <h3>Factures PDF d’achat sur Google Drive</h3>
            <div class="hint">Liste des PDF ajoutés depuis les lignes d’achat. Tu peux les consulter ou les supprimer.</div>
          </div>
          <button type="button" onclick="loadPurchasePdfDriveFiles(true).then(() => render())">Actualiser</button>
        </div>
        ${renderPurchasePdfList()}
      </div>
    </section>
  `;
}

function renderInvestments() {
  const t = totals();
  return renderTablePage({
    key: 'investments',
    title: 'Investissements',
    hint: 'Les investissements sont encodés directement ici, sans passer par les achats.',
    addLabel: 'Ajouter un investissement',
    onAdd: `addRow('investments', { date: '', supplier: '', invoiceNumber: '', description: '', amount: 0, durationMonths: 60 })`,
    tableAttrs: `style="table-layout:fixed; width:100%;"`,
    colgroup: `
    <colgroup>
      <col style="width: 110px;">
      <col style="width: 110px;">
      <col style="width: 100px;">
      <col style="width: 180px;">
      <col style="width: 90px;">
      <col style="width: 75px;">
      <col style="width: 75px;">
      <col style="width: 75px;">
      <col style="width: 75px;">
      <col style="width: 75px;">
    </colgroup>
  `,
    headers: ['Date achat', 'Fournisseur', 'N° facture', 'Description', 'Montant HTVA', 'Durée (mois)', 'Amorti année', 'Amorti total', 'Valeur restante', ''],

    rows: t.investmentComputed.map((row, i) => `
      <tr>
  <tr>
  <td><input type="date" value="${escapeAttr(row.date)}" onchange="data.investments[${i}].date=this.value; saveData(false)"></td>

  <td><input value="${escapeAttr(data.investments[i].supplier || '')}" onchange="data.investments[${i}].supplier=this.value; saveData(false)"></td>

  <td><input value="${escapeAttr(data.investments[i].invoiceNumber || '')}" onchange="data.investments[${i}].invoiceNumber=this.value; saveData(false)"></td>

  <td><input value="${escapeAttr(data.investments[i].description || '')}" onchange="data.investments[${i}].description=this.value; saveData(false)"></td>

  <td><input type="number" step="0.01" value="${num(row.amount)}" onchange="data.investments[${i}].amount=parseFloat(this.value)||0; saveData(false)"></td>

  <td><input type="number" min="1" step="1" value="${parseInt(row.durationMonths || 60, 10)}" onchange="data.investments[${i}].durationMonths=parseInt(this.value,10)||1; saveData(false)"></td>

  <td>${money(row.amortYear)}</td>
  <td>${money(row.amortTotal)}</td>
  <td>${money(row.netValue)}</td>

  <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" onclick="deleteRow('investments', ${i})">×</button></td>
</tr>
</tr>
    `).join('') || `<tr><td colspan="8">Aucun investissement encodé.</td></tr>`,
    footer: `
      <div class="kv"><span>Total investissements HTVA</span><span>${money(t.investmentComputed.reduce((sum, row) => sum + row.amount, 0))}</span></div>
      <div class="kv"><span>Total amortissements investissements de l'année</span><span>${money(t.investmentComputed.reduce((sum, row) => sum + row.amortYear, 0))}</span></div>
      <div class="kv"><span>Total amorti cumulé investissements</span><span>${money(t.investmentComputed.reduce((sum, row) => sum + row.amortTotal, 0))}</span></div>
    `
  });
}

function renderAssets() {
  const t = totals();
  return renderTablePage({
    key: 'assets',
    title: 'Immobilisations',
    hint: 'Encodage direct des investissements et immobilisations.',
    addLabel: 'Ajouter une immobilisation',
    onAdd: `addRow('assets', { date: '', supplier: '', invoiceNumber: '', description: '', label: '', amount: 0, durationMonths: 60 })`,
    headers: ['Date', 'Libellé', 'Fournisseur', 'Montant HTVA', 'Durée (mois)', 'Amorti année', 'Amorti total', 'Valeur nette', ''],
    rows: t.assetsComputed.map((row, i) => `
      <tr>
        <td><input type="date" value="${escapeAttr(row.date)}" onchange="data.assets[${i}].date=this.value; saveData(false)"></td>
        <td><input value="${escapeAttr(row.label)}" onchange="data.assets[${i}].label=this.value; saveData(false)"></td>
        <td><input value="${escapeAttr(data.assets[i].supplier || '')}" onchange="data.assets[${i}].supplier=this.value; saveData(false)"></td>
        <td><input type="number" step="0.01" value="${num(row.amount)}" onchange="data.assets[${i}].amount=parseFloat(this.value)||0; saveData(false)"></td>
        <td><input type="number" min="1" step="1" value="${parseInt(row.durationMonths || 60, 10)}" onchange="data.assets[${i}].durationMonths=parseInt(this.value,10)||1; saveData(false)"></td>
        <td>${money(row.amortYear)}</td>
        <td>${money(row.amortTotal)}</td>
        <td>${money(row.netValue)}</td>
        <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" onclick="deleteRow('assets', ${i})">×</button></td>
      </tr>
    `).join('') || `<tr><td colspan="9">Aucune immobilisation encodée.</td></tr>`,
    footer: `
      <div class="kv"><span>Total immobilisations</span><span>${money(t.assetsComputed.reduce((sum, row) => sum + row.amount, 0))}</span></div>
<div class="kv"><span>Amortissement annuel</span><span>${money(t.assetsComputed.reduce((sum, row) => sum + row.amortYear, 0))}</span></div>
<div class="kv"><span>Amortissement cumulé</span><span>${money(t.assetsComputed.reduce((sum, row) => sum + row.amortTotal, 0))}</span></div>
<div class="kv"><span>Valeur nette</span><span>${money(t.assetsComputed.reduce((sum, row) => sum + row.netValue, 0))}</span></div>
    `
  });
}

function renderStock() {
  const t = totals();
  return renderTablePage({
    key: 'stock',
    title: 'Stock matériaux',
    hint: 'Le stock est valorisé en quantité x prix unitaire.',
    addLabel: 'Ajouter une ligne de stock',
    onAdd: `addRow('stock', { label: '', quantity: 0, unitPrice: 0 })`,
    headers: ['Libellé', 'Quantité', 'Prix unitaire', 'Valeur', ''],
    rows: data.stock.map((row, i) => `
          <tr>
            <td><input value="${escapeAttr(row.label)}" onchange="data.stock[${i}].label=this.value; saveData(false)"></td>
            <td><input type="number" step="0.01" value="${num(row.quantity)}" onchange="data.stock[${i}].quantity=parseFloat(this.value)||0; saveData(false)"></td>
            <td><input type="number" step="0.01" value="${num(row.unitPrice, 4)}" onchange="data.stock[${i}].unitPrice=parseFloat(this.value)||0; saveData(false)"></td>
            <td>${money(toNumber(row.quantity) * toNumber(row.unitPrice))}</td>
            <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" onclick="deleteRow('stock', ${i})">×</button></td>
          </tr>
        `).join(''),
    footer: `<div class="kv"><span>Valeur totale du stock</span><span>${money(t.stockValue)}</span></div>`
  });
}

function renderLosses() {
  const t = totals();
  return renderTablePage({
    key: 'losses',
    title: 'Pertes et charges diverses',
    hint: 'Pour les charges non reprises dans les achats classiques : cotisations sociales, pertes ou autres frais spécifiques.',
    addLabel: 'Ajouter une charge',
    onAdd: `addRow('losses', { date: '', label: '', quantity: 1, unitPrice: 0 })`,
    headers: ['Date', 'Libellé', 'Quantité', 'Montant unitaire', 'Total', ''],
    rows: data.losses.map((row, i) => `
          <tr>
            <td><input type="date" value="${escapeAttr(row.date)}" onchange="data.losses[${i}].date=this.value; saveData(false)"></td>
            <td><input value="${escapeAttr(row.label)}" onchange="data.losses[${i}].label=this.value; saveData(false)"></td>
            <td><input type="number" step="0.01" value="${num(row.quantity)}" onchange="data.losses[${i}].quantity=parseFloat(this.value)||0; saveData(false)"></td>
            <td><input type="number" step="0.01" value="${num(row.unitPrice)}" onchange="data.losses[${i}].unitPrice=parseFloat(this.value)||0; saveData(false)"></td>
            <td>${money(toNumber(row.quantity) * toNumber(row.unitPrice))}</td>
            <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" onclick="deleteRow('losses', ${i})">×</button></td>
          </tr>
        `).join(''),
    footer: `<div class="kv"><span>Total pertes / charges diverses</span><span>${money(t.lossesTotal)}</span></div>`
  });
}

function renderKm() {
  const t = totals();
  return renderTablePage({
    key: 'km',
    title: 'Kilomètres',
    addLabel: 'Ajouter un déplacement',
    onAdd: `addRow('km', { date: '', person: '', route: '', km: 0, trips: 1 })`,
    headers: ['Date', 'Personne', 'Trajet', 'Km', 'Nb déplacements', 'Km totaux', ''],
    rows: data.km.map((row, i) => `
          <tr>
            <td><input type="date" value="${escapeAttr(row.date)}" onchange="data.km[${i}].date=this.value; saveData(false)"></td>
            <td><input value="${escapeAttr(row.person)}" onchange="data.km[${i}].person=this.value; saveData(false)"></td>
            <td><input value="${escapeAttr(row.route)}" onchange="data.km[${i}].route=this.value; saveData(false)"></td>
            <td><input type="number" step="0.01" value="${num(row.km)}" onchange="data.km[${i}].km=parseFloat(this.value)||0; saveData(false)"></td>
            <td><input type="number" step="0.01" value="${num(row.trips)}" onchange="data.km[${i}].trips=parseFloat(this.value)||0; saveData(false)"></td>
            <td>${num(toNumber(row.km) * toNumber(row.trips), 2)} km</td>
            <td><button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" onclick="deleteRow('km', ${i})">×</button></td>
          </tr>
        `).join(''),
    footer: `<div class="kv"><span>Total kilomètres</span><span>${num(t.kmTotal, 2)} km</span></div>`
  });
}

function renderResult() {
  const t = totals();
  const taxAndSocial = t.lossesTotal;
  const exemptionThreshold = toNumber(data.settings.socialExemptionThreshold || 1881.76);
  const contributionRate = toNumber(data.settings.socialContributionRate || 20.5);
  const contributionFeeRate = toNumber(data.settings.socialContributionFeeRate || 3.5);
  const isExemptSocial = t.estimatedProfit <= exemptionThreshold;
  const socialBaseContribution = isExemptSocial ? 0 : (t.estimatedProfit * contributionRate / 100);
  const socialFeeContribution = isExemptSocial ? 0 : (socialBaseContribution * contributionFeeRate / 100);
  const socialTotalContribution = socialBaseContribution + socialFeeContribution;
  const taxableBase = isExemptSocial
    ? t.estimatedProfit + taxAndSocial
    : t.estimatedProfit - socialTotalContribution;
  const socialStatusLabel = isExemptSocial
    ? `Exonéré de cotisations sociales (≤ ${money(exemptionThreshold)})`
    : `Non exonéré de cotisations sociales (> ${money(exemptionThreshold)})`;
  const socialDetailLabel = isExemptSocial
    ? 'Cotisations sociales récupérées'
    : `Cotisations sociales (${num(contributionRate, 1)}%) + frais caisse (${num(contributionFeeRate, 1)}%)`;

  return `
        <section class="page ${activePage === 'result' ? 'active' : ''}">
          <div class="card">
            <div class="section-head">
              <div>
                <h2>Compte de résultat</h2>
              </div>
            </div>

            <div style="overflow:auto;">
              <table>
                <thead>
                  <tr>
                    <th style="width:40%; text-align:center;">Recette des ventes</th>
                    <th style="width:42%; text-align:center;">Dépenses &amp; Frais</th>
                    <th style="width:18%; text-align:center;">Valeurs</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                   <td style="background:#dcfce7; font-weight:700; font-size:22px;">${money(t.salesNet)}</td>
                   <td>60 – Marchandises</td>
                   <td style="text-align:right;">${money(t.purchasesMerchandiseNet)}</td>
                  </tr>

                  <tr>
                    <td rowspan="6" style="background:#f8fafc;"></td>
                    <td>61 – Frais de fonctionnement / Frais généraux</td>
                    <td style="text-align:right;">${money(t.purchasesGeneralNet)}</td>
                  </tr>
                  <tr>
                    <td>62 – Rémunérations</td>
                    <td style="text-align:right;">${money(0)}</td>
                  </tr>
                  <tr>
                    <td>63 – Amortissements</td>
                    <td style="text-align:right;">${money(t.yearlyAmort)}</td>
                  </tr>
                  <tr>
                    <td>64 – Taxes **</td>
                    <td style="text-align:right;">${money(0)}</td>
                  </tr>
                  <tr>
                    <td>65 – Frais financier</td>
                    <td style="text-align:right;">${money(0)}</td>
                  </tr>
                  <tr>
                    <td>66 – Charges exceptionnel</td>
                    <td style="text-align:right;">${money(0)}</td>
                  </tr>
                  <tr style="background:#f1f5f9; font-weight:700;">
                    <td style="text-align:right;">Total :</td>
                    <td style="text-align:right;">${money(
    t.purchasesMerchandiseNet + t.purchasesGeneralNet + t.yearlyAmort
  )}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style="max-width:560px; margin:18px 0 0 auto; display:grid; gap:10px;">
              <div style="display:grid; grid-template-columns: 1fr 180px; border:1px solid var(--line);">
                <div style="padding:10px 12px; background:#e2e8f0; font-weight:700; text-align:right;">TOTAUX :</div>
                <div style="padding:10px 12px; background:#fef08a; font-weight:700; text-align:right;">${money(t.estimatedProfit)}</div>
              </div>
              <div style="display:grid; grid-template-columns: 1fr 180px; border:1px solid var(--line);">
                <div style="padding:10px 12px; text-align:center;">
                  ${socialStatusLabel}<br>
                  <span style="color:var(--muted); font-size:13px;">${socialDetailLabel}</span>
                </div>
                <div style="padding:10px 12px; text-align:right;">
                  ${isExemptSocial ? '+' : '-'} ${money(isExemptSocial ? taxAndSocial : socialTotalContribution)}
                </div>
              </div>
              <div style="display:grid; grid-template-columns: 1fr 180px; border:1px solid var(--line);">
                <div style="padding:10px 12px; background:#e2e8f0; font-weight:700; text-align:right;">Solde imposable :</div>
                <div style="padding:10px 12px; background:#fef08a; font-weight:700; text-align:right;">${money(taxableBase)}</div>
              </div>
            </div>
          </div>
        </section>
      `;
}

function renderBalance() {
  const t = totals();
  return `
        <section class="page two-cols ${activePage === 'balance' ? 'active' : ''}">
          <div class="card">
            <div class="section-head"><h2>Bilan simplifié</h2></div>
            <div class="kv"><span>Immobilisations nettes</span><span>${money(t.netFixedAssets)}</span></div>
            <div class="kv"><span>Stock</span><span>${money(t.stockValue)}</span></div>
            <div class="kv"><span>TVA à recevoir</span><span>${money(t.receivableVat)}</span></div>
            <div class="kv"><span>Banque + caisse</span><span>${money(t.liquidities)}</span></div>
            <div class="kv"><span><strong>Total actif</strong></span><span><strong>${money(t.assetsSide)}</strong></span></div>
          </div>
          <div class="card">
            <div class="section-head"><h3>Passif simplifié</h3></div>
            <div class="kv"><span>Capital de départ</span><span>${money(data.settings.capitalStart)}</span></div>
            <div class="kv"><span>Résultat reporté</span><span>${money(data.settings.retainedEarnings)}</span></div>
            <div class="kv"><span>Résultat de l'exercice</span><span>${money(t.estimatedProfit)}</span></div>
            <div class="kv"><span>TVA à payer</span><span>${money(t.payableVat)}</span></div>
            <div class="kv"><span><strong>Total passif</strong></span><span><strong>${money(t.liabilitiesSide)}</strong></span></div>
            <div class="kv"><span>Écart</span><span class="${Math.abs(t.assetsSide - t.liabilitiesSide) < 0.01 ? 'status-good' : 'status-bad'}">${money(t.assetsSide - t.liabilitiesSide)}</span></div>
          </div>
        </section>
      `;
}


function renderVat() {
  ensureVatStructures();
  const vatLedger = computeVatLedger();

  return `
        <section class="page ${activePage === 'vat' ? 'active' : ''}">
          <div class="card">
            <div class="section-head">
              <div>
                <h2>Suivi TVA</h2>
                <div class="hint">Les 4 trimestres de l’année affichée sont générés automatiquement. Les dates de début et fin s’adaptent au bon nombre de jours du mois. Une période clôturée devient verrouillée.</div>
              </div>
              <div class="inline-actions">
                <button type="button" onclick="openIntervat()">Intervat</button>
              </div>
            </div>

            <div class="summary-grid" style="margin-bottom:16px;">
              <div class="card"><div class="metric-label">Report initial TVA</div><div class="metric-value">${money(data.settings.vatCarryover)}</div></div>
              <div class="card"><div class="metric-label">TVA non déclarée</div><div class="metric-value">${money(vatLedger.totalUnfiledDue - vatLedger.totalUnfiledCredit)}</div></div>
              <div class="card"><div class="metric-label">Déclarée mais non payée</div><div class="metric-value">${money(vatLedger.totalFiledUnpaid)}</div></div>
              <div class="card"><div class="metric-label">Solde TVA ouvert</div><div class="metric-value">${money(vatLedger.totalDueOpen)}</div></div>
            </div>

            <div class="muted-box" style="margin-bottom:16px;">
              <strong>Grilles principales :</strong><br>
              01 / 02 / 03 / 54 / 59 / 71 / 72 sont affichées en priorité.<br>
              Les autres codes Intervat restent disponibles sous <strong>Plus de codes</strong> pour les cas particuliers.<br>
              Le bouton <strong>Intervat</strong> ouvre directement le portail officiel de déclaration.
            </div>

            ${vatLedger.rows.map((row, i) => {
    const dec = row.declaration;
    const c = row.computed;
    const isExpanded = expandedVatDeclarationId === dec.id;
    const isClosed = !!dec.closed;
    const disableAttr = isClosed ? 'disabled' : '';
    const netLabel = (() => {
      if (c.dueAmount > 0) {
        if (dec.paid && row.outstanding <= 0.009) {
          return `Payé : ${money(toNumber(dec.paymentAmount) || c.dueAmount)}`;
        }
        if (dec.paid && row.outstanding > 0.009) {
          return `Solde restant : ${money(row.outstanding)}`;
        }
        return `À payer : ${money(c.dueAmount)}`;
      }
      if (c.creditAmount > 0) {
        return dec.reimbursementRequested
          ? `Remboursement demandé : ${money(c.creditAmount)}`
          : `Crédit à reporter : ${money(c.creditAmount)}`;
      }
      return 'TVA équilibrée';
    })();
    const netLabelClass = (() => {
      if (c.dueAmount > 0 && (!dec.paid || row.outstanding > 0.009)) return 'status-bad';
      return 'status-good';
    })();
    const dueDateLabel = dec.dueDate ? printableDate(dec.dueDate) : '—';
    const statusBadge = isClosed
      ? '<span class="vat-pill success">Clôturé</span>'
      : (dec.filed ? '<span class="vat-pill">Déclarée</span>' : '<span class="vat-pill muted">À déclarer</span>');
    const paymentBadge = (() => {
      if (c.dueAmount > 0) {
        if (dec.paid && row.outstanding <= 0.009) return '<span class="vat-pill success">Payée</span>';
        if (dec.paid && row.outstanding > 0.009) return '<span class="vat-pill danger">Solde TVA restant</span>';
        return '<span class="vat-pill danger">TVA à payer</span>';
      }
      if (c.creditAmount > 0) {
        return dec.reimbursementRequested
          ? '<span class="vat-pill success">Remboursement demandé</span>'
          : '<span class="vat-pill">Crédit à reporter</span>';
      }
      return '<span class="vat-pill muted">TVA équilibrée</span>';
    })();
    const situationText = getVatSituationText(dec, c, row.outstanding);
    return `
                <div class="card vat-declaration-card compact">
                  <div class="vat-summary-header" onclick="toggleVatDeclarationExpanded('${escapeAttr(dec.id)}')">
                    <div class="vat-summary-main">
                      <div class="vat-summary-title">${escapeHtml(quarterLabel(dec.year, dec.quarter))}</div>
                      <div class="hint">Période : ${printableDate(c.startDate)} au ${printableDate(c.endDate)} · Échéance : ${dueDateLabel}</div>
                      <div class="hint"><strong>${escapeHtml(situationText)}</strong></div>
                      <div class="vat-summary-badges">
                        ${statusBadge}
                        ${paymentBadge}
                        <span class="vat-pill muted">${c.salesCount} vente(s)</span>
                        <span class="vat-pill muted">${c.purchaseCount} achat(s)</span>
                      </div>
                    </div>
                    <div class="vat-summary-amount ${netLabelClass}">${netLabel}</div>
                  </div>

                  <div class="vat-summary-details">
                    <div class="vat-mini-box">
                      <div class="vat-mini-label">Grille 54</div>
                      <div class="vat-mini-value">${money(c.boxes['54'])}</div>
                    </div>
                    <div class="vat-mini-box">
                      <div class="vat-mini-label">Grille 59</div>
                      <div class="vat-mini-value">${money(c.boxes['59'])}</div>
                    </div>
                    <div class="vat-mini-box">
                      <div class="vat-mini-label">Grille 71</div>
                      <div class="vat-mini-value">${money(c.boxes['71'])}</div>
                    </div>
                    <div class="vat-mini-box">
                      <div class="vat-mini-label">Grille 72</div>
                      <div class="vat-mini-value">${money(c.boxes['72'])}</div>
                    </div>
                  </div>

                  ${isExpanded ? `
                    <div class="vat-expanded-panel">
                      <div class="grid-2">
                        <div>
                          <table>
                            <tbody>
                              <tr><td>Année</td><td><input type="number" step="1" value="${escapeAttr(dec.year)}" ${disableAttr} onchange="data.vat.declarations[${i}].year=parseInt(this.value,10)||new Date().getFullYear(); syncVatDeclarationPeriod(${i})"></td></tr>
                              <tr><td>Trimestre</td><td><select ${disableAttr} onchange="data.vat.declarations[${i}].quarter=parseInt(this.value,10)||1; syncVatDeclarationPeriod(${i})">
                                <option value="1" ${parseInt(dec.quarter, 10) === 1 ? 'selected' : ''}>T1 (janvier à mars)</option>
                                <option value="2" ${parseInt(dec.quarter, 10) === 2 ? 'selected' : ''}>T2 (avril à juin)</option>
                                <option value="3" ${parseInt(dec.quarter, 10) === 3 ? 'selected' : ''}>T3 (juillet à septembre)</option>
                                <option value="4" ${parseInt(dec.quarter, 10) === 4 ? 'selected' : ''}>T4 (octobre à décembre)</option>
                              </select></td></tr>
                              <tr><td>Date limite</td><td><input type="date" value="${escapeAttr(dec.dueDate || '')}" ${disableAttr} onchange="data.vat.declarations[${i}].dueDate=this.value; saveData(false)"></td></tr>
                              <tr><td>Déclaration déposée</td><td><select ${disableAttr} onchange="data.vat.declarations[${i}].filed=this.value==='true'; saveData(false)"><option value="false" ${!dec.filed ? 'selected' : ''}>Non</option><option value="true" ${dec.filed ? 'selected' : ''}>Oui</option></select></td></tr>
                              <tr><td>Date dépôt</td><td><input type="date" value="${escapeAttr(dec.filedDate || '')}" ${disableAttr} onchange="data.vat.declarations[${i}].filedDate=this.value; saveData(false)"></td></tr>
                              <tr><td>Paiement effectué</td><td><select ${disableAttr} onchange="data.vat.declarations[${i}].paid=this.value==='true'; saveData(false)"><option value="false" ${!dec.paid ? 'selected' : ''}>Non</option><option value="true" ${dec.paid ? 'selected' : ''}>Oui</option></select></td></tr>
                              <tr><td>Date paiement</td><td><input type="date" value="${escapeAttr(dec.paidDate || '')}" ${disableAttr} onchange="data.vat.declarations[${i}].paidDate=this.value; saveData(false)"></td></tr>
                              <tr><td>Montant payé</td><td><input type="number" step="0.01" value="${num(dec.paymentAmount)}" ${disableAttr} onchange="data.vat.declarations[${i}].paymentAmount=parseFloat(this.value)||0; saveData(false)"></td></tr>
                              <tr><td>Demande de remboursement</td><td><select ${disableAttr} onchange="data.vat.declarations[${i}].reimbursementRequested=this.value==='true'; saveData(false)"><option value="false" ${!dec.reimbursementRequested ? 'selected' : ''}>Non</option><option value="true" ${dec.reimbursementRequested ? 'selected' : ''}>Oui</option></select></td></tr>
                              <tr><td>Clôturé</td><td><label style="display:flex; align-items:center; gap:10px;"><input type="checkbox" style="width:auto;" ${dec.closed ? 'checked' : ''} onchange="setVatClosed(${i}, this.checked)"><span>${dec.closed ? 'Oui — période verrouillée, décoche pour modifier à nouveau' : 'Coche pour verrouiller la période'}</span></label></td></tr>
                            </tbody>
                          </table>
                          ${dec.closed ? '<div class="lock-note">Cette période est clôturée. Décoche la case « Clôturé » pour la déverrouiller et modifier à nouveau les champs.</div>' : ''}
                        </div>

                        <div>
                          <table>
                            <tbody>
                              <tr><td>TVA ventes</td><td>${money(c.salesVat)}</td></tr>
                              <tr><td>TVA achats déductible</td><td>${money(c.deductibleVat)}</td></tr>
                              <tr><td>Crédit reporté période précédente</td><td>${money(c.previousCredit)}</td></tr>
                              <tr><td>Solde déclaration (grille 71)</td><td>${money(c.boxes['71'])}</td></tr>
                              <tr><td>Crédit à reporter (grille 72)</td><td>${money(c.boxes['72'])}</td></tr>
                              <tr><td>Reste à payer</td><td class="${row.outstanding > 0.009 ? 'status-bad' : 'status-good'}">${money(row.outstanding)}</td></tr>
                              <tr><td>Lignes ventes prises en compte</td><td>${c.salesCount}</td></tr>
                              <tr><td>Lignes achats prises en compte</td><td>${c.purchaseCount}</td></tr>
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div class="vat-primary-codes" style="overflow:auto;">
                        <table class="vat-code-table">
                          <thead>
                            <tr>
                              <th>Grille</th>
                              <th>Libellé</th>
                              <th>Montant</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr><td>01</td><td>Opérations à 6 %</td><td>${money(c.boxes['01'])}</td></tr>
                            <tr><td>02</td><td>Opérations à 12 %</td><td>${money(c.boxes['02'])}</td></tr>
                            <tr><td>03</td><td>Opérations à 21 %</td><td>${money(c.boxes['03'])}</td></tr>
                            <tr><td>54</td><td>TVA due sur ventes encodées</td><td>${money(c.boxes['54'])}</td></tr>
                            <tr><td>59</td><td>TVA déductible sur achats</td><td>${money(c.boxes['59'])}</td></tr>
                            <tr><td>71</td><td>TVA à payer</td><td>${money(c.boxes['71'])}</td></tr>
                            <tr><td>72</td><td>Crédit TVA à reporter</td><td>${money(c.boxes['72'])}</td></tr>
                          </tbody>
                        </table>
                      </div>

                      <div class="vat-extra-codes">
                        <button type="button" class="vat-extra-toggle" ${disableAttr} onclick="toggleVatExtraCodes('${escapeAttr(dec.id)}')">
                          <span>Plus de codes</span>
                          <span>${dec.showExtraCodes ? '▲' : '▼'}</span>
                        </button>
                        <div class="vat-extra-body ${dec.showExtraCodes ? 'open' : ''}">
                          <div style="overflow:auto;">
                            <table class="vat-code-table">
                              <thead>
                                <tr>
                                  <th>Grille</th>
                                  <th>Libellé</th>
                                  <th>Montant</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr><td>44</td><td>Prestations/services particuliers</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['44'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['44']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>46</td><td>Livraisons intracom / opérations assimilées</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['46'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['46']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>47</td><td>Autres opérations exemptées</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['47'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['47']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>48</td><td>Notes de crédit sur opérations antérieures</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['48'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['48']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>49</td><td>Autres opérations sans TVA belge</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['49'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['49']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>55</td><td>TVA due acquisitions intracom / autoliquidation</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['55'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['55']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>56</td><td>TVA due opérations cocontractant</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['56'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['56']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>57</td><td>TVA importations / autres régularisations dues</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['57'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['57']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>61</td><td>Régularisations TVA en faveur de l’État</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['61'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['61']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>62</td><td>Régularisations TVA en votre faveur</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['62'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['62']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>63</td><td>Crédit antérieur / autres TVA déductibles</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['63'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['63']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>81</td><td>Achats marchandises / matières</td><td>${money(c.boxes['81'])}</td></tr>
                                <tr><td>82</td><td>Services, biens divers et autres</td><td>${money(c.boxes['82'])}</td></tr>
                                <tr><td>83</td><td>Biens d’investissement</td><td><input type="number" step="0.01" value="${num(c.boxes['83'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['83']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                                <tr><td>91</td><td>Acompte de décembre (si applicable)</td><td><input type="number" step="0.01" value="${num(dec.manualBoxes['91'])}" ${disableAttr} onchange="data.vat.declarations[${i}].manualBoxes['91']=parseFloat(this.value)||0; saveData(false)"></td></tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>

                      <div style="margin-top:16px;">
                        <label style="display:block; font-weight:700; margin-bottom:8px;">Notes TVA / Intervat</label>
                        <textarea ${disableAttr} onchange="data.vat.declarations[${i}].notes=this.value; saveData(false)">${escapeHtml(dec.notes || '')}</textarea>
                      </div>

                      <div class="inline-actions" style="margin-top:16px;">
                        <button class="delete-icon-btn" title="Supprimer" aria-label="Supprimer" ${disableAttr} onclick="deleteVatDeclaration(${i})">×</button>
                      </div>
                    </div>
                  ` : ''}
                </div>
              `;
  }).join('') || `<div class="muted-box">Aucune période TVA.</div>`}
          </div>
        </section>
      `;
}

function renderSettings() {
  return `
        <section class="page two-cols ${activePage === 'settings' ? 'active' : ''}">
          <div class="card">
            <div class="section-head">
              <div>
                <h2>Paramètres</h2>
                <div class="hint">Uniquement les réglages encore utiles au calcul.</div>
              </div>
            </div>
            <table>
              <tbody>
                <tr><td>Nom de l'entreprise</td><td><input value="${escapeAttr(data.company.name)}" onchange="setField('company.name', this.value)"></td></tr>
                <tr><td>Période</td><td><input value="${escapeAttr(data.company.period)}" onchange="setField('company.period', this.value)"></td></tr>
                <tr><td>Report TVA</td><td><input type="number" step="0.01" value="${num(data.settings.vatCarryover)}" onchange="setField('settings.vatCarryover', parseFloat(this.value)||0)"></td></tr>
                <tr><td>Seuil exonération cotisations sociales</td><td><input type="number" step="0.01" value="${num(data.settings.socialExemptionThreshold)}" onchange="setField('settings.socialExemptionThreshold', parseFloat(this.value)||1881.76)"></td></tr>
                <tr><td>Taux cotisations sociales (%)</td><td><input type="number" step="0.01" value="${num(data.settings.socialContributionRate)}" onchange="setField('settings.socialContributionRate', parseFloat(this.value)||20.5)"></td></tr>
                <tr><td>Frais caisse sociale (%)</td><td><input type="number" step="0.01" value="${num(data.settings.socialContributionFeeRate)}" onchange="setField('settings.socialContributionFeeRate', parseFloat(this.value)||3.5)"></td></tr>
                <tr><td>Banque</td><td><input type="number" step="0.01" value="${num(data.settings.bankBalance)}" onchange="setField('settings.bankBalance', parseFloat(this.value)||0)"></td></tr>
                <tr><td>Caisse</td><td><input type="number" step="0.01" value="${num(data.settings.cashBalance)}" onchange="setField('settings.cashBalance', parseFloat(this.value)||0)"></td></tr>
                <tr><td>Capital de départ</td><td><input type="number" step="0.01" value="${num(data.settings.capitalStart)}" onchange="setField('settings.capitalStart', parseFloat(this.value)||0)"></td></tr>
                <tr><td>Résultat reporté</td><td><input type="number" step="0.01" value="${num(data.settings.retainedEarnings)}" onchange="setField('settings.retainedEarnings', parseFloat(this.value)||0)"></td></tr>
              </tbody>
            </table>
          </div>
          <div class="card">
            <div class="section-head"><h3>Notes internes</h3></div>
            <textarea onchange="setField('company.notes', this.value)">${escapeHtml(data.company.notes || '')}</textarea>
            <div class="footer-note">Tu peux t'en servir pour noter des rappels comptables ou des points à vérifier.</div>

            <div class="section-head" style="margin-top:20px;">
              <div>
                <h3>Exercice suivant</h3>
                <div class="hint">Crée un nouveau fichier JSON pour l'année suivante en reprenant le stock, les immobilisations, les investissements, les paramètres et le résultat reporté. Tu choisis ensuite un téléchargement sur PC ou un envoi direct sur Drive.</div>
              </div>
            </div>
            <div class="inline-actions">
              <button type="button" onclick="createNextExerciseFile()">Créer l'exercice suivant</button>
            </div>
          </div>
        </section>
      `;
}

function renderTablePage({ key, title, hint, addLabel, onAdd, headers, rows, footer, tableAttrs = '', colgroup = '' }) {
  const hasHint = Boolean(hint && hint.trim());
  const hasButton = Boolean(addLabel && addLabel.trim() && onAdd && onAdd.trim());

  return `
    <section class="page ${activePage === key ? 'active' : ''}">
      <div class="card">
        <div class="section-head">
          <div>
            <h2>${title}</h2>
            ${hasHint ? `<div class="hint">${hint}</div>` : ``}
          </div>
          ${hasButton ? `
            <div class="inline-actions">
              <button class="primary" onclick="${onAdd}">${addLabel}</button>
            </div>
          ` : ``}
        </div>
        <div style="overflow:auto;">
          <table ${tableAttrs}>
            ${colgroup}
            <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${headers.length}">Aucune ligne.</td></tr>`}</tbody>
          </table>
        </div>
        <div style="margin-top: 14px;">${footer || ''}</div>
      </div>
    </section>
  `;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, '&#096;');
}


function printableDate(value) {
  if (!value) return '—';
  const d = new Date(value + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat('fr-BE').format(d);
}

function reportTable(headers, rows, options = {}) {
  const cls = options.compact ? 'report-table compact' : 'report-table';
  return `
        <div class="table-wrap">
          <table class="${cls}">
            <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="empty-row">Aucune donnée</td></tr>`}</tbody>
          </table>
        </div>
      `;
}

function reportKv(items) {
  return `<div class="report-kv">${items.map(([label, value]) => `
        <div class="report-kv-row">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `).join('')}</div>`;
}

function buildPrintReportHtml() {
  const t = totals();
  const year = parseInt(data.company.period, 10) || new Date().getFullYear();
  const taxAndSocial = t.lossesTotal;
  const exemptionThreshold = toNumber(data.settings.socialExemptionThreshold || 1881.76);
  const contributionRate = toNumber(data.settings.socialContributionRate || 20.5);
  const contributionFeeRate = toNumber(data.settings.socialContributionFeeRate || 3.5);
  const isExemptSocial = t.estimatedProfit <= exemptionThreshold;
  const socialBaseContribution = isExemptSocial ? 0 : (t.estimatedProfit * contributionRate / 100);
  const socialFeeContribution = isExemptSocial ? 0 : (socialBaseContribution * contributionFeeRate / 100);
  const socialTotalContribution = socialBaseContribution + socialFeeContribution;
  const taxableBase = isExemptSocial ? t.estimatedProfit + taxAndSocial : t.estimatedProfit - socialTotalContribution;
  const vatLedger = computeVatLedger();
  const vatReportRows = vatLedger.rows.flatMap(row => [
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – période`, `${printableDate(row.computed.startDate)} au ${printableDate(row.computed.endDate)}`],
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – échéance`, printableDate(row.declaration.dueDate || '')],
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – grille 54`, money(row.computed.boxes['54'])],
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – grille 59`, money(row.computed.boxes['59'])],
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – grille 71`, money(row.computed.boxes['71'])],
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – grille 72`, money(row.computed.boxes['72'])],
    [`${quarterLabel(row.declaration.year, row.declaration.quarter)} – reste à payer`, money(row.outstanding)]
  ]);

  const salesRows = data.sales.map(row => [
    printableDate(row.date),
    escapeHtml(row.client || '—'),
    escapeHtml(row.invoiceNumber || '—'),
    escapeHtml(row.description || '—'),
    `${num(row.rate)} %`,
    money(salesRowNet(row)),
    money(salesRowVat(row)),
    money(salesRowTvac(row))
  ]);

  const purchaseRows = data.purchases.map((row, i) => [
    printableDate(row.date),
    escapeHtml(row.supplier || '—'),
    escapeHtml(row.invoiceNumber || '—'),
    escapeHtml(row.category === 'marchandise' ? 'Marchandise' : 'Frais généraux'),
    `${num(row.rate)} %`,
    money(row.htva),
    row.deductible ? 'Oui' : 'Non',
    money(row.deductible ? purchaseVatDisplay(i) : 0),
    money(rowHtvaToTvac(row.htva, row.rate))
  ]);

  const investmentRows = t.investmentComputed.map(row => [
    printableDate(row.date),
    escapeHtml(row.supplier || '—'),
    escapeHtml(row.invoiceNumber || '—'),
    escapeHtml(row.description || row.label || '—'),
    money(row.amount),
    `${parseInt(row.durationMonths || 0, 10)} mois`,
    money(row.amortYear),
    money(row.amortTotal),
    money(row.netValue)
  ]);

  const assetRows = t.assetsComputed.map(row => [
    printableDate(row.date),
    escapeHtml(row.label || '—'),
    escapeHtml(row.supplier || '—'),
    money(row.amount),
    `${parseInt(row.durationMonths || 0, 10)} mois`,
    money(row.amortYear),
    money(row.amortTotal),
    money(row.netValue)
  ]);

  const stockRows = data.stock.map(row => [
    escapeHtml(row.label || '—'),
    num(row.quantity),
    money(row.unitPrice),
    money(toNumber(row.quantity) * toNumber(row.unitPrice))
  ]);

  const lossRows = data.losses.map(row => [
    printableDate(row.date),
    escapeHtml(row.label || '—'),
    num(row.quantity),
    money(row.unitPrice),
    money(toNumber(row.quantity) * toNumber(row.unitPrice))
  ]);

  const kmRows = data.km.map(row => [
    printableDate(row.date),
    escapeHtml(row.person || '—'),
    escapeHtml(row.route || '—'),
    `${num(row.km)} km`,
    num(row.trips),
    `${num(toNumber(row.km) * toNumber(row.trips))} km`
  ]);

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Export comptabilité ${escapeHtml(data.company.period || '')}</title>
<style>
  :root {
    --ink: #172033;
    --muted: #5c667a;
    --line: #d7deea;
    --soft: #f6f8fc;
    --soft-2: #edf2fb;
    --accent: #1d4ed8;
    --good: #166534;
    --bad: #b91c1c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #eef3f9; color: var(--ink); font-family: Arial, Helvetica, sans-serif; }
  body { padding: 24px; }
  .report { max-width: 1180px; margin: 0 auto; background: #fff; padding: 28px; border-radius: 20px; box-shadow: 0 18px 50px rgba(15,23,42,0.08); }
  .report-header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; padding-bottom: 20px; border-bottom: 2px solid var(--soft-2); margin-bottom: 20px; }
  .report-header h1 { margin: 0 0 6px; font-size: 30px; }
  .report-subtitle { color: var(--muted); line-height: 1.5; }
  .report-meta { min-width: 270px; background: var(--soft); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 14px; margin: 22px 0 26px; }
  .metric { border: 1px solid var(--line); background: var(--soft); border-radius: 16px; padding: 16px; }
  .metric span { display:block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
  .metric strong { font-size: 24px; }
  .section { margin-top: 22px; page-break-inside: avoid; }
  .section-title { font-size: 21px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid var(--soft-2); }
  .section-grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; }
  .panel { border:1px solid var(--line); border-radius:16px; background: #fff; overflow:hidden; }
  .panel.soft { background: var(--soft); }
  .panel-body { padding: 16px; }
  .table-wrap { overflow: hidden; border:1px solid var(--line); border-radius: 16px; }
  table.report-table { width:100%; border-collapse: collapse; font-size: 12.5px; }
  .report-table th { background: var(--soft-2); color: var(--muted); text-transform: uppercase; letter-spacing: .03em; font-size: 11px; padding: 10px 8px; text-align: center; border-bottom:1px solid var(--line); }
  .report-table td { border-bottom:1px solid var(--line); padding: 8px; vertical-align: top; }
  .report-table tbody tr:nth-child(even) td { background: #fbfcfe; }
  .report-table td:nth-child(1), .report-table td:nth-last-child(1) { white-space: nowrap; }
  .report-table.compact td, .report-table.compact th { padding: 7px 8px; }
  .empty-row { text-align:center; color: var(--muted); padding: 14px; }
  .report-kv { border:1px solid var(--line); border-radius: 16px; overflow:hidden; }
  .report-kv-row { display:grid; grid-template-columns: 1fr auto; gap: 16px; padding: 11px 14px; border-bottom:1px solid var(--line); }
  .report-kv-row:last-child { border-bottom:none; }
  .totals-grid { display:grid; grid-template-columns: 1.2fr .8fr; gap: 16px; }
  .result-card { border:1px solid var(--line); border-radius:16px; overflow:hidden; }
  .result-card .row { display:grid; grid-template-columns: 1fr 220px; }
  .result-card .row > div { padding: 12px 14px; border-bottom:1px solid var(--line); }
  .result-card .row > div:last-child { text-align:right; font-weight:700; border-left:1px solid var(--line); }
  .result-card .row.total > div { background: #fff7bf; font-size: 18px; }
  .muted { color: var(--muted); }
  .good { color: var(--good); }
  .bad { color: var(--bad); }
  .footer-note { margin-top: 20px; color: var(--muted); font-size: 12px; text-align: center; }
  .print-toolbar { position: sticky; top: 0; z-index: 20; display:flex; justify-content:flex-end; gap:10px; margin-bottom: 18px; }
  .print-toolbar button { border: none; background: var(--accent); color: #fff; padding: 12px 16px; border-radius: 12px; font-weight: 700; cursor: pointer; }
  .print-toolbar button.secondary { background: #e5e7eb; color: #111827; }
  @page { size: A4 landscape; margin: 12mm; }
  @media print {
    html, body { background: #fff; }
    body { padding: 0; }
    .print-toolbar { display:none; }
    .report { box-shadow:none; border-radius:0; max-width:none; padding: 0; }
    .section { break-inside: avoid; page-break-inside: avoid; }
    .table-wrap { overflow: visible; }
    table.report-table { font-size: 10.5px; }
    .report-table th, .report-table td { padding: 6px 5px; }
    .report-table thead { display: table-header-group; }
    .report-table tr { break-inside: avoid; }
    .metrics { gap: 8px; }
    .metric { padding: 10px; }
    .metric strong { font-size: 18px; }
  }
  @media (max-width: 980px) {
    .metrics, .section-grid, .totals-grid { grid-template-columns: 1fr; }
    .report-header { flex-direction: column; }
    .report-meta { min-width: 0; width: 100%; }
  }
</style>
</head>
<body>
  <div class="print-toolbar">
    <button onclick="window.print()">Imprimer / Enregistrer en PDF</button>
    <button class="secondary" onclick="window.close()">Fermer</button>
  </div>
  <div class="report">
    <div class="report-header">
      <div>
        <h1>Comptabilité – ${escapeHtml(data.company.name || 'Entreprise')}</h1>
        <div class="report-subtitle">Export complet de tous les onglets, optimisé pour une impression propre en A4 paysage.</div>
      </div>
      <div class="report-meta">
        <div><strong>Période :</strong> ${escapeHtml(data.company.period || '—')}</div>
        <div><strong>Date d’export :</strong> ${new Intl.DateTimeFormat('fr-BE', { dateStyle: 'full', timeStyle: 'short' }).format(new Date())}</div>
        <div><strong>Lignes achats :</strong> ${data.purchases.length}</div>
        <div><strong>Lignes ventes :</strong> ${data.sales.length}</div>
      </div>
    </div>

    <div class="metrics">
      <div class="metric"><span>Ventes HTVA</span><strong>${money(t.salesNet)}</strong></div>
      <div class="metric"><span>Achats HTVA</span><strong>${money(t.purchasesNet)}</strong></div>
      <div class="metric"><span>TVA nette</span><strong>${money(t.netVat)}</strong></div>
      <div class="metric"><span>Résultat estimé</span><strong>${money(t.estimatedProfit)}</strong></div>
    </div>

    <section class="section">
      <h2 class="section-title">Vue d'ensemble</h2>
      <div class="section-grid">
        <div class="panel soft"><div class="panel-body">${reportKv([
    ['Société', escapeHtml(data.company.name || '—')],
    ['Période', escapeHtml(data.company.period || '—')],
    ['Investissements', String(t.investmentComputed.length)],
    ['Immobilisations', String(data.assets.length)],
    ['Km encodés', `${num(t.kmTotal, 0)} km`],
    ['Stock estimé', money(t.stockValue)]
  ])}</div></div>
        <div class="panel soft"><div class="panel-body">${reportKv([
    ['TVA ventes', money(t.salesVat)],
    ['TVA achats récupérable', money(t.purchasesVat)],
    ['Report TVA', money(data.settings.vatCarryover)],
    ['Actif simplifié', money(t.assetsSide)],
    ['Passif simplifié', money(t.liabilitiesSide)],
    ['Écart bilan', money(t.assetsSide - t.liabilitiesSide)]
  ])}</div></div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Ventes</h2>
      ${reportTable(['Date', 'Client', 'N° facture', 'Description', 'Taux TVA', 'HTVA', 'TVA', 'TVAC'], salesRows)}
      <div style="margin-top:12px;">${reportKv([
    ['Total ventes HTVA', money(t.salesNet)],
    ['Total TVA ventes', money(t.salesVat)]
  ])}</div>
    </section>

    <section class="section">
      <h2 class="section-title">Achats</h2>
      ${reportTable(['Date', 'Fournisseur', 'N° facture', 'Type', 'Taux TVA', 'HTVA', 'TVA déductible', 'TVA récup.', 'TVAC'], purchaseRows, { compact: true })}
      <div style="margin-top:12px;">${reportKv([
    ['Total achats en charges', money(t.purchasesNet)],
    ['Dont frais généraux', money(t.purchasesGeneralNet)],
    ['Dont marchandises', money(t.purchasesMerchandiseNet)],
    ['Total TVA récupérable', money(t.purchasesVat)]
  ])}</div>
    </section>

    <section class="section">
      <h2 class="section-title">Investissements</h2>
      ${reportTable(['Date achat', 'Fournisseur', 'N° facture', 'Description', 'Montant HTVA', 'Durée', 'Amorti année', 'Amorti total', 'Valeur restante'], investmentRows, { compact: true })}
    </section>

    <section class="section">
      <h2 class="section-title">Immobilisations</h2>
      ${reportTable(['Date', 'Libellé', 'Fournisseur', 'Montant HTVA', 'Durée', 'Amorti année', 'Amorti total', 'Valeur nette'], assetRows, { compact: true })}
    </section>

    <section class="section">
      <h2 class="section-title">Stock matériaux</h2>
      ${reportTable(['Libellé', 'Quantité', 'Prix unitaire', 'Valeur'], stockRows)}
    </section>

    <section class="section">
      <h2 class="section-title">Pertes et charges diverses</h2>
      ${reportTable(['Date', 'Libellé', 'Quantité', 'Montant unitaire', 'Total'], lossRows)}
    </section>

    <section class="section">
      <h2 class="section-title">Kilomètres</h2>
      ${reportTable(['Date', 'Personne', 'Trajet', 'Km', 'Nb déplacements', 'Km totaux'], kmRows)}
    </section>

    <section class="section">
      <h2 class="section-title">Compte de résultat</h2>
      <div class="totals-grid">
        <div class="result-card">
          <div class="row"><div>Recettes des ventes</div><div>${money(t.salesNet)}</div></div>
          <div class="row"><div>60 – Marchandises</div><div>${money(t.purchasesMerchandiseNet)}</div></div>
          <div class="row"><div>61 – Frais généraux</div><div>${money(t.purchasesGeneralNet)}</div></div>
          <div class="row"><div>63 – Amortissements</div><div>${money(t.yearlyAmort)}</div></div>
          <div class="row"><div>Autres charges diverses</div><div>${money(t.lossesTotal)}</div></div>
          <div class="row total"><div>Résultat estimé</div><div>${money(t.estimatedProfit)}</div></div>
        </div>
        <div class="panel soft"><div class="panel-body">${reportKv([
    ['Exercice', String(year)],
    ['Seuil exonération sociale', money(exemptionThreshold)],
    ['Cotisations sociales estimées', money(socialTotalContribution)],
    ['Statut social', escapeHtml(isExemptSocial ? 'Exonéré' : 'Non exonéré')],
    ['Solde imposable', money(taxableBase)]
  ])}</div></div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Bilan simplifié</h2>
      <div class="section-grid">
        <div class="panel"><div class="panel-body">${reportKv([
    ['Immobilisations nettes', money(t.netFixedAssets)],
    ['Stock', money(t.stockValue)],
    ['TVA à recevoir', money(t.receivableVat)],
    ['Banque + caisse', money(t.liquidities)],
    ['Total actif', money(t.assetsSide)]
  ])}</div></div>
        <div class="panel"><div class="panel-body">${reportKv([
    ['Capital de départ', money(data.settings.capitalStart)],
    ['Résultat reporté', money(data.settings.retainedEarnings)],
    ['Résultat de l’exercice', money(t.estimatedProfit)],
    ['TVA à payer', money(t.payableVat)],
    ['Total passif', money(t.liabilitiesSide)]
  ])}</div></div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Suivi TVA</h2>
      <div class="section-grid">
        <div class="panel"><div class="panel-body">${reportKv(vatReportRows.length ? vatReportRows : [['Aucune période TVA', '—']])}</div></div>
        <div class="panel"><div class="panel-body">${reportKv([
    ['Report TVA initial', money(data.settings.vatCarryover)],
    ['TVA déclarée non payée', money(vatLedger.totalFiledUnpaid)],
    ['TVA non déclarée nette', money(vatLedger.totalUnfiledDue - vatLedger.totalUnfiledCredit)],
    ['Solde TVA ouvert', money(vatLedger.totalDueOpen)]
  ])}</div></div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Paramètres</h2>
      <div class="section-grid">
        <div class="panel"><div class="panel-body">${reportKv([
    ['Nom de l’entreprise', escapeHtml(data.company.name || '—')],
    ['Période', escapeHtml(data.company.period || '—')],
    ['Report TVA', money(data.settings.vatCarryover)],
    ['Banque', money(data.settings.bankBalance)],
    ['Caisse', money(data.settings.cashBalance)],
    ['Capital de départ', money(data.settings.capitalStart)],
    ['Résultat reporté', money(data.settings.retainedEarnings)]
  ])}</div></div>
        <div class="panel"><div class="panel-body">${reportKv([
    ['Seuil exonération cotisations sociales', money(data.settings.socialExemptionThreshold)],
    ['Taux cotisations sociales', `${num(data.settings.socialContributionRate)} %`],
    ['Frais caisse sociale', `${num(data.settings.socialContributionFeeRate)} %`],
    ['Notes', escapeHtml((data.company.notes || '').trim() || '—')]
  ])}</div></div>
      </div>
    </section>

    <div class="footer-note">Export généré depuis l’application locale Bast Aménagement.</div>
  </div>
</body>
</html>`;
}

function openPrintReport() {
  saveData(false);
  const reportWindow = window.open('', '_blank');
  if (!reportWindow) {
    alert('Le navigateur a bloqué l’ouverture de la fenêtre d’impression. Autorise les pop-ups puis réessaie.');
    return;
  }
  reportWindow.document.open();
  reportWindow.document.write(buildPrintReportHtml());
  reportWindow.document.close();
  reportWindow.focus();
}

function render() {
  ensureVatStructures();
  const t = totals();

  renderTabs();
  renderPages();

  const metricSales = document.getElementById('metricSales');
  const metricPurchases = document.getElementById('metricPurchases');
  const metricVat = document.getElementById('metricVat');
  const metricProfit = document.getElementById('metricProfit');

  if (metricSales) metricSales.textContent = money(t.salesNet);
  if (metricPurchases) metricPurchases.textContent = money(t.purchasesNet);
  if (metricVat) metricVat.textContent = money(t.netVat);
  if (metricProfit) metricProfit.textContent = money(t.estimatedProfit);
}


function normalizeInvoiceImportRow(row) {
  const documentStatus = String(row?.documentStatus || 'sent');
  const documentType = String(row?.documentType || 'invoice');
  const rawTvac = Math.round(((parseFloat(row?.tvac) || 0) + Number.EPSILON) * 100) / 100;
  const isCreditNote = documentType.toLowerCase() === 'credit_note' || documentStatus.toLowerCase() === 'credit_note';
  return {
    date: String(row?.date || ''),
    client: String(row?.client || ''),
    invoiceNumber: String(row?.invoiceNumber || ''),
    linkedInvoiceNumber: String(row?.linkedInvoiceNumber || ''),
    documentStatus,
    documentType,
    description: String(row?.description || ''),
    rate: parseFloat(row?.rate) || 0,
    tvac: isCreditNote ? -Math.abs(rawTvac) : rawTvac
  };
}

function getInvoiceImportTypeLabel(row) {
  if (row.documentType === 'credit_note' || row.documentStatus === 'credit_note') return 'Note de crédit';
  return 'Facture';
}

async function importInvoiceSalesRowsFromPortal(payloadOrRows) {
  const payload = Array.isArray(payloadOrRows)
    ? { action: 'upsert', rows: payloadOrRows }
    : (payloadOrRows || {});

  const action = String(payload.action || 'upsert');
  const invoiceNumber = String(payload.invoiceNumber || '').trim();

  const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
  const incomingRows = rawRows
    .map(normalizeInvoiceImportRow)
    .filter(row => row.tvac !== 0 || row.description || row.invoiceNumber || row.client);

  const invoiceNumbers = [...new Set([
    invoiceNumber,
    ...incomingRows.map(row => row.invoiceNumber)
  ].filter(Boolean))];

  if (!invoiceNumbers.length) {
    return { ok: false, count: 0, message: 'Aucun numéro de facture valide à traiter.' };
  }

  const existingRows = data.sales.filter(row => invoiceNumbers.includes(String(row.invoiceNumber || '')));
  const lockedExisting = existingRows.find(row => getClosedVatDeclarationForDate(row.date || ''));
  if (lockedExisting) {
    const dec = getClosedVatDeclarationForDate(lockedExisting.date || '');
    return { ok: false, count: 0, message: getVatLockMessage(dec) };
  }

  if (action === 'cancel') {
    const before = data.sales.length;
    data.sales = data.sales.filter(row => !invoiceNumbers.includes(String(row.invoiceNumber || '')));
    const removed = before - data.sales.length;
    sortByDate(data.sales);
    activePage = 'sales';
    await saveData(false);
    if (googleAccessToken) await saveCurrentYearJsonToDrive(false);
    render();

    return {
      ok: true,
      count: removed,
      message: removed
        ? `Facture annulée : ${removed} ligne(s) retirée(s) du journal des ventes.`
        : 'Facture annulée : aucune ligne existante à retirer du journal des ventes.'
    };
  }

  if (!incomingRows.length) {
    return { ok: false, count: 0, message: 'Aucune donnée de facture valide à importer.' };
  }

  const lockedIncoming = incomingRows.find(row => getClosedVatDeclarationForDate(row.date || ''));
  if (lockedIncoming) {
    const dec = getClosedVatDeclarationForDate(lockedIncoming.date || '');
    return { ok: false, count: 0, message: getVatLockMessage(dec) };
  }

  data.sales = data.sales.filter(row => !invoiceNumbers.includes(String(row.invoiceNumber || '')));
  data.sales.push(...incomingRows);
  sortByDate(data.sales);
  activePage = 'sales';
  await saveData(false);
  if (googleAccessToken) await saveCurrentYearJsonToDrive(false);
  render();

  const hasCreditNote = incomingRows.some(row => row.documentType === 'credit_note');
  const replacedText = invoiceNumbers.length ? ' Les anciennes lignes avec le même N° document ont été remplacées.' : '';
  return {
    ok: true,
    count: incomingRows.length,
    message: incomingRows.length + (hasCreditNote ? ' ligne(s) de note de crédit ajoutée(s) dans le journal des ventes.' : ' ligne(s) ajoutée(s) dans le journal des ventes.') + replacedText
  };
}

window.importInvoiceSalesRowsFromPortal = importInvoiceSalesRowsFromPortal;

document.addEventListener('click', (event) => {
  if (!event.target.closest('.dropdown')) {
    closeFileMenu();
  }
});

async function saveFromPortalGlobal(options = {}) {
  const interceptedAlerts = [];
  const originalAlert = window.alert;
  if (options?.silent) {
    window.alert = message => {
      interceptedAlerts.push(String(message || ''));
      console.info('Alerte Comptabilité interceptée pendant la sauvegarde globale:', message);
    };
  }

  try {
    ensureVatStructures();
    ensurePurchaseRowIds();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const chantierSynced = await syncPurchasesToChantiers(false);
    let driveSynced = false;
    let driveError = '';

    if (googleAccessToken) {
      try {
        driveSynced = await saveCurrentYearJsonToDrive(false);
      } catch (error) {
        driveError = error?.message || String(error);
        console.error('Sauvegarde Drive Comptabilité impossible.', error);
      }
    }

    render();
    return {
      ok: true,
      module: 'comptabilite',
      local: true,
      drive: !!googleAccessToken && driveSynced,
      chantierSynced,
      alertsIntercepted: interceptedAlerts.length,
      warnings: [driveError && `Drive sync: ${driveError}`].filter(Boolean)
    };
  } finally {
    if (options?.silent) window.alert = originalAlert;
  }
}

window.BastComptaModule = {
  name: 'Comptabilité',
  save: saveFromPortalGlobal,
  saveData,
  getStatus: () => ({ ready: true, module: 'comptabilite' })
};


window.addEventListener('load', async () => {
  ensureVatStructures();
  render();
  await initDriveClientOnly();

  try {
    window.parent.postMessage({
      type: 'BASTCOMPTA_DRIVE_STATUS_REQUEST'
    }, window.location.origin);
  } catch (error) {
    console.error('Impossible de demander le statut Drive au portail.', error);
  }
});
