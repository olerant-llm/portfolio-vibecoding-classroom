(function(){
  var KEY = 'shikiai.sidebarCollapsed';
  var sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  try {
    if (localStorage.getItem(KEY) === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (e) {}

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sidebar-toggle';
  btn.setAttribute('aria-controls', 'sidebar-nav');

  var logo = sidebar.querySelector('.logo');
  var nav = sidebar.querySelector('.sidebar-nav');
  if (nav && !nav.id) nav.id = 'sidebar-nav';

  function render(){
    var collapsed = document.body.classList.contains('sidebar-collapsed');
    var expandedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1"></rect><path d="M9 4v16"></path><path d="M15 10l-3 2 3 2"></path></svg>';
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('title', collapsed ? 'メニューを開く' : 'メニューを畳む');
    btn.setAttribute('aria-label', collapsed ? 'メニューを開く' : 'メニューを畳む');
    btn.innerHTML = '<span class="toggle-icon">' + (collapsed ? '&gt;' : expandedIcon) + '</span><span class="toggle-label">' + (collapsed ? '開く' : '畳む') + '</span>';
  }

  btn.addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    var collapsed = document.body.classList.toggle('sidebar-collapsed');
    try {
      localStorage.setItem(KEY, collapsed ? '1' : '0');
    } catch (e) {}
    render();
  });

  if (logo) {
    logo.appendChild(btn);
  } else {
    sidebar.insertBefore(btn, sidebar.firstElementChild);
  }
  render();

  // スマホ用ハンバーガーメニュー開閉
  var menuBtn = document.querySelector('.sidebar-menu-btn');
  var sidebarBody = document.querySelector('.sidebar-body');
  if (menuBtn && sidebarBody) {
    menuBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var isOpen = sidebarBody.classList.toggle('open');
      menuBtn.textContent = isOpen ? '✕' : '☰';
    });
  }
})();

(function(){
  var DB_PREFIX = 'otq:';
  var accounts = Array.prototype.slice.call(document.querySelectorAll('.sidebar-account'));
  if (!accounts.length) return;

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function currentUid() {
    try {
      return localStorage.getItem(DB_PREFIX + 'current_uid') || null;
    } catch (e) {
      return null;
    }
  }

  function currentProfile() {
    var bridgeProfile = null;
    try {
      bridgeProfile = window.FirebaseAuthBridge && window.FirebaseAuthBridge.getCurrentProfile
        ? window.FirebaseAuthBridge.getCurrentProfile()
        : null;
    } catch (e) {}
    if (bridgeProfile && bridgeProfile.uid) return bridgeProfile;

    var uid = currentUid();
    if (!uid) return null;
    return readJson(DB_PREFIX + 'user:' + uid, { uid: uid, nickname: uid });
  }

  function roleLabel(profile) {
    if (!profile) return '';
    if (profile.role === 'classroom_manager') return '教室管理者';
    if (profile.authType === 'school_id' || profile.organizationId || profile.orgId) return '教室アカウント';
    return 'Googleアカウント';
  }

  function displayName(profile) {
    if (!profile) return '未ログイン';
    return profile.nickname || profile.displayName || profile.email || profile.uid || 'ログイン中';
  }

  function coins(profile) {
    return Number(profile && profile.coins ? profile.coins : 0);
  }

  function openLogin() {
    if (typeof window.loginFromHeader === 'function') {
      window.loginFromHeader();
      return;
    }
    var modal = document.getElementById('loginModal');
    if (modal) {
      modal.classList.add('open');
      return;
    }
    if (typeof window.dummyLogin === 'function') {
      window.dummyLogin('google');
      return;
    }
    window.location.href = 'corder.html';
  }

  function logout() {
    if (typeof window.logoutFromHeader === 'function') {
      window.logoutFromHeader();
      return;
    }
    if (window.FirebaseAuthBridge && window.FirebaseAuthBridge.isConfigured) {
      window.FirebaseAuthBridge.logout().catch(function(error){
        console.error('Logout failed:', error);
      });
      return;
    }
    try {
      localStorage.removeItem(DB_PREFIX + 'current_uid');
    } catch (e) {}
    window.location.reload();
  }

  function renderShell(account) {
    account.classList.add('sidebar-account-unified');
    account.innerHTML =
      '<div class="vc-account-label">ACCOUNT</div>' +
      '<button class="btn-login vc-login-btn" type="button">ログイン</button>' +
      '<div class="user-menu vc-user-menu" hidden>' +
        '<button class="user-btn vc-user-btn" type="button">' +
          '<span class="uavatar">👤</span>' +
          '<span class="vc-account-name">未ログイン</span>' +
          '<span class="caret">▾</span>' +
        '</button>' +
        '<div class="user-drop vc-user-drop">' +
          '<div class="ud-head"><span class="vc-account-role">ログイン中</span><b class="vc-account-name-full">未ログイン</b></div>' +
          '<a class="ud-item" href="userpage.html">👤 マイページ</a>' +
          '<a class="ud-item" href="market.html">🪙 マーケット <span class="vc-account-coins"></span></a>' +
          '<a class="ud-item" href="user_admin.html">🏫 教室での利用</a>' +
          '<button class="ud-item vc-logout-btn" type="button">🚪 ログアウト</button>' +
        '</div>' +
      '</div>';

    account.querySelector('.vc-login-btn').addEventListener('click', function(e){
      e.preventDefault();
      openLogin();
    });
    account.querySelector('.vc-user-btn').addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      account.querySelector('.vc-user-drop').classList.toggle('open');
    });
    account.querySelector('.vc-logout-btn').addEventListener('click', function(e){
      e.preventDefault();
      logout();
    });
  }

  function updateAccount(account) {
    var profile = currentProfile();
    var signedIn = !!profile;
    var loginBtn = account.querySelector('.vc-login-btn');
    var userMenu = account.querySelector('.vc-user-menu');
    var name = displayName(profile);
    if (loginBtn) loginBtn.hidden = signedIn;
    if (userMenu) userMenu.hidden = !signedIn;
    account.querySelectorAll('.vc-account-name').forEach(function(el){ el.textContent = name; });
    account.querySelectorAll('.vc-account-name-full').forEach(function(el){ el.textContent = name; });
    var role = account.querySelector('.vc-account-role');
    if (role) role.textContent = roleLabel(profile);
    var coin = account.querySelector('.vc-account-coins');
    if (coin) coin.textContent = signedIn ? '(' + coins(profile) + '両)' : '';
  }

  function updateAll() {
    accounts.forEach(updateAccount);
    
    // 所持コイン表示（#sidebarCoin）の自動制御
    var profile = currentProfile();
    var signedIn = !!profile;
    var sidebarCoin = document.getElementById('sidebarCoin');
    var coinVal = document.getElementById('coinVal');
    if (sidebarCoin) {
      if (signedIn) {
        sidebarCoin.style.display = 'flex';
        if (coinVal) {
          var val = coins(profile);
          coinVal.textContent = typeof window.num === 'function' ? window.num(val) : val.toLocaleString();
        }
      } else {
        sidebarCoin.style.display = 'none';
      }
    }
  }

  accounts.forEach(function(account){
    renderShell(account);
  });
  updateAll();

  document.addEventListener('click', function(e){
    accounts.forEach(function(account){
      if (!account.contains(e.target)) {
        var drop = account.querySelector('.vc-user-drop');
        if (drop) drop.classList.remove('open');
      }
    });
  });
  window.addEventListener('vibecoding-auth-change', updateAll);
  window.addEventListener('vibecoding-achievement-unlocked', updateAll);
  window.addEventListener('storage', updateAll);
  setTimeout(updateAll, 300);
})();
