(function () {
  const DB_PREFIX = "otq:";
  const DEFAULT_FAM_TYPES = ["cat", "robo", "fairy"];
  const config = window.VIBECODING_FIREBASE_CONFIG || {};
  const isConfigured =
    config.apiKey &&
    config.apiKey !== "YOUR_API_KEY" &&
    config.projectId &&
    config.appId &&
    config.appId !== "YOUR_APP_ID" &&
    window.firebase;

  let auth = null;
  let db = null;
  let currentProfile = null;
  let lastSyncError = null;
  const listeners = new Set();

  function localKey(key) {
    const uid = localStorage.getItem(DB_PREFIX + "current_uid");
    const isolated = ["user", "favorites", "owned_misc", "liked_works", "reacted_works", "played_works"].includes(key);
    return DB_PREFIX + (isolated ? `${key}:${uid || "guest"}` : key);
  }

  function saveLocalSession(profile) {
    localStorage.setItem(DB_PREFIX + "current_uid", profile.uid);
    localStorage.setItem(localKey("user"), JSON.stringify({
      uid: profile.uid,
      nickname: profile.nickname || "",
      role: profile.role || "student",
      schoolId: profile.schoolId ?? null,
      municipalityId: profile.municipalityId ?? null,
      isActive: profile.isActive !== false,
      coins: Number(profile.coins || 0),
      slotsMax: Number(profile.slotsMax || 3),
      ownedImages: Array.isArray(profile.ownedImages) ? profile.ownedImages : [],
      ownedFamTypes: Array.isArray(profile.ownedFamTypes) ? profile.ownedFamTypes : DEFAULT_FAM_TYPES
    }));
  }

  function clearLocalSession() {
    localStorage.removeItem(DB_PREFIX + "current_uid");
  }

  function emitAuthChange() {
    const detail = {
      configured: Boolean(isConfigured),
      user: auth?.currentUser || null,
      profile: currentProfile
    };
    window.dispatchEvent(new CustomEvent("vibecoding-auth-change", { detail }));
    listeners.forEach((listener) => listener(detail));
  }

  async function registerOrSyncUserSession(user) {
    const userRef = db.collection("users").doc(user.uid);
    const snapshot = await userRef.get();

    if (!snapshot.exists) {
      const profile = {
        uid: user.uid,
        email: user.email || "",
        nickname: user.displayName || "",
        role: "student",
        schoolId: null,
        municipalityId: null,
        isActive: true,
        coins: 0,
        slotsMax: 3,
        ownedImages: [],
        ownedFamTypes: DEFAULT_FAM_TYPES,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await userRef.set(profile);
      return { ...profile };
    }

    await userRef.update({ lastLoginAt: firebase.firestore.FieldValue.serverTimestamp() });
    return { uid: user.uid, ...snapshot.data() };
  }

  async function loginWithGoogle() {
    if (!isConfigured) {
      throw new Error("Firebase Auth is not ready. Check firebase-config.js and Firebase SDK script loading.");
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    try {
      currentProfile = await registerOrSyncUserSession(result.user);
      lastSyncError = null;
    } catch (error) {
      lastSyncError = error;
      console.error("Firebase user registration failed after sign-in:", error);
      currentProfile = {
        uid: result.user.uid,
        email: result.user.email || "",
        nickname: result.user.displayName || "",
        role: "student",
        schoolId: null,
        municipalityId: null,
        isActive: true,
        coins: 0,
        slotsMax: 3,
        ownedImages: [],
        ownedFamTypes: DEFAULT_FAM_TYPES
      };
    }
    saveLocalSession(currentProfile);
    emitAuthChange();
    return result.user;
  }

  async function logout() {
    if (!isConfigured) return;
    await auth.signOut();
  }

  async function updateNickname(nickname) {
    const clean = String(nickname || "").trim().slice(0, 50);
    if (!clean || !auth?.currentUser) return;
    await db.collection("users").doc(auth.currentUser.uid).update({ nickname: clean });
    currentProfile = { ...(currentProfile || {}), uid: auth.currentUser.uid, nickname: clean };
    saveLocalSession(currentProfile);
    emitAuthChange();
  }

  async function getIdTokenForApi() {
    if (!auth?.currentUser) return null;
    return auth.currentUser.getIdToken(true);
  }

  async function authFetch(url, options = {}) {
    const token = await getIdTokenForApi();
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  }

  function onChange(listener) {
    listeners.add(listener);
    listener({ configured: Boolean(isConfigured), user: auth?.currentUser || null, profile: currentProfile });
    return () => listeners.delete(listener);
  }

  if (isConfigured) {
    firebase.initializeApp(config);
    auth = firebase.auth();
    db = config.firestoreDatabaseId
      ? firebase.firestore(firebase.app(), config.firestoreDatabaseId)
      : firebase.firestore();

    auth.onAuthStateChanged(async (user) => {
      if (!user) {
        currentProfile = null;
        clearLocalSession();
        emitAuthChange();
        return;
      }

      try {
        currentProfile = await registerOrSyncUserSession(user);
        saveLocalSession(currentProfile);
      } catch (error) {
        console.error("Firebase user registration failed:", error);
      }
      emitAuthChange();
    });
  } else {
    console.warn("Firebase auth compat bridge is disabled. Config or SDK scripts are missing.");
  }

  window.FirebaseAuthBridge = {
    isConfigured: Boolean(isConfigured),
    loginWithGoogle,
    logout,
    updateNickname,
    getIdTokenForApi,
    authFetch,
    onChange,
    getLastSyncError: () => lastSyncError
  };
})();
