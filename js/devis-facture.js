// BastCompta - module Devis & Facture

const STORAGE_KEY = 'devis-facture-style-vrai-document';
const DRIVE_SYNC_FILE_NAME = 'bastcompta-crm-sync.json';

let googleAccessToken = null;
let googleDriveFiles = [];
let selectedDriveFileId = '';
let selectedDriveFileIds = [];

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

const defaultLines = () => ([
  {
    description: '',
    qty: 1,
    unit: 'p',
    unitPrice: 0,
    costPrice: 0,
    discount: 0,
    vatRate: 21
  }
]);

const defaultData = {
  company: {
    name: '',
    address: '',
    city: '',
    phone: '',
    email: '',
    website: '',
    vat: '',
    iban: '',
    bic: '',
    conditions: '',
    logo: ''
  },
  quote: {
    documentNumber: '',
    clientNumber: '',
    clientVat: '',
    clientId: '',
    clientName: '',
    clientEmail: '',
    address: '',
    date: '',
    validity: '',
    siteName: '',
    chantierId: '',
    lines: defaultLines(),
    suppliesEnabled: false,
    suppliesLines: defaultLines(),
    notes: ''
  },
  invoice: {
    documentNumber: '',
    clientNumber: '',
    clientVat: '',
    clientId: '',
    clientName: '',
    clientEmail: '',
    address: '',
    date: '',
    dueDate: '',
    siteName: '',
    chantierId: '',
    paidAmount: 0,
    status: 'draft',
    linkedInvoiceNumber: '',
    creditNoteReason: '',
    lines: defaultLines(),
    suppliesEnabled: false,
    suppliesLines: defaultLines(),
    notes: ''
  },
  reminder: {
    documentNumber: '',
    clientNumber: '',
    clientVat: '',
    clientId: '',
    clientName: '',
    clientEmail: '',
    address: '',
    date: '',
    dueDate: '',
    siteName: '',
    chantierId: '',
    paidAmount: 0,
    lines: defaultLines(),
    suppliesEnabled: false,
    suppliesLines: defaultLines(),
    notes: ''
  },
  communication: {
    clientNumber: '',
    invoiceYear: '',
    invoiceNumber: '',
    controlNumber: '',
    formatted: ''
  },
  clients: [],
  mail: {
    recentEmails: [],
    quoteSubject: 'Votre devis {documentNumber}',
    quoteBody: `Bonjour {clientName},

Veuillez trouver ci-joint votre devis {documentNumber}.

Cordialement,
{companyName}`,
    invoiceSubject: 'Votre facture {documentNumber}',
    invoiceBody: `Bonjour {clientName},

Veuillez trouver ci-joint votre facture {documentNumber} d'un montant de {totalTTC}.

Cordialement,
{companyName}`,
    reminderSubject: 'Votre rappel {documentNumber}',
    reminderBody: `Bonjour {clientName},

Veuillez trouver ci-joint votre rappel {documentNumber} concernant le solde restant de {totalTTC}.

Cordialement,
{companyName}`
  }
};

const pageDefs = [
  { key: 'quote', label: 'Devis' },
  { key: 'invoice', label: 'Facture' },
  { key: 'reminder', label: 'Rappel' },
  { key: 'communication', label: 'Communication structurée' },
  { key: 'peppol', label: 'Peppol / Doccle' },
  { key: 'settings', label: 'Paramètres' }
];

let data = loadData();
let activePage = 'quote';
let crmExpandedClientId = '';
let crmSearchTerm = '';
let driveFileIndex = {};

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

async function saveData(showAlert = true) {
  const btn = document.getElementById('saveButton');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sauvegarde...';
  }

  try {
    syncCommunicationFromInvoice(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const chantierLinked = await syncAllDocumentsToChantiers(showAlert && !!googleAccessToken);

    if (showAlert) {
      if (googleAccessToken) {
        let syncSaved = false;
        let exportedDocs = [];

        try {
          syncSaved = await saveSyncToDrive(false);
        } catch (error) {
          console.error(error);
        }

        try {
          exportedDocs = await exportAvailableDocumentsToDrive(false);
        } catch (error) {
          console.error(error);
        }

        if (syncSaved && exportedDocs.length) {
          alert(`Données sauvegardées localement, CRM synchronisé, ${chantierLinked ? 'suivi client synchronisé, ' : ''}et documents exportés sur Google Drive : ${exportedDocs.join(', ')}`);
        } else if (syncSaved) {
          alert(`Données sauvegardées localement et synchronisées avec Google Drive (CRM, paramètres, documents${chantierLinked ? ' et suivis client' : ''}).`);
        } else if (exportedDocs.length) {
          alert(`Données sauvegardées localement, ${chantierLinked ? 'suivi client synchronisé, ' : ''}et documents exportés sur Google Drive : ${exportedDocs.join(', ')}`);
        } else {
          alert(`Données sauvegardées localement${chantierLinked ? ' et suivi client synchronisé' : ''}.`);
        }
      } else {
        alert(`Données sauvegardées localement${chantierLinked ? ' et suivi client synchronisé' : ''}.`);
      }
    }

    render();

  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sauvegarder';
    }
  }
}

function exportDataLocal() {
  syncCommunicationFromInvoice(false);
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
    const docType = normalizeDocTypeFromName(file.name || '');

    if (docType === 'quote' && parsed.quote) {
      data.quote = mergeDeep(structuredClone(defaultData.quote), parsed.quote);
      activePage = 'quote';
    } else if (docType === 'invoice' && parsed.invoice) {
      data.invoice = mergeDeep(structuredClone(defaultData.invoice), parsed.invoice);
      activePage = 'invoice';
    } else if (docType === 'reminder' && parsed.reminder) {
      data.reminder = mergeDeep(structuredClone(defaultData.reminder), parsed.reminder);
      activePage = 'reminder';
    } else {
      throw new Error('Type de document inconnu.');
    }

    syncCommunicationFromInvoice(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    render();
    alert(`Import réussi : ${file.name}`);
  } catch (error) {
    console.error(error);
    alert("Le fichier sélectionné n'est pas un JSON valide.");
  } finally {
    event.target.value = '';
  }
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
function getDriveDocsByType(type) {
  return googleDriveFiles.filter(file => normalizeDocTypeFromName(file.name) === type);
}

function renderDriveColumn(type, title) {
  const docs = getDriveDocsByType(type);
  const items = docs.map(file => {
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
              <div class="hint">Radio = charger. Case = télécharger ou supprimer.</div>
            </div>
            <div class="drive-file-date">${escapeHtml(dateLabel)}</div>
          </div>
        `;
  }).join('');

  return `
        <div class="crm-drive-column">
          <h3 style="margin:0 0 10px; font-size:18px;">${escapeHtml(title)}${docs.length ? ` (${docs.length})` : ''}</h3>
          <div class="drive-file-list">
            ${items || `<div class="simple-box">Aucun ${escapeHtml(title.toLowerCase())} sur Drive.</div>`}
          </div>
        </div>
      `;
}

function getDriveFileName(docKey = '') {
  const numbers = {
    quote: String(data.quote.documentNumber || '').trim(),
    invoice: String(data.invoice.documentNumber || '').trim(),
    reminder: String(data.reminder?.documentNumber || '').trim()
  };
  const prefixes = {
    quote: 'devis',
    invoice: 'facture',
    reminder: 'rappel'
  };

  if (docKey && numbers[docKey]) {
    return `${prefixes[docKey]}-${numbers[docKey]}.json`;
  }

  if (activePage === 'quote' && numbers.quote) return `devis-${numbers.quote}.json`;
  if (activePage === 'invoice' && numbers.invoice) return `facture-${numbers.invoice}.json`;
  if (activePage === 'reminder' && numbers.reminder) return `rappel-${numbers.reminder}.json`;
  if (numbers.quote) return `devis-${numbers.quote}.json`;
  if (numbers.invoice) return `facture-${numbers.invoice}.json`;
  if (numbers.reminder) return `rappel-${numbers.reminder}.json`;

  return 'devis-facture-sans-numero.json';
}

async function loadDriveFiles(showAlert = true) {
  if (!googleAccessToken) {
    if (showAlert) alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  try {
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `mimeType='application/json' and trashed=false and (name contains 'devis-' or name contains 'facture-' or name contains 'rappel-' or name contains 'NC-')`,
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      fields: 'files(id, name, modifiedTime)'
    });

    if (!list) return;

    googleDriveFiles = (list.result.files || []).filter(file => {
      const hiddenSyncNames = ['bastcompta-devis-facture-sync.json', DRIVE_SYNC_FILE_NAME];
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

    driveFileIndex = Object.fromEntries(
      Object.entries(driveFileIndex).filter(([id]) => validIds.has(id))
    );

    render();
    ensureDriveFileIndex(true).then(() => {
      if (activePage === 'crm') render();
    });

  } catch (error) {
    console.error(error);

    if (showAlert) alert("Impossible de charger la liste des sauvegardes Drive. Vérifie la connexion Google Drive dans le portail.");
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

  await loadDriveJsonFileById(selectedDriveFileId, true);
}

async function downloadSelectedJsonFromDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return;
  }

  const fileIds = selectedDriveFileIds.length ? [...selectedDriveFileIds] : (selectedDriveFileId ? [selectedDriveFileId] : []);

  if (!fileIds.length) {
    activePage = 'crm';
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

    alert(importedCount === 1
      ? '1 fichier local a été envoyé vers Google Drive.'
      : `${importedCount} fichiers locaux ont été envoyés vers Google Drive.`);
  } catch (error) {
    console.error(error);
    alert("Échec de l'envoi du fichier local vers Google Drive.");
  } finally {
    event.target.value = '';
  }
}

function money(value) {
  return new Intl.NumberFormat('fr-BE', {
    style: 'currency',
    currency: 'EUR'
  }).format(Number(value || 0));
}

function num(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
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

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function setField(path, value) {
  const keys = path.split('.');
  let ref = data;
  for (let i = 0; i < keys.length - 1; i++) ref = ref[keys[i]];
  ref[keys[keys.length - 1]] = value;
  saveData(false);
}

function lineBase(row) {
  return toNumber(row.qty) * toNumber(row.unitPrice);
}

function lineDiscountAmount(row) {
  return lineBase(row) * (toNumber(row.discount) / 100);
}

function lineNet(row) {
  return lineBase(row) - lineDiscountAmount(row);
}

function lineVat(row) {
  return lineNet(row) * (toNumber(row.vatRate) / 100);
}

function lineTvac(row) {
  return lineNet(row) + lineVat(row);
}

function lineCost(row) {
  // Prix de revient interne : utilisé uniquement pour les fournitures et masqué à l'impression/PDF.
  const costPrice = Number(row?.costPrice ?? row?.purchasePrice ?? row?.cost ?? row?.unitPrice ?? 0) || 0;
  return toNumber(row.qty) * costPrice;
}

function lineSupplyMargin(row) {
  return lineNet(row) - lineCost(row);
}

function totalsFor(docKey) {
  const doc = data[docKey];
  const mainLines = Array.isArray(doc.lines) ? doc.lines : [];
  const suppliesLines = doc.suppliesEnabled && Array.isArray(doc.suppliesLines) ? doc.suppliesLines : [];
  const allLines = [...mainLines, ...suppliesLines];

  const workHtva = mainLines.reduce((sum, row) => sum + lineNet(row), 0);
  const workVat = mainLines.reduce((sum, row) => sum + lineVat(row), 0);
  const suppliesSaleHtva = suppliesLines.reduce((sum, row) => sum + lineNet(row), 0);
  const suppliesVat = suppliesLines.reduce((sum, row) => sum + lineVat(row), 0);
  const suppliesCostHtva = suppliesLines.reduce((sum, row) => sum + lineCost(row), 0);
  const htva = allLines.reduce((sum, row) => sum + lineNet(row), 0);
  const vat = allLines.reduce((sum, row) => sum + lineVat(row), 0);
  const tvac = htva + vat;
  return {
    htva, vat, tvac,
    workHtva, workVat, workTvac: workHtva + workVat,
    suppliesSaleHtva,
    suppliesHtva: suppliesSaleHtva,
    suppliesVat,
    suppliesTvac: suppliesSaleHtva + suppliesVat,
    suppliesCostHtva
  };
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
    console.error('Impossible de lire les suivis client locaux.', error);
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

function getClientTrackingKey(doc) {
  const clientId = String(doc.clientId || '').trim();
  const clientRef = String(doc.clientNumber || doc.clientRef || '').trim();
  const clientName = String(doc.clientName || '').trim();
  if (clientId) return 'id:' + clientId;
  if (clientRef) return 'ref:' + chantierSlug(clientRef);
  return 'name:' + chantierSlug(clientName);
}

function normalizeClientTrackingTitle(doc) {
  return String(doc.clientName || doc.clientNumber || 'Client').trim() || 'Client';
}

function findOrCreateChantierProject(chantiersData, doc) {
  const clientName = String(doc.clientName || '').trim();
  if (!clientName) return null;

  const clientId = String(doc.clientId || '').trim();
  const clientRef = String(doc.clientNumber || '').trim();
  const clientKey = getClientTrackingKey(doc);
  const fallbackClientSlug = chantierSlug(clientName || clientRef || clientId);

  let project = (chantiersData.projects || []).find(item => {
    if (clientId && String(item.clientId || '') === clientId) return true;
    if (clientRef && String(item.clientRef || '') === clientRef) return true;
    return getClientTrackingKey(item) === clientKey;
  });

  if (!project && doc.chantierId) {
    project = (chantiersData.projects || []).find(item => String(item.id || '') === String(doc.chantierId));
  }

  if (!project) {
    project = {
      id: `client-${fallbackClientSlug}-${Date.now().toString(36)}`,
      title: normalizeClientTrackingTitle(doc),
      clientId,
      clientName,
      clientRef,
      address: doc.address || '',
      description: '',
      status: 'active',
      startDate: doc.date || '',
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
  } else {
    project.title = project.clientName || normalizeClientTrackingTitle(doc);
    project.clientId = project.clientId || clientId;
    project.clientName = project.clientName || clientName;
    project.clientRef = project.clientRef || clientRef;
    project.address = project.address || doc.address || '';
    if (!Array.isArray(project.linkedQuotes)) project.linkedQuotes = [];
    if (!Array.isArray(project.linkedInvoices)) project.linkedInvoices = [];
    if (!Array.isArray(project.linkedReminders)) project.linkedReminders = [];
    if (!Array.isArray(project.costs)) project.costs = [];
    if (!Array.isArray(project.documents)) project.documents = [];
    if (!Array.isArray(project.tasks)) project.tasks = [];
    if (!Array.isArray(project.notes)) project.notes = [];
    if (!Array.isArray(project.timeline)) project.timeline = [];
  }

  doc.chantierId = project.id;
  return project;
}

function upsertProjectMoneyItem(list, payload) {
  const stableKey = String(payload.documentUid || payload.id || '').trim();
  const refKey = String(payload.ref || '').trim();
  let item = list.find(entry => stableKey && String(entry.documentUid || entry.id || '').trim() === stableKey);
  if (!item && refKey) {
    item = list.find(entry => String(entry.ref || '').trim() === refKey);
  }
  if (!item) {
    item = { id: payload.id || stableKey || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
    list.push(item);
  }
  Object.assign(item, payload, { documentUid: stableKey || payload.documentUid || payload.id || '' });
}

function addChantierTimeline(project, text) {
  if (!Array.isArray(project.timeline)) project.timeline = [];
  const existingRecent = project.timeline.find(event => event.text === text);
  if (!existingRecent) {
    project.timeline.unshift({
      id: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      date: new Date().toISOString(),
      text
    });
  }
  project.timeline = project.timeline.slice(0, 100);
}

function syncDocumentToChantiers(docKey) {
  const doc = data[docKey];
  if (!doc) return false;

  const siteName = String(doc.siteName || '').trim();
  const clientName = String(doc.clientName || '').trim();
  const documentNumber = String(doc.documentNumber || '').trim();
  if (!clientName || !documentNumber) return false;

  const chantiersData = loadChantiersLocalData();
  const project = findOrCreateChantierProject(chantiersData, doc);
  if (!project) return false;

  const totals = totalsFor(docKey);
  const item = {
    id: `${docKey}-${documentNumber}`,
    documentUid: `${docKey}-${documentNumber}`,
    date: doc.date || '',
    ref: documentNumber,
    description: `${docKey === 'quote' ? 'Devis' : docKey === 'invoice' ? 'Facture' : 'Rappel'} ${documentNumber}`,
    // Suivi client : total facturé au client = prestations + fournitures.
    amount: roundMoney(totals.htva),
    clientHtva: roundMoney(totals.htva),
    totalClientHtva: roundMoney(totals.htva),
    workHtva: roundMoney(totals.workHtva ?? totals.htva),
    htva: roundMoney(totals.workHtva ?? totals.htva),
    vat: roundMoney(totals.vat),
    tvac: roundMoney(totals.tvac),
    suppliesSaleHtva: roundMoney(totals.suppliesSaleHtva ?? totals.suppliesHtva ?? 0),
    suppliesHtva: roundMoney(totals.suppliesSaleHtva ?? totals.suppliesHtva ?? 0),
    suppliesCost: roundMoney(totals.suppliesCostHtva ?? 0),
    suppliesCostHtva: roundMoney(totals.suppliesCostHtva ?? 0),
    costHtva: roundMoney(totals.suppliesCostHtva ?? 0),
    suppliesVat: roundMoney(totals.suppliesVat ?? 0),
    suppliesTvac: roundMoney(totals.suppliesTvac ?? 0),
    source: 'devis-facture',
    docKey,
    clientId: doc.clientId || '',
    clientName,
    clientRef: doc.clientNumber || '',
    siteName,
    suiviClientId: project.id,
    chantierId: project.id
  };

  if (docKey === 'quote') {
    upsertProjectMoneyItem(project.linkedQuotes, item);
    if (!project.quoteAmount || project.quoteAmount < item.htva) project.quoteAmount = item.htva;
  } else if (docKey === 'invoice') {
    upsertProjectMoneyItem(project.linkedInvoices, item);
  } else if (docKey === 'reminder') {
    if (!Array.isArray(project.linkedReminders)) project.linkedReminders = [];
    upsertProjectMoneyItem(project.linkedReminders, item);
  }

  project.updatedAt = new Date().toISOString();
  addChantierTimeline(project, `${item.description} synchronisé dans le suivi client global.`);
  saveChantiersLocalData(chantiersData);
  return true;
}

async function syncAllDocumentsToChantiers(saveDrive = false) {
  // Ne pas utiliser .some() ici : il s’arrête au premier document lié.
  // On veut synchroniser devis + facture + rappel dans le même passage.
  const results = ['quote', 'invoice', 'reminder'].map(docKey => syncDocumentToChantiers(docKey));
  const changed = results.some(Boolean);
  if (changed && saveDrive && googleAccessToken) {
    await saveChantiersSyncToDrive(false);
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

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name';
    let method = 'POST';
    if (isUpdate) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart&fields=id,name`;
      method = 'PATCH';
    }

    const res = await googleDriveFetch(url, {
      method,
      headers: { Authorization: `Bearer ${googleAccessToken}` },
      body: form
    }, false);

    return !!res && res.ok;
  } catch (error) {
    console.error(error);
    if (showErrorAlert) alert('La synchronisation des suivis client vers Google Drive a échoué.');
    return false;
  }
}

async function syncCurrentDocumentToChantierFromButton(docKey) {
  const ok = syncDocumentToChantiers(docKey);
  if (ok && googleAccessToken) await saveChantiersSyncToDrive(false);
  alert(ok
    ? 'Le document est lié au chantier.'
    : 'Indique au minimum un client, un nom de chantier et un numéro de document.');
}

function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

const DOCUMENT_NUMBER_CONFIG = {
  quote: { prefix: 'D', label: 'devis' },
  invoice: { prefix: 'F', label: 'facture' },
  reminder: { prefix: 'RF', label: 'rappel' },
  credit_note: { prefix: 'NC', label: 'note de crédit' }
};

function getCurrentDocumentYear() {
  return String(new Date().getFullYear());
}

function formatDocumentNumber(kind, year, sequence) {
  const config = DOCUMENT_NUMBER_CONFIG[kind] || DOCUMENT_NUMBER_CONFIG.quote;
  return `${config.prefix}-${year}-${String(sequence || 1).padStart(3, '0')}`;
}

function parseBusinessDocumentNumber(value) {
  const text = String(value || '').trim().toUpperCase();
  const match = text.match(/\b(RF|NC|D|F)-(\d{4})-(\d{1,})\b/);
  if (!match) return null;

  const prefixToKind = { D: 'quote', F: 'invoice', RF: 'reminder', NC: 'credit_note' };
  return {
    kind: prefixToKind[match[1]] || '',
    prefix: match[1],
    year: match[2],
    sequence: parseInt(match[3], 10) || 0
  };
}

function addDocumentNumberCandidate(candidates, value, source = '') {
  const parsed = parseBusinessDocumentNumber(value);
  if (!parsed || !parsed.kind || !parsed.sequence) return;
  candidates.push({ ...parsed, source });
}

function collectDocumentNumberCandidates() {
  const candidates = [];

  addDocumentNumberCandidate(candidates, data.quote?.documentNumber, 'quote.current');
  addDocumentNumberCandidate(candidates, data.invoice?.documentNumber, 'invoice.current');
  addDocumentNumberCandidate(candidates, data.reminder?.documentNumber, 'reminder.current');

  (googleDriveFiles || []).forEach(file => {
    addDocumentNumberCandidate(candidates, file?.name, 'drive.name');
  });

  Object.values(driveFileIndex || {}).forEach(meta => {
    addDocumentNumberCandidate(candidates, meta?.documentNumber, 'drive.index');
  });

  return candidates;
}

function getHighestDocumentSequence(kind, year = getCurrentDocumentYear()) {
  return collectDocumentNumberCandidates()
    .filter(item => item.kind === kind && item.year === String(year))
    .reduce((max, item) => Math.max(max, item.sequence || 0), 0);
}

function generateNextDocumentNumber(kind, year = getCurrentDocumentYear()) {
  return formatDocumentNumber(kind, year, getHighestDocumentSequence(kind, year) + 1);
}

async function refreshDocumentNumberSources() {
  if (!googleAccessToken || !window.gapi?.client) return;
  try {
    await loadDriveFiles(false);
    await ensureDriveFileIndex(true);
  } catch (error) {
    console.error('Impossible de rafraîchir les sources de numérotation.', error);
  }
}

function setAutomaticDocumentNumber(docKey, kind = docKey, force = false) {
  const doc = data[docKey];
  if (!doc) return '';
  if (!force && String(doc.documentNumber || '').trim()) return doc.documentNumber;
  const nextNumber = generateNextDocumentNumber(kind);
  doc.documentNumber = nextNumber;
  return nextNumber;
}

function setDefaultDocumentDates(docKey) {
  const doc = data[docKey];
  if (!doc) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!doc.date) doc.date = today;
}

async function prepareNewDocument(docKey, kind = docKey) {
  await refreshDocumentNumberSources();
  setAutomaticDocumentNumber(docKey, kind, true);
  setDefaultDocumentDates(docKey);
}

const INVOICE_STATUS_LABELS = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  paid: 'Payée',
  partial: 'Partiellement payée',
  cancelled: 'Annulée',
  credit_note: 'Note de crédit'
};

function getInvoiceStatusLabel(status) {
  return INVOICE_STATUS_LABELS[status] || INVOICE_STATUS_LABELS.draft;
}

function getEffectiveInvoiceStatus(doc = data.invoice) {
  const explicit = String(doc?.status || 'draft');
  if (explicit === 'cancelled' || explicit === 'credit_note') return explicit;
  const totals = totalsFor('invoice');
  const paid = toNumber(doc?.paidAmount);
  if (totals.tvac > 0 && paid >= totals.tvac - 0.009) return 'paid';
  if (paid > 0.009) return 'partial';
  return explicit || 'draft';
}

function setInvoiceStatus(status) {
  data.invoice.status = status || 'draft';
  saveData(false);
}

function cancelInvoice() {
  const number = String(data.invoice.documentNumber || '').trim() || 'cette facture';
  if (!confirm(`Marquer ${number} comme annulée ?\n\nElle ne sera plus envoyée comme vente en comptabilité. Si elle avait déjà été envoyée, l’envoi vers comptabilité supprimera/remplacera ses lignes existantes hors période TVA clôturée.`)) return;
  data.invoice.status = 'cancelled';
  saveData(false);
}

function makeCreditNoteNumber(originalNumber) {
  return generateNextDocumentNumber('credit_note');
}

async function createCreditNoteFromInvoice() {
  const original = String(data.invoice.documentNumber || '').trim();
  if (!original) {
    alert('Indique d’abord un numéro de facture avant de créer une note de crédit.');
    return;
  }
  if (!confirm(`Créer une note de crédit liée à la facture ${original} ?\n\nUn numéro NC sera attribué automatiquement et les lignes seront reprises en négatif pour corriger la vente et la TVA.`)) return;

  await refreshDocumentNumberSources();
  const creditNumber = makeCreditNoteNumber(original);

  const cloneLinesAsCredit = rows => (Array.isArray(rows) ? rows : defaultLines()).map(row => ({
    ...structuredClone(row),
    qty: -Math.abs(toNumber(row.qty) || 1)
  }));

  data.invoice.documentNumber = creditNumber;
  data.invoice.linkedInvoiceNumber = original;
  data.invoice.creditNoteReason = data.invoice.creditNoteReason || `Note de crédit liée à la facture ${original}`;
  data.invoice.status = 'credit_note';
  data.invoice.paidAmount = 0;
  data.invoice.lines = cloneLinesAsCredit(data.invoice.lines);
  if (data.invoice.suppliesEnabled) {
    data.invoice.suppliesLines = cloneLinesAsCredit(data.invoice.suppliesLines);
  }
  saveData(false);
  activePage = 'invoice';
  render();
}

function getInvoiceAccountingRowsForComptabilite() {
  const invoice = data.invoice || {};
  const status = getEffectiveInvoiceStatus(invoice);
  const invoiceNumber = String(invoice.documentNumber || '').trim();

  if (status === 'cancelled') {
    return {
      action: 'cancel',
      documentType: 'cancelled_invoice',
      documentStatus: status,
      invoiceNumber,
      rows: [],
      message: `La facture ${invoiceNumber || ''} est annulée. L’envoi vers comptabilité retirera ses lignes existantes si la période TVA n’est pas clôturée.`
    };
  }

  const mainLines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const suppliesLines = invoice.suppliesEnabled && Array.isArray(invoice.suppliesLines) ? invoice.suppliesLines : [];
  const allLines = [...mainLines, ...suppliesLines].filter(row => {
    return String(row.description || '').trim() || toNumber(row.qty) || toNumber(row.unitPrice);
  });

  if (!allLines.length) {
    return { rows: [], message: 'La facture ne contient aucune ligne.' };
  }

  const grouped = new Map();
  allLines.forEach(row => {
    const rate = roundMoney(row.vatRate);
    const key = String(rate);
    if (!grouped.has(key)) grouped.set(key, { rate, tvac: 0, descriptions: [] });
    const group = grouped.get(key);
    group.tvac += lineTvac(row);
    const description = String(row.description || '').trim();
    if (description) group.descriptions.push(description);
  });

  const isCreditNote = status === 'credit_note';
  const rows = Array.from(grouped.values()).map(group => ({
    date: invoice.date || '',
    client: invoice.clientName || '',
    invoiceNumber,
    linkedInvoiceNumber: invoice.linkedInvoiceNumber || '',
    documentStatus: status,
    documentType: isCreditNote ? 'credit_note' : 'invoice',
    description: isCreditNote
      ? `Note de crédit${invoice.linkedInvoiceNumber ? ' liée à ' + invoice.linkedInvoiceNumber : ''}`
      : '',
    rate: group.rate,
    tvac: isCreditNote ? -Math.abs(roundMoney(group.tvac)) : roundMoney(group.tvac)
  }));

  return {
    action: 'upsert',
    documentType: status === 'credit_note' ? 'credit_note' : 'invoice',
    documentStatus: status,
    invoiceNumber,
    linkedInvoiceNumber: invoice.linkedInvoiceNumber || '',
    rows,
    message: rows.length + ' ligne(s) prête(s) pour la comptabilité.'
  };
}

window.getInvoiceAccountingRowsForComptabilite = getInvoiceAccountingRowsForComptabilite;

function sendInvoiceToAccountingFromIframe() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'BASTCOMPTA_SEND_INVOICE_TO_ACCOUNTING' }, window.location.origin);
      return;
    }
  } catch (error) {
    console.error(error);
  }
  alert('Cette action doit être utilisée depuis le portail BastCompta.');
}

window.sendInvoiceToAccountingFromIframe = sendInvoiceToAccountingFromIframe;

function createEmptyLine() {
  return {
    description: '',
    qty: 1,
    unit: 'p',
    unitPrice: 0,
    costPrice: 0,
    discount: 0,
    vatRate: 21
  };
}

function addLine(docKey, section = 'lines') {
  data[docKey][section].push(createEmptyLine());
  saveData(false);
}

function deleteLine(docKey, section, index) {
  if (!confirm('Supprimer cette ligne ?')) return;
  data[docKey][section].splice(index, 1);
  if (!data[docKey][section].length) {
    data[docKey][section].push(createEmptyLine());
  }
  saveData(false);
}

function toggleSupplies(docKey, checked) {
  data[docKey].suppliesEnabled = checked;
  if (!Array.isArray(data[docKey].suppliesLines) || !data[docKey].suppliesLines.length) {
    data[docKey].suppliesLines = defaultLines();
  }
  saveData(false);
}

async function copyQuoteToInvoice() {
  if (!confirm('Reprendre les données du devis dans la facture ? Cela remplacera les données actuelles de la facture.')) return;

  data.invoice.clientId = data.quote.clientId || '';
  data.invoice.clientNumber = data.quote.clientNumber;
  data.invoice.clientVat = data.quote.clientVat;
  data.invoice.clientName = data.quote.clientName;
  data.invoice.clientEmail = data.quote.clientEmail || '';
  data.invoice.address = data.quote.address;
  data.invoice.siteName = data.quote.siteName;
  data.invoice.chantierId = data.quote.chantierId || '';
  data.invoice.notes = data.quote.notes;
  data.invoice.status = 'draft';
  data.invoice.linkedInvoiceNumber = '';
  data.invoice.creditNoteReason = '';
  data.invoice.paidAmount = 0;

  data.invoice.lines = structuredClone(data.quote.lines || defaultLines());
  data.invoice.suppliesEnabled = !!data.quote.suppliesEnabled;
  data.invoice.suppliesLines = structuredClone(data.quote.suppliesLines || defaultLines());

  await prepareNewDocument('invoice', 'invoice');

  saveData(false);
  activePage = 'invoice';
  render();
}

async function copyInvoiceToReminder() {
  if (!confirm('Reprendre les données de la facture dans le rappel ? Cela remplacera les données actuelles du rappel.')) return;

  data.reminder.clientId = data.invoice.clientId || '';
  data.reminder.clientNumber = data.invoice.clientNumber;
  data.reminder.clientVat = data.invoice.clientVat;
  data.reminder.clientName = data.invoice.clientName;
  data.reminder.clientEmail = data.invoice.clientEmail || '';
  data.reminder.address = data.invoice.address;
  data.reminder.date = data.invoice.date || '';
  data.reminder.dueDate = data.invoice.dueDate || '';
  data.reminder.siteName = data.invoice.siteName;
  data.reminder.chantierId = data.invoice.chantierId || '';
  data.reminder.paidAmount = toNumber(data.invoice.paidAmount);
  data.reminder.notes = data.invoice.notes;
  data.reminder.lines = structuredClone(data.invoice.lines || defaultLines());
  data.reminder.suppliesEnabled = !!data.invoice.suppliesEnabled;
  data.reminder.suppliesLines = structuredClone(data.invoice.suppliesLines || defaultLines());

  await prepareNewDocument('reminder', 'reminder');

  saveData(false);
  activePage = 'reminder';
  render();
}

async function resetDocumentLocal(docKey) {
  const labels = {
    quote: 'devis',
    invoice: 'facture',
    reminder: 'rappel'
  };
  const label = labels[docKey] || 'document';

  if (!confirm(`Créer un nouveau ${label} ?\n\nLe document actuel sera vidé localement et un nouveau numéro sera attribué automatiquement.`)) return;

  data[docKey] = structuredClone(defaultData[docKey]);
  await prepareNewDocument(docKey, docKey);

  if (docKey === 'invoice') {
    syncCommunicationFromInvoice(false);
  }

  saveData(false);
  render();
}


function closeToolbarMenus() {
  document.querySelectorAll('.menu-panel.open').forEach(panel => panel.classList.remove('open'));
}

function toggleToolbarMenu(event, menuId) {
  event.stopPropagation();
  const target = document.getElementById(menuId);
  if (!target) return;

  const shouldOpen = !target.classList.contains('open');
  closeToolbarMenus();
  if (shouldOpen) {
    target.classList.add('open');
  }
}

function getInvoicePaymentText() {
  const totals = totalsFor('invoice');
  const paidAmount = toNumber(data.invoice.paidAmount);
  const balance = totals.tvac - paidAmount;

  return `Paiement : ${money(balance)}
Compte : ${data.company.iban || 'IBAN'}
Communication : ${data.communication.formatted || '+++...+++'}`;
}

function normalizeClientNumber(value) {
  let v = String(value || '').replace(/\D/g, '');

  if (!v) return '';

  // Si déjà sur 3 chiffres → on garde
  if (v.length === 3) return v;

  // Si 1 ou 2 chiffres → on ajoute "1" devant
  if (v.length <= 2) {
    return ('1' + v).slice(0, 3);
  }

  return v.slice(0, 3);
}

function normalizeYear(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 4);
}

function normalizeInvoiceNumber(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 2);
}

function computeStructuredCommunication(clientNumber, invoiceYear, invoiceNumber) {
  const c = normalizeClientNumber(clientNumber);
  const y = normalizeYear(invoiceYear);
  const i = normalizeInvoiceNumber(invoiceNumber);

  if (!c || !y || !i || y.length !== 4) {
    return { base: '', control: '', formatted: '+++...+++' };
  }

  const base = `${c}${y}${i}`;
  const mod = Number(base) % 97;
  const control = mod === 0 ? 97 : mod;
  const controlPadded = String(control).padStart(2, '0');

  return {
    base,
    control: controlPadded,
    formatted: `+++${c}/${y}/${i}${controlPadded}+++`
  };
}

function syncCommunicationFromInvoice(shouldRender = true) {
  // On force l'utilisation des données de la facture uniquement
  const clientSource = data.invoice.clientNumber;
  const yearSource = data.invoice.date ? String(data.invoice.date).slice(0, 4) : '';

  const invoiceDigits = String(data.invoice.documentNumber || '').replace(/\D/g, '');
  const invoiceShort = invoiceDigits ? invoiceDigits.slice(-2) : '';

  const result = computeStructuredCommunication(clientSource, yearSource, invoiceShort);

  data.communication.clientNumber = normalizeClientNumber(clientSource);
  data.communication.invoiceYear = normalizeYear(yearSource);
  data.communication.invoiceNumber = normalizeInvoiceNumber(invoiceShort);
  data.communication.controlNumber = result.control;
  data.communication.formatted = result.formatted;

  if (shouldRender) render();
  return result;
}


function getSyncDriveFileName() {
  return DRIVE_SYNC_FILE_NAME;
}

async function saveSyncToDrive(showErrorAlert = false) {
  if (!googleAccessToken) return false;

  try {
    const fileName = getSyncDriveFileName();
    const syncPayload = {
      company: mergeDeep(structuredClone(defaultData.company), data.company || {}),
      clients: Array.isArray(data.clients) ? data.clients : [],
      mail: {
        recentEmails: Array.isArray(data.mail?.recentEmails) ? data.mail.recentEmails : [],
        quoteSubject: data.mail?.quoteSubject || defaultData.mail.quoteSubject,
        quoteBody: data.mail?.quoteBody || defaultData.mail.quoteBody,
        invoiceSubject: data.mail?.invoiceSubject || defaultData.mail.invoiceSubject,
        invoiceBody: data.mail?.invoiceBody || defaultData.mail.invoiceBody,
        reminderSubject: data.mail?.reminderSubject || defaultData.mail.reminderSubject,
        reminderBody: data.mail?.reminderBody || defaultData.mail.reminderBody
      }
    };
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

    if (!res) return false;

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
    }, false);

    if (!res) return false;

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const parsed = await res.json();
    if (parsed.company && typeof parsed.company === 'object') {
      data.company = mergeDeep(structuredClone(defaultData.company), parsed.company);
    }
    if (Array.isArray(parsed.clients)) {
      data.clients = parsed.clients.map(normalizeClient).filter(client => client.name);
    }
    if (parsed.mail && typeof parsed.mail === 'object') {
      data.mail = mergeDeep(structuredClone(defaultData.mail), parsed.mail);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function downloadHiddenCrmSyncFromDrive() {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return false;
  }

  try {
    const fileName = getSyncDriveFileName();
    const list = await driveFilesList({
      spaces: 'appDataFolder',
      q: `name='${fileName.replace(/'/g, "\'")}' and trashed=false`,
      orderBy: 'modifiedTime desc',
      pageSize: 1,
      fields: 'files(id, name, modifiedTime)'
    }, false);

    if (!list) return false;
    const file = (list.result.files || [])[0];
    if (!file) {
      alert('Aucun fichier CRM caché trouvé sur Google Drive.');
      return false;
    }

    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      }
    });

    if (!res) return false;

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const content = await res.text();
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name || fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    alert(`Téléchargement terminé : ${file.name || fileName}`);
    return true;
  } catch (error) {
    console.error(error);
    alert("Échec du téléchargement du fichier CRM caché depuis Google Drive.");
    return false;
  }
}


function createEmptyClient() {
  return {
    id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    email: '',
    address: '',
    clientNumber: '',
    vat: '',
    phone: '',
    contact: '',
    notes: '',
    favorite: false,
    createdAt: new Date().toISOString()
  };
}

function normalizeClient(client = {}) {
  const base = createEmptyClient();
  return {
    ...base,
    ...client,
    name: String(client.name || '').trim(),
    email: sanitizeEmail(client.email || ''),
    address: String(client.address || '').trim(),
    clientNumber: String(client.clientNumber || '').trim(),
    vat: String(client.vat || '').trim(),
    phone: String(client.phone || '').trim(),
    contact: String(client.contact || '').trim(),
    notes: String(client.notes || '').trim(),
    favorite: !!client.favorite,
    createdAt: client.createdAt || base.createdAt,
    id: client.id || base.id
  };
}

function getClients() {
  const clients = Array.isArray(data.clients) ? data.clients : [];
  return clients
    .map(normalizeClient)
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;

      const aNum = String(a.clientNumber || '999999');
      const bNum = String(b.clientNumber || '999999');

      const byNumber = aNum.localeCompare(bNum, 'fr', { numeric: true, sensitivity: 'base' });
      if (byNumber !== 0) return byNumber;

      return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
    });
}

function clientLabel(client) {
  const parts = [client.name || 'Client sans nom'];
  if (client.email) parts.push(client.email);
  if (client.clientNumber) parts.push(`N° ${client.clientNumber}`);
  return parts.join(' — ');
}

function saveClientRecord(client, shouldAlert = true) {
  const normalized = normalizeClient(client);

  if (!normalized.name) {
    if (shouldAlert) {
      alert('Renseigne au minimum le nom du client.');
    }
    return;
  }

  const list = Array.isArray(data.clients) ? [...data.clients] : [];
  const normalizedClientNumber = String(normalized.clientNumber || '').trim();

  let index = -1;

  if (normalized.id) {
    index = list.findIndex(item => item.id === normalized.id);
  }

  if (index < 0 && normalizedClientNumber) {
    index = list.findIndex(item =>
      String(item?.clientNumber || '').trim() === normalizedClientNumber
    );

    if (index >= 0) {
      normalized.id = list[index].id;
    }
  }

  if (index >= 0) {
    list[index] = {
      ...list[index],
      ...normalized
    };
  } else {
    list.push(normalized);
  }

  data.clients = list.filter(item => String(item?.name || '').trim());
  crmExpandedClientId = normalized.id;

  if (normalized.email) rememberClientEmail(normalized.email);
  saveData(false);

  if (shouldAlert) alert("Client enregistré dans le carnet d'adresses.");
}

function saveCurrentClientFromDoc(docKey) {
  const doc = data[docKey] || {};
  saveClientRecord({
    id: doc.clientId || '',
    name: doc.clientName || '',
    email: doc.clientEmail || '',
    address: doc.address || '',
    clientNumber: doc.clientNumber || '',
    vat: doc.clientVat || '',
    phone: '',
    contact: '',
    notes: ''
  }, false);

  const savedClient = getClients().find(client =>
    String(client.clientNumber || '').trim() === String(doc.clientNumber || '').trim()
  );

  if (savedClient) {
    data[docKey].clientId = savedClient.id;
    saveData(false);
  }
}

function applyClientToDocument(docKey, clientId) {
  const client = getClients().find(item => item.id === clientId);
  if (!client) return;

  data[docKey].clientId = client.id;
  data[docKey].clientName = client.name || '';
  data[docKey].clientEmail = client.email || '';
  data[docKey].address = client.address || '';
  data[docKey].clientNumber = client.clientNumber || '';
  data[docKey].clientVat = client.vat || '';
  if (client.email) rememberClientEmail(client.email);
  saveData(false);
}

function deleteClient(clientId) {
  const client = getClients().find(item => item.id === clientId);
  if (!client) return;
  if (!confirm(`Supprimer le client ${client.name || 'sans nom'} ?`)) return;
  data.clients = (data.clients || []).filter(item => item.id !== clientId);
  ['quote', 'invoice'].forEach(docKey => {
    if (data[docKey].clientId === clientId) {
      data[docKey].clientId = '';
    }
  });
  saveData(false);
}

function duplicateClient(clientId) {
  const client = getClients().find(item => item.id === clientId);
  if (!client) return;
  saveClientRecord({
    ...client,
    id: '',
    name: `${client.name} (copie)`,
    favorite: false,
    createdAt: new Date().toISOString()
  }, false);
  alert('Client dupliqué.');
}

function createNewClient() {
  const client = normalizeClient({
    name: `Nouveau client ${(Array.isArray(data.clients) ? data.clients.length : 0) + 1}`,
    createdAt: new Date().toISOString()
  });
  data.clients = [...(Array.isArray(data.clients) ? data.clients : []), client];
  crmExpandedClientId = client.id;
  saveData(false);
}

function toggleClientExpanded(clientId) {
  crmExpandedClientId = crmExpandedClientId === clientId ? '' : clientId;
  render();
}

function getClientStats(clientId) {
  const quoteCount = data.quote?.clientId === clientId ? 1 : 0;
  const invoiceCount = data.invoice?.clientId === clientId ? 1 : 0;
  const invoiceTotal = data.invoice?.clientId === clientId ? totalsFor('invoice').tvac : 0;
  return { quoteCount, invoiceCount, invoiceTotal };
}

function renderClientOptions(selectedId = '') {
  const options = getClients().map(client => `
        <option value="${escapeAttr(client.id)}" ${selectedId === client.id ? 'selected' : ''}>${escapeHtml(client.name || 'Client sans nom')}</option>
      `).join('');
  return `<option value="">-- Choisir un client enregistré --</option>${options}`;
}


function setCrmSearchTerm(value) {
  crmSearchTerm = String(value || '');

  const crmPage = document.querySelector('.page[data-page="crm"]');
  if (!crmPage) return;

  const oldPanel = crmPage.querySelector('.comm-panel');
  if (!oldPanel) return;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderCRMInner();
  const newPanel = wrapper.firstElementChild;

  if (newPanel) {
    oldPanel.replaceWith(newPanel);
  }

  const searchInput = document.getElementById('crmSearchInput');
  if (searchInput) {
    searchInput.focus();
    const len = searchInput.value.length;
    try {
      searchInput.setSelectionRange(len, len);
    } catch (e) { }
  }
}

function normalizeClientNumberForMatch(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || String(value || '').trim().toLowerCase();
}

function normalizeDocTypeFromName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.startsWith('devis-')) return 'quote';
  if (lower.startsWith('facture-')) return 'invoice';
  if (lower.startsWith('note-credit-') || lower.startsWith('credit-note-')) return 'invoice';
  if (lower.startsWith('rappel-')) return 'reminder';
  return '';
}

function getDriveDocMetaFromParsed(parsed, fileName, modifiedTime = '') {
  const type = normalizeDocTypeFromName(fileName);
  const source = type === 'invoice'
    ? (parsed.invoice || {})
    : type === 'reminder'
      ? (parsed.reminder || {})
      : (parsed.quote || {});
  return {
    type,
    documentNumber: String(source.documentNumber || '').trim(),
    clientNumber: String(source.clientNumber || '').trim(),
    clientName: String(source.clientName || '').trim(),
    modifiedTime: modifiedTime || ''
  };
}

async function fetchDriveFileParsed(fileId) {
  const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: {
      Authorization: `Bearer ${googleAccessToken}`
    }
  }, false);

  if (!res) {
    throw new Error('Session Google Drive expirée.');
  }

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

async function ensureDriveFileIndex(force = false) {
  if (!googleAccessToken) return [];
  if (!googleDriveFiles.length) return [];

  const filesToRead = force
    ? googleDriveFiles
    : googleDriveFiles.filter(file => !driveFileIndex[file.id]);

  if (filesToRead.length) {
    const summaries = await Promise.all(filesToRead.map(async (file) => {
      try {
        const parsed = await fetchDriveFileParsed(file.id);
        return [file.id, {
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime || '',
          ...getDriveDocMetaFromParsed(parsed, file.name, file.modifiedTime || '')
        }];
      } catch (error) {
        console.error(error);
        return [file.id, {
          id: file.id,
          name: file.name,
          modifiedTime: file.modifiedTime || '',
          type: normalizeDocTypeFromName(file.name),
          documentNumber: '',
          clientNumber: '',
          clientName: ''
        }];
      }
    }));
    for (const [id, summary] of summaries) {
      driveFileIndex[id] = summary;
    }
  }

  return googleDriveFiles.map(file => driveFileIndex[file.id]).filter(Boolean);
}

function getIndexedDriveDocsForClient(client) {
  const clientKey = normalizeClientNumberForMatch(client.clientNumber);
  const docs = Object.values(driveFileIndex).filter(doc => normalizeClientNumberForMatch(doc.clientNumber) === clientKey);

  const sortDocs = (a, b) => {
    const aNum = String(a.documentNumber || '');
    const bNum = String(b.documentNumber || '');
    return aNum.localeCompare(bNum, 'fr', { numeric: true, sensitivity: 'base' });
  };

  return {
    quotes: docs.filter(doc => doc.type === 'quote').sort(sortDocs),
    invoices: docs.filter(doc => doc.type === 'invoice').sort(sortDocs),
    reminders: docs.filter(doc => doc.type === 'reminder').sort(sortDocs)
  };
}

function clientMatchesSearch(client) {
  const term = crmSearchTerm.trim().toLowerCase();
  if (!term) return true;

  const baseFields = [
    client.name,
    client.clientNumber,
    client.email,
    client.vat
  ].map(value => String(value || '').toLowerCase());

  if (baseFields.some(value => value.includes(term))) return true;

  const linked = getIndexedDriveDocsForClient(client);
  const docs = [...linked.quotes, ...linked.invoices, ...linked.reminders];
  return docs.some(doc => [
    doc.documentNumber,
    doc.clientNumber,
    doc.clientName,
    doc.name
  ].some(value => String(value || '').toLowerCase().includes(term)));
}

async function loadDriveJsonFileById(fileId, showAlert = true) {
  if (!fileId) {
    if (showAlert) alert("Aucun fichier sélectionné.");
    return null;
  }

  if (!googleAccessToken) {
    if (showAlert) alert("Connecte Google Drive depuis le portail BastCompta.");
    return null;
  }

  try {
    const file = googleDriveFiles.find(item => item.id === fileId) || driveFileIndex[fileId] || null;
    const parsed = await fetchDriveFileParsed(fileId);

    // Dans le suivi client, les documents viennent parfois de l'index CRM (driveFileIndex)
    // et pas directement de googleDriveFiles. On détecte donc le type par ordre de fiabilité :
    // 1) contenu du JSON, 2) index CRM, 3) nom du fichier.
    let docType = '';
    if (parsed && parsed.quote) docType = 'quote';
    else if (parsed && parsed.invoice) docType = 'invoice';
    else if (parsed && parsed.reminder) docType = 'reminder';
    else docType = driveFileIndex[fileId]?.type || normalizeDocTypeFromName(file?.name || '');

    if (docType === 'quote' && parsed.quote) {
      data.quote = mergeDeep(structuredClone(defaultData.quote), parsed.quote);
      activePage = 'quote';
    } else if (docType === 'invoice' && parsed.invoice) {
      data.invoice = mergeDeep(structuredClone(defaultData.invoice), parsed.invoice);
      activePage = 'invoice';
    } else if (docType === 'reminder' && parsed.reminder) {
      data.reminder = mergeDeep(structuredClone(defaultData.reminder), parsed.reminder);
      activePage = 'reminder';
    } else {
      console.warn('Document Drive non reconnu', { fileId, file, parsed });
      throw new Error('Type de document inconnu.');
    }

    syncCommunicationFromInvoice(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    selectedDriveFileId = fileId;
    render();

    setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 0);

    if (showAlert) {
      alert(`Import réussi : ${file ? file.name : 'fichier sélectionné'}`);
    }

    return parsed;
  } catch (error) {
    console.error(error);
    if (showAlert) {
      alert("Échec de l'import depuis Google Drive. Ouvre la console pour voir le détail.");
    }
    return null;
  }
}

async function downloadDriveFileById(fileId, showAlert = true) {
  if (!googleAccessToken) {
    if (showAlert) alert("Connecte Google Drive depuis le portail BastCompta.");
    return false;
  }

  try {
    const file = googleDriveFiles.find(item => item.id === fileId);
    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      }
    });

    if (!res) return false;

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

    if (showAlert) {
      alert('Téléchargement terminé.');
    }
    return true;
  } catch (error) {
    console.error(error);
    if (showAlert) {
      alert("Échec du téléchargement depuis Google Drive.");
    }
    return false;
  }
}

async function deleteDriveFileById(fileId, showAlert = true) {
  if (!googleAccessToken) {
    if (showAlert) alert("Connecte Google Drive depuis le portail BastCompta.");
    return false;
  }

  const file = googleDriveFiles.find(item => item.id === fileId);
  if (!confirm(`Supprimer définitivement ${file?.name || 'cette sauvegarde'} ?`)) return false;

  try {
    const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${googleAccessToken}`
      }
    });
    if (!res) return false;
    if (!res.ok) throw new Error(await res.text());

    delete driveFileIndex[fileId];
    googleDriveFiles = googleDriveFiles.filter(item => item.id !== fileId);
    selectedDriveFileIds = selectedDriveFileIds.filter(id => id !== fileId);
    if (selectedDriveFileId === fileId) {
      selectedDriveFileId = googleDriveFiles[0]?.id || '';
    }
    render();

    if (showAlert) {
      alert('Sauvegarde supprimée.');
    }
    return true;
  } catch (error) {
    console.error(error);
    if (showAlert) {
      alert('Erreur lors de la suppression.');
    }
    return false;
  }
}


function getClientDriveDocIds(clientId) {
  const client = getClients().find(item => item.id === clientId);
  if (!client) return [];
  const linkedDocs = getIndexedDriveDocsForClient(client);
  return [...linkedDocs.quotes, ...linkedDocs.invoices, ...linkedDocs.reminders].map(doc => doc.id);
}

function getSelectedDriveIdsForClient(clientId) {
  const allowedIds = new Set(getClientDriveDocIds(clientId));
  const checkedIds = selectedDriveFileIds.filter(id => allowedIds.has(id));
  if (checkedIds.length) return checkedIds;
  if (selectedDriveFileId && allowedIds.has(selectedDriveFileId)) return [selectedDriveFileId];
  return [];
}

function selectAllDriveFilesForClient(clientId) {
  const ids = getClientDriveDocIds(clientId);
  if (!ids.length) {
    alert('Aucun fichier Drive lié à ce client.');
    return;
  }
  selectedDriveFileIds = [...new Set([...selectedDriveFileIds, ...ids])];
  if (!selectedDriveFileId) {
    selectedDriveFileId = ids[0] || '';
  }
  render();
}

function clearDriveFileSelectionForClient(clientId) {
  const ids = new Set(getClientDriveDocIds(clientId));
  selectedDriveFileIds = selectedDriveFileIds.filter(id => !ids.has(id));
  if (selectedDriveFileId && ids.has(selectedDriveFileId)) {
    selectedDriveFileId = '';
  }
  render();
}

async function importSelectedClientJsonFromDrive(clientId) {
  const ids = getSelectedDriveIdsForClient(clientId);
  if (!ids.length) {
    alert('Choisis d’abord un fichier lié à ce client.');
    return null;
  }
  selectedDriveFileId = ids[0];
  return loadDriveJsonFileById(selectedDriveFileId);
}

async function downloadSelectedClientJsonFromDrive(clientId) {
  const fileIds = getSelectedDriveIdsForClient(clientId);
  if (!fileIds.length) {
    alert('Choisis au moins un fichier lié à ce client.');
    return false;
  }

  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return false;
  }

  try {
    for (const fileId of fileIds) {
      const file = googleDriveFiles.find(f => f.id === fileId);
      const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      if (!res) return false;
      if (!res.ok) throw new Error(await res.text());
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
    alert(fileIds.length === 1 ? 'Téléchargement terminé.' : `${fileIds.length} fichiers ont été téléchargés vers ce PC.`);
    return true;
  } catch (error) {
    console.error(error);
    alert("Échec du téléchargement depuis Google Drive.");
    return false;
  }
}

async function deleteSelectedClientJsonFromDrive(clientId) {
  const fileIds = getSelectedDriveIdsForClient(clientId);
  if (!fileIds.length) {
    alert('Coche au moins une sauvegarde liée à ce client à supprimer.');
    return false;
  }

  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return false;
  }

  if (!confirm(fileIds.length === 1
    ? 'Supprimer cette sauvegarde définitivement ?'
    : `Supprimer définitivement ces ${fileIds.length} sauvegardes ?`)) return false;

  try {
    for (const fileId of fileIds) {
      const res = await googleDriveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${googleAccessToken}` }
      });
      if (!res) return false;
      if (!res.ok) throw new Error(await res.text());
      delete driveFileIndex[fileId];
    }

    googleDriveFiles = googleDriveFiles.filter(item => !fileIds.includes(item.id));
    selectedDriveFileIds = selectedDriveFileIds.filter(id => !fileIds.includes(id));
    if (selectedDriveFileId && fileIds.includes(selectedDriveFileId)) {
      selectedDriveFileId = '';
    }

    render();
    alert(fileIds.length === 1 ? 'Sauvegarde supprimée.' : `${fileIds.length} sauvegardes supprimées.`);
    return true;
  } catch (error) {
    console.error(error);
    alert('Erreur lors de la suppression.');
    return false;
  }
}

async function exportDocTypeToDrive(docKey, showAlert = true) {
  if (!googleAccessToken) {
    if (showAlert) alert("Connecte Google Drive depuis le portail BastCompta.");
    return null;
  }

  try {
    const doc = data[docKey] || {};
    const prefixes = { quote: 'devis', invoice: 'facture', reminder: 'rappel' };
    const prefix = prefixes[docKey] || 'document';
    const docNumber = String(doc.documentNumber || '').trim();
    if (!docNumber) {
      return null;
    }
    const fileName = `${prefix}-${docNumber}.json`;
    const content = JSON.stringify(data, null, 2);

    const existing = await driveFilesList({
      spaces: 'appDataFolder',
      q: `name='${fileName.replace(/'/g, "\\'")}' and trashed=false`,
      fields: 'files(id, name)'
    });

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

    if (!res) return null;

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const saved = await res.json();
    await loadDriveFiles();
    selectedDriveFileId = saved.id;

    if (showAlert) {
      alert(`Export Google Drive réussi : ${saved.name}`);
    }
    return saved;
  } catch (error) {
    console.error(error);
    if (showAlert) {
      alert("Échec de l'export vers Google Drive.");
    }
    return null;
  }
}

function renderCrmDriveDocList(docs, emptyLabel) {
  if (!docs.length) {
    return `<div class="crm-drive-empty">${escapeHtml(emptyLabel)}</div>`;
  }

  return `<div class="crm-drive-doc-list">${docs.map(doc => {
    const isImportSelected = selectedDriveFileId === doc.id;
    const isChecked = isDriveFileChecked(doc.id);
    return `
    <div class="crm-drive-doc-item">
      <div style="display:grid; grid-template-columns:22px 22px 1fr; gap:10px; align-items:start;">
        <input type="radio" name="driveImportFile" ${isImportSelected ? 'checked' : ''} onchange="selectDriveFileForImport('${escapeAttr(doc.id)}')" title="Choisir ce fichier pour le charger dans l’application">
        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleDriveFileSelection('${escapeAttr(doc.id)}', this.checked)" title="Ajouter ce fichier à la sélection pour téléchargement ou suppression">
        <div>
          <div class="crm-drive-doc-title">${escapeHtml(doc.documentNumber || doc.name || 'Document')}</div>
          <div class="crm-drive-doc-meta">
            ${escapeHtml(doc.name || '')}<br>
            ${doc.modifiedTime ? `Modifié le ${escapeHtml(new Date(doc.modifiedTime).toLocaleString('fr-BE'))}` : 'Date inconnue'}
          </div>
          <div class="inline-actions no-print">
            <button type="button" data-drive-load-id="${escapeAttr(doc.id)}">Charger</button>
            <button type="button" data-drive-download-id="${escapeAttr(doc.id)}">Télécharger</button>
            <button type="button" class="danger" data-drive-delete-id="${escapeAttr(doc.id)}">Supprimer</button>
          </div>
        </div>
      </div>
    </div>
  `;
  }).join('')}</div>`;
}


function getClientChantiers(client) {
  const chantiersData = loadChantiersLocalData();
  const clientId = String(client.id || '').trim();
  const clientRef = String(client.clientNumber || '').trim();
  const clientNameKey = chantierSlug(client.name || '');

  return (chantiersData.projects || [])
    .filter(project => {
      const projectClientRef = String(project.clientRef || '').trim();
      const projectClientId = String(project.clientId || '').trim();
      const projectClientNameKey = chantierSlug(project.clientName || '');
      return (clientId && projectClientId === clientId)
        || (clientRef && projectClientRef === clientRef)
        || (!!clientNameKey && projectClientNameKey === clientNameKey);
    })
    .map(project => ({
      ...project,
      linkedQuotes: Array.isArray(project.linkedQuotes) ? project.linkedQuotes : [],
      linkedInvoices: Array.isArray(project.linkedInvoices) ? project.linkedInvoices : [],
      linkedReminders: Array.isArray(project.linkedReminders) ? project.linkedReminders : [],
      costs: Array.isArray(project.costs) ? project.costs : [],
      documents: Array.isArray(project.documents) ? project.documents : [],
      tasks: Array.isArray(project.tasks) ? project.tasks : []
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}


function getChantiersForDocument(doc) {
  const chantiersData = loadChantiersLocalData();
  const clientId = String(doc?.clientId || '').trim();
  const clientRef = String(doc?.clientNumber || '').trim();
  const clientNameKey = chantierSlug(doc?.clientName || '');

  return (chantiersData.projects || [])
    .filter(project => {
      const projectClientId = String(project.clientId || '').trim();
      const projectClientRef = String(project.clientRef || '').trim();
      const projectClientNameKey = chantierSlug(project.clientName || '');
      return (clientId && projectClientId === clientId)
        || (clientRef && projectClientRef === clientRef)
        || (!!clientNameKey && projectClientNameKey === clientNameKey)
        || (!clientId && !clientRef && !clientNameKey);
    })
    .sort((a, b) => `${a.clientName || ''} ${a.title || ''}`.localeCompare(`${b.clientName || ''} ${b.title || ''}`, 'fr', { sensitivity: 'base' }));
}

function renderChantierOptionsForDocument(doc) {
  const projects = getChantiersForDocument(doc);
  const selectedId = String(doc?.chantierId || '').trim();
  const rows = ['<option value="">— Aucun suivi client synchronisé —</option>'];
  projects.forEach(project => {
    const label = `${project.clientName || 'Client'} — ${project.title || 'Chantier'}`;
    rows.push(`<option value="${escapeAttr(project.id)}" ${selectedId === String(project.id) ? 'selected' : ''}>${escapeHtml(label)}</option>`);
  });
  return rows.join('');
}

function setDocumentChantier(docKey, projectId) {
  const doc = data[docKey];
  if (!doc) return;
  const chantiersData = loadChantiersLocalData();
  const project = (chantiersData.projects || []).find(item => String(item.id || '') === String(projectId || ''));

  doc.chantierId = project?.id || '';
  if (project) {
    doc.siteName = project.title || doc.siteName || '';
    doc.clientId = project.clientId || doc.clientId || '';
    doc.clientName = project.clientName || doc.clientName || '';
    doc.clientNumber = project.clientRef || doc.clientNumber || '';
    doc.address = doc.address || project.address || '';
  }
  saveData(false);
}

function chantierProjectTotals(project) {
  const quoteAmount = toNumber(project.quoteAmount) || (project.linkedQuotes || []).reduce((sum, item) => sum + toNumber(item.tvac ?? item.amount), 0);
  const invoices = (project.linkedInvoices || []).reduce((sum, item) => sum + toNumber(item.tvac ?? item.amount), 0);
  const costs = (project.costs || []).reduce((sum, item) => sum + toNumber(item.amount), 0);
  const margin = invoices - costs;
  return { quoteAmount, invoices, costs, margin };
}

function createChantierFromCrmClient(clientId) {
  const client = getClients().find(c => c.id === clientId);
  if (!client) return;

  const title = prompt('Nom du nouveau chantier pour ce client :', 'Nouveau chantier');
  if (!String(title || '').trim()) return;

  const chantiersData = loadChantiersLocalData();
  const project = {
    id: `chantier-${chantierSlug(client.name || client.clientNumber)}-${chantierSlug(title)}-${Date.now().toString(36)}`,
    title: String(title).trim(),
    clientId: client.id || '',
    clientName: client.name || '',
    clientRef: client.clientNumber || '',
    address: client.address || '',
    description: '',
    status: 'planned',
    startDate: '',
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
    timeline: [{
      id: `evt-${Date.now().toString(36)}`,
      date: new Date().toISOString(),
      text: 'Chantier créé depuis le CRM.'
    }]
  };

  chantiersData.projects.unshift(project);
  saveChantiersLocalData(chantiersData);
  render();
  openChantierFromCrm(project.id);
}

function openChantierFromCrm(projectId) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'BASTCOMPTA_OPEN_CHANTIER',
        projectId
      }, window.location.origin);
      return;
    }
  } catch (error) {
    console.error(error);
  }

  alert('Ouvre le module Suivi client depuis le portail pour afficher cette fiche client.');
}

function renderCrmChantiersForClient(client) {
  const clientFollowups = getClientChantiers(client);

  if (!clientFollowups.length) {
    return `
          <div class="simple-box" style="margin-top:16px; margin-bottom:16px;">
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
              <div>
                <strong>Suivi client global lié</strong><br>
                <span class="hint">Aucun suivi client n’est encore lié à ce client.</span>
              </div>
              <button type="button" class="no-print" onclick="createChantierFromCrmClient('${escapeAttr(client.id)}')">Créer un suivi client</button>
            </div>
          </div>
        `;
  }

  return `
        <div class="simple-box" style="margin-top:16px; margin-bottom:16px;">
          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; margin-bottom:12px;">
            <div>
              <strong>Suivi client global lié à ce client</strong><br>
              <span class="hint">Ce suivi global regroupe les devis, factures et rappels de ce client.</span>
            </div>
            <button type="button" class="no-print" onclick="createChantierFromCrmClient('${escapeAttr(client.id)}')">Créer un suivi client</button>
          </div>

          <div class="crm-drive-doc-list">
            ${clientFollowups.map(project => {
    const totals = chantierProjectTotals(project);
    const openTasks = (project.tasks || []).filter(task => !task.done).length;
    const statusLabel = ({ planned: 'Prévu', active: 'En cours', waiting: 'En attente', closed: 'Clôturé', cancelled: 'Annulé' })[project.status] || project.status || '—';
    return `
                <div class="crm-drive-doc-item">
                  <div class="crm-drive-doc-title">${escapeHtml(project.title || 'Chantier sans nom')}</div>
                  <div class="crm-drive-doc-meta">
                    Statut : ${escapeHtml(statusLabel)}<br>
                    Devis : ${escapeHtml(money(totals.quoteAmount))} • Facturé : ${escapeHtml(money(totals.invoices))} • Coûts : ${escapeHtml(money(totals.costs))}<br>
                    Marge : ${escapeHtml(money(totals.margin))} • Documents : ${(project.documents || []).length} • Tâches ouvertes : ${openTasks}
                  </div>
                  <div class="inline-actions no-print">
                    <button type="button" onclick="openChantierFromCrm('${escapeAttr(project.id)}')">Ouvrir le chantier</button>
                  </div>
                </div>
              `;
  }).join('')}
          </div>
        </div>
      `;
}

function renderCRMInner() {
  const clients = getClients().filter(clientMatchesSearch);
  const cards = clients.map((client, index) => {
    const stats = getClientStats(client.id);
    const isExpanded = crmExpandedClientId === client.id;
    const linkedDocs = getIndexedDriveDocsForClient(client);

    return `
      <div class="simple-box" style="margin-bottom:14px;">
        <div class="crm-card-header">
          <button type="button" style="flex:1; text-align:left; box-shadow:none;" onclick="toggleClientExpanded('${escapeAttr(client.id)}')">
            ${escapeHtml(client.name || `Client ${index + 1}`)} ${client.favorite ? '★' : ''}${client.clientNumber ? ` — N° ${escapeHtml(client.clientNumber)}` : ''}
          </button>
          <div class="inline-actions no-print">
            <button type="button" onclick="duplicateClient('${escapeAttr(client.id)}')">Dupliquer</button>
            <button type="button" class="danger" onclick="deleteClient('${escapeAttr(client.id)}')">Supprimer</button>
          </div>
        </div>
        ${isExpanded ? `
          <div style="margin-top:12px;" class="settings-grid">
            <div class="stack">
              <div class="field">
                <label>Nom / société</label>
                <input value="${escapeAttr(client.name)}" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), name: this.value }, false)">
              </div>
              <div class="field">
                <label>Email</label>
                <input type="email" value="${escapeAttr(client.email)}" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), email: this.value }, false)">
              </div>
              <div class="field">
                <label>Adresse</label>
                <textarea oninput="autoResize(this)" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), address: this.value }, false)">${escapeHtml(client.address)}</textarea>
              </div>
              <div class="field">
                <label>Notes</label>
                <textarea oninput="autoResize(this)" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), notes: this.value }, false)">${escapeHtml(client.notes)}</textarea>
              </div>
            </div>
            <div class="stack">
              <div class="field">
                <label>N° client</label>
                <input value="${escapeAttr(client.clientNumber)}" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), clientNumber: this.value }, false)">
              </div>
              <div class="field">
                <label>N° TVA</label>
                <input value="${escapeAttr(client.vat)}" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), vat: this.value }, false)">
              </div>
              <div class="field">
                <label>Téléphone</label>
                <input value="${escapeAttr(client.phone)}" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), phone: this.value }, false)">
              </div>
              <div class="field">
                <label>Personne de contact</label>
                <input value="${escapeAttr(client.contact)}" onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), contact: this.value }, false)">
              </div>
              <div class="field">
                <label>Favori</label>
                <select onchange="saveClientRecord({ ...(getClients().find(c => c.id === '${escapeAttr(client.id)}') || {}), favorite: this.value === 'true' }, false)">
                  <option value="false" ${!client.favorite ? 'selected' : ''}>Non</option>
                  <option value="true" ${client.favorite ? 'selected' : ''}>Oui</option>
                </select>
              </div>
              <div class="simple-box" style="line-height:1.7;">
                <strong>Historique local</strong><br>
                Devis liés : ${stats.quoteCount}<br>
                Factures liées : ${stats.invoiceCount}<br>
                Total facture lié : ${escapeHtml(money(stats.invoiceTotal))}
              </div>
            </div>
          </div>

          ${renderCrmChantiersForClient(client)}

          <div class="simple-box" style="margin-top:16px; margin-bottom:16px;">
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
              <div>
                <strong>Documents Drive liés à ce client</strong><br>
                <span class="hint">Radio = charger. Case = télécharger ou supprimer.</span>
              </div>
              <div class="inline-actions no-print">
                <button type="button" onclick="pickLocalJsonForDrive()">Importer des fichiers du PC vers Drive</button>
              </div>
            </div>
            <div class="inline-actions no-print" style="margin-top:12px;">
              <button type="button" onclick="downloadSelectedClientJsonFromDrive('${escapeAttr(client.id)}')">Télécharger la sélection</button>
              <button type="button" onclick="selectAllDriveFilesForClient('${escapeAttr(client.id)}')">Tout cocher</button>
              <button type="button" onclick="clearDriveFileSelectionForClient('${escapeAttr(client.id)}')">Tout décocher</button>
              <button type="button" class="danger" onclick="deleteSelectedClientJsonFromDrive('${escapeAttr(client.id)}')">Supprimer la sélection</button>
            </div>
          </div>

<div class="simple-box no-print" style="margin-top:14px;">
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
      <div>
        <strong>Documents Drive liés à ce client</strong><br>
        <span class="hint">Radio = charger. Case = télécharger ou supprimer.</span>
      </div>
      <div class="inline-actions">
        <button type="button" onclick="downloadSelectedClientJsonFromDrive('${escapeAttr(client.id)}')">Télécharger la sélection</button>
        <button type="button" onclick="selectAllDriveFilesForClient('${escapeAttr(client.id)}')">Tout cocher</button>
        <button type="button" onclick="clearDriveFileSelectionForClient('${escapeAttr(client.id)}')">Tout décocher</button>
        <button type="button" class="danger" onclick="deleteSelectedClientJsonFromDrive('${escapeAttr(client.id)}')">Supprimer la sélection</button>
      </div>
    </div>
  </div>

  <div class="crm-drive-grid" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
    <div class="crm-drive-column">
      <strong>Devis</strong>
      ${renderCrmDriveDocList(linkedDocs.quotes, 'Aucun devis lié à ce client.')}
    </div>

    <div class="crm-drive-column">
      <strong>Factures</strong>
      ${renderCrmDriveDocList(linkedDocs.invoices, 'Aucune facture liée à ce client.')}
    </div>

    <div class="crm-drive-column">
      <strong>Rappels</strong>
      ${renderCrmDriveDocList(linkedDocs.reminders, 'Aucun rappel lié à ce client.')}
    </div>
  </div>
` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="comm-panel">
      <h2>Carnet d'adresses / CRM</h2>

      <div class="simple-box" style="margin-bottom:16px; line-height:1.7;">
        Le bouton <strong>Sauvegarder</strong> met à jour automatiquement le CRM sur Google Drive sans créer de doublon quand la connexion Drive est active.
        À la reconnexion, le CRM est rechargé automatiquement.
      </div>

      <div class="simple-box" style="margin-bottom:16px;">
        <label for="crmSearchInput"><strong>Recherche</strong></label>
        <input
          id="crmSearchInput"
          class="crm-search-input"
          type="text"
          placeholder="Chercher par nom, n° client, n° devis ou n° facture"
          value="${escapeAttr(crmSearchTerm)}"
          oninput="setCrmSearchTerm(this.value)"
        >
      </div>

      ${cards || '<div class="simple-box">Aucun client enregistré pour le moment.</div>'}
    </div>
  `;
}

function renderCRM() {
  return `
    <section class="page ${activePage === 'crm' ? 'active' : ''}" data-page="crm">
      <div class="sheet">
<div class="toolbar no-print">
  <div class="hint">Le CRM se gère ici, puis devis et facture récupèrent simplement les infos client.</div>
  <div class="inline-actions">
    <button class="primary" onclick="createNewClient()">Nouveau client</button>
    <button onclick="loadDriveFiles()">Actualiser Drive</button>
    <button onclick="pickLocalJsonForDrive()">Importer des fichiers du PC vers Drive</button>
    <button onclick="downloadHiddenCrmSyncFromDrive()">Télécharger le CRM caché</button>
  </div>
</div>
        </div>

        ${renderCRMInner()}
      </div>
    </section>
  `;
}

function sanitizeEmail(email) {
  return String(email || '').trim().replace(/[;,\s]+$/g, '');
}

function rememberClientEmail(email) {
  const clean = sanitizeEmail(email).toLowerCase();
  if (!clean || !clean.includes('@')) return;

  const current = Array.isArray(data.mail?.recentEmails) ? data.mail.recentEmails : [];
  const next = [clean, ...current.filter(item => String(item || '').toLowerCase() !== clean)].slice(0, 20);
  data.mail.recentEmails = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getEmailSuggestions() {
  const recent = Array.isArray(data.mail?.recentEmails) ? data.mail.recentEmails : [];
  const live = [data.quote?.clientEmail, data.invoice?.clientEmail].filter(Boolean);
  return [...new Set([...live, ...recent].map(sanitizeEmail).filter(Boolean))];
}

function renderEmailDatalist() {
  const options = getEmailSuggestions().map(email => `<option value="${escapeAttr(email)}"></option>`).join('');
  return `<datalist id="client-email-suggestions">${options}</datalist>`;
}

function setClientEmail(docKey, value) {
  data[docKey].clientEmail = value;
  rememberClientEmail(value);
  saveData(false);
}

function formatMailTemplate(template, docKey) {
  const doc = data[docKey] || {};
  const totals = totalsFor(docKey);
  const replacements = {
    clientName: doc.clientName || '',
    clientEmail: doc.clientEmail || '',
    documentNumber: doc.documentNumber || '',
    companyName: data.company.name || '',
    totalHTVA: money(totals.htva),
    totalTVA: money(totals.vat),
    totalTTC: money(totals.tvac),
    date: doc.date || '',
    dueDate: doc.dueDate || '',
    validity: doc.validity || ''
  };

  return String(template || '').replace(/\{(clientName|clientEmail|documentNumber|companyName|totalHTVA|totalTVA|totalTTC|date|dueDate|validity)\}/g, (_, key) => replacements[key] || '');
}

function sendDocumentEmail(docKey) {
  const doc = data[docKey] || {};
  const email = sanitizeEmail(doc.clientEmail || '');
  if (!email) {
    alert("Renseigne d'abord l'adresse email du client.");
    return;
  }

  rememberClientEmail(email);

  const isQuote = docKey === 'quote';
  const isReminder = docKey === 'reminder';
  const subjectTemplate = isQuote
    ? data.mail?.quoteSubject
    : isReminder
      ? data.mail?.reminderSubject
      : data.mail?.invoiceSubject;
  const bodyTemplate = isQuote
    ? data.mail?.quoteBody
    : isReminder
      ? data.mail?.reminderBody
      : data.mail?.invoiceBody;
  const subject = formatMailTemplate(subjectTemplate, docKey);
  const body = formatMailTemplate(bodyTemplate, docKey);
  const url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

function copyCommunication() {
  syncCommunicationFromInvoice(false);
  navigator.clipboard.writeText(data.communication.formatted || '');
  alert('Communication structurée copiée.');
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/'/g, "\'");
}

function normalizeInvoiceLookupValue(value) {
  return String(value || '')
    .trim()
    .replace(/^facture-/i, '')
    .replace(/\.json$/i, '')
    .trim()
    .toLowerCase();
}

function invoiceFileMatchesNumber(file, invoiceNumber) {
  const wanted = normalizeInvoiceLookupValue(invoiceNumber);
  const fileName = String(file?.name || '');
  const fileNumber = normalizeInvoiceLookupValue(fileName);
  return !!wanted && (fileNumber === wanted || fileName.toLowerCase().includes(wanted));
}

async function findInvoiceDriveFileByNumber(invoiceNumber, preferredFileId = '') {
  if (!googleAccessToken) {
    alert("Connecte Google Drive depuis le portail BastCompta.");
    return null;
  }

  const normalized = String(invoiceNumber || '').trim();
  if (!normalized) {
    alert('Numéro de facture manquant.');
    return null;
  }

  if (preferredFileId) {
    const preferred = (googleDriveFiles || []).find(file => file.id === preferredFileId);
    if (preferred) return preferred;
    return { id: preferredFileId, name: `facture-${normalized}.json` };
  }

  let cachedFile = (googleDriveFiles || []).find(file => invoiceFileMatchesNumber(file, normalized));
  if (cachedFile) return cachedFile;

  await loadDriveFiles();
  cachedFile = (googleDriveFiles || []).find(file => invoiceFileMatchesNumber(file, normalized));
  if (cachedFile) return cachedFile;

  const searchValue = escapeDriveQueryValue(normalized);
  const list = await driveFilesList({
    spaces: 'appDataFolder',
    q: `mimeType='application/json' and trashed=false and name contains '${searchValue}'`,
    orderBy: 'modifiedTime desc',
    pageSize: 20,
    fields: 'files(id, name, modifiedTime)'
  });

  if (!list) return null;
  return (list.result.files || []).find(file => invoiceFileMatchesNumber(file, normalized)) || null;
}

async function openInvoicePreviewByNumberFromDrive(invoiceNumber, preferredFileId = '') {
  try {
    const normalized = String(invoiceNumber || '').trim();
    const file = await findInvoiceDriveFileByNumber(normalized, preferredFileId);
    if (!file) {
      alert(`Aucune facture trouvée sur Drive pour le numéro ${normalized}.`);
      return false;
    }

    const parsed = await fetchDriveFileParsed(file.id);
    if (!parsed?.invoice) {
      alert('Le fichier trouvé ne contient pas de facture valide.');
      return false;
    }

    const loadedNumber = String(parsed.invoice?.documentNumber || '').trim();
    if (normalized && loadedNumber && normalizeInvoiceLookupValue(loadedNumber) !== normalizeInvoiceLookupValue(normalized)) {
      alert(`Le fichier trouvé (${file.name || file.id}) contient la facture ${loadedNumber}, pas ${normalized}.`);
      return false;
    }

    // Important : ne jamais remplacer tout "data" ici.
    // On charge uniquement la facture à imprimer afin de préserver le CRM complet.
    data.invoice = mergeDeep(structuredClone(defaultData.invoice), parsed.invoice);
    selectedDriveFileId = file.id;
    activePage = 'invoice';
    syncCommunicationFromInvoice(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    render();

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    setTimeout(() => {
      window.focus();
      printCurrentPage();
    }, 250);

    return true;
  } catch (error) {
    console.error(error);
    alert("Impossible d’ouvrir l’aperçu d’impression de cette facture.");
    return false;
  }
}

window.openInvoicePreviewByNumberFromDrive = openInvoicePreviewByNumberFromDrive;

function printCurrentPage() {
  const pages = Array.from(document.querySelectorAll('.page'));
  pages.forEach(page => page.classList.remove('print-include'));
  const active = document.querySelector(`.page[data-page="${activePage}"]`);
  if (active) active.classList.add('print-include');
  window.print();
  if (active) active.classList.remove('print-include');
}

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) return;

  const message = event.data || {};

  if (message.type === 'BASTCOMPTA_GOOGLE_TOKEN') {
    googleAccessToken = message.accessToken || null;

    if (googleAccessToken && window.gapi?.client) {
      try {
        gapi.client.setToken({ access_token: googleAccessToken });
        await loadSyncDataFromDriveIfAvailable();
        await loadDriveFiles();
        await ensureDriveFileIndex(true);
      } catch (error) {
        console.error(error);
      }
    }

    render();
  }

  if (message.type === 'BASTCOMPTA_SET_ACTIVE_PAGE') {
    const pageKey = message.pageKey || message.docKey || '';
    if (pageDefs.some(page => page.key === pageKey)) {
      data = loadData();
      activePage = pageKey;
      render();
    }
  }

  if (message.type === 'BASTCOMPTA_GOOGLE_LOGOUT') {
    googleAccessToken = null;
    googleDriveFiles = [];
    selectedDriveFileId = '';
    selectedDriveFileIds = [];

    if (window.gapi?.client) {
      gapi.client.setToken(null);
    }

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

async function exportAvailableDocumentsToDrive(showAlert = true) {
  const savedNames = [];
  try {
    syncCommunicationFromInvoice(false);
    for (const docKey of ['quote', 'invoice', 'reminder']) {
      const doc = data[docKey];
      const docNumber = String(doc?.documentNumber || '').trim();
      const clientName = String(doc?.clientName || '').trim();

      if (!docNumber || !clientName) continue;

      const saved = await exportDocTypeToDrive(docKey, false);
      if (saved?.name) savedNames.push(saved.name);
    }
    await syncAllDocumentsToChantiers(!!googleAccessToken);
    await loadDriveFiles();
    if (showAlert) {
      alert(savedNames.length
        ? `Export Google Drive réussi : ${savedNames.join(', ')}`
        : 'Aucun devis, facture ou rappel numéroté à exporter.');
    }
    return savedNames;
  } catch (error) {
    console.error(error);
    if (showAlert) alert("Échec de l'export vers Google Drive.");
    return savedNames;
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

function openDoccle() {
  window.open('https://secure.doccle.be/ui/company', '_blank', 'noopener,noreferrer');
}

function printInvoiceFromPeppol() {
  activePage = 'invoice';
  render();

  setTimeout(() => {
    printCurrentPage();
  }, 50);
}

function peppolTrim(value) {
  return String(value ?? '').trim();
}

function peppolAmount(value) {
  return Number(value || 0).toFixed(2);
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeVatNumber(value) {
  return peppolTrim(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getVatCountry(vatNumber) {
  const normalized = normalizeVatNumber(vatNumber);
  return /^[A-Z]{2}/.test(normalized) ? normalized.slice(0, 2) : 'BE';
}

function isBelgianVat(value) {
  return normalizeVatNumber(value).startsWith('BE');
}

function peppolSafeFileName(value, fallback = 'facture') {
  return String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function getInvoiceLinesForPeppol() {
  const invoice = data.invoice || {};
  const mainLines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const suppliesLines = invoice.suppliesEnabled && Array.isArray(invoice.suppliesLines) ? invoice.suppliesLines : [];
  return [...mainLines, ...suppliesLines]
    .filter(row => peppolTrim(row.description) || toNumber(row.qty) || toNumber(row.unitPrice));
}

function getPeppolChecks() {
  const invoice = data.invoice || {};
  const totals = totalsFor('invoice');
  const lines = getInvoiceLinesForPeppol();
  const checks = [
    { ok: !!peppolTrim(invoice.documentNumber), label: 'Numéro de facture renseigné' },
    { ok: !!peppolTrim(invoice.date), label: 'Date de facture renseignée' },
    { ok: !!peppolTrim(invoice.dueDate), label: 'Date d’échéance renseignée' },
    { ok: !!peppolTrim(invoice.clientName), label: 'Nom du client renseigné' },
    { ok: !!peppolTrim(invoice.address), label: 'Adresse client renseignée' },
    { ok: !!peppolTrim(invoice.clientVat), label: 'N° TVA client renseigné' },
    { ok: !!peppolTrim(invoice.clientEmail), label: 'Email client renseigné' },
    { ok: !!peppolTrim(data.company.name), label: 'Nom de votre société renseigné' },
    { ok: !!peppolTrim(data.company.vat), label: 'N° TVA de votre société renseigné' },
    { ok: !!peppolTrim(data.company.iban), label: 'IBAN renseigné' },
    { ok: lines.length > 0, label: 'Au moins une ligne de facture présente' },
    { ok: totals.tvac > 0, label: 'Montant total supérieur à 0 €' }
  ];
  return checks;
}

function renderPeppolChecklist() {
  return getPeppolChecks().map(item => `
        <div class="peppol-check ${item.ok ? 'ok' : 'ko'}">
          <span>${item.ok ? '✓' : '✕'}</span>
          <strong>${escapeHtml(item.label)}</strong>
        </div>
      `).join('');
}

function getPeppolReadiness() {
  const checks = getPeppolChecks();
  const missing = checks.filter(item => !item.ok);
  if (!missing.length) return { level: 'ready', title: 'Facture prête', text: 'Tous les contrôles principaux sont validés.' };
  if (missing.length <= 3) return { level: 'warning', title: 'Presque prête', text: `${missing.length} point(s) à corriger avant un envoi propre.` };
  return { level: 'danger', title: 'Facture incomplète', text: `${missing.length} point(s) manquant(s) ou incomplets.` };
}

function getPeppolHistory() {
  if (!Array.isArray(data.invoice.peppolHistory)) data.invoice.peppolHistory = [];
  return data.invoice.peppolHistory;
}

function addPeppolHistory(label) {
  getPeppolHistory().unshift({
    id: `peppol-${Date.now().toString(36)}`,
    date: new Date().toISOString(),
    label
  });
  data.invoice.peppolHistory = getPeppolHistory().slice(0, 30);
  saveData(false);
  render();
}

function setInvoicePeppolStatus(status) {
  data.invoice.peppolStatus = status;
  const labels = {
    ready: 'Facture marquée prête à envoyer',
    sent: 'Facture marquée comme envoyée',
    paid: 'Facture marquée comme payée'
  };
  if (status === 'paid') {
    data.invoice.status = 'paid';
    data.invoice.paidAmount = totalsFor('invoice').tvac;
  }
  addPeppolHistory(labels[status] || 'Statut mis à jour');
}

function copyInvoiceEmailText() {
  const invoice = data.invoice || {};
  const totals = totalsFor('invoice');
  const subject = peppolTrim(data.mail?.invoiceSubject || 'Votre facture {documentNumber}');
  const body = peppolTrim(data.mail?.invoiceBody || 'Bonjour {clientName},\n\nVeuillez trouver ci-joint votre facture {documentNumber}.\n\nCordialement,\n{companyName}');
  const replacements = {
    '{clientName}': invoice.clientName || '',
    '{clientEmail}': invoice.clientEmail || '',
    '{documentNumber}': invoice.documentNumber || '',
    '{companyName}': data.company.name || '',
    '{totalHTVA}': money(totals.htva),
    '{totalTVA}': money(totals.vat),
    '{totalTTC}': money(totals.tvac),
    '{date}': invoice.date || '',
    '{dueDate}': invoice.dueDate || ''
  };
  const replaceTokens = text => Object.entries(replacements).reduce((acc, [key, value]) => acc.replaceAll(key, value), text);
  const fullText = `Objet : ${replaceTokens(subject)}\n\n${replaceTokens(body)}`;
  navigator.clipboard?.writeText(fullText).then(() => {
    addPeppolHistory('Texte email copié');
    alert('Texte email copié.');
  }).catch(() => {
    prompt('Copie le texte email :', fullText);
  });
}

function buildPeppolXml() {
  const invoice = data.invoice || {};
  const company = data.company || {};
  const totals = totalsFor('invoice');
  const lines = getInvoiceLinesForPeppol();
  const supplierVat = normalizeVatNumber(company.vat);
  const customerVat = normalizeVatNumber(invoice.clientVat);
  const supplierCountry = getVatCountry(supplierVat);
  const customerCountry = getVatCountry(customerVat);
  const supplierEndpoint = supplierVat || 'BE0000000000';
  const customerEndpoint = customerVat || 'BE0000000000';
  const issueDate = invoice.date || new Date().toISOString().slice(0, 10);
  const dueDate = invoice.dueDate || issueDate;
  const invoiceNumber = peppolTrim(invoice.documentNumber) || 'FACTURE-SANS-NUMERO';
  const paymentReference = peppolTrim(data.communication?.formatted) || invoiceNumber;
  const paymentTerms = peppolTrim(invoice.notes) || peppolTrim(company.conditions) || 'Paiement à l’échéance indiquée.';
  const currency = 'EUR';

  const vatByRate = new Map();
  lines.forEach(row => {
    const rate = toNumber(row.vatRate);
    const base = lineNet(row);
    const tax = lineVat(row);
    const current = vatByRate.get(rate) || { base: 0, tax: 0 };
    current.base += base;
    current.tax += tax;
    vatByRate.set(rate, current);
  });

  const taxSubtotals = [...vatByRate.entries()].map(([rate, item]) => {
    const category = rate === 0 ? 'Z' : 'S';
    return `
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${peppolAmount(item.base)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${peppolAmount(item.tax)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID>${category}</cbc:ID>
          <cbc:Percent>${peppolAmount(rate)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`;
  }).join('');

  const invoiceLines = lines.map((row, index) => {
    const qty = toNumber(row.qty) || 1;
    const rate = toNumber(row.vatRate);
    const category = rate === 0 ? 'Z' : 'S';
    const description = peppolTrim(row.description) || `Ligne ${index + 1}`;
    const unitCode = peppolTrim(row.unit).toLowerCase().includes('h') ? 'HUR' : 'C62';
    return `
  <cac:InvoiceLine>
    <cbc:ID>${index + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${unitCode}">${peppolAmount(qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${peppolAmount(lineNet(row))}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${xmlEscape(description)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${category}</cbc:ID>
        <cbc:Percent>${peppolAmount(rate)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${peppolAmount(toNumber(row.unitPrice))}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${xmlEscape(invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${xmlEscape(issueDate)}</cbc:IssueDate>
  <cbc:DueDate>${xmlEscape(dueDate)}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${xmlEscape(invoice.clientNumber || invoice.clientName || 'Client')}</cbc:BuyerReference>

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0208">${xmlEscape(supplierEndpoint)}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${xmlEscape(company.name)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(company.address)}</cbc:StreetName>
        <cbc:CityName>${xmlEscape(company.city)}</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>${xmlEscape(supplierCountry)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(supplierVat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${xmlEscape(company.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:ElectronicMail>${xmlEscape(company.email)}</cbc:ElectronicMail>
        <cbc:Telephone>${xmlEscape(company.phone)}</cbc:Telephone>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0208">${xmlEscape(customerEndpoint)}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${xmlEscape(invoice.clientName)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(invoice.address)}</cbc:StreetName>
        <cac:Country><cbc:IdentificationCode>${xmlEscape(customerCountry)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(customerVat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${xmlEscape(invoice.clientName)}</cbc:RegistrationName></cac:PartyLegalEntity>
      <cac:Contact><cbc:ElectronicMail>${xmlEscape(invoice.clientEmail)}</cbc:ElectronicMail></cac:Contact>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cbc:PaymentID>${xmlEscape(paymentReference)}</cbc:PaymentID>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${xmlEscape(company.iban)}</cbc:ID>
      ${peppolTrim(company.bic) ? `<cac:FinancialInstitutionBranch><cbc:ID>${xmlEscape(company.bic)}</cbc:ID></cac:FinancialInstitutionBranch>` : ''}
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>

  <cac:PaymentTerms><cbc:Note>${xmlEscape(paymentTerms)}</cbc:Note></cac:PaymentTerms>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${peppolAmount(totals.vat)}</cbc:TaxAmount>${taxSubtotals}
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${peppolAmount(totals.htva)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${peppolAmount(totals.htva)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${peppolAmount(totals.tvac)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${peppolAmount(totals.tvac)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${invoiceLines}
</Invoice>`;
}

function downloadPeppolXmlForCurrentInvoice() {
  const readiness = getPeppolReadiness();
  if (readiness.level === 'danger' && !confirm('La facture est encore incomplète. Exporter quand même le XML ?')) return;
  const xml = buildPeppolXml();
  const number = peppolSafeFileName(data.invoice.documentNumber, 'facture');
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${number}-peppol.xml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  addPeppolHistory('XML Peppol exporté');
}

function renderPeppolHistory() {
  const history = getPeppolHistory();
  if (!history.length) return '<div class="peppol-history-empty">Aucune action enregistrée pour cette facture.</div>';
  return history.map(item => {
    const date = item.date ? new Date(item.date) : null;
    const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('fr-BE') : '—';
    return `<div class="peppol-history-item"><strong>${escapeHtml(dateText)}</strong><span>${escapeHtml(item.label)}</span></div>`;
  }).join('');
}

function renderPeppol() {
  const invoice = data.invoice || {};
  const totals = totalsFor('invoice');
  const readiness = getPeppolReadiness();
  const clientVat = normalizeVatNumber(invoice.clientVat);
  const clientType = clientVat
    ? (isBelgianVat(clientVat) ? 'Entreprise belge / B2B probable' : 'Entreprise étrangère / TVA intracom probable')
    : 'Client non identifié fiscalement';
  const statusLabel = {
    ready: 'Prête',
    sent: 'Envoyée',
    paid: 'Payée'
  }[invoice.peppolStatus] || 'Non envoyée';

  return `
    <section class="page ${activePage === 'peppol' ? 'active' : ''}" data-page="peppol">
      <div class="sheet">
        <div class="toolbar no-print">
          <div class="toolbar-meta">
            <div class="toolbar-title">Assistant facture électronique</div>
            <div class="toolbar-subtitle">Contrôle, export XML Peppol, suivi d’envoi et paiement de la facture en cours.</div>
          </div>
          <div class="toolbar-actions">
            <button onclick="printInvoiceFromPeppol()">Imprimer / PDF</button>
            <button onclick="copyInvoiceEmailText()">Copier email</button>
            <button class="primary" onclick="downloadPeppolXmlForCurrentInvoice()">Exporter XML Peppol</button>
            <button onclick="openDoccle()">Ouvrir Doccle</button>
          </div>
        </div>

        <div class="comm-panel peppol-panel">
          <div class="peppol-head">
            <div>
              <h2>Conformité & envoi</h2>
              <p>Basé sur la facture actuellement ouverte dans l’onglet Facture.</p>
            </div>
            <div class="peppol-status ${readiness.level}">
              <strong>${escapeHtml(readiness.title)}</strong>
              <span>${escapeHtml(readiness.text)}</span>
            </div>
          </div>

          <div class="peppol-summary-grid">
            <div class="simple-box">
              <strong>N° facture</strong><br>
              ${escapeHtml(invoice.documentNumber || '—')}
            </div>
            <div class="simple-box">
              <strong>Client</strong><br>
              ${escapeHtml(invoice.clientName || '—')}
            </div>
            <div class="simple-box">
              <strong>Total TVAC</strong><br>
              ${escapeHtml(money(totals.tvac))}
            </div>
            <div class="simple-box">
              <strong>Statut</strong><br>
              ${escapeHtml(statusLabel)}
            </div>
          </div>

          <div class="peppol-grid">
            <div class="simple-box">
              <h3>Checklist facture</h3>
              <div class="peppol-checklist">${renderPeppolChecklist()}</div>
            </div>

            <div class="simple-box">
              <h3>Analyse client</h3>
              <div class="peppol-client-card">
                <div><span>Type</span><strong>${escapeHtml(clientType)}</strong></div>
                <div><span>N° TVA</span><strong>${escapeHtml(clientVat || '—')}</strong></div>
                <div><span>Email</span><strong>${escapeHtml(invoice.clientEmail || '—')}</strong></div>
                <div><span>Adresse</span><strong>${escapeHtml(invoice.address || '—')}</strong></div>
              </div>
              <div class="peppol-note">
                L’export XML prépare un fichier UBL/Peppol à contrôler avant dépôt chez un prestataire Peppol ou une plateforme compatible.
              </div>
            </div>
          </div>

          <div class="simple-box peppol-actions-box no-print">
            <h3>Actions de suivi</h3>
            <div class="peppol-actions">
              <button onclick="setInvoicePeppolStatus('ready')">Marquer prête</button>
              <button onclick="setInvoicePeppolStatus('sent')">Marquer envoyée</button>
              <button onclick="setInvoicePeppolStatus('paid')">Marquer payée</button>
            </div>
          </div>

          <div class="simple-box">
            <h3>Historique</h3>
            <div class="peppol-history">${renderPeppolHistory()}</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = pageDefs.map(page => `
        <button class="tab ${activePage === page.key ? 'active' : ''}" onclick="activePage='${page.key}'; render()">${page.label}</button>
      `).join('');
}

async function assignNextDocumentNumber(docKey) {
  const kind = docKey === 'invoice' && getEffectiveInvoiceStatus(data.invoice) === 'credit_note'
    ? 'credit_note'
    : docKey;
  await prepareNewDocument(docKey, kind);
  if (docKey === 'invoice') syncCommunicationFromInvoice(false);
  saveData(false);
  render();
}

function renderMetaTable(docKey, isQuote) {
  const doc = data[docKey];
  return `
        <div class="meta-table-wrap">
          <table class="meta-table">
            <thead>
              <tr>
                <th>N° document</th>
                <th>${isQuote ? 'Date de validité' : 'Date d’échéance'}</th>
                <th>Votre n° de client</th>
                <th>Votre n° TVA</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <input value="${escapeAttr(doc.documentNumber)}" onchange="data.${docKey}.documentNumber=this.value; saveData(false)">
                    <button type="button" class="no-print" style="padding:7px 9px; box-shadow:none;" title="Attribuer le prochain numéro automatique" onclick="assignNextDocumentNumber('${docKey}')">↻</button>
                  </div>
                </td>
                <td><input type="date" value="${escapeAttr(isQuote ? doc.validity : doc.dueDate)}" onchange="data.${docKey}.${isQuote ? 'validity' : 'dueDate'}=this.value; saveData(false)"></td>
                <td><input value="${escapeAttr(doc.clientNumber)}" onchange="data.${docKey}.clientNumber=this.value; saveData(false)"></td>
                <td><input value="${escapeAttr(doc.clientVat)}" onchange="data.${docKey}.clientVat=this.value; saveData(false)"></td>
                <td><input type="date" value="${escapeAttr(doc.date)}" onchange="data.${docKey}.date=this.value; saveData(false)"></td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
}

function renderLinesTable(docKey, section, title = '') {
  const rows = data[docKey][section] || [];

  return `
        ${title ? `<div class="section-title">${escapeHtml(title)}</div>` : ''}
        <div class="doc-table-wrap">
          <table class="doc-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Quantité</th>
                <th>Unité</th>
                <th>Pr. unit.</th>
                ${section === 'suppliesLines' ? '<th class="no-print">Prix de revient</th>' : ''}
                <th>Remise</th>
                <th>Total</th>
                <th>TVA</th>
                <th class="no-print"></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row, i) => `
                <tr>
                  <td>
  <textarea
  oninput="autoResize(this); data.${docKey}.${section}[${i}].description=this.value"
  onchange="saveData(false)"
>${escapeHtml(row.description || '')}</textarea>
</td>
                  <td><input type="number" step="0.01" value="${num(row.qty)}" onchange="data.${docKey}.${section}[${i}].qty=parseFloat(this.value)||0; saveData(false)"></td>
                  <td><input value="${escapeAttr(row.unit)}" onchange="data.${docKey}.${section}[${i}].unit=this.value; saveData(false)"></td>
                  <td><input type="number" step="0.01" value="${num(row.unitPrice)}" onchange="data.${docKey}.${section}[${i}].unitPrice=parseFloat(this.value)||0; saveData(false)"></td>
                  ${section === 'suppliesLines' ? `<td class="no-print"><input type="number" step="0.01" value="${num(row.costPrice ?? row.purchasePrice ?? row.cost ?? row.unitPrice)}" title="Prix de revient interne, non imprimé" onchange="data.${docKey}.${section}[${i}].costPrice=parseFloat(this.value)||0; saveData(false)"></td>` : ''}
                  <td><input type="number" step="0.01" value="${num(row.discount)}" onchange="data.${docKey}.${section}[${i}].discount=parseFloat(this.value)||0; saveData(false)"></td>
                  <td>${money(lineNet(row))}</td>
                  <td>
                    <select onchange="data.${docKey}.${section}[${i}].vatRate=parseFloat(this.value)||0; saveData(false)">
                      <option value="0" ${toNumber(row.vatRate) === 0 ? 'selected' : ''}>0%</option>
                      <option value="6" ${toNumber(row.vatRate) === 6 ? 'selected' : ''}>6%</option>
                      <option value="12" ${toNumber(row.vatRate) === 12 ? 'selected' : ''}>12%</option>
                      <option value="21" ${toNumber(row.vatRate) === 21 ? 'selected' : ''}>21%</option>
                    </select>
                  </td>
                  <td class="no-print"><button class="danger" onclick="deleteLine('${docKey}', '${section}', ${i})">Suppr.</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="line-add-actions no-print">
          <button type="button" class="line-add-button" onclick="addLine('${docKey}', '${section}')">+ ${section === 'suppliesLines' ? 'Fourniture' : 'Ligne'}</button>
        </div>
      `;
}

function renderCompanyBlock() {
  return `
    <div class="seller">

  <div class="seller-text">
    <h2>${escapeHtml(data.company.name || 'Nom de votre société')}</h2>
    <div class="seller-lines">${escapeHtml(
    [
      data.company.address || 'Adresse',
      data.company.city || 'Code postal - Ville',
      data.company.phone ? 'Tél. ' + data.company.phone : 'Tél. —',
      data.company.email || 'email@exemple.be',
      data.company.website || '',
      data.company.vat ? 'TVA ' + data.company.vat : 'TVA —'
    ].filter(Boolean).join('\n')
  )}</div>
  </div>

  ${data.company.logo ? `
    <div class="company-logo-wrap">
      <img src="${escapeAttr(data.company.logo)}" alt="Logo de l'entreprise" class="company-logo">
    </div>
  ` : ''}

</div>
  `;
}

function renderConditionsPages(docKey, label) {
  const content = escapeHtml(data.company.conditions || '');

  return `
        <div class="conditions-screen">
          <h3>Conditions</h3>
          <div class="conditions-content">${content || 'Aucune condition renseignée.'}</div>
        </div>

        <div class="conditions-print-page">
          <h3>${label} - Conditions</h3>
          <div class="conditions-content">${content}</div>
        </div>
      `;
}

function renderDocumentPage(docKey) {
  const doc = data[docKey];
  const totals = totalsFor(docKey);
  const isQuote = docKey === 'quote';
  const isReminder = docKey === 'reminder';
  const invoiceStatus = docKey === 'invoice' ? getEffectiveInvoiceStatus(doc) : '';
  const docLabel = isQuote ? 'DEVIS' : (isReminder ? 'RAPPEL' : (invoiceStatus === 'credit_note' ? 'NOTE DE CRÉDIT' : 'FACTURE'));
  const emailLabel = isQuote ? 'Envoyer le devis' : (isReminder ? 'Envoyer le rappel' : 'Envoyer la facture');
  const notesLabel = isQuote ? 'Remarques du devis' : (isReminder ? 'Remarques du rappel' : 'Remarques');
  const paidAmount = isQuote ? 0 : toNumber(doc.paidAmount);
  const balance = isQuote ? totals.tvac : (totals.tvac - paidAmount);
  const totalLines = (Array.isArray(doc.lines) ? doc.lines.length : 0) + (doc.suppliesEnabled && Array.isArray(doc.suppliesLines) ? doc.suppliesLines.length : 0);
  const docSubtitle = isQuote
    ? `${totalLines} ligne${totalLines > 1 ? 's' : ''} • Total estimé ${money(totals.tvac)}`
    : `${totalLines} ligne${totalLines > 1 ? 's' : ''} • Solde ${money(balance)}`;

  return `
        <section class="page ${activePage === docKey ? 'active' : ''}" data-page="${docKey}">
          <div class="toolbar no-print">
            <div class="toolbar-meta">
              <div class="toolbar-title">Actions ${docLabel.toLowerCase()}</div>
              <div class="toolbar-subtitle">${docSubtitle}</div>
            </div>
            <div class="toolbar-actions">
              <div class="toolbar-group secondary">
                ${docKey === 'invoice' ? `<button onclick="copyQuoteToInvoice()">Reprendre le devis</button><button class="primary" onclick="sendInvoiceToAccountingFromIframe()">Envoyer en comptabilité</button>` : ''}
                ${docKey === 'reminder' ? `<button onclick="copyInvoiceToReminder()">Reprendre la facture</button>` : ''}
                <button onclick="saveCurrentClientFromDoc('${docKey}')">Enregistrer le client</button>
              </div>
              <div class="toolbar-group primary">
                <div class="split-button toolbar-menu" data-menu-root>
                  <button class="primary split-button-main" onclick="sendDocumentEmail('${docKey}')">${emailLabel}</button>
                  <button class="primary split-button-toggle" type="button" onclick="toggleToolbarMenu(event, 'send-menu-${docKey}')">▼</button>
                  <div class="menu-panel" id="send-menu-${docKey}">
                    <button type="button" onclick="sendDocumentEmail('${docKey}'); closeToolbarMenus();">${emailLabel}</button>
                    <button type="button" onclick="printCurrentPage(); closeToolbarMenus();">Imprimer ${isQuote ? 'le devis' : (isReminder ? 'le rappel' : 'la facture')}</button>
                    <button type="button" onclick="exportDataLocal(); closeToolbarMenus();">Exporter en JSON</button>
                  </div>
                </div>
              </div>
              <div class="toolbar-group more">
                <div class="toolbar-menu" data-menu-root>
                  <button class="button-icon" type="button" title="Plus d’actions" onclick="toggleToolbarMenu(event, 'more-menu-${docKey}')">⋯</button>
                  <div class="menu-panel" id="more-menu-${docKey}">
                    ${docKey === 'invoice' ? `<button type="button" onclick="setInvoiceStatus('sent'); closeToolbarMenus();">Marquer envoyée</button>
                    <button type="button" onclick="setInvoiceStatus('paid'); closeToolbarMenus();">Marquer payée</button>
                    <button type="button" onclick="createCreditNoteFromInvoice(); closeToolbarMenus();">Créer une note de crédit</button>
                    <button type="button" onclick="cancelInvoice(); closeToolbarMenus();" class="danger-ghost">Annuler la facture</button>` : ''}
                    <button type="button" onclick="resetDocumentLocal('${docKey}'); closeToolbarMenus();" class="danger-ghost">Nouveau ${isQuote ? 'devis' : (isReminder ? 'rappel' : 'facture')}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="sheet">
            <div class="doc-head">
  ${renderCompanyBlock()}

  <div class="doc-head-right">
    <div class="doc-title-top">${docLabel}</div>
    ${docKey === 'invoice' ? `
      <div class="client-box no-print" style="margin-bottom:10px;">
        <div class="box-title">Statut facture</div>
        <div class="stack">
          <select onchange="setInvoiceStatus(this.value)">
            <option value="draft" ${invoiceStatus === 'draft' ? 'selected' : ''}>Brouillon</option>
            <option value="sent" ${invoiceStatus === 'sent' ? 'selected' : ''}>Envoyée</option>
            <option value="partial" ${invoiceStatus === 'partial' ? 'selected' : ''}>Partiellement payée</option>
            <option value="paid" ${invoiceStatus === 'paid' ? 'selected' : ''}>Payée</option>
            <option value="cancelled" ${invoiceStatus === 'cancelled' ? 'selected' : ''}>Annulée</option>
            <option value="credit_note" ${invoiceStatus === 'credit_note' ? 'selected' : ''}>Note de crédit</option>
          </select>
          ${invoiceStatus === 'credit_note' ? `<input placeholder="Facture d’origine" value="${escapeAttr(doc.linkedInvoiceNumber || '')}" onchange="data.invoice.linkedInvoiceNumber=this.value; saveData(false)">` : ''}
          <div class="hint">${escapeHtml(getInvoiceStatusLabel(invoiceStatus))}${invoiceStatus === 'cancelled' ? ' — exclue de la comptabilité' : ''}</div>
        </div>
      </div>
    ` : ''}

    <div class="client-box">
      <div class="box-title">Client</div>
      <div class="stack">
        <select class="no-print" onchange="applyClientToDocument('${docKey}', this.value)">
          ${renderClientOptions(doc.clientId || '')}
        </select>
        <input placeholder="Nom / société" value="${escapeAttr(doc.clientName)}" onchange="data.${docKey}.clientName=this.value; saveData(false)">
        <input type="email" list="client-email-suggestions" placeholder="Email client" value="${escapeAttr(doc.clientEmail || '')}" onchange="setClientEmail('${docKey}', this.value)">
        <textarea placeholder="Adresse client" oninput="autoResize(this); data.${docKey}.address=this.value" onchange="saveData(false)">${escapeHtml(doc.address || '')}</textarea>
      </div>
    </div>

    <div class="client-box" style="margin-top:10px;">
      <div class="box-title">Chantier</div>
      <div class="stack">
        <select class="no-print" onchange="setDocumentChantier('${docKey}', this.value)">
          ${renderChantierOptionsForDocument(doc)}
        </select>
        <input placeholder="Nom du chantier / site" value="${escapeAttr(doc.siteName || '')}" onchange="data.${docKey}.siteName=this.value; data.${docKey}.chantierId=''; saveData(false)">
        <div class="hint no-print">Sélectionnez un chantier existant ou tapez un nom : le document sera lié par identifiant chantier quand il existe.</div>
      </div>
    </div>
  </div>
</div>

            ${renderMetaTable(docKey, isQuote)}
            ${docKey === 'invoice' ? `<div class="simple-box" style="margin-bottom:12px;"><strong>Statut :</strong> ${escapeHtml(getInvoiceStatusLabel(invoiceStatus))}${doc.linkedInvoiceNumber ? ` · <strong>Facture liée :</strong> ${escapeHtml(doc.linkedInvoiceNumber)}` : ''}${doc.creditNoteReason ? `<br>${escapeHtml(doc.creditNoteReason)}` : ''}</div>` : ''}

            ${renderLinesTable(docKey, 'lines')}

            <div class="toggle-row no-print">
              <input class="check-inline" type="checkbox" id="${docKey}-supplies-toggle" ${doc.suppliesEnabled ? 'checked' : ''} onchange="toggleSupplies('${docKey}', this.checked)">
              <label for="${docKey}-supplies-toggle">Afficher le cadre Fournitures</label>
            </div>

            ${doc.suppliesEnabled ? renderLinesTable(docKey, 'suppliesLines', 'Fournitures') : ''}

            <div class="bottom">
  <div>
    <div class="notes-block">
      <div class="box-title">${notesLabel}</div>
      <textarea oninput="autoResize(this); data.${docKey}.notes=this.value" onchange="saveData(false)">${escapeHtml(doc.notes || '')}</textarea>
${!isQuote ? `<div style="margin-top:6px; white-space:pre-line; font-size:12px; line-height:1.35;">${escapeHtml(`Paiement : ${money(balance)}
Compte : ${data.company.iban || 'IBAN'}
Communication : ${data.communication.formatted || '+++...+++'}`)}</div>` : ``}
    </div>
  </div>

  <div>
    <div class="totals">
      <div class="row"><div>Total HTVA</div><div>${money(totals.htva)}</div></div>
      <div class="row"><div>Total TVA</div><div>${money(totals.vat)}</div></div>
      <div class="row final"><div>Total TVA incl.</div><div>${money(totals.tvac)}</div></div>
    </div>

    ${!isQuote ? `
      <div class="pay-block">
        <div class="field" style="margin-bottom:10px;">
          <label>Montant payé</label>
          <input type="number" step="0.01" value="${num(doc.paidAmount)}" onchange="data.${docKey}.paidAmount=parseFloat(this.value)||0; saveData(false)">
        </div>
        <div class="pay-line"><span>Payé</span><strong>${money(paidAmount)}</strong></div>
        <div class="pay-line"><span>Solde</span><strong>${money(balance)}</strong></div>
      </div>
    ` : ``}
  </div>
</div>

          ${renderConditionsPages(docKey, docLabel)}
        </section>
      `;
}

function renderQuote() {
  return renderDocumentPage('quote');
}

function renderInvoice() {
  syncCommunicationFromInvoice(false);
  return renderDocumentPage('invoice');
}

function renderReminder() {
  syncCommunicationFromInvoice(false);
  return renderDocumentPage('reminder');
}

function renderCommunication() {
  const result = syncCommunicationFromInvoice(false);

  return `
        <section class="page ${activePage === 'communication' ? 'active' : ''}" data-page="communication">
          <div class="comm-panel">
            <h2>Communication structurée</h2>
            <div class="footer-note" style="margin-top:0; margin-bottom:16px;">
            </div>

            <div class="comm-grid">
              <div class="field">
                <label>Numéro client</label>
                <input value="${escapeAttr(data.communication.clientNumber)}" onchange="setField('communication.clientNumber', this.value)">
              </div>
              <div class="field">
                <label>Année de facturation</label>
                <input value="${escapeAttr(data.communication.invoiceYear)}" onchange="setField('communication.invoiceYear', this.value)">
              </div>
              <div class="field">
                <label>Numéro de facture</label>
                <input value="${escapeAttr(data.communication.invoiceNumber)}" onchange="setField('communication.invoiceNumber', this.value)">
              </div>
              <div class="inline-actions no-print">
                <button class="primary" style="width:100%;" onclick="copyCommunication()">Copier</button>
              </div>
            </div>

            <div class="comm-result">${escapeHtml(result.formatted)}</div>

            <div class="comm-meta">
              <div class="simple-box"><strong>Base utilisée</strong><br>${escapeHtml(result.base || '—')}</div>
              <div class="simple-box"><strong>Chiffre de contrôle</strong><br>${escapeHtml(result.control || '—')}</div>
              <div class="simple-box"><strong>Rappel</strong><br>Peut reprendre automatiquement les infos de l’onglet Facture.</div>
            </div>
          </div>
        </section>
      `;
}

function handleLogoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    data.company.logo = reader.result;
    saveData(false);
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  data.company.logo = '';
  saveData(false);
}

function renderSettings() {
  return `
        <section class="page ${activePage === 'settings' ? 'active' : ''}" data-page="settings">
          <div class="sheet">
            <div class="toolbar no-print">
              <div class="hint">Paramètres société utilisés pour devis, facture et rappel</div>
            </div>

            <div class="simple-box no-print" style="margin-bottom:16px; line-height:1.7;">
              <strong>Sauvegarde complète</strong><br>
              Les sauvegardes et restaurations complètes se font maintenant depuis l’onglet <strong>Sauvegarde</strong> du portail BastCompta.
            </div>

            <div class="settings-grid">
              <div class="stack">
                <div class="field">
                  <label>Logo</label>
                  <label class="file-label" style="display:inline-block;">Importer un logo
                    <input type="file" accept="image/*" onchange="handleLogoUpload(event)">
                  </label>
                  ${data.company.logo ? `
                    <div style="margin-top:10px;">
                      <img src="${escapeAttr(data.company.logo)}" alt="Aperçu logo" class="company-logo">
                    </div>
                    <div style="margin-top:8px;">
                      <button type="button" class="danger" onclick="removeLogo()">Supprimer le logo</button>
                    </div>
                  ` : ''}
                </div>

                <div class="field">
                  <label>Nom de la société</label>
                  <input value="${escapeAttr(data.company.name)}" onchange="setField('company.name', this.value)">
                </div>

                <div class="field">
                  <label>Adresse</label>
                  <input value="${escapeAttr(data.company.address)}" onchange="setField('company.address', this.value)">
                </div>

                <div class="field">
                  <label>Code postal / Ville</label>
                  <input value="${escapeAttr(data.company.city)}" onchange="setField('company.city', this.value)">
                </div>

                <div class="field">
                  <label>Téléphone</label>
                  <input value="${escapeAttr(data.company.phone)}" onchange="setField('company.phone', this.value)">
                </div>

                <div class="field">
                  <label>Email</label>
                  <input value="${escapeAttr(data.company.email)}" onchange="setField('company.email', this.value)">
                </div>
              </div>

              <div class="stack">
                <div class="field">
                  <label>Site web</label>
                  <input value="${escapeAttr(data.company.website)}" onchange="setField('company.website', this.value)">
                </div>

                <div class="field">
                  <label>TVA</label>
                  <input value="${escapeAttr(data.company.vat)}" onchange="setField('company.vat', this.value)">
                </div>

                <div class="field">
                  <label>IBAN</label>
                  <input value="${escapeAttr(data.company.iban)}" onchange="setField('company.iban', this.value)">
                </div>

                <div class="field">
                  <label>BIC</label>
                  <input value="${escapeAttr(data.company.bic)}" onchange="setField('company.bic', this.value)">
                </div>

                <div class="field">
                  <label>Objet email devis</label>
                  <input value="${escapeAttr(data.mail.quoteSubject || '')}" onchange="setField('mail.quoteSubject', this.value)">
                </div>

                <div class="field">
                  <label>Message email devis</label>
                  <textarea oninput="autoResize(this); data.mail.quoteBody=this.value" onchange="saveData(false)">${escapeHtml(data.mail.quoteBody || '')}</textarea>
                </div>

                <div class="field">
                  <label>Objet email facture</label>
                  <input value="${escapeAttr(data.mail.invoiceSubject || '')}" onchange="setField('mail.invoiceSubject', this.value)">
                </div>

                <div class="field">
                  <label>Message email facture</label>
                  <textarea oninput="autoResize(this); data.mail.invoiceBody=this.value" onchange="saveData(false)">${escapeHtml(data.mail.invoiceBody || '')}</textarea>
                </div>

                <div class="field">
                  <label>Objet email rappel</label>
                  <input value="${escapeAttr(data.mail.reminderSubject || '')}" onchange="setField('mail.reminderSubject', this.value)">
                </div>

                <div class="field">
                  <label>Message email rappel</label>
                  <textarea oninput="autoResize(this); data.mail.reminderBody=this.value" onchange="saveData(false)">${escapeHtml(data.mail.reminderBody || '')}</textarea>
                </div>

                <div class="field">
                  <label>Conditions</label>
                  <textarea oninput="autoResize(this); data.company.conditions=this.value" onchange="saveData(false)">${escapeHtml(data.company.conditions || '')}</textarea>
                </div>

                <div class="simple-box" style="line-height:1.7;">
                  Variables disponibles :<br>
                  {clientName} · {clientEmail} · {documentNumber} · {companyName}<br>
                  {totalHTVA} · {totalTVA} · {totalTTC} · {date} · {dueDate} · {validity}
                </div>
              </div>
            </div>
          </div>
        </section>
      `;
}

function renderPages() {
  const wrap = document.getElementById('pages');
  wrap.innerHTML = `
    ${renderQuote()}
    ${renderInvoice()}
    ${renderReminder()}
    ${renderCommunication()}
    ${renderPeppol()}
    ${renderCRM()}
    ${renderSettings()}
    ${renderEmailDatalist()}
  `;
}

function render() {
  syncCommunicationFromInvoice(false);
  renderTabs();
  renderPages();

  setTimeout(() => {
    document.querySelectorAll('textarea').forEach(autoResize);
  }, 0);
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-menu-root]')) {
    closeToolbarMenus();
  }

  const loadBtn = event.target.closest('[data-drive-load-id]');
  if (loadBtn) {
    event.preventDefault();
    loadDriveJsonFileById(loadBtn.dataset.driveLoadId);
    return;
  }

  const downloadBtn = event.target.closest('[data-drive-download-id]');
  if (downloadBtn) {
    event.preventDefault();
    downloadDriveFileById(downloadBtn.dataset.driveDownloadId);
    return;
  }

  const deleteBtn = event.target.closest('[data-drive-delete-id]');
  if (deleteBtn) {
    event.preventDefault();
    deleteDriveFileById(deleteBtn.dataset.driveDeleteId);
  }
});


// Exposition explicite des fonctions utilisées par les boutons du CRM / Suivi client.
// Cela évite que les boutons "Charger" ne fassent rien selon le contexte de chargement du script.
window.loadDriveJsonFileById = loadDriveJsonFileById;
window.downloadDriveFileById = downloadDriveFileById;
window.deleteDriveFileById = deleteDriveFileById;
window.selectDriveFileForImport = selectDriveFileForImport;
window.toggleDriveFileSelection = toggleDriveFileSelection;
window.loadDriveFiles = loadDriveFiles;

// API appelée par index.html pour générer les PDF dans la sauvegarde ZIP
let bastComptaBackupPdfState = null;

function cloneForBackup(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    return JSON.parse(JSON.stringify(value || null));
  }
}

function getBackupControlText(control) {
  if (!control) return '';
  const tag = String(control.tagName || '').toLowerCase();
  if (tag === 'select') {
    const selected = control.options && control.selectedIndex >= 0 ? control.options[control.selectedIndex] : null;
    return selected ? selected.textContent.trim() : String(control.value || '').trim();
  }
  return String(control.value || '').trim();
}

function materializeBackupPdfControls(docKey) {
  const page = document.querySelector(`.page[data-page="${docKey}"].active`);
  if (!page) return;

  page.querySelectorAll('input:not(.no-print), textarea:not(.no-print), select:not(.no-print)').forEach(control => {
    if (control.closest('.no-print')) return;
    const tag = String(control.tagName || '').toLowerCase();
    const value = getBackupControlText(control);
    const replacement = document.createElement(tag === 'textarea' ? 'div' : 'span');
    replacement.className = 'backup-pdf-value';
    replacement.textContent = value || ' ';
    control.replaceWith(replacement);
  });
}

async function prepareBastComptaDocumentForBackupPdf(payload, docKey) {
  if (!['quote', 'invoice', 'reminder'].includes(docKey)) return false;

  if (!bastComptaBackupPdfState) {
    bastComptaBackupPdfState = {
      data: cloneForBackup(data),
      activePage
    };
  }

  data = mergeDeep(structuredClone(defaultData), cloneForBackup(payload || {}));
  activePage = docKey;
  render();

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  document.body.classList.add('backup-pdf-capture');

  document.querySelectorAll('textarea').forEach(textarea => {
    try { autoResize(textarea); } catch { }
  });

  materializeBackupPdfControls(docKey);

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  return true;
}

async function restoreBastComptaAfterBackupPdf() {
  if (!bastComptaBackupPdfState) return true;

  document.body.classList.remove('backup-pdf-capture');
  data = cloneForBackup(bastComptaBackupPdfState.data);
  activePage = bastComptaBackupPdfState.activePage || 'quote';
  bastComptaBackupPdfState = null;
  render();

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  return true;
}

window.prepareBastComptaDocumentForBackupPdf = prepareBastComptaDocumentForBackupPdf;
window.restoreBastComptaAfterBackupPdf = restoreBastComptaAfterBackupPdf;


async function saveFromPortalGlobal(options = {}) {
  const interceptedAlerts = [];
  const originalAlert = window.alert;
  if (options?.silent) {
    window.alert = message => {
      interceptedAlerts.push(String(message || ''));
      console.info('Alerte Devis & Facture interceptée pendant la sauvegarde globale:', message);
    };
  }

  try {
    syncCommunicationFromInvoice(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const chantierLinked = await syncAllDocumentsToChantiers(false);
    let driveSyncSaved = false;
    let exportedDocuments = [];
    let driveError = '';
    let exportError = '';

    if (googleAccessToken) {
      try {
        driveSyncSaved = await saveSyncToDrive(false);
      } catch (error) {
        driveError = error?.message || String(error);
        console.error('Sauvegarde Drive Devis/Facture impossible.', error);
      }

      try {
        exportedDocuments = await exportAvailableDocumentsToDrive(false);
      } catch (error) {
        exportError = error?.message || String(error);
        console.error('Export documents Drive impossible.', error);
      }
    }

    render();
    return {
      ok: true,
      module: 'devis-facture',
      local: true,
      drive: !!googleAccessToken && (driveSyncSaved || exportedDocuments.length > 0),
      driveSyncSaved,
      chantierLinked,
      exportedDocuments,
      exportedDocumentsCount: exportedDocuments.length,
      alertsIntercepted: interceptedAlerts.length,
      warnings: [driveError && `Drive sync: ${driveError}`, exportError && `Export documents: ${exportError}`].filter(Boolean)
    };
  } finally {
    if (options?.silent) window.alert = originalAlert;
  }
}

window.BastComptaModule = {
  name: 'Devis & Facture',
  save: saveFromPortalGlobal,
  saveData,
  getStatus: () => ({ ready: true, module: 'devis-facture' })
};


window.addEventListener('load', async () => {
  render();
  await initDriveClientOnly();
});
