// BastCompta - module Impôts IPP belge
// Module indépendant : lit les données existantes sans modifier Devis/Facture, Comptabilité ou Suivi client.

(function () {
  'use strict';

  const SETTINGS_KEY = 'bastcompta-impots-belgique-v1';
  const COMPTA_KEY = 'comptabilite-local-v1';
  const DEVIS_KEY = 'devis-facture-style-vrai-document';
  const CHANTIERS_KEY = 'bastcompta-chantiers-v1';

  const defaultSettings = {
    incomeYear: new Date().getFullYear() - 1,
    taxYear: new Date().getFullYear(),
    region: 'wallonie',
    declarationMode: 'benefices',
    taxColumn: 'left',
    activityLabel: 'Activité indépendante personne physique',
    enterpriseNumber: '',
    operatingAddress: '',
    socialContributionsManual: 0,
    useEstimatedSocialContributions: false,
    plci: 0,
    advancePayments: 0,
    priorLosses: 0,
    spouseHelperRemuneration: 0,
    privateProfessionalShare: 100,
    kmAllowance: 0.4259,
    homeOfficeCosts: 0,
    otherManualCosts: 0,
    accountantNotes: '',
    privateChecklist: {
      salary: false,
      mortgage: false,
      children: false,
      pensionSaving: false,
      donations: false,
      serviceVouchers: false
    }
  };

  const pageDefs = [
    { key: 'summary', label: 'Résumé fiscal' },
    { key: 'codes', label: 'Codes IPP' },
    { key: 'checks', label: 'Contrôles' },
    { key: 'details', label: 'Détails chiffres' },
    { key: 'manual', label: 'Réglages / manuel' }
  ];

  let settings = loadSettings();
  let activePage = 'summary';
  let snapshot = buildSnapshot();

  function safeJson(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function round2(value) {
    return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
  }

  function money(value) {
    return toNumber(value).toLocaleString('fr-BE', { style: 'currency', currency: 'EUR' });
  }

  function num(value, digits = 2) {
    return toNumber(value).toLocaleString('fr-BE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, '&#10;');
  }

  function normalizeText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function loadSettings() {
    const parsed = safeJson(localStorage.getItem(SETTINGS_KEY), {});
    return mergeDeep(structuredClone(defaultSettings), parsed || {});
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

  function saveSettings(showAlert = false) {
    settings.taxYear = toNumber(settings.incomeYear) + 1;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings, null, 2));
    if (showAlert) alert('Réglages Impôts IPP sauvegardés.');
    refreshAll(false);
    return true;
  }

  function readSources() {
    return {
      compta: safeJson(localStorage.getItem(COMPTA_KEY), {}),
      devis: safeJson(localStorage.getItem(DEVIS_KEY), {}),
      chantiers: safeJson(localStorage.getItem(CHANTIERS_KEY), { version: 1, projects: [] })
    };
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
    // Le journal des ventes de Comptabilité stocke les ventes en TVAC.
    // Il faut donc reprendre exactement la même logique que comptabilite.js : HTVA = TVAC / (1 + TVA).
    if ('tvac' in row) {
      return round2(salesRowTvac(row) / (1 + toNumber(row.rate || row.vatRate || 21) / 100));
    }
    if ('htva' in row) return toNumber(row.htva);
    const qty = toNumber(row.quantity || row.qty || 1);
    const price = toNumber(row.unitPrice || row.price || 0);
    const discount = toNumber(row.discount || 0);
    return round2(qty * price * (1 - discount / 100));
  }

  function salesRowVat(row) {
    if ('tvac' in row) return round2(salesRowTvac(row) - salesRowNet(row));
    if ('vat' in row) return toNumber(row.vat);
    return round2(salesRowNet(row) * toNumber(row.rate || row.vatRate || 21) / 100);
  }

  function rowDateYear(row) {
    const raw = row?.date || row?.invoiceDate || row?.createdAt || '';
    const year = parseInt(String(raw).slice(0, 4), 10);
    return Number.isFinite(year) ? year : null;
  }

  function inIncomeYear(row) {
    const year = rowDateYear(row);
    return !year || year === toNumber(settings.incomeYear);
  }

  function computeAmortization(amount, date, durationMonths, year) {
    amount = toNumber(amount);
    durationMonths = Math.max(1, parseInt(durationMonths || 60, 10));
    const start = String(date || '').slice(0, 10);
    const startYear = parseInt(start.slice(0, 4), 10);
    const startMonth = parseInt(start.slice(5, 7), 10) || 1;
    if (!startYear || startYear > year) return { amortYear: 0, amortTotal: 0, netValue: amount };

    const monthly = amount / durationMonths;
    const elapsedBeforeYear = Math.max(0, (year - startYear) * 12 + (1 - startMonth));
    const remainingAtYearStart = Math.max(0, durationMonths - elapsedBeforeYear);
    const monthsInYear = Math.min(12, remainingAtYearStart);
    const amortYear = round2(monthly * monthsInYear);
    const elapsedToYearEnd = Math.max(0, (year - startYear) * 12 + (12 - startMonth + 1));
    const amortTotal = round2(monthly * Math.min(durationMonths, elapsedToYearEnd));
    return { amortYear, amortTotal, netValue: round2(Math.max(0, amount - amortTotal)) };
  }

  function categoryAmount(rows, matcher) {
    return (Array.isArray(rows) ? rows : []).filter(inIncomeYear).reduce((sum, row) => matcher(row) ? sum + toNumber(row.htva || row.amount || 0) : sum, 0);
  }

  function detectSocialContributions(compta) {
    const rows = [...(Array.isArray(compta.losses) ? compta.losses : []), ...(Array.isArray(compta.purchases) ? compta.purchases : [])].filter(inIncomeYear);
    return rows.reduce((sum, row) => {
      const label = normalizeText([row.label, row.description, row.supplier, row.category].join(' '));
      if (label.includes('cotisation') || label.includes('caisse sociale') || label.includes('securex') || label.includes('xerius') || label.includes('partena') || label.includes('acerta') || label.includes('liantis')) {
        return sum + toNumber(row.htva || row.amount || (toNumber(row.quantity || 1) * toNumber(row.unitPrice || 0)));
      }
      return sum;
    }, 0);
  }

  function buildSnapshot() {
    const { compta, devis, chantiers } = readSources();
    const incomeYear = toNumber(settings.incomeYear);
    const sales = (Array.isArray(compta.sales) ? compta.sales : []).filter(inIncomeYear);
    const purchases = (Array.isArray(compta.purchases) ? compta.purchases : []).filter(inIncomeYear);
    const investments = (Array.isArray(compta.investments) ? compta.investments : []).filter(row => !rowDateYear(row) || rowDateYear(row) <= incomeYear);
    const assets = (Array.isArray(compta.assets) ? compta.assets : []).filter(row => !rowDateYear(row) || rowDateYear(row) <= incomeYear);
    const losses = (Array.isArray(compta.losses) ? compta.losses : []).filter(inIncomeYear);
    const km = (Array.isArray(compta.km) ? compta.km : []).filter(inIncomeYear);

    const salesNet = sales.reduce((sum, row) => sum + salesRowNet(row), 0);
    const salesVat = sales.reduce((sum, row) => sum + salesRowVat(row), 0);
    const purchasesNet = purchases.reduce((sum, row) => sum + toNumber(row.htva), 0);
    const purchasesVat = purchases.reduce((sum, row) => sum + (row.deductible === false ? 0 : round2(toNumber(row.htva) * toNumber(row.rate || row.vatRate || 21) / 100)), 0);
    const purchasesMerchandiseNet = categoryAmount(purchases, row => row.category === 'marchandise');
    const purchasesGeneralNet = categoryAmount(purchases, row => row.category !== 'marchandise');
    const lossesTotal = losses.reduce((sum, row) => sum + toNumber(row.quantity || 1) * toNumber(row.unitPrice || row.amount || 0), 0);
    const kmTotal = km.reduce((sum, row) => sum + toNumber(row.km) * toNumber(row.trips || 1), 0);
    const kmFiscal = kmTotal * toNumber(settings.kmAllowance);
    const amortInvestments = investments.map(row => ({ ...row, ...computeAmortization(row.amount, row.date, row.durationMonths || 60, incomeYear) }));
    const amortAssets = assets.map(row => ({ ...row, ...computeAmortization(row.amount, row.date, row.durationMonths || 60, incomeYear) }));
    const yearlyAmort = amortInvestments.reduce((sum, row) => sum + row.amortYear, 0);
    const assetsAmort = amortAssets.reduce((sum, row) => sum + row.amortYear, 0);
    const socialDetected = detectSocialContributions(compta);

    const estimatedSocial = (() => {
      const threshold = toNumber(compta.settings?.socialExemptionThreshold || 1881.76);
      const rate = toNumber(compta.settings?.socialContributionRate || 20.5);
      const feeRate = toNumber(compta.settings?.socialContributionFeeRate || 3.5);
      const baseProfit = salesNet - purchasesNet - lossesTotal - yearlyAmort;
      if (baseProfit <= threshold) return 0;
      const contribution = baseProfit * rate / 100;
      return round2(contribution + contribution * feeRate / 100);
    })();

    const socialContributions = toNumber(settings.socialContributionsManual) || socialDetected || (settings.useEstimatedSocialContributions ? estimatedSocial : 0);
    const extraManualCosts = toNumber(settings.homeOfficeCosts) + toNumber(settings.otherManualCosts) + toNumber(settings.spouseHelperRemuneration);
    const professionalShare = Math.max(0, Math.min(100, toNumber(settings.privateProfessionalShare || 100))) / 100;
    const rawCosts = purchasesNet + lossesTotal + yearlyAmort + kmFiscal + extraManualCosts;
    const fiscalCosts = round2(rawCosts * professionalShare);
    const taxableProfit = round2(salesNet - fiscalCosts - socialContributions - toNumber(settings.plci) - toNumber(settings.priorLosses));
    const netVat = round2(salesVat - purchasesVat - toNumber(compta.settings?.vatCarryover || 0));

    return {
      compta, devis, chantiers, incomeYear,
      sales, purchases, investments: amortInvestments, assets: amortAssets, losses, km,
      salesNet: round2(salesNet), salesVat: round2(salesVat), purchasesNet: round2(purchasesNet), purchasesVat: round2(purchasesVat),
      purchasesMerchandiseNet: round2(purchasesMerchandiseNet), purchasesGeneralNet: round2(purchasesGeneralNet),
      lossesTotal: round2(lossesTotal), kmTotal: round2(kmTotal), kmFiscal: round2(kmFiscal), yearlyAmort: round2(yearlyAmort), assetsAmort: round2(assetsAmort),
      socialDetected: round2(socialDetected), estimatedSocial, socialContributions: round2(socialContributions), fiscalCosts, taxableProfit, netVat,
      projectCount: Array.isArray(chantiers.projects) ? chantiers.projects.length : 0,
      clientCount: Array.isArray(devis.clients) ? devis.clients.length : 0,
      sourceStatus: {
        compta: !!localStorage.getItem(COMPTA_KEY),
        devis: !!localStorage.getItem(DEVIS_KEY),
        chantiers: !!localStorage.getItem(CHANTIERS_KEY)
      }
    };
  }

  function fiscalCodes() {
    const left = settings.taxColumn !== 'right';
    const isProfits = settings.declarationMode === 'profits';
    const suffix = left ? 'gauche' : 'droite';
    if (isProfits) {
      return [
        { section: 'Cadre XVIII - Profits', label: 'Recettes provenant de l’exercice de la profession', code: left ? '1650-96' : '2650-66', amount: snapshot.salesNet, source: 'Ventes comptables', note: 'Pour professions libérales, charges, offices ou autres occupations lucratives.' },
        { section: 'Cadre XVIII - Profits', label: 'Cotisations sociales', code: left ? '1656-90' : '2656-60', amount: snapshot.socialContributions, source: 'Détection + réglage manuel', note: 'À vérifier avec l’attestation de ta caisse sociale.' },
        { section: 'Cadre XVIII - Profits', label: 'Frais professionnels réels', code: left ? '1657-89' : '2657-59', amount: snapshot.fiscalCosts, source: 'Achats + charges + amortissements + km', note: 'Code probable pour autres frais professionnels si tu optes pour les frais réels.' },
        { section: 'Cadre X - Réductions', label: 'Pension complémentaire pour indépendants', code: left ? '1342-16' : '2342-83', amount: settings.plci, source: 'Saisie manuelle', note: 'PLCI / pension complémentaire, selon attestation.' }
      ];
    }

    return [
      { section: 'Cadre XVII - Bénéfices', label: 'Bénéfice brut de l’exploitation proprement dite', code: left ? '1600-49' : '2600-19', amount: snapshot.salesNet, source: 'Ventes comptables', note: 'Pour activité commerciale, industrielle, artisanale ou agricole.' },
      { section: 'Cadre XVII - Bénéfices', label: 'Cotisations sociales', code: left ? '1632-17' : '2632-84', amount: snapshot.socialContributions, source: 'Détection + réglage manuel', note: 'À vérifier avec l’attestation de ta caisse sociale.' },
      { section: 'Cadre XVII - Bénéfices', label: 'Autres frais professionnels réels', code: left ? '1606-43' : '2606-13', amount: snapshot.fiscalCosts, source: 'Achats + charges + amortissements + km', note: 'Autres frais professionnels, hors cotisations sociales.' },
      { section: 'Cadre VIII', label: 'Pertes professionnelles antérieures', code: left ? '1349-09' : '2349-76', amount: settings.priorLosses, source: 'Saisie manuelle', note: 'Uniquement si pertes reportables confirmées.' },
      { section: 'Cadre X - Réductions', label: 'Pension complémentaire pour indépendants', code: left ? '1342-16' : '2342-83', amount: settings.plci, source: 'Saisie manuelle', note: 'PLCI / pension complémentaire, selon attestation.' }
    ].map(item => ({ ...item, note: item.note + ` Colonne ${suffix}.` }));
  }

  function alerts() {
    const list = [];
    if (!snapshot.sourceStatus.compta) list.push({ level: 'danger', title: 'Comptabilité introuvable', text: 'Aucune donnée comptable locale trouvée. Le module doit lire comptabilite-local-v1.' });
    if (!snapshot.sales.length) list.push({ level: 'warn', title: 'Aucune vente détectée', text: `Aucune vente comptable détectée pour ${settings.incomeYear}. Vérifie la période ou le journal des ventes.` });
    if (!snapshot.socialContributions) list.push({ level: 'warn', title: 'Cotisations sociales absentes', text: 'Aucun montant de cotisations sociales n’a été trouvé. Encode le montant exact de l’attestation dans les réglages.' });
    if (snapshot.netVat && Math.abs(snapshot.netVat) > 1) list.push({ level: 'warn', title: 'Contrôle TVA', text: `TVA nette calculée : ${money(snapshot.netVat)}. Compare avec tes déclarations Intervat.` });
    if (snapshot.purchases.some(row => row.deductible === false)) list.push({ level: 'warn', title: 'Achats non déductibles TVA', text: 'Certains achats sont marqués non déductibles. Vérifie leur traitement fiscal.' });
    if (snapshot.fiscalCosts > snapshot.salesNet && snapshot.salesNet > 0) list.push({ level: 'danger', title: 'Frais supérieurs aux recettes', text: 'Les frais fiscaux dépassent les recettes. C’est possible, mais à vérifier avant déclaration.' });
    if (!settings.enterpriseNumber) list.push({ level: 'warn', title: 'Numéro d’entreprise manquant', text: 'Encode ton numéro d’entreprise dans les réglages pour préparer le cadre activité.' });
    if (settings.declarationMode === 'profits') list.push({ level: 'warn', title: 'Mode profits sélectionné', text: 'Vérifie que ton activité relève bien du Cadre XVIII et non du Cadre XVII bénéfices.' });
    return list;
  }

  function renderSummaryGrid() {
    const items = [
      ['Recettes HTVA', snapshot.salesNet, `${snapshot.sales.length} ligne(s) vente`],
      ['Frais fiscaux estimés', snapshot.fiscalCosts, 'achats + charges + amort. + km'],
      ['Cotisations sociales', snapshot.socialContributions, snapshot.socialDetected ? 'détectées' : 'manuel / estimation'],
      ['Bénéfice imposable estimé', snapshot.taxableProfit, `revenus ${settings.incomeYear}`],
      ['TVA nette contrôle', snapshot.netVat, 'contrôle Intervat']
    ];
    return items.map(([label, value, sub]) => `
      <div class="card">
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-value">${money(value)}</div>
        <div class="metric-sub">${escapeHtml(sub)}</div>
      </div>
    `).join('');
  }

  function renderTabs() {
    return pageDefs.map(page => `<button class="tab ${activePage === page.key ? 'active' : ''}" onclick="goToPage('${page.key}')">${escapeHtml(page.label)}</button>`).join('');
  }

  function renderSummary() {
    const codeRows = fiscalCodes().filter(row => toNumber(row.amount) !== 0 || ['1600-49', '2600-19', '1650-96', '2650-66'].includes(row.code));
    return `
      <section class="page ${activePage === 'summary' ? 'active' : ''}">
        <div class="grid-2">
          <div class="card">
            <div class="section-head"><div><h2>Préparation IPP personne physique</h2><div class="hint">Exercice d’imposition ${escapeHtml(settings.taxYear)} — revenus ${escapeHtml(settings.incomeYear)}.</div></div></div>
            <div class="kv"><span>Région</span><strong>${settings.region === 'wallonie' ? 'Wallonie' : escapeHtml(settings.region)}</strong></div>
            <div class="kv"><span>Volet métier</span><strong>${settings.declarationMode === 'profits' ? 'Cadre XVIII - Profits' : 'Cadre XVII - Bénéfices'}</strong></div>
            <div class="kv"><span>Activité</span><strong>${escapeHtml(settings.activityLabel || '—')}</strong></div>
            <div class="kv"><span>N° entreprise</span><strong>${escapeHtml(settings.enterpriseNumber || 'À compléter')}</strong></div>
            <div class="kv total-line"><span>Bénéfice imposable estimé</span><strong>${money(snapshot.taxableProfit)}</strong></div>
            <div class="footer-note">Calcul simplifié : recettes - frais réels - cotisations sociales - PLCI - pertes reportées. À vérifier avant encodage.</div>
          </div>
          <div class="card">
            <div class="section-head"><h2>Sources lues</h2></div>
            <div class="kv"><span>Comptabilité</span><span class="badge ${snapshot.sourceStatus.compta ? 'ok' : 'danger'}">${snapshot.sourceStatus.compta ? 'OK' : 'Absent'}</span></div>
            <div class="kv"><span>Devis & Facture / CRM</span><span class="badge ${snapshot.sourceStatus.devis ? 'ok' : 'warn'}">${snapshot.clientCount} client(s)</span></div>
            <div class="kv"><span>Suivi client</span><span class="badge ${snapshot.sourceStatus.chantiers ? 'ok' : 'warn'}">${snapshot.projectCount} fiche(s)</span></div>
            <div class="kv"><span>Achats comptables</span><strong>${snapshot.purchases.length}</strong></div>
            <div class="kv"><span>Investissements suivis</span><strong>${snapshot.investments.length}</strong></div>
          </div>
        </div>
        <div class="card">
          <div class="section-head"><h2>Codes principaux proposés</h2><button class="small" onclick="goToPage('codes')">Voir tous les codes</button></div>
          ${renderCodesTable(codeRows)}
        </div>
      </section>`;
  }

  function renderCodesTable(rows) {
    return `<div style="overflow:auto;"><table><thead><tr><th>Cadre</th><th>Poste</th><th>Code</th><th class="num">Montant</th><th>Source</th><th>Note</th></tr></thead><tbody>
      ${rows.map(row => `<tr><td>${escapeHtml(row.section)}</td><td>${escapeHtml(row.label)}</td><td><strong>${escapeHtml(row.code)}</strong></td><td class="num">${money(row.amount)}</td><td><span class="source-pill">${escapeHtml(row.source)}</span></td><td>${escapeHtml(row.note || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function renderCodes() {
    return `<section class="page ${activePage === 'codes' ? 'active' : ''}">
      <div class="card"><div class="section-head"><div><h2>Tableau codes IPP</h2><div class="hint">Codes probables basés sur le document préparatoire IPP belge. Vérifie l’année exacte avant encodage Tax-on-web.</div></div></div>${renderCodesTable(fiscalCodes())}</div>
      <div class="card"><h3>Postes à compléter manuellement hors BastCompta</h3><p class="hint">Salaire, chômage, habitation, prêt hypothécaire, enfants, épargne-pension, libéralités, titres-services, revenus mobiliers : ces données ne viennent pas de tes modules métier et doivent rester dans Tax-on-web ou être encodées manuellement.</p></div>
    </section>`;
  }

  function renderChecks() {
    const items = alerts();
    return `<section class="page ${activePage === 'checks' ? 'active' : ''}">
      <div class="card"><div class="section-head"><h2>Contrôles avant déclaration</h2><button class="small" onclick="refreshAll()">Relancer</button></div>
        <div class="alert-list">${items.length ? items.map(item => `<div class="alert-item ${escapeAttr(item.level)}"><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.text)}</div>`).join('') : '<div class="alert-item"><strong>Aucune alerte majeure.</strong><br>Les chiffres restent à vérifier avec les attestations officielles.</div>'}</div>
      </div>
    </section>`;
  }

  function renderDetails() {
    return `<section class="page ${activePage === 'details' ? 'active' : ''}">
      <div class="grid-2">
        <div class="card"><div class="section-head"><h2>Détail calcul fiscal</h2></div>
          <div class="kv"><span>Recettes HTVA</span><strong>${money(snapshot.salesNet)}</strong></div>
          <div class="kv"><span>Achats HTVA</span><strong>${money(snapshot.purchasesNet)}</strong></div>
          <div class="kv"><span>Pertes / charges diverses</span><strong>${money(snapshot.lossesTotal)}</strong></div>
          <div class="kv"><span>Amortissements année</span><strong>${money(snapshot.yearlyAmort)}</strong></div>
          <div class="kv"><span>Kilomètres pro (${num(snapshot.kmTotal, 1)} km × ${num(settings.kmAllowance, 4)})</span><strong>${money(snapshot.kmFiscal)}</strong></div>
          <div class="kv"><span>Frais bureau domicile</span><strong>${money(settings.homeOfficeCosts)}</strong></div>
          <div class="kv"><span>Autres frais manuels</span><strong>${money(settings.otherManualCosts)}</strong></div>
          <div class="kv"><span>Part professionnelle appliquée</span><strong>${num(settings.privateProfessionalShare, 0)}%</strong></div>
          <div class="kv total-line"><span>Frais fiscaux estimés</span><strong>${money(snapshot.fiscalCosts)}</strong></div>
        </div>
        <div class="card"><div class="section-head"><h2>Cotisations / réductions</h2></div>
          <div class="kv"><span>Cotisations détectées</span><strong>${money(snapshot.socialDetected)}</strong></div>
          <div class="kv"><span>Cotisations estimées</span><strong>${money(snapshot.estimatedSocial)}</strong></div>
          <div class="kv"><span>Cotisations retenues</span><strong>${money(snapshot.socialContributions)}</strong></div>
          <div class="kv"><span>PLCI / pension complémentaire</span><strong>${money(settings.plci)}</strong></div>
          <div class="kv"><span>Pertes antérieures</span><strong>${money(settings.priorLosses)}</strong></div>
          <div class="kv"><span>Versements anticipés</span><strong>${money(settings.advancePayments)}</strong></div>
          <div class="kv total-line"><span>Bénéfice imposable estimé</span><strong>${money(snapshot.taxableProfit)}</strong></div>
        </div>
      </div>
      <div class="card"><div class="section-head"><h2>Investissements / amortissements</h2></div>${renderInvestmentTable()}</div>
    </section>`;
  }

  function renderInvestmentTable() {
    const rows = snapshot.investments;
    if (!rows.length) return '<div class="hint">Aucun investissement détecté.</div>';
    return `<div style="overflow:auto;"><table><thead><tr><th>Date</th><th>Fournisseur</th><th>Description</th><th class="num">Montant</th><th class="num">Amort. année</th><th class="num">Valeur nette</th></tr></thead><tbody>
      ${rows.map(row => `<tr><td>${escapeHtml(row.date || '')}</td><td>${escapeHtml(row.supplier || '')}</td><td>${escapeHtml(row.description || row.label || '')}</td><td class="num">${money(row.amount)}</td><td class="num">${money(row.amortYear)}</td><td class="num">${money(row.netValue)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function renderManual() {
    const checklist = settings.privateChecklist || {};
    return `<section class="page ${activePage === 'manual' ? 'active' : ''}">
      <div class="grid-2">
        <div class="form-card">
          <h2>Réglages fiscaux</h2>
          <div class="grid-2">
            <div><label>Année des revenus</label><input type="number" value="${escapeAttr(settings.incomeYear)}" onchange="setSetting('incomeYear', parseInt(this.value,10)||new Date().getFullYear()-1)"></div>
            <div><label>Région</label><select onchange="setSetting('region', this.value)"><option value="wallonie" ${settings.region === 'wallonie' ? 'selected' : ''}>Wallonie</option><option value="bruxelles" ${settings.region === 'bruxelles' ? 'selected' : ''}>Bruxelles</option><option value="flandre" ${settings.region === 'flandre' ? 'selected' : ''}>Flandre</option></select></div>
            <div><label>Type de cadre</label><select onchange="setSetting('declarationMode', this.value)"><option value="benefices" ${settings.declarationMode === 'benefices' ? 'selected' : ''}>Cadre XVII - Bénéfices</option><option value="profits" ${settings.declarationMode === 'profits' ? 'selected' : ''}>Cadre XVIII - Profits</option></select></div>
            <div><label>Colonne déclaration</label><select onchange="setSetting('taxColumn', this.value)"><option value="left" ${settings.taxColumn === 'left' ? 'selected' : ''}>Gauche / déclarant</option><option value="right" ${settings.taxColumn === 'right' ? 'selected' : ''}>Droite / partenaire</option></select></div>
            <div><label>Activité</label><input value="${escapeAttr(settings.activityLabel)}" onchange="setSetting('activityLabel', this.value)"></div>
            <div><label>N° entreprise</label><input value="${escapeAttr(settings.enterpriseNumber)}" onchange="setSetting('enterpriseNumber', this.value)"></div>
          </div>
          <div><label>Adresse du siège d'exploitation si différente</label><textarea onchange="setSetting('operatingAddress', this.value)">${escapeHtml(settings.operatingAddress)}</textarea></div>
        </div>
        <div class="form-card">
          <h2>Montants manuels</h2>
          <div class="grid-2">
            <div><label>Cotisations sociales exactes</label><input type="number" step="0.01" value="${escapeAttr(settings.socialContributionsManual)}" onchange="setSetting('socialContributionsManual', parseFloat(this.value)||0)"></div>
            <div><label>PLCI / pension complémentaire</label><input type="number" step="0.01" value="${escapeAttr(settings.plci)}" onchange="setSetting('plci', parseFloat(this.value)||0)"></div>
            <div><label>Versements anticipés</label><input type="number" step="0.01" value="${escapeAttr(settings.advancePayments)}" onchange="setSetting('advancePayments', parseFloat(this.value)||0)"></div>
            <div><label>Pertes antérieures</label><input type="number" step="0.01" value="${escapeAttr(settings.priorLosses)}" onchange="setSetting('priorLosses', parseFloat(this.value)||0)"></div>
            <div><label>Indemnité km</label><input type="number" step="0.0001" value="${escapeAttr(settings.kmAllowance)}" onchange="setSetting('kmAllowance', parseFloat(this.value)||0)"></div>
            <div><label>Part professionnelle %</label><input type="number" step="1" value="${escapeAttr(settings.privateProfessionalShare)}" onchange="setSetting('privateProfessionalShare', parseFloat(this.value)||100)"></div>
            <div><label>Frais bureau domicile</label><input type="number" step="0.01" value="${escapeAttr(settings.homeOfficeCosts)}" onchange="setSetting('homeOfficeCosts', parseFloat(this.value)||0)"></div>
            <div><label>Autres frais manuels</label><input type="number" step="0.01" value="${escapeAttr(settings.otherManualCosts)}" onchange="setSetting('otherManualCosts', parseFloat(this.value)||0)"></div>
          </div>
          <label><input style="width:auto" type="checkbox" ${settings.useEstimatedSocialContributions ? 'checked' : ''} onchange="setSetting('useEstimatedSocialContributions', this.checked)"> Utiliser l'estimation si aucune cotisation exacte n'est encodée</label>
        </div>
      </div>
      <div class="form-card">
        <h2>Checklist privée à ne pas automatiser</h2>
        <div class="grid-3">
          ${Object.entries({ salary: 'Salaire / chômage', mortgage: 'Habitation / prêt', children: 'Enfants à charge', pensionSaving: 'Épargne-pension', donations: 'Libéralités', serviceVouchers: 'Titres-services' }).map(([key, label]) => `<label><input style="width:auto" type="checkbox" ${checklist[key] ? 'checked' : ''} onchange="setChecklist('${key}', this.checked)"> ${escapeHtml(label)}</label>`).join('')}
        </div>
        <div><label>Notes pour comptable / Tax-on-web</label><textarea onchange="setSetting('accountantNotes', this.value)">${escapeHtml(settings.accountantNotes)}</textarea></div>
      </div>
    </section>`;
  }

  function render() {
    document.getElementById('summaryGrid').innerHTML = renderSummaryGrid();
    document.getElementById('tabs').innerHTML = renderTabs();
    document.getElementById('pages').innerHTML = [renderSummary(), renderCodes(), renderChecks(), renderDetails(), renderManual()].join('');
  }

  function refreshAll(show = true) {
    settings = loadSettings();
    snapshot = buildSnapshot();
    render();
    if (show) console.info('Impôts IPP actualisé.');
  }

  function goToPage(pageKey) {
    activePage = pageKey;
    render();
  }

  function setSetting(key, value) {
    settings[key] = value;
    saveSettings(false);
  }

  function setChecklist(key, value) {
    settings.privateChecklist = settings.privateChecklist || {};
    settings.privateChecklist[key] = !!value;
    saveSettings(false);
  }

  function printReport() {
    window.print();
  }

  async function saveFromPortalGlobal(options = {}) {
    saveSettings(false);
    return { ok: true, module: 'impots', local: true, drive: false, alertsIntercepted: 0 };
  }

  window.goToPage = goToPage;
  window.refreshAll = refreshAll;
  window.saveSettings = saveSettings;
  window.setSetting = setSetting;
  window.setChecklist = setChecklist;
  window.printReport = printReport;

  window.BastComptaModule = {
    name: 'Impôts IPP',
    save: saveFromPortalGlobal,
    saveData: saveFromPortalGlobal,
    getStatus: () => ({ ready: true, module: 'impots' })
  };

  window.addEventListener('storage', event => {
    if ([COMPTA_KEY, DEVIS_KEY, CHANTIERS_KEY, SETTINGS_KEY].includes(event.key)) refreshAll(false);
  });

  window.addEventListener('load', () => refreshAll(false));
})();
