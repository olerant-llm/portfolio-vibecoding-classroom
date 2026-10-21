(function () {
  var ICON_SPRITE_ID = 'jisakuya-sidebar-icons';

  var ICON_SPRITE =
    '<svg id="' + ICON_SPRITE_ID + '" width="0" height="0" style="position:absolute" aria-hidden="true">' +
      '<symbol id="i-house" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 23 10.7l-.9 1.2-1.6-1.3v10.9H19V9.4l-7-5.4-7 5.4v12.1H3.5V10.6l-1.6 1.3L1 10.7 12 2Zm4.5 8.5v9h-9v-9h9Zm-5.3 5.3H9V18h2.2v-2.2Zm1.6 0V18H15v-2.2h-2.2Zm0-1.5H15V12h-2.2v2.3Zm-1.5-.1V12H9v2.2h2.3Z"/></symbol>' +
      '<symbol id="i-mailing" viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 2.5C19.1 2.6 22 5.6 22 9.2V17h-9v5h-2v-5H2V8.9c0-3.5 2.9-6.4 6.5-6.4h7ZM3.5 8.9v6.6h5.1V9.2c0-2.1.9-4 2.4-5.2H8.4C5.7 4 3.5 6.2 3.5 8.9Zm6.5 6.6h10.4V9.2C20.4 6.3 18.1 4 15.2 4S10 6.3 10 9.2v6.3Zm2.3-6.1h6.3v1.5h-6.3V9.4Z"/></symbol>' +
      '<symbol id="i-documents" viewBox="0 0 24 24"><path fill="currentColor" d="m11.6 6-2-2H2v17h20V6H11.6ZM9 5.5l2 2h9.5v3H3.5v-5H9Zm-5.5 14V12h17v7.5h-17Z"/></symbol>' +
      '<symbol id="i-money" viewBox="0 0 24 24"><path fill="currentColor" d="M2 12C2 6.5 6.5 2 12 2s10 4.5 10 10-4.5 10-10 10S2 17.5 2 12Zm1.5 0c0 4.7 3.8 8.5 8.5 8.5s8.5-3.8 8.5-8.5S16.7 3.5 12 3.5 3.5 7.3 3.5 12Zm8.5-.3L14.7 7h1.7l-2.8 5H16v1h-3.3v1.5H16v1h-3.3V18h-1.5v-2.5H8v-1h3.2V13H8v-1h2.4L7.6 7h1.7l2.7 4.7Z"/></symbol>' +
      '<symbol id="i-me" viewBox="0 0 24 24"><path fill="currentColor" d="M15 6.5c0-1.7-1.3-3-3-3s-3 1.3-3 3 1.3 3 3 3 3-1.3 3-3Zm-7.5 0C7.5 4 9.5 2 12 2s4.5 2 4.5 4.5S14.5 11 12 11 7.5 9 7.5 6.5ZM19.5 22v-1.2c0-3.4-2.8-6.2-6.2-6.2h-2.5c-3.4 0-6.2 2.8-6.2 6.2V22H3v-1.2c0-4.3 3.5-7.7 7.8-7.7h2.5c4.3 0 7.8 3.5 7.8 7.7V22h-1.6Z"/></symbol>' +
      '<symbol id="i-information" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10Zm0-18.5c-4.7 0-8.5 3.8-8.5 8.5s3.8 8.5 8.5 8.5 8.5-3.8 8.5-8.5S16.7 3.5 12 3.5ZM11.2 9.5h1.5V18h-1.5V9.5ZM11 7c0-.3.1-.5.3-.7.2-.2.4-.3.7-.3.3 0 .5.1.7.3.2.2.3.4.3.7 0 .3-.1.5-.3.7-.2.2-.4.3-.7.3-.3 0-.5-.1-.7-.3A1 1 0 0 1 11 7Z"/></symbol>' +
      '<symbol id="i-application" viewBox="0 0 24 24"><path fill="currentColor" d="M4 2h12.7L20 5.2V22H4V2Zm1.5 1.5v17h13v-14h-3v-3h-10ZM7 11h10v1.5H7V11Zm10-3H7v1.5h10V8Zm-7.6 7.2 1.9 1.7 3.3-3 1 1.2-4.3 3.9-2.9-2.7 1-1.1Z"/></symbol>' +
      '<symbol id="i-search" viewBox="0 0 24 24"><path fill="currentColor" d="m21 20.5-6-6A7.4 7.4 0 0 0 16.9 9.5C17 5.4 13.6 2 9.5 2S2 5.4 2 9.5 5.3 17 9.5 17c1.7 0 3.2-.6 4.5-1.5l6 6 1-1ZM3.5 9.5c0-3.3 2.7-6 6-6s6 2.7 6 6-2.7 6-6 6-6-2.7-6-6Z"/></symbol>' +
      '<symbol id="i-add" viewBox="0 0 24 24"><path fill="currentColor" d="M21 11.2h-8.3V3h-1.5v8.2H3v1.5h8.2V21h1.5v-8.3H21v-1.5Z"/></symbol>' +
      '<symbol id="i-arrow_left" viewBox="0 0 24 24"><path fill="currentColor" d="M14.5 21 5.4 12l9.1-9 1 1-7.9 8 7.9 8-1 1Z"/></symbol>' +
      '<symbol id="i-arrow_right" viewBox="0 0 24 24"><path fill="currentColor" d="m9 21-1-1 8-8-8-8 1-1 9.1 9L9 21Z"/></symbol>' +
      '<symbol id="i-update" viewBox="0 0 24 24"><path fill="currentColor" d="m20.5 13.7 2-2 1 1-3.8 3.8-3.8-3.8 1.1-1.1 2 2v-1.9c0-4-3.1-7.3-6.9-7.3-.8 0-1.6.2-2.4.5l-.5-1.4c1-.3 1.9-.5 2.9-.5 4.7 0 8.4 3.9 8.4 8.8v1.9ZM5.1 11.7C5.1 15.7 8.2 19 12 19c.8 0 1.6-.2 2.4-.3l.5 1.4c-1 .3-1.9.5-2.9.5-4.6 0-8.4-4-8.4-8.8v-1.4l-2 2-1.1-1.1 3.8-3.8 3.9 3.7-1.1 1.1-2-2v1.4Z"/></symbol>' +
      '<symbol id="i-notification" viewBox="0 0 24 24"><path fill="currentColor" d="M18 9.5c0 3.1 1.9 6.6 1.9 6.6l.1.2V18H4v-1.7l.1-.2S6 12.6 6 9.5c0-1.8.8-3.4 2-4.5.6-.5 1.2-.8 2-1.2.1-1 1-1.8 2-1.8s1.9.8 2 1.8c.8.3 1.4.7 2 1.2 1.2 1.1 2 2.7 2 4.5Zm-10.5 0c0 2.9-1.4 6-1.9 7h12.8c-.5-1-1.9-4.1-1.9-7 0-.7-.2-1.4-.5-2-.4-.9-1.1-1.6-2-2-.6-.3-1.3-.5-2-.5s-1.4.2-2 .5c-.9.4-1.6 1.1-2 2-.3.6-.5 1.3-.5 2ZM14.5 19.5c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5h5Z"/></symbol>' +
      '<symbol id="i-play" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></symbol>' +
      '<symbol id="i-heart" viewBox="0 0 24 24"><path fill="currentColor" d="m12 21.35-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z"/></symbol>' +
      '<symbol id="i-star" viewBox="0 0 24 24"><path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"/></symbol>' +
      '<symbol id="i-book" viewBox="0 0 24 24"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9Zm-1 16H5v-7c0-3.31 2.69-6 6-6v13Zm8 0h-6V6c3.31 0 6 2.69 6 6v7Z"/></symbol>' +
      '<symbol id="i-share" viewBox="0 0 24 24"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A3 3 0 1 0 15 5c0 .24.04.47.09.7L8.04 9.81A3 3 0 1 0 8.04 14.19l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92Z"/></symbol>' +
      '<symbol id="i-fullscreen" viewBox="0 0 24 24"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3Zm-2-4h2V7h3V5H5v5Zm12 7h-3v2h5v-5h-2v3ZM14 5v2h3v3h2V5h-5Z"/></symbol>' +
    '</svg>';

  var ITEMS = [
    { key: 'home', label: 'ホーム', href: 'index.html', icon: 'i-house', indexView: 'top' },
    { key: 'quest', label: 'ミッション', href: 'index.html#quest', icon: 'i-mailing', indexView: 'quest' },
    { key: 'corder', label: 'じさくや コーダー', href: 'corder.html', icon: 'i-application' },
    { key: 'knowledge', label: 'ナレッジベース', href: 'knowledge.html', icon: 'i-documents', requiresLogin: true },
    { key: 'knowledge_history', label: '学習履歴', href: 'knowledge_history.html', icon: 'i-documents' },
    { key: 'market', label: 'マーケット', href: 'market.html', icon: 'i-money' },
    { key: 'user_admin', label: '教室での利用はこちら', href: 'user_admin.html', icon: 'i-information', className: 'side-link-classroom' },
    { key: 'userpage', label: 'マイページ', href: 'userpage.html', icon: 'i-me' }
  ];

  function insertIcons() {
    if (document.getElementById(ICON_SPRITE_ID)) return;
    document.body.insertAdjacentHTML('afterbegin', ICON_SPRITE);
  }

  function icon(id) {
    return '<svg class="ic"><use href="#' + id + '"></use></svg>';
  }

  function isSignedIn() {
    try {
      if (window.FirebaseAuthBridge && window.FirebaseAuthBridge.getCurrentProfile && window.FirebaseAuthBridge.getCurrentProfile()) {
        return true;
      }
    } catch (e) {}
    try {
      return !!localStorage.getItem('otq:current_uid');
    } catch (e) {
      return false;
    }
  }

  function showLoginRequired() {
    if (typeof window.toast === 'function') {
      window.toast('ログインが必要です', 'ナレッジベースを見るにはログインしてください。', true);
      return;
    }
    alert('ログインが必要です');
  }

  function currentKey(sidebar) {
    if (sidebar.dataset.active) return sidebar.dataset.active;
    var name = (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
    if (name === 'index') return 'home';
    return name;
  }

  function logoClick(active) {
    if (active === 'home') return "if(typeof nav==='function'){nav('top')}else{location.href='index.html'}";
    return "location.href='index.html'";
  }

  function navItem(item, active, isIndex) {
    var classes = 'side-link' + (item.className ? ' ' + item.className : '') + (active === item.key ? ' active' : '');
    var body = icon(item.icon) + item.label;
    if (isIndex && item.indexView) {
      var id = item.indexView === 'top' ? ' id="navTop"' : ' id="navQuest"';
      return '<button class="' + classes + '"' + id + ' type="button" data-index-view="' + item.indexView + '">' + body + '</button>';
    }
    var guard = item.requiresLogin ? ' data-requires-login="true"' : '';
    return '<a class="' + classes + '" href="' + item.href + '"' + guard + '>' + body + '</a>';
  }

  function renderSidebar(sidebar) {
    var active = currentKey(sidebar);
    var isIndex = active === 'home';
    var html =
      '<div class="sidebar-header">' +
        '<div class="logo" onclick="' + logoClick(active) + '">' +
          '<img class="logo-mark" src="img/logo_shikiai.svg" alt="じさくや" />' +
          '<span>じさくや</span>' +
        '</div>' +
        '<button class="sidebar-menu-btn" id="sidebarMenuBtn" type="button" aria-label="メニュー開閉">☰</button>' +
      '</div>' +
      '<div class="sidebar-body" id="sidebarBody">' +
        '<a class="sidebar-coin" id="sidebarCoin" href="market.html" title="両: 作品の閲覧やミッション達成で獲得できます" style="display:none">' +
          icon('i-money') + ' <span id="coinVal">0</span> 両' +
        '</a>' +
        '<nav class="sidebar-nav">' + ITEMS.map(function (item) { return navItem(item, active, isIndex); }).join('') + '</nav>' +
        '<div class="sidebar-spacer"></div>' +
        '<nav class="sidebar-legal" aria-label="サイト情報">' +
          '<a href="about.html">このサイトについて</a>' +
          '<a href="terms.html">利用規約</a>' +
        '</nav>' +
        '<div class="sidebar-account"><!-- account context --></div>' +
      '</div>';
    sidebar.innerHTML = html;
    sidebar.querySelectorAll('[data-index-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (typeof window.nav === 'function') {
          window.nav(button.getAttribute('data-index-view'));
          return;
        }
        location.href = button.getAttribute('data-index-view') === 'quest' ? 'index.html#quest' : 'index.html';
      });
    });
    sidebar.querySelectorAll('[data-requires-login="true"]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (isSignedIn()) return;
        event.preventDefault();
        showLoginRequired();
      });
    });
  }

  insertIcons();
  document.querySelectorAll('.sidebar').forEach(renderSidebar);
})();
