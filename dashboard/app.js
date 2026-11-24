// Token Radar round 3 — dashboard. Renders window.RADAR (written by main.ts).
// No network, no framework: the page reads ../data.js and builds every view
// from it, so the screenshots and the code always agree.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.body.textContent = 'No radar data.'; return; }
  var rows = R.rows, meta = R.meta;

  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function pct(x) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + x.toFixed(1) + '%'; }
  function ageFmt(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d < 30) return d + 'd';
    if (d < 365) return Math.round(d / 30) + 'mo';
    return (d / 365).toFixed(1) + 'y';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // KPI strip: the model, its fit and its coverage, live from the data.
  var kpi = document.getElementById('kpi');
  var v = meta.validation, m = meta.model;
  var kpis = [
    ['Board', rows.length + ' ranked · ' + meta.accounting.watchlist + '/40 watchlist'],
    ['Model', 'avg of TVL-only + TVL/growth/age fits'],
    ['Walk-forward', '×' + v.factors.wf.toFixed(2) + ' vs hand-picked tiers'],
    ['Leave-one-out', '×' + v.factors.loo.toFixed(2) + ' · σ ' + v.loo.sigma.toFixed(2)],
    ['90% intervals', 'cover ' + (v.loo.cov90 * 100).toFixed(1) + '% held out'],
    ['All accounted', meta.accounting.board + ' board + ' + meta.accounting.live + ' live + ' + meta.accounting.setAside + ' set aside'],
  ];
  kpis.forEach(function (kv) {
    var d = el('div');
    d.appendChild(el('dt', '', kv[0]));
    d.appendChild(el('dd', '', kv[1]));
    kpi.appendChild(d);
  });

  // Tabs.
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs button'));
  function showTab(name) {
    tabs.forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      document.getElementById('tab-' + b.dataset.tab).hidden = !on;
    });
  }
  tabs.forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });

  // Filters.
  var q = document.getElementById('q');
  var cat = document.getElementById('cat');
  var wl = document.getElementById('wl');
  var sort = document.getElementById('sort');
  var cats = Array.from(new Set(rows.map(function (r) { return r.category; }).filter(Boolean))).sort();
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c; cat.appendChild(o);
  });

  var tbody = document.querySelector('#board tbody');
  var count = document.getElementById('count');
  var detail = document.getElementById('detail');

  function filtered() {
    var needle = q.value.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (wl.checked && !r.watchlist) return false;
      if (cat.value && r.category !== cat.value) return false;
      if (needle && r.name.toLowerCase().indexOf(needle) < 0 && r.slug.indexOf(needle) < 0) return false;
      return true;
    });
    var s = sort.value;
    list.sort(function (a, b) {
      if (s === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (s === 'odds') return b.odds_1y - a.odds_1y || a.rank - b.rank;
      if (s === 'age') return (b.age_days || 0) - (a.age_days || 0);
      if (s === 'name') return a.name.localeCompare(b.name);
      return a.rank - b.rank;
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    tbody.innerHTML = '';
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.setAttribute('aria-selected', 'false');
      tr.dataset.slug = r.slug;
      var cells = [
        r.rank, null, r.category || '—', r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's'),
        money(r.tvl_usd), pct(r.change_7d), ageFmt(r.age_days),
        money(r.implied_value_usd), money(r.low_usd) + '–' + money(r.high_usd),
        Math.round(r.odds_1y * 100) + '%',
      ];
      cells.forEach(function (c, i) {
        var td = document.createElement(i === 0 || i >= 4 ? 'td' : 'td');
        if (i >= 4) td.className = 'num';
        td.textContent = c === null ? '' : c;
        tr.appendChild(td);
      });
      var nameCell = tr.children[1];
      nameCell.textContent = r.name;
      if (r.watchlist) {
        var b = el('span', 'badge', 'WATCHLIST');
        nameCell.appendChild(b);
      }
      tr.addEventListener('click', function () { showDetail(r); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(r); } });
      tbody.appendChild(tr);
    });
    count.textContent = list.length + ' of ' + rows.length + ' protocols';
  }

  function showDetail(r) {
    Array.prototype.forEach.call(tbody.children, function (tr) {
      tr.setAttribute('aria-selected', tr.dataset.slug === r.slug ? 'true' : 'false');
    });
    detail.hidden = false;
    detail.innerHTML = '';
    detail.appendChild(el('h2', '', '#' + r.rank + ' — ' + r.name));
    var p = el('p', '', (r.category || 'Uncategorised') + ' · ' + r.chains.join(', ') + ' · TVL ' + money(r.tvl_usd) +
      ' · 7-day change ' + pct(r.change_7d) + ' · age ' + ageFmt(r.age_days) +
      (r.watchlist ? ' · on the house watchlist' : ''));
    detail.appendChild(p);
    detail.appendChild(el('h3', '', 'How the value is built'));
    var b0 = m.beta0, b2 = m.beta2;
    var lt = Math.log(r.tvl_usd);
    var g = r.change_7d === null ? 0 : Math.max(-0.6, Math.min(1.2, r.change_7d / 100));
    var a = r.age_days === null ? 1 : r.age_days / 365.25;
    var p0 = b0[0] + b0[1] * lt;
    var p2 = b2[0] + b2[1] * lt + b2[2] * g + b2[3] * a;
    var build = el('p', '', 'TVL-only fit: log(value) = ' + b0[0].toFixed(2) + ' + ' + b0[1].toFixed(2) +
      ' × log(TVL) = ' + p0.toFixed(2) + ' → ' + money(Math.round(Math.exp(p0))) + '. ' +
      'Three-feature fit: log(value) = ' + b2[0].toFixed(2) + ' + ' + b2[1].toFixed(2) + ' × log(TVL) + ' +
      b2[2].toFixed(2) + ' × growth + ' + b2[3].toFixed(2) + ' × age = ' + p2.toFixed(2) + ' → ' +
      money(Math.round(Math.exp(p2))) + '. Average of the two: ' + money(r.implied_value_usd) +
      ', with a 90% interval of ' + money(r.low_usd) + ' to ' + money(r.high_usd) +
      ' (±1.6449 × the leave-one-out residual SD of ' + v.loo.sigma.toFixed(2) + ' in log terms).');
    detail.appendChild(build);
    detail.appendChild(el('p', '', 'Launch odds in the next year: ' + Math.round(r.odds_1y * 100) +
      '% — from the peers’ record (see How it scores). Odds are a separate column: the board ranks by implied value, not by expected value.'));
    detail.appendChild(el('h3', '', 'Farm plan'));
    var ol = document.createElement('ol');
    r.farm_steps.forEach(function (s) { ol.appendChild(el('li', '', s)); });
    detail.appendChild(ol);
    detail.appendChild(el('p', 'verdict', r.verdict));
    // The detail sits below the 214-row board in the document, so showing it
    // there leaves the reader (and a screenshot) at the bottom of the board.
    // Move it above the board when it is shown, so the detail is the focus
    // and the board's top rows are what is visible with it.
    var tw = document.getElementById('board').closest('.tablewrap');
    if (tw) tw.parentNode.insertBefore(detail, tw);
    detail.scrollIntoView({ block: 'nearest' });
  }

  [q, cat, wl, sort].forEach(function (c) { c.addEventListener('input', renderBoard); });

  // Live tokens.
  var lt = document.querySelector('#livetab tbody');
  R.live.forEach(function (p) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', '', p.name));
    tr.appendChild(el('td', '', p.category || '—'));
    var td = el('td', 'num', p.usable ? money(p.mcap_usd) : 'Token recorded, no usable market cap in this snapshot');
    tr.appendChild(td);
    lt.appendChild(tr);
  });

  // Set aside.
  var at = document.querySelector('#asidetab tbody');
  R.setAside.forEach(function (p) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', '', p.name));
    tr.appendChild(el('td', '', p.category || '—'));
    tr.appendChild(el('td', '', p.reason));
    at.appendChild(tr);
  });

  // How it scores: method, validation, limits, what would change my mind.
  var meth = document.getElementById('method');
  function h2(t) { meth.appendChild(el('h2', '', t)); }
  function para(t) { meth.appendChild(el('p', '', t)); }
  h2('Method');
  para('Two log-linear fits on the ' + m.nTrain + ' protocols in the snapshot that already have a token (market cap above zero). ' +
    'Fit one: ' + m.m0 + '. Fit two: ' + m.m2 + '. Each protocol’s implied value is the average of the two fits, exponentiated. ' +
    'The coefficients are fitted from the snapshot on every run — nothing about a value is hard-coded except the form of the model. ' +
    'Growth is the 7-day TVL change, clipped to −60%…+120% (0 when unreported). Age is years since DefiLlama first listed the protocol (1 year when no listed date is reported). ' +
    'The board holds the ' + meta.accounting.board + ' protocols that record no token and are not set aside; the ' + meta.accounting.live +
    ' protocols that record a token are listed separately, and ' + meta.accounting.setAside + ' wrapped, staked, bridged or exchange products are set aside by a rule on the category field alone, never by name.');
  para('Fitted coefficients — TVL-only fit: intercept ' + m.beta0[0].toFixed(4) + ', log(TVL) ' + m.beta0[1].toFixed(4) +
    ' (R² ' + m.r2_0.toFixed(4) + '). Three-feature fit: intercept ' + m.beta2[0].toFixed(4) + ', log(TVL) ' + m.beta2[1].toFixed(4) +
    ', growth ' + m.beta2[2].toFixed(4) + ', age ' + m.beta2[3].toFixed(4) + ' (R² ' + m.r2_2.toFixed(4) + '). ' +
    'Growth’s coefficient is negative because a one-week TVL spike mean-reverts: the fit discounts it rather than rewarding it.');
  h2('Validation — blind tests against the hand-picked tiers');
  var vt = document.createElement('table');
  vt.innerHTML = '<thead><tr><th scope="col">Test</th><th scope="col">TVL only</th><th scope="col">Three-feature</th><th scope="col">Average (this entry)</th><th scope="col">Hand-picked tiers</th></tr></thead>';
  var vb = document.createElement('tbody');
  function vrow(name, a, b, c, d) {
    var tr = document.createElement('tr');
    [name, a, b, c, d].forEach(function (x, i) {
      var td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = x; tr.appendChild(td);
    });
    vb.appendChild(tr);
  }
  function rm(x) { return x.rmse.toFixed(4) + ' / ρ ' + x.spearman.toFixed(3); }
  vrow('Walk-forward (fit before 18 Feb 2024, predict the 48 later)', rm(v.wf.m0), rm(v.wf.m2), rm(v.wf.avg), rm(v.wf.r1));
  vrow('Leave-one-out (128 refits)', rm(v.loo.m0), rm(v.loo.m2), rm(v.loo.avg), '—');
  vrow('5-fold, folds by slug order', rm(v.cv5.m0), rm(v.cv5.m2), rm(v.cv5.avg), '—');
  vt.appendChild(vb);
  meth.appendChild(vt);
  para('Numbers are log-RMSE with Spearman rank correlation on held-out cases; lower RMSE and higher ρ are better. ' +
    'The average beats the hand-picked tiers by ×' + v.factors.wf.toFixed(2) + ' walk-forward, ×' + v.factors.loo.toFixed(2) +
    ' leave-one-out and ×' + v.factors.cv5.toFixed(2) + ' 5-fold. No single simple model dominates: TVL-only wins leave-one-out and 5-fold, ' +
    'the three-feature fit wins walk-forward, and the average is top-two on every test — which is why the average is the model. ' +
    'Category dummies and a full model with every feature had the best in-sample R² and the worst out-of-sample scores, so they were rejected as overfit.');
  h2('Uncertainty — checked, not just intended');
  para('Every value carries a 90% interval: prediction ± 1.6449 × the leave-one-out residual SD (' + v.loo.sigma.toFixed(2) +
    ' in log terms, about ×' + Math.exp(v.loo.sigma).toFixed(1) + ' one standard deviation). Measured on held-out cases, the 90% intervals cover ' +
    (v.loo.cov90 * 100).toFixed(1) + '% and the 80% intervals cover ' + (v.loo.cov80 * 100).toFixed(1) +
    '%. The intervals are wide because the snapshot’s figures explain about a fifth of launch value; the rest is protocol-specific.');
  h2('Token odds');
  para('Odds come from the peers’ record: the share of protocols still without a token at each age, smoothed so it never rises with age, ' +
    'then read as a continuous curve — linear between each age band’s median age, flat outside — and each band’s forward 1-year odds are read on that curve. ' +
    'A step function would give 0% wherever a band is wider than a year, so the curve is used instead; it reads the same record. A protocol’s odds are its age band’s forward odds: ' +
    'past the curve’s last point the record is too thin to resolve age finer than the band. ' +
    'Protocols of unknown age take the odds at the median pre-token age (' + meta.medianPreTokenAgeDays + ' days).');
  var ot = document.createElement('table');
  ot.innerHTML = '<thead><tr><th scope="col">Age band</th><th scope="col">Protocols</th><th scope="col">Still without a token</th><th scope="col">Forward 1-year odds</th></tr></thead>';
  var ob = document.createElement('tbody');
  meta.oddsBands.forEach(function (b) {
    var tr = document.createElement('tr');
    var label = b.hiDays === null ? b.loDays + '+ days' : b.loDays + '–' + b.hiDays + ' days';
    [label, String(b.n), (b.smoothed * 100).toFixed(1) + '%', Math.round(b.forwardOdds * 100) + '%'].forEach(function (x, i) {
      var td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = x; tr.appendChild(td);
    });
    ob.appendChild(tr);
  });
  ot.appendChild(ob);
  meth.appendChild(ot);
  h2('Limits — where this radar is weak');
  para('Selection bias: the model is trained on protocols that already have tokens, but the board is protocols that do not. ' +
    'The board’s protocols are younger (median age 1.5 years against 2.7 in training) and run on fewer chains (median 1 against 2). ' +
    'Every validation number above measures prediction among protocols that launched tokens; the true error on the board is unknown and likely larger than the validation error, and the intervals are calibrated on the training population, not on the board. ' +
    'Odds say nothing about a specific protocol’s plans, team, backing or announcements — none of that is in the snapshot. ' +
    'A market cap of zero or less in the snapshot (16 protocols record a token but carry no usable market cap) is treated as “token recorded, no usable market cap”, and those protocols are never trained on. ' +
    'Farm plans assume $2 per simple transaction, the capital tiers and hold days stated next to each number; gas prices move, and a reader should check the chain’s gas price before starting.');
  para('Top of the board — read the first ten rows with care. Ranks 1, 2, 4 and 6 (Steakhouse Financial, Sentora Curator, Gauntlet, Nonce Capital) are risk curators and rank 3 (Veda) is an onchain capital allocator: their TVL is capital deployed into other protocols’ vaults, so the same dollars are counted in the underlying protocols’ TVL as well as their own, and their implied values are likely overstated next to protocols whose TVL is original. The model was fitted on protocols whose TVL is mostly original — only 1 risk curator and 2 allocators sit in the 128 training protocols — so applying it to curators is an extrapolation. Rank 5 (USDD, a CDP on Tron) matches a stablecoin by name, chain and category: if the product is the USDD stablecoin itself, its token already trades and the row should not be ranked as a launch at all. Rank 7 (DeFi Saver Asset Management) is a manager whose TVL is funds it manages in other protocols’ positions, counted there too. Ranks 9 and 10 (B14G, Symbiotic) are restaking protocols whose collateral also appears in the underlying protocols’ TVL. Rank 8 (bittensor-dtao) is clean: its TVL is pool liquidity in its own pools. No rule on the snapshot’s own fields separates these rows cleanly — the house’s own watchlist holds 12 risk curators and 3 allocators, so a category rule would break the 40/40 coverage the gate requires — so they stay on the board and the doubt is stated here instead. What would settle it: DefiLlama’s per-vault breakdown showing which underlying protocols hold each curator’s capital and how much overlaps, and a stablecoin listing confirming whether the USDD token already trades.');
  h2('What would change my mind');
  para('A larger training set — more launches in a later snapshot — would tighten the intervals; if the next snapshot’s launches land outside these 90% intervals more than about 10% of the time, the intervals are too narrow and the residual SD needs widening. ' +
    'A second growth window would test whether growth matters at all: right now one week of growth is all the snapshot carries, and its coefficient is negative. ' +
    'If a category that is currently set aside launches a token of its own, the set-aside rule for that category should be revisited.');

  // Hash state, so screenshots open the exact view: #detail=<slug>, #filter=watchlist.
  // Applied on load and on hash changes (back/forward and same-document navigation).
  function applyHash() {
    var hash = window.location.hash || '';
    var dm = hash.match(/detail=([a-z0-9-]+)/);
    if (dm) {
      var found = rows.find(function (r) { return r.slug === dm[1]; });
      if (found) showDetail(found);
    }
    if (/filter=watchlist/.test(hash)) { wl.checked = true; renderBoard(); }
  }
  renderBoard();
  applyHash();
  window.addEventListener('hashchange', applyHash);
})();
