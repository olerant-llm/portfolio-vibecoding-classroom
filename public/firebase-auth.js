import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  signInWithCustomToken,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  connectFirestoreEmulator
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const DB_PREFIX = "otq:";
const DEFAULT_FAM_TYPES = ["tora", "robo", "fairy"];
// 管理者は課金機能を検証用に使える（firestore.rules / functions の verifyAdmin と一致させる）
const ADMIN_EMAILS = [
  "admin@example.com"
];
function isAdminUser() {
  const email = (auth && auth.currentUser && auth.currentUser.email) || (currentProfile && currentProfile.email) || "";
  return ADMIN_EMAILS.includes(email);
}

const config = window.VIBECODING_FIREBASE_CONFIG || {};
const isConfigured =
  config.apiKey &&
  config.apiKey !== "YOUR_API_KEY" &&
  config.projectId &&
  config.appId &&
  config.appId !== "YOUR_APP_ID";

let app = null;
let auth = null;
let db = null;
let currentProfile = null;
let lastSyncError = null;
const listeners = new Set();
let authReadyResolved = !isConfigured;
let resolveAuthReady = null;
const authReadyPromise = new Promise((resolve) => {
  resolveAuthReady = resolve;
  if (authReadyResolved) resolve();
});

function normalizeProfile(profile = {}) {
  const organizationId = profile.organizationId ?? profile.orgId ?? profile.schoolId ?? null;
  const authType = profile.authType || (organizationId ? "school_id" : "google");
  return {
    ...profile,
    orgId: profile.orgId ?? organizationId,
    organizationId,
    schoolId: profile.schoolId ?? organizationId,
    authType,
    licenseState: profile.licenseState || (organizationId ? "paid" : "free"),
    paidUntil: profile.paidUntil ?? profile.contractEndDate ?? null,
    seatStatus: profile.seatStatus || "active"
  };
}

function parseDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value.toDate === "function") return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function isOrganizationContractActive(org) {
  if (!org || org.status !== "active") return false;
  const today = todayDateOnly();
  const start = parseDateOnly(org.contractStartDate);
  const end = parseDateOnly(org.contractEndDate);
  if (start && today < start) return false;
  if (end && today > end) return false;
  return true;
}

function localKey(key) {
  const uid = localStorage.getItem(DB_PREFIX + "current_uid");
  const isolated = ["user", "favorites", "owned_misc", "liked_works", "reacted_works", "played_works"].includes(key);
  return DB_PREFIX + (isolated ? `${key}:${uid || "guest"}` : key);
}

function saveLocalSession(profile) {
  profile = normalizeProfile(profile);
  localStorage.setItem(DB_PREFIX + "current_uid", profile.uid);
  
  let famType = profile.famType || "tora";
  if (famType === "cat") famType = "tora";
  
  let ownedFamTypes = Array.isArray(profile.ownedFamTypes) ? profile.ownedFamTypes : DEFAULT_FAM_TYPES;
  if (ownedFamTypes.includes("cat")) {
    ownedFamTypes = ownedFamTypes.filter(x => x !== "cat");
  }
  if (!ownedFamTypes.includes("tora")) {
    ownedFamTypes.push("tora");
  }

  localStorage.setItem(localKey("user"), JSON.stringify({
    uid: profile.uid,
    nickname: profile.nickname || "",
    role: profile.role || "student",
    orgId: profile.orgId ?? profile.organizationId ?? null,
    schoolId: profile.schoolId ?? null,
    organizationId: profile.organizationId ?? null,
    authType: profile.authType || "google",
    licenseState: profile.licenseState || "free",
    paidUntil: profile.paidUntil ?? null,
    seatStatus: profile.seatStatus || "active",
    municipalityId: profile.municipalityId ?? null,
    isActive: profile.isActive !== false,
    coins: Number(profile.coins || 0),
    slotsMax: Number(profile.slotsMax || 3),
    ownedImages: Array.isArray(profile.ownedImages) ? profile.ownedImages : [],
    ownedFamTypes: ownedFamTypes,
    ownedMiscItems: Array.isArray(profile.ownedMiscItems) ? profile.ownedMiscItems : [],
    famType: famType,
    unlockedAchievements: Array.isArray(profile.unlockedAchievements) ? profile.unlockedAchievements : [],
    hobbies: Array.isArray(profile.hobbies) ? profile.hobbies : [],
    bgType: profile.bgType || "color",
    bgColor: profile.bgColor || "#FDFBF7",
    bgImage: profile.bgImage || "default",
    ownedBgImages: Array.isArray(profile.ownedBgImages) ? profile.ownedBgImages : ["bg_stars.png"]
  }));
}

function clearLocalSession() {
  localStorage.removeItem(DB_PREFIX + "current_uid");
}

function emitAuthChange() {
  const detail = {
    configured: isConfigured,
    user: auth?.currentUser || null,
    profile: currentProfile
  };
  window.dispatchEvent(new CustomEvent("vibecoding-auth-change", { detail }));
  listeners.forEach((listener) => listener(detail));
}

function markAuthReady() {
  if (authReadyResolved) return;
  authReadyResolved = true;
  resolveAuthReady?.();
}

// ゲストデータを初期状態にリセットするヘルパー
function resetGuestData() {
  try {
    const seedGuest = {
      nickname: 'ゲストさん',
      bio: 'ゲストとしてお試し中！',
      avatarColor: '#8b5cf6',
      coins: 100,
      slotsMax: 2,
      famType: 'tora',
      hobbies: ['ゲスト', 'おためし'],
      ownedImages: ['ノートパソコン.png'],
      ownedFamTypes: ['tora', 'robo', 'fairy']
    };
    localStorage.setItem(DB_PREFIX + "user:guest", JSON.stringify(seedGuest));
    localStorage.setItem(DB_PREFIX + "knowledge:guest", JSON.stringify([]));
  } catch(e) {
    console.error("Failed to reset guest data", e);
  }
}

async function registerOrSyncUserSession(user, context = {}) {
  const userRef = doc(db, "users", user.uid);
  const snapshot = await getDoc(userRef);
  const organizationId = context.organizationId ?? context.orgId ?? null;
  const authType = context.authType || (organizationId ? "school_id" : "google");

  // ゲストからの実績・ワット移行処理
  let guestAchievements = [];
  let guestEarnedCoins = 0;
  let guestHasData = false;
  try {
    const guestUser = JSON.parse(localStorage.getItem(DB_PREFIX + "user:guest"));
    if (guestUser) {
      guestHasData = true;
      if (Array.isArray(guestUser.unlockedAchievements)) {
        guestAchievements = guestUser.unlockedAchievements;
      }
      guestEarnedCoins = Math.max(0, Number(guestUser.coins || 100) - 100);
    }
  } catch(e) {}

  let guestKnowledge = [];
  try {
    guestKnowledge = JSON.parse(localStorage.getItem(DB_PREFIX + "knowledge:guest")) || [];
  } catch(e) {}

  if (!snapshot.exists()) {
    let initialCoins = 100;
    if (user.uid.startsWith('google') || (user.providerData && user.providerData.some(p => p.providerId === 'google.com'))) {
      initialCoins = 300;
    } else if (user.uid.startsWith('school')) {
      initialCoins = 150;
    }
    let finalCoins = initialCoins + guestEarnedCoins;
    // セキュリティルール (coins <= 350) を突破しないよう、新規登録時の初期コインを最大 350 に制限
    if (finalCoins > 350) {
      finalCoins = 350;
    }

    const profile = {
      uid: user.uid,
      email: user.email || "",
      // プライバシー保護: Googleの表示名(本名の可能性)は使わない。初回に本人がニックネームを決める。
      nickname: context.nickname || "名前未設定",
      role: "student",
      schoolId: organizationId,
      organizationId,
      authType,
      licenseState: organizationId ? "paid" : "free",
      paidUntil: null,
      seatStatus: "active",
      municipalityId: null,
      isActive: true,
      coins: finalCoins,
      slotsMax: 2,
      ownedImages: [],
      ownedFamTypes: DEFAULT_FAM_TYPES,
      ownedMiscItems: [],
      famType: "tora",
      unlockedAchievements: guestAchievements,
      hobbies: [],
      bgType: "color",
      bgColor: "#FDFBF7",
      bgImage: "default",
      ownedBgImages: ["bg_stars.png"],
      guestDataMerged: true,
      learnedTermKeys: guestKnowledge.map(k => k.key),
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp()
    };
    await setDoc(userRef, profile);
    
    if (guestHasData) {
      try {
        const userKnowledgeKey = DB_PREFIX + `knowledge:${user.uid}`;
        localStorage.setItem(userKnowledgeKey, JSON.stringify(guestKnowledge));
      } catch(e) {}
      resetGuestData();
    }
    
    return normalizeProfile(profile);
  }

  const data = snapshot.data();
  const existingUnlocks = Array.isArray(data?.unlockedAchievements) ? data.unlockedAchievements : [];
  const mergedUnlocks = [...new Set([...existingUnlocks, ...guestAchievements])];
  
  let newCoins = Number(data?.coins || 0);
  let guestDataMerged = data?.guestDataMerged || false;

  // Restore/Merge knowledge from Firestore to localStorage
  try {
    const userKnowledgeKey = DB_PREFIX + `knowledge:${user.uid}`;
    let userKnowledge = [];
    try {
      userKnowledge = JSON.parse(localStorage.getItem(userKnowledgeKey)) || [];
    } catch(e) {}

    const firestoreKeys = Array.isArray(data?.learnedTermKeys) ? data.learnedTermKeys : [];
    let updatedKnowledge = [...userKnowledge];
    
    // Add any missing firestore keys to local
    firestoreKeys.forEach(key => {
      if (!updatedKnowledge.some(uk => uk.key === key)) {
        updatedKnowledge.push({ key, label: key, date: new Date().toISOString() });
      }
    });

    // If merging guest data
    if (!guestDataMerged && guestHasData) {
      guestKnowledge.forEach(gk => {
        if (!updatedKnowledge.some(uk => uk.key === gk.key)) {
          updatedKnowledge.push(gk);
        }
      });
    }

    localStorage.setItem(userKnowledgeKey, JSON.stringify(updatedKnowledge));
    
    // update Firestore learnedTermKeys with the merged result
    data.learnedTermKeys = updatedKnowledge.map(uk => uk.key);
  } catch(e) {
    console.error("Failed to restore/merge learned terms", e);
  }

  if (!guestDataMerged && guestHasData) {
    newCoins += guestEarnedCoins;
    guestDataMerged = true;
    resetGuestData();
  }

  const updateFields = { 
    lastLoginAt: serverTimestamp(),
    learnedTermKeys: data.learnedTermKeys || []
  };
  
  if (guestDataMerged !== (data?.guestDataMerged || false)) {
    updateFields.guestDataMerged = guestDataMerged;
  }

  // 注意：coins, unlockedAchievements, slotsMax, organizationId 等の重要フィールドは、
  // セキュリティルール (firestore.rules) によりクライアントからの直接更新が禁止されています。
  // そのため、ここでは updateFields に追加せず、直接の updateDoc から排除します。
  // 実績の解除やコインの追加は、ログイン後に AchievementBridge.unlockAchievement などの
  // バックエンド API 経由で安全に同期されます。

  await updateDoc(userRef, updateFields);

  return normalizeProfile({ 
    uid: user.uid, 
    ...data, 
    ...updateFields,
    unlockedAchievements: mergedUnlocks, 
    coins: newCoins, 
    guestDataMerged: guestDataMerged,
    slotsMax: data?.slotsMax ?? 2 
  });
}

async function loginWithGoogle() {
  if (!isConfigured) {
    throw new Error("Firebase config is not set. Edit v_coding/firebase-config.js first.");
  }
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  try {
    currentProfile = await registerOrSyncUserSession(result.user, { authType: "google" });
    lastSyncError = null;
  } catch (error) {
    lastSyncError = error;
    console.error("Firebase user registration failed after sign-in:", error);
    currentProfile = {
      uid: result.user.uid,
      email: result.user.email || "",
      nickname: "名前未設定", // Googleの表示名(本名の可能性)は使わない
      role: "student",
      schoolId: null,
      municipalityId: null,
      isActive: true,
      coins: 0,
      slotsMax: 2,
      ownedImages: [],
      ownedFamTypes: DEFAULT_FAM_TYPES,
      ownedMiscItems: [],
      hobbies: []
    };
  }
  saveLocalSession(currentProfile);
  emitAuthChange();
  return result.user;
}

async function loginWithIdAndPassword(loginId, orgId, password) {
  if (!isConfigured) {
    throw new Error("Firebase config is not set. Edit v_coding/firebase-config.js first.");
  }

  const response = await fetch("/api/loginWithPassword", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, orgId, password })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || "ログインに失敗しました。");
  }

  const result = await signInWithCustomToken(auth, data.customToken);
  
  try {
    currentProfile = await registerOrSyncUserSession(result.user, {
      authType: "school_id",
      organizationId: data.organizationId || data.orgId || orgId,
      nickname: data.nickname || loginId
    });
    lastSyncError = null;
  } catch (error) {
    lastSyncError = error;
    console.error("Firebase user registration failed after Custom Token sign-in:", error);
    currentProfile = normalizeProfile({
      uid: result.user.uid,
      email: "",
      nickname: data?.nickname || loginId,
      role: "student",
      schoolId: orgId,
      organizationId: orgId,
      authType: "school_id",
      licenseState: "paid",
      paidUntil: data?.paidUntil ?? null,
      seatStatus: data?.seatStatus || "active",
      municipalityId: null,
      isActive: true,
      coins: 150,
      slotsMax: 2,
      ownedImages: [],
      ownedFamTypes: DEFAULT_FAM_TYPES,
      ownedMiscItems: [],
      famType: "tora",
      unlockedAchievements: [],
      hobbies: [],
      bgType: "color",
      bgColor: "#FDFBF7",
      bgImage: "default",
      ownedBgImages: ["bg_stars.png"]
    });
  }
  saveLocalSession(currentProfile);
  emitAuthChange();
  return result.user;
}

async function loginWithCode(loginCode) {
  if (!isConfigured) {
    throw new Error("Firebase config is not set. Edit v_coding/firebase-config.js first.");
  }

  const response = await fetch("/api/loginWithPassword", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginCode })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || "ログインに失敗しました。");
  }

  const result = await signInWithCustomToken(auth, data.customToken);
  
  try {
    currentProfile = await registerOrSyncUserSession(result.user, {
      authType: "school_id",
      organizationId: data.organizationId || data.orgId,
      nickname: data.nickname
    });
    lastSyncError = null;
  } catch (error) {
    lastSyncError = error;
    console.error("Firebase user registration failed after Custom Token sign-in:", error);
    currentProfile = normalizeProfile({
      uid: result.user.uid,
      email: "",
      nickname: data?.nickname || "生徒",
      role: "student",
      schoolId: data.orgId,
      organizationId: data.orgId,
      authType: "school_id",
      licenseState: "paid",
      paidUntil: data?.paidUntil ?? null,
      seatStatus: data?.seatStatus || "active",
      municipalityId: null,
      isActive: true,
      coins: 150,
      slotsMax: 2,
      ownedImages: [],
      ownedFamTypes: DEFAULT_FAM_TYPES,
      ownedMiscItems: [],
      famType: "tora",
      unlockedAchievements: [],
      hobbies: [],
      bgType: "color",
      bgColor: "#FDFBF7",
      bgImage: "default",
      ownedBgImages: ["bg_stars.png"]
    });
  }
  saveLocalSession(currentProfile);
  emitAuthChange();
  return result.user;
}

async function loginClassroomManager(orgId, password) {
  if (!isConfigured) {
    throw new Error("Firebase config is not set.");
  }

  const response = await fetch("/api/admin/loginClassroomManager", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId, password })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || "管理者ログインに失敗しました。");
  }

  const result = await signInWithCustomToken(auth, data.customToken);
  
  currentProfile = {
    uid: result.user.uid,
    role: "classroom_manager",
    orgId: orgId,
    organizationId: orgId,
    nickname: "教室管理者"
  };
  saveLocalSession(currentProfile);
  emitAuthChange();
  return result.user;
}

async function buildClassroomManagerProfile(user, claims = {}) {
  const orgId = claims.orgId || currentProfile?.orgId || currentProfile?.organizationId || "";
  let orgName = currentProfile?.orgName || "";
  if (orgId && db) {
    try {
      const orgDoc = await getDoc(doc(db, "organizations", orgId));
      if (orgDoc.exists()) {
        orgName = orgDoc.data().orgName || orgName;
      }
    } catch (error) {
      console.warn("Failed to load classroom manager organization:", error);
    }
  }
  return {
    uid: user.uid,
    role: "classroom_manager",
    orgId,
    organizationId: orgId,
    nickname: "教室管理者",
    orgName,
    authType: "classroom_manager",
    licenseState: "paid",
    seatStatus: "active"
  };
}

async function logout() {
  if (!isConfigured) return;
  await signOut(auth);
}

async function updateNickname(nickname) {
  const clean = String(nickname || "").trim().slice(0, 50);
  if (!clean || !auth?.currentUser) return;
  await updateDoc(doc(db, "users", auth.currentUser.uid), { nickname: clean });
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
  listener({ configured: isConfigured, user: auth?.currentUser || null, profile: currentProfile });
  return () => listeners.delete(listener);
}

if (isConfigured) {
  app = initializeApp(config);
  auth = getAuth(app);

  const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const dbId = isLocal ? null : config.firestoreDatabaseId;
  db = dbId ? getFirestore(app, dbId) : getFirestore(app);

  if (isLocal) {
    console.log("Connecting to Firebase Emulators...");
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentProfile = null;
      clearLocalSession();
      markAuthReady();
      emitAuthChange();
      return;
    }

    try {
      const tokenResult = await user.getIdTokenResult();
      if (tokenResult.claims?.role === "classroom_manager") {
        currentProfile = await buildClassroomManagerProfile(user, tokenResult.claims);
      } else {
        currentProfile = await registerOrSyncUserSession(user);
      }
      lastSyncError = null;
      saveLocalSession(currentProfile);
    } catch (error) {
      lastSyncError = error;
      console.error("Firebase user registration failed:", error);
    }
    markAuthReady();
    emitAuthChange();
  });
} else {
  console.warn("Firebase auth is disabled until v_coding/firebase-config.js is configured.");
}

async function getFirestoreDocs(collectionName) {
  if (!isConfigured || !db) return [];
  try {
    const querySnapshot = await getDocs(collection(db, collectionName));
    const docs = [];
    querySnapshot.forEach(d => {
      docs.push({ id: d.id, ...d.data() });
    });
    return docs;
  } catch (error) {
    console.error(`getFirestoreDocs failed for ${collectionName}:`, error);
    return [];
  }
}

async function getFirestoreDoc(collectionName, docId) {
  if (!isConfigured || !db || !docId) return null;
  try {
    const snapshot = await getDoc(doc(db, collectionName, docId));
    if (!snapshot.exists()) return null;
    return { id: snapshot.id, ...snapshot.data() };
  } catch (error) {
    console.error(`getFirestoreDoc failed for ${collectionName}/${docId}:`, error);
    return null;
  }
}

async function getPublicWorks(maxCount = 50) {
  console.log('[getPublicWorks] called. isConfigured:', isConfigured, 'db:', !!db);
  if (!isConfigured || !db) return [];
  try {
    // 複合インデックスが未作成の場合でもエラーを回避できるよう、等価クエリのみを発行し、
    // 並び替えはクライアント側で行います。
    const q = query(
      collection(db, 'works'),
      where('visibility', '==', 'public'),
      limit(maxCount)
    );
    console.log('[getPublicWorks] executing query...');
    const snap = await getDocs(q);
    console.log('[getPublicWorks] query returned', snap.size, 'docs');
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.deleted === true) return; // 論理削除された作品は除外
      if (data.blocked === true) return; // 管理者が公開停止した作品は除外
      docs.push({ id: d.id, ...data });
    });
    console.log('[getPublicWorks] after filter:', docs.length, 'docs');
    // 作成日時の降順（最新順）にソート
    docs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return docs;
  } catch (e) {
    console.error('[getPublicWorks] FAILED:', e.code, e.message, e);
    return [];
  }
}

async function getAuthorPublicWorks(authorUid, maxCount = 50) {
  if (!isConfigured || !db || !authorUid) return [];
  try {
    const q = query(
      collection(db, 'works'),
      where('authorUid', '==', authorUid),
      where('visibility', '==', 'public'),
      orderBy('createdAt', 'desc'),
      limit(maxCount)
    );
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.deleted === true) return;
      if (data.blocked === true) return;
      docs.push({ id: d.id, ...data });
    });
    return docs;
  } catch (e) {
    console.error('getAuthorPublicWorks failed', e);
    return [];
  }
}

async function getMyWorks(uid) {
  if (!isConfigured || !db || !uid) return [];
  try {
    const response = await authFetch('/api/myWorks');
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok && Array.isArray(data.works)) {
      return data.works;
    }
    console.warn('getMyWorks API fallback:', data?.message || response.statusText);
  } catch (e) {
    console.warn('getMyWorks API failed, falling back to Firestore query:', e);
  }

  try {
    const q = query(collection(db, 'works'), where('authorUid', '==', uid));
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.deleted === true) return; // 論理削除された作品は除外
      docs.push({ id: d.id, ...data });
    });
    return docs;
  } catch (e) {
    console.error('getMyWorks failed', e);
    return [];
  }
}

async function getClassroomWorks(orgId, maxCount = 100) {
  if (!isConfigured || !db || !orgId) return [];
  try {
    const q = query(
      collection(db, 'works'),
      where('orgId', '==', orgId),
      orderBy('createdAt', 'desc'),
      limit(maxCount)
    );
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.deleted === true) return;
      docs.push({ id: d.id, ...data });
    });
    return docs;
  } catch (e) {
    console.error('getClassroomWorks failed', e);
    return [];
  }
}

async function getClassroomStudents(orgId) {
  if (!isConfigured || !db || !orgId) return [];
  try {
    const q = query(
      collection(db, 'users'),
      where('orgId', '==', orgId),
      limit(100)
    );
    const snap = await getDocs(q);
    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.role === 'student') {
        docs.push({ id: d.id, ...data });
      }
    });
    return docs;
  } catch (e) {
    console.error('getClassroomStudents failed', e);
    return [];
  }
}

async function setFirestoreDoc(collectionName, docId, data) {
  if (!isConfigured || !db) return;
  await setDoc(doc(db, collectionName, docId), data, { merge: true });
}

// 既存ドキュメントのみ更新（存在しない場合は何もしない）。作品の削除・公開範囲変更に使用。
async function updateFirestoreDoc(collectionName, docId, data) {
  if (!isConfigured || !db || !docId) return false;
  try {
    await updateDoc(doc(db, collectionName, docId), data);
    return true;
  } catch (e) {
    // ローカルのみのデモ作品（Firestore未登録）は更新対象が無いので無視
    console.warn(`updateFirestoreDoc skipped for ${collectionName}/${docId}:`, e?.message || e);
    return false;
  }
}

async function hasClassroomTicket() {
  // 管理者は検証用に課金機能を使える
  if (isAdminUser()) return true;

  const profile = normalizeProfile(currentProfile || {});
  if (!profile.uid) {
    try {
      const uid = localStorage.getItem(DB_PREFIX + "current_uid");
      const raw = uid ? localStorage.getItem(DB_PREFIX + `user:${uid}`) : null;
      if (raw) Object.assign(profile, normalizeProfile(JSON.parse(raw)));
    } catch(e) {}
  }

  const organizationId = profile.organizationId || profile.orgId || profile.schoolId;
  if (!organizationId || profile.seatStatus === "inactive") return false;

  if (!isConfigured || !db) {
    return profile.licenseState === "paid";
  }

  const org = await getFirestoreDoc("organizations", organizationId);
  return isOrganizationContractActive(org);
}

async function requireClassroomTicket() {
  const ok = await hasClassroomTicket();
  return {
    ok,
    message: ok ? "" : "この機能をつかうには教室チケットが必要です"
  };
}

window.FirebaseAuthBridge = {
  isConfigured,
  loginWithGoogle,
  loginWithIdAndPassword,
  loginWithCode,
  loginClassroomManager,
  logout,
  updateNickname,
  getIdTokenForApi,
  authFetch,
  onChange,
  getLastSyncError: () => lastSyncError,
  getCurrentProfile: () => currentProfile,
  getCurrentAuthUid: () => auth?.currentUser?.uid || currentProfile?.uid || null,
  waitForAuthReady: () => authReadyPromise,
  getFirestoreDocs,
  getFirestoreDoc,
  setFirestoreDoc,
  updateFirestoreDoc,
  getPublicWorks,
  getAuthorPublicWorks,
  getMyWorks,
  getClassroomWorks,
  getClassroomStudents,
  hasClassroomTicket,
  requireClassroomTicket,
  db
};

/* ================= 実績解除（アチーブメント）システム ================= */
const ACHIEVEMENTS = [
  { id: 'first_work', title: 'はじめての作品', desc: '作品を1回完成させた！', emoji: '🎨' },
  { id: 'first_like', title: 'はじめてのいいね', desc: '作品に「いいね」をした！', emoji: '❤️' },
  { id: 'first_buy', title: 'はじめてのかいもの', desc: 'ショップでアイテムを購入した！', emoji: '🛍️' },
  { id: 'first_quest', title: 'はじめての依頼クリア', desc: 'AI先生の依頼審査に合格した！', emoji: '📮' },
  { id: 'first_login', title: 'はじめてのログイン', desc: 'アカウントを作成してログインした！', emoji: '🔑' }
];

// 多重ロック用のメモリ上のキャッシュ
const unlockingCache = new Set();

async function unlockAchievement(id) {
  const ach = ACHIEVEMENTS.find(a => a.id === id);
  if (!ach) return;

  const uid = localStorage.getItem(DB_PREFIX + "current_uid");
  const userKey = localKey("user");
  let userObj = {};
  try {
    userObj = JSON.parse(localStorage.getItem(userKey)) || {};
  } catch(e) {}

  if (!userObj.unlockedAchievements) {
    userObj.unlockedAchievements = [];
  }

  // すでに解除済み、または現在解除中の場合は処理を弾く（楽観的ロック）
  if (userObj.unlockedAchievements.includes(id) || unlockingCache.has(id)) {
    return;
  }

  // ロックを掛ける
  unlockingCache.add(id);

  // 実績解除リストに追加
  userObj.unlockedAchievements.push(id);
  
  // 解除報酬 (一律 +10 ワット、ただしログイン実績は特別に+50)
  const reward = id === 'first_login' ? 50 : 10;
  userObj.coins = Number(userObj.coins || 0) + reward;
  
  // ローカルに即座に反映して保存
  localStorage.setItem(userKey, JSON.stringify(userObj));

  // Firestore同期 - Cloud Functions経由（coins/unlockedAchievementsはrulesでクライアント直接更新不可）
  if (isConfigured && auth?.currentUser) {
    try {
      const resp = await authFetch('/api/unlockAchievement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ achievementId: id })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok) {
          userObj.coins = data.coins;
          userObj.unlockedAchievements = data.unlockedAchievements;
          localStorage.setItem(userKey, JSON.stringify(userObj));
          if (currentProfile) {
            currentProfile.unlockedAchievements = data.unlockedAchievements;
            currentProfile.coins = data.coins;
          }
        }
      }
    } catch (error) {
      console.error("Failed to sync achievement or coins to Firestore", error);
    }
  }

  // 画面表示更新用のグローバルイベントを発火（マイページのワット表示などの連動）
  window.dispatchEvent(new CustomEvent("vibecoding-achievement-unlocked", { detail: { achievement: ach, coins: userObj.coins } }));

  // ポップアップモーダルを表示
  showAchievementModal(ach);
  
  // ロック解除
  unlockingCache.delete(id);
}

function getUnlockedAchievements() {
  const userKey = localKey("user");
  try {
    const userObj = JSON.parse(localStorage.getItem(userKey)) || {};
    return Array.isArray(userObj.unlockedAchievements) ? userObj.unlockedAchievements : [];
  } catch(e) {
    return [];
  }
}

function showAchievementModal(achievement) {
  // 既存のモーダルがあれば削除
  const existing = document.getElementById('achievement-modal');
  if (existing) existing.remove();

  // モーダルHTML
  const html = `
    <div id="achievement-modal" style="position:fixed; inset:0; background:rgba(27,27,58,0.5); display:grid; place-items:center; padding:20px; z-index:99999; backdrop-filter:blur(3px);">
      <div style="width:min(440px,100%); background:#FFF; border:2.5px solid #1B1B3A; border-radius:24px; box-shadow:8px 8px 0px #1B1B3A; padding:26px; text-align:center; animation:ach-rise 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
        <h2 style="font-family:'Mochiy Pop One', sans-serif; font-size:22px; color:#AEEA00; margin:0 0 10px;">🏆 実績解除！</h2>
        <p style="font-size:14px; font-weight:800; color:#5B5B7A; margin:0 0 20px;">おめでとう！新しいメダルを獲得したよ！</p>
        
        <!-- メダル（バッジ）演出 -->
        <div style="width:120px; height:120px; border-radius:50%; border:2.5px solid #1B1B3A; background:#FFD23D; box-shadow:4px 4px 0px #1B1B3A; display:grid; place-items:center; margin:0 auto 20px; position:relative; animation:ach-bounce 0.6s ease-in-out infinite alternate;">
          <span style="font-size:64px; filter:drop-shadow(3px 3px 0px rgba(0,0,0,0.15));">${achievement.emoji}</span>
        </div>
        
        <div style="font-family:'Mochiy Pop One', sans-serif; font-size:18px; font-weight:800; color:#1B1B3A; margin-bottom:8px;">${achievement.title}</div>
        <p style="font-size:13.5px; font-weight:700; color:#1B1B3A; background:#E0F2FE; border:2.5px solid #1B1B3A; border-radius:12px; padding:10px 14px; margin:0 0 16px; box-shadow:2px 2px 0px #1B1B3A;">${achievement.desc}</p>
        
        <div style="font-size:16px; font-weight:800; color:#B45309; margin-bottom:22px; display:flex; align-items:center; justify-content:center; gap:6px;">
          <span>報酬：</span>
          <span style="background:#FFD23D; border:2px solid #1B1B3A; border-radius:999px; padding:4px 14px; box-shadow:2px 2px 0px #1B1B3A;">🔋 +10 W を獲得！</span>
        </div>
        
        <button id="ach-close-btn" style="width:100%; font-family:inherit; cursor:pointer; background:#2FE0A8; border:2.5px solid #1B1B3A; border-radius:14px; padding:12px 22px; font-weight:800; font-size:15px; box-shadow:4px 4px 0px #1B1B3A; transition:transform 0.1s, box-shadow 0.1s;">やった！</button>
      </div>
      <style>
        @keyframes ach-rise {
          from { transform: scale(0.8) translateY(30px); opacity:0; }
          to { transform: scale(1) translateY(0); opacity:1; }
        }
        @keyframes ach-bounce {
          from { transform: translateY(0); }
          to { transform: translateY(-8px); }
        }
        #ach-close-btn:hover {
          transform: translate(1px, 1px);
          box-shadow: 3px 3px 0 #1B1B3A;
        }
        #ach-close-btn:active {
          transform: translate(4px, 4px);
          box-shadow: 0px 0px 0 #1B1B3A;
        }
      </style>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  
  triggerConfettiGlobal();
  
  document.getElementById('ach-close-btn').onclick = () => {
    document.getElementById('achievement-modal').remove();
    // イベントを発行して、ワット表示を各ページのUIで再描画させる
    window.dispatchEvent(new CustomEvent("vibecoding-achievement-modal-closed"));
  };
}

function triggerConfettiGlobal() {
  const colors = ['#3CC9F7', '#C4B5FD', '#AEEA00', '#2FE0A8', '#FFD23D', '#FB923C'];
  const count = 60;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'global-confetti-piece';
    el.style.position = 'fixed';
    el.style.width = '10px';
    el.style.height = '10px';
    el.style.zIndex = '999999';
    el.style.pointerEvents = 'none';
    el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.top = -Math.random() * 20 - 10 + 'px';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    
    const size = Math.random() * 8 + 6;
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    
    const duration = Math.random() * 2 + 2;
    const delay = Math.random() * 1.5;
    
    if (!document.getElementById('global-confetti-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'global-confetti-style';
      styleEl.textContent = `
        .global-confetti-piece {
          animation: global-confetti-fall linear forwards;
        }
        @keyframes global-confetti-fall {
          0% { transform: translateY(-50px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(360deg); opacity: 0.2; }
        }
      `;
      document.head.appendChild(styleEl);
    }
    
    el.style.animationDuration = `${duration}s`;
    el.style.animationDelay = `${delay}s`;
    
    document.body.appendChild(el);
    
    setTimeout(() => {
      el.remove();
    }, (duration + delay) * 1000);
  }
}

window.AchievementBridge = {
  ACHIEVEMENTS,
  unlockAchievement,
  getUnlockedAchievements
};
