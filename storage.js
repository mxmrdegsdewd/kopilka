// ============================================================================
//  storage.js — ЕДИНСТВЕННЫЙ модуль, который знает про Supabase.
//
//  Всё приложение общается только с window.Cloud.* — никогда напрямую с
//  Supabase. Чтобы в будущем сменить бэкенд, переписывается только этот файл.
//
//  Что он делает:
//   • Вход/регистрация по email+паролю (Supabase Auth).
//   • Чтение всех данных пользователя при входе  → pullAll()
//   • Первичная заливка локальных данных в облако → pushAll(D)   (миграция)
//   • Построчная досинхронизация при изменениях   → sync(D)      (только дельта)
//   • Перевод денег рубли↔копейки на границе с базой.
//
//  Зависимости: глобальный window.supabase из supabase-js (подключается
//  <script>'ом в index.html). Если его нет или нет настроек подключения —
//  модуль молча выключен, приложение работает чисто локально.
// ============================================================================
window.Cloud = (function () {
  'use strict';

  const LS_URL = 'kop_sb_url';      // URL проекта (можно задать в настройках)
  const LS_KEY = 'kop_sb_key';      // anon public ключ
  const AUTH_STORAGE_KEY = 'kop_sb_auth'; // где supabase-js хранит сессию

  let client = null;
  let _lastRows = null;             // снимок строк (в копейках) с прошлой синхр.

  // ── Деньги: рубли ↔ копейки. В базе всё целое (копейки) ────────────────────
  const R2K = r => Math.round(Number(r || 0) * 100);   // рубли  → копейки
  const K2R = k => Number(k || 0) / 100;               // копейки → рубли

  // ── Настройки подключения (вводятся в приложении, хранятся в браузере) ───────
  function getConfig() {
    return {
      url: (localStorage.getItem(LS_URL) || '').trim(),
      key: (localStorage.getItem(LS_KEY) || '').trim()
    };
  }
  function setConfig(url, key) {
    const cleanUrl = (url || '').trim().replace(/\/(rest\/v1\/?|v1\/?)$/i, '').replace(/\/$/, '');
    localStorage.setItem(LS_URL, cleanUrl);
    localStorage.setItem(LS_KEY, (key || '').trim());
    client = null;
  }
  function isConfigured() {
    const c = getConfig();
    return !!(c.url && c.key && window.supabase);
  }
  function _client() {
    if (client) return client;
    const c = getConfig();
    if (!c.url || !c.key) throw new Error('Подключение к Supabase не настроено');
    if (!window.supabase) throw new Error('Библиотека Supabase не загрузилась');
    client = window.supabase.createClient(c.url, c.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY }
    });
    return client;
  }

  // ── АУТЕНТИФИКАЦИЯ ────────────────────────────────────────────────────────
  async function signUp(email, password) {
    const { data, error } = await _client().auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }
  async function signIn(email, password) {
    const { data, error } = await _client().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }
  async function signOut() {
    if (!isConfigured()) return;
    _lastRows = null;
    const { error } = await _client().auth.signOut();
    if (error) throw error;
  }
  async function currentUser() {
    if (!isConfigured()) return null;
    // getSession читает из localStorage мгновенно, без сети — сессия не теряется при перезагрузке
    const { data } = await _client().auth.getSession();
    return data && data.session ? data.session.user : null;
  }
  function onAuthChange(cb) {
    if (!isConfigured()) return () => {};
    const { data } = _client().auth.onAuthStateChange((_event, session) => {
      cb(session ? session.user : null);
    });
    return () => { try { data.subscription.unsubscribe(); } catch (e) {} };
  }
  async function _uid() {
    const u = await currentUser();
    if (!u) throw new Error('Не выполнен вход');
    return u.id;
  }

  // ── ПЕРЕВОД: приложение (D, рубли) → строки таблиц (копейки) ────────────────
  // Каждая запись adjustments получает стабильный _rid (uuid). Если его ещё нет
  // (старые данные) — генерируем. Это нужно для построчной синхронизации.
  function _ensureRid(entry) {
    if (!entry._rid) {
      entry._rid = (crypto.randomUUID && crypto.randomUUID()) ||
        ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    }
    return entry._rid;
  }

  function dToRows(D, uid, prevRows) {
    const accounts = (D.accounts || []).map((a, i) => ({
      user_id: uid, local_id: a.id, name: a.name || '',
      initial_balance: R2K(a.initialBalance), start_date: a.startDate || null,
      color: a.color || null, position: i
    }));

    // Категории — простой список строк. local_id берём из прошлой синхронизации
    // по имени (чтобы id не «прыгали» при переупорядочивании), новым выдаём след.
    const prevCats = (prevRows && prevRows.categories) || [];
    const byName = {}; let maxCat = 0;
    prevCats.forEach(c => { byName[c.name] = c.local_id; if (c.local_id > maxCat) maxCat = c.local_id; });
    const categories = (D.categories || []).map((name, i) => {
      let id = byName[name];
      if (id == null) { id = ++maxCat; byName[name] = id; }
      return { user_id: uid, local_id: id, name: name, position: i };
    });

    const payments = (D.payments || []).map((p, i) => ({
      user_id: uid, local_id: p.id, name: p.name || '',
      amount: R2K(p.amount), type: p.type === 'income' ? 'income' : 'expense',
      day_of_month: (p.dayOfMonth == null ? null : p.dayOfMonth),
      active: p.active !== false,
      start_date: p.startDate || null, end_date: p.endDate || null,
      history: (p.history || []).map(h => ({
        oldAmount: R2K(h.oldAmount), changedOn: h.changedOn, ts: h.ts || null
      })),
      position: i
    }));

    const adjustments = [];
    Object.entries(D.adjustments || {}).forEach(([date, arr]) => {
      (arr || []).forEach((j, idx) => {
        if (!j) return;
        adjustments.push({
          id: _ensureRid(j), user_id: uid, date: date,
          amount: j.balUpd ? null : R2K(j.amount),
          note: j.note || null,
          account_id: (j.acId == null ? null : j.acId),
          bal_upd: !!j.balUpd,
          target: j.balUpd ? R2K(j.target) : null,
          ts: j.ts || null, ord: idx
        });
      });
    });

    const day_overrides = Object.entries(D.dayOverrides || {}).map(([date, o]) => ({
      user_id: uid, date: date,
      added: (o && o.added) || [], removed: (o && o.removed) || []
    }));

    const goals = (D.goals || []).map((g, i) => ({
      user_id: uid, local_id: g.id, name: g.name || '',
      amount: R2K(g.amount), date: g.date || null, position: i
    }));

    const settings = {
      user_id: uid, theme: D.theme || 'auto',
      forecast_months: D.forecastMonths || 24,
      next_id: D.nextId || 1, next_ac_id: D.nextAcId || 1, next_goal_id: D.nextGoalId || 1
    };

    return { accounts, categories, payments, adjustments, day_overrides, goals, settings };
  }

  // ── ПЕРЕВОД: строки таблиц (копейки) → приложение (D, рубли) ────────────────
  function rowsToD(r) {
    const D = {};
    D.accounts = (r.accounts || []).sort((a, b) => a.position - b.position).map(a => ({
      id: a.local_id, name: a.name,
      initialBalance: K2R(a.initial_balance),
      startDate: a.start_date || undefined, color: a.color || '#007AFF'
    }));
    D.categories = (r.categories || []).sort((a, b) => a.position - b.position).map(c => c.name);
    D.payments = (r.payments || []).sort((a, b) => a.position - b.position).map(p => {
      const o = {
        id: p.local_id, name: p.name, amount: K2R(p.amount),
        type: p.type, dayOfMonth: p.day_of_month, active: p.active,
        startDate: p.start_date || undefined
      };
      if (p.end_date) o.endDate = p.end_date;
      if (p.history && p.history.length) {
        o.history = p.history.map(h => ({ oldAmount: K2R(h.oldAmount), changedOn: h.changedOn, ts: h.ts || undefined }));
      }
      return o;
    });
    D.adjustments = {};
    (r.adjustments || []).slice().sort((a, b) => (a.ord || 0) - (b.ord || 0)).forEach(j => {
      const date = j.date;
      if (!D.adjustments[date]) D.adjustments[date] = [];
      const e = { _rid: j.id, note: j.note || undefined };
      if (j.account_id != null) e.acId = j.account_id;
      if (j.ts != null) e.ts = j.ts;
      if (j.bal_upd) { e.balUpd = true; e.target = K2R(j.target); }
      else { e.amount = K2R(j.amount); }
      D.adjustments[date].push(e);
    });
    D.dayOverrides = {};
    (r.day_overrides || []).forEach(o => {
      D.dayOverrides[o.date] = { added: o.added || [], removed: o.removed || [] };
    });
    D.goals = (r.goals || []).sort((a, b) => a.position - b.position).map(g => ({
      id: g.local_id, name: g.name, amount: K2R(g.amount), date: g.date || ''
    }));
    const s = r.settings || {};
    D.theme = s.theme || 'auto';
    D.forecastMonths = s.forecast_months || 24;
    D.nextId = s.next_id || (Math.max(0, ...D.payments.map(p => p.id || 0)) + 1);
    D.nextAcId = s.next_ac_id || (Math.max(0, ...D.accounts.map(a => a.id || 0)) + 1);
    D.nextGoalId = s.next_goal_id || (Math.max(0, ...D.goals.map(g => g.id || 0)) + 1);
    return D;
  }

  // ── ЧТЕНИЕ ВСЕГО при входе ─────────────────────────────────────────────────
  async function pullAll() {
    const c = _client();
    const uid = await _uid();
    const tables = ['accounts', 'categories', 'payments', 'adjustments', 'day_overrides', 'goals'];
    const out = {};
    for (const t of tables) {
      const { data, error } = await c.from(t).select('*').eq('user_id', uid);
      if (error) throw error;
      out[t] = data || [];
    }
    const { data: sett, error: sErr } = await c.from('settings').select('*').eq('user_id', uid).maybeSingle();
    if (sErr) throw sErr;
    out.settings = sett || null;
    const D = rowsToD(out);
    _lastRows = out;          // запоминаем как «эталон» для будущих дельт
    return D;
  }

  // Есть ли у пользователя хоть какие-то данные в облаке?
  async function hasRemoteData() {
    const c = _client();
    const uid = await _uid();
    const { count, error } = await c.from('accounts').select('*', { count: 'exact', head: true }).eq('user_id', uid);
    if (error) throw error;
    return (count || 0) > 0;
  }

  // ── ПЕРВИЧНАЯ ЗАЛИВКА (миграция локальных данных в облако) ──────────────────
  async function pushAll(D) {
    const c = _client();
    const uid = await _uid();
    const rows = dToRows(D, uid, _lastRows);
    await _upsert(c, 'accounts', rows.accounts, 'user_id,local_id');
    await _upsert(c, 'categories', rows.categories, 'user_id,local_id');
    await _upsert(c, 'payments', rows.payments, 'user_id,local_id');
    await _upsert(c, 'adjustments', rows.adjustments, 'id');
    await _upsert(c, 'day_overrides', rows.day_overrides, 'user_id,date');
    await _upsert(c, 'goals', rows.goals, 'user_id,local_id');
    await _upsert(c, 'settings', [rows.settings], 'user_id');
    _lastRows = rows;
  }

  async function _upsert(c, table, rows, onConflict) {
    if (!rows || !rows.length) return;
    const { error } = await c.from(table).upsert(rows, { onConflict });
    if (error) throw error;
  }
  async function _deleteKeys(c, table, uid, keyField, values) {
    if (!values.length) return;
    const { error } = await c.from(table).delete().eq('user_id', uid).in(keyField, values);
    if (error) throw error;
  }
  async function _deleteIds(c, table, ids) {
    if (!ids.length) return;
    const { error } = await c.from(table).delete().in('id', ids);
    if (error) throw error;
  }

  // ── ПОСТРОЧНАЯ ДОСИНХРОНИЗАЦИЯ (только то, что изменилось) ──────────────────
  // Сравниваем текущее состояние с прошлым снимком (_lastRows): что добавилось/
  // изменилось — upsert одной-несколькими строками; что исчезло — delete.
  async function sync(D) {
    const c = _client();
    const uid = await _uid();
    const cur = dToRows(D, uid, _lastRows);
    const prev = _lastRows || { accounts: [], categories: [], payments: [], adjustments: [], day_overrides: [], goals: [], settings: null };

    // Таблицы с ключом (user_id, local_id)
    for (const [t, keyName] of [['accounts', 'local_id'], ['categories', 'local_id'], ['payments', 'local_id'], ['goals', 'local_id']]) {
      const changed = _diffUpsert(prev[t] || [], cur[t], keyName);
      await _upsert(c, t, changed, 'user_id,' + keyName);
      const gone = _diffDeleted(prev[t] || [], cur[t], keyName);
      await _deleteKeys(c, t, uid, keyName, gone);
    }
    // day_overrides — ключ date
    {
      const changed = _diffUpsert(prev.day_overrides || [], cur.day_overrides, 'date');
      await _upsert(c, 'day_overrides', changed, 'user_id,date');
      const gone = _diffDeleted(prev.day_overrides || [], cur.day_overrides, 'date');
      await _deleteKeys(c, 'day_overrides', uid, 'date', gone);
    }
    // adjustments — ключ id (uuid)
    {
      const changed = _diffUpsert(prev.adjustments || [], cur.adjustments, 'id');
      await _upsert(c, 'adjustments', changed, 'id');
      const gone = _diffDeleted(prev.adjustments || [], cur.adjustments, 'id');
      await _deleteIds(c, 'adjustments', gone);
    }
    // settings — всегда одна строка
    if (JSON.stringify(prev.settings) !== JSON.stringify(cur.settings)) {
      await _upsert(c, 'settings', [cur.settings], 'user_id');
    }
    _lastRows = cur;
  }

  // Строки, которые новые или изменились (сравнение по JSON без user_id/position-шума)
  function _diffUpsert(prevArr, curArr, key) {
    const prevMap = {};
    prevArr.forEach(r => { prevMap[r[key]] = JSON.stringify(r); });
    return curArr.filter(r => prevMap[r[key]] !== JSON.stringify(r));
  }
  // Ключи, которые были, но исчезли
  function _diffDeleted(prevArr, curArr, key) {
    const curKeys = new Set(curArr.map(r => r[key]));
    return prevArr.filter(r => !curKeys.has(r[key])).map(r => r[key]);
  }

  return {
    // настройки подключения
    getConfig, setConfig, isConfigured,
    // авторизация
    signUp, signIn, signOut, currentUser, onAuthChange,
    // данные
    pullAll, pushAll, sync, hasRemoteData,
    // утилиты (на всякий случай наружу)
    _R2K: R2K, _K2R: K2R
  };
})();
