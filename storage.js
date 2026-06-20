// ============================================================================
//  storage.js — ЕДИНСТВЕННЫЙ модуль, который знает про облако (Яндекс Диск).
//
//  Всё приложение общается только с window.Cloud.* — никогда напрямую с API.
//  Чтобы в будущем сменить бэкенд, переписывается только этот файл.
//
//  Модель: данные приложения (объект D) хранятся ОДНИМ файлом kopilka.json в
//  ПАПКЕ ПРИЛОЖЕНИЯ на Яндекс Диске пользователя (scope cloud_api:disk.app_folder
//  — доступ только к своей папке, не ко всему диску). Целый файл, last-write-wins.
//  Вход — Яндекс OAuth (implicit flow, токен в URL после #). Без сервера.
//
//  НАСТРОЙКА ВЛАДЕЛЬЦЕМ (один раз): зарегистрируй приложение на
//  https://oauth.yandex.ru/client/new , дай ему доступ «Яндекс Диск REST API →
//  Доступ к папке приложения», впиши Redirect URI = адрес страницы, и вставь
//  выданный client_id в константу CLIENT_ID ниже. client_id публичный — его
//  безопасно держать в коде (как anon-ключ).
// ============================================================================
window.Cloud = (function () {
  'use strict';

  // ВПИШИ СЮДА client_id своего OAuth-приложения Яндекса (см. шапку файла):
  const CLIENT_ID = '9def35ba659d4fe392b722e50e2819d8';

  const LS_TOKEN = 'kop_yndx_token';   // OAuth-токен
  const LS_USER  = 'kop_yndx_user';    // кэш данных аккаунта (для мгновенного UI)
  const LS_META  = 'kop_yndx_meta';    // последняя виденная метка файла (modified/md5)
  const OWNER_KEY = 'kop_yndx_owner';  // чей аккаунт владеет локальными данными (защита от утечки)

  const API = 'https://cloud-api.yandex.net/v1/disk';
  const FILE_PATH = 'app:/kopilka.json';

  // ── Токен / заголовки ──────────────────────────────────────────────────────
  function _token() { return localStorage.getItem(LS_TOKEN) || ''; }
  function hasToken() { return !!_token(); }
  function _authHdr() { return { 'Authorization': 'OAuth ' + _token() }; }

  function isConfigured() { return !!CLIENT_ID; }

  function _redirectUri() { return location.origin + location.pathname; }

  // Ошибка, пойманная из URL при возврате с OAuth (например, redirect_uri не совпал).
  let _authError = '';
  function lastAuthError() { return _authError; }

  // Перехват токена ИЛИ ошибки из URL после возврата с OAuth. Яндекс отдаёт результат
  // в hash: при успехе `#access_token=...`, при отказе `#error=...&error_description=...`.
  // Вызывается сразу при загрузке модуля, ДО старта приложения.
  function _captureTokenFromUrl() {
    const h = location.hash || '';
    if (h.indexOf('access_token=') === -1 && h.indexOf('error=') === -1) return;
    try {
      const p = new URLSearchParams(h.replace(/^#/, ''));
      const t = p.get('access_token');
      if (t) {
        localStorage.setItem(LS_TOKEN, t);
      } else {
        const e = p.get('error_description') || p.get('error');
        if (e) _authError = decodeURIComponent(e.replace(/\+/g, ' '));
      }
    } catch (e) {}
    // вычищаем хвост из адреса в любом случае
    try { history.replaceState(null, '', location.origin + location.pathname + location.search); } catch (e) {}
  }
  _captureTokenFromUrl();

  // ── АУТЕНТИФИКАЦИЯ ────────────────────────────────────────────────────────
  function signInWithYandex() {
    if (!CLIENT_ID) { alert('Не задан client_id приложения. Впиши его в storage.js (см. инструкцию в окне синхронизации).'); return; }
    const url = 'https://oauth.yandex.ru/authorize?response_type=token'
      + '&client_id=' + encodeURIComponent(CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(_redirectUri());
    location.href = url;
  }

  function signOut() {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_META);
  }

  // Мгновенно (без сети) — из кэша. Для оптимистичного восстановления сессии.
  function getCachedUser() {
    if (!_token()) return null;
    try { return JSON.parse(localStorage.getItem(LS_USER) || 'null'); } catch (e) { return null; }
  }

  // С проверкой по сети: валидирует токен и достаёт логин/имя из /v1/disk/.
  // 401 → токен протух, чистим. Возвращает {id,login,display} или null.
  async function currentUser() {
    if (!isConfigured() || !_token()) return null;
    const r = await fetch(API + '/?fields=user', { headers: _authHdr() });
    if (r.status === 401) { signOut(); return null; }
    if (!r.ok) throw new Error('Яндекс Диск недоступен (' + r.status + ')');
    const d = await r.json();
    const u = (d && d.user) || {};
    const user = { id: u.uid || u.login || '', login: u.login || '', display: u.display_name || u.login || 'аккаунт' };
    localStorage.setItem(LS_USER, JSON.stringify(user));
    return user;
  }

  function onAuthChange(cb) { try { cb(getCachedUser()); } catch (e) {} return function () {}; }

  // ── ФАЙЛ НА ДИСКЕ ──────────────────────────────────────────────────────────
  async function _meta() {
    const r = await fetch(API + '/resources?path=' + encodeURIComponent(FILE_PATH) + '&fields=modified,md5,name', { headers: _authHdr() });
    if (r.status === 404) return null;
    if (r.status === 401) { const e = new Error('Сессия истекла — войдите снова'); e.code = 'AUTH'; throw e; }
    if (!r.ok) throw new Error('Ошибка Диска (' + r.status + ')');
    return await r.json();
  }
  function _rememberMeta(m) { if (m) try { localStorage.setItem(LS_META, JSON.stringify({ modified: m.modified, md5: m.md5 })); } catch (e) {} }
  function getRemoteMeta() { try { return JSON.parse(localStorage.getItem(LS_META) || 'null'); } catch (e) { return null; } }

  async function hasRemoteData() { return (await _meta()) !== null; }

  async function pullAll() {
    const r = await fetch(API + '/resources/download?path=' + encodeURIComponent(FILE_PATH), { headers: _authHdr() });
    if (r.status === 401) { const e = new Error('Сессия истекла — войдите снова'); e.code = 'AUTH'; throw e; }
    if (!r.ok) throw new Error('Не удалось получить ссылку на скачивание');
    const { href } = await r.json();
    const f = await fetch(href);
    if (!f.ok) throw new Error('Не удалось скачать данные');
    const D = await f.json();
    _rememberMeta(await _meta());
    return D;
  }

  async function pushAll(D) {
    const r = await fetch(API + '/resources/upload?path=' + encodeURIComponent(FILE_PATH) + '&overwrite=true', { headers: _authHdr() });
    if (r.status === 401) { const e = new Error('Сессия истекла — войдите снова'); e.code = 'AUTH'; throw e; }
    if (!r.ok) throw new Error('Не удалось получить ссылку на загрузку');
    const { href } = await r.json();
    // без кастомного Content-Type — чтобы лишний раз не усложнять CORS-preflight на storage-хосте
    const up = await fetch(href, { method: 'PUT', body: JSON.stringify(D) });
    if (!(up.ok || up.status === 201 || up.status === 202)) throw new Error('Не удалось загрузить данные');
    _rememberMeta(await _meta());
  }

  // Целый файл, last-write-wins. Для одного пользователя достаточно.
  async function sync(D) { await pushAll(D); }

  return {
    isConfigured, signInWithYandex, signOut,
    getCachedUser, currentUser, onAuthChange, hasToken,
    hasRemoteData, pullAll, pushAll, sync, getRemoteMeta,
    lastAuthError,
    redirectUri: _redirectUri, OWNER_KEY: OWNER_KEY
  };
})();
