import { GoogleGenAI } from "@google/genai";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import Stripe from "stripe";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { buildManualTicketIssueRequest, buildTicketLifecycleRequest } from "./manual-ticket.js";

const adminApp = initializeApp();
// 新OEMプロジェクトは (default) Firestore DB を使う。
const db = getFirestore(adminApp);
const authAdmin = getAuth();

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const getAiKey = () => geminiApiKey.value() || process.env.GEMINI_API_KEY;
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const stripePriceClassroom10 = defineString("STRIPE_PRICE_CLASSROOM_10");
const stripePriceClassroom20 = defineString("STRIPE_PRICE_CLASSROOM_20");
const stripePriceClassroom40 = defineString("STRIPE_PRICE_CLASSROOM_40");

const MODELS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash"
];
const MAX_PROMPT_LENGTH = 500;
const MAX_HTML_LENGTH = 50000;
const DEFAULT_CONTRACT_DAYS = 90;

// 管理者メールアドレス定義（検証用およびデプロイ初期用）
// ※本番環境で運用する際は、管理者のGoogleアカウントのメールアドレスをこの配列に追加してください。
const ADMIN_EMAILS = [
  "admin@example.com"
];

const ACHIEVEMENT_REWARDS = {
  first_work: 10,
  first_like: 10,
  first_buy: 10,
  first_quest: 10,
  first_login: 50
};

// スロット(作品枠)の価格表: キーは購入後の枠数。クライアントの SLOT_PRICE と一致させる。
const SLOT_PRICE_TABLE = { 3: 50, 4: 100, 5: 200, 6: 300, 7: 400, 8: 500 };
const SLOT_MAX = 8;

// ショップ商品のフォールバック価格表（Firestore shop_items が未設定のとき使用）。クライアントの shopItems() 既定値と一致させる。
const SHOP_ITEMS_FALLBACK = {
  fam_dragon: 120,
  fam_rabbit: 80,
  bg_rainbow: 40,
  bg_space: 30,
  bg_ocean: 30,
  bg_forest: 30,
  bg_sunset: 30,
  bg_cherry: 30
};
const IMAGE_PRICE_FALLBACK = { icon: 5, chara: 20, bg: 20, prem: 50 };

const FORBIDDEN_PATTERNS = [
  { pattern: /\bfetch\s*\(/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /XMLHttpRequest/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /WebSocket/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /sendBeacon/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /\bimport\s*\(/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /new\s+Worker\s*\(/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /\beval\s*\(/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /new\s+Function\s*\(/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /setTimeout\s*\(\s*["'`]/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /setInterval\s*\(\s*["'`]/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /document\.write\s*\(/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /<script[^>]+src\s*=/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /<link[^>]+href\s*=/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /src\s*=\s*["']https?:/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /url\s*\(\s*["']?https?:/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /<iframe/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /<object/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /<embed/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /localStorage/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /sessionStorage/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /indexedDB/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /document\.cookie/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /location\s*\.\s*(href|replace|assign)/i, errorCode: "EXTERNAL_ACCESS" },
  { pattern: /window\.open\s*\(/i, errorCode: "DANGEROUS_PATTERN" }
];

const JS_DANGER_PATTERNS = [
  /while\s*\(\s*true\s*\)/i,
  /while\s*\(\s*1\s*\)/i,
  /for\s*\(\s*;\s*;\s*\)/i,
  /document\.body\.innerHTML\s*=\s*["'`]{2}/i,
  /document\.documentElement\.remove/i
];

const ERROR_MESSAGES = {
  UNSAFE_CODE: "このコードは安全でない可能性があるため、作り直してみよう",
  EXTERNAL_ACCESS: "外部につながるコードが含まれているよ。別の方法を試してみよう",
  DANGEROUS_PATTERN: "この書き方は危険なので、AIに別の指示をしてみよう",
  GEMINI_ERROR: "AIがうまく答えられなかったよ。もう一度試してみよう",
  TOO_LONG: "アプリが大きくなりすぎたみたい。もう少しシンプルな指示にしてみよう",
  BAD_REQUEST: "入力内容を確認して、もう一度試してみよう"
};

export const generate = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }
    const images = Array.isArray(req.body?.images) ? req.body.images : [];

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const html = await generateHtml(prompt, images, apiKey);
      const check = checkSafety(html);
      if (!check.ok) {
        res.status(422).json({
          ok: false,
          errorCode: check.errorCode,
          message: ERROR_MESSAGES[check.errorCode] || ERROR_MESSAGES.UNSAFE_CODE
        });
        return;
      }

      res.json({
        ok: true,
        html,
        generationId: crypto.randomUUID()
      });
    } catch (error) {
      console.error("generate failed", error);
      sendError(res, 500, "GEMINI_ERROR");
    }
  }
);

async function generateHtml(prompt, images, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  let lastError;

  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: buildPrompt(prompt, images),
        config: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      });

      return extractHtml(response.text || "");
    } catch (error) {
      lastError = error;
      if (![429, 503].includes(error?.status)) {
        throw error;
      }
      console.warn(`Gemini model ${model} unavailable, trying fallback`, error?.status);
    }
  }

  throw lastError;
}

function buildPrompt(prompt, images) {
  let imageInstructions = "";
  if (Array.isArray(images) && images.length > 0) {
    imageInstructions = `\n【使用可能な画像アセット】\nあなたは、以下の画像素材のみを <img src="img/ファイル名"> の形で使用できます。インターネット上の画像や、これら以外の画像パスは絶対に使用しないでください。\n` + images.map(img => `- img/${img}`).join('\n') + `\n`;
  }

  return `あなたは高校生向けの安全なWebアプリ生成AIです。
以下の制約を必ず守って、1つのHTMLファイルに完結するアプリを生成してください。

【絶対的な制約】
- 外部スクリプト、外部API、外部画像、外部フォントは禁止
- fetch, XMLHttpRequest, WebSocket, eval, new Function は禁止
- Cookie, LocalStorage, SessionStorage, IndexedDB は禁止
- iframe, object, embed は禁止
- location の変更、window.open は禁止
- while(true) などの無限ループは禁止
- setInterval の間隔は 100ms 以上にする
${imageInstructions}
【出力形式】
- <!DOCTYPE html> から始まる完全なHTML 1ファイルのみを出力
- <script> タグは1つだけ、<style> タグは1つだけ
- JavaScript は200行以内
- コードブロック記号や説明文は出力しない

【教育的配慮】
- 高校生が読んで理解できるシンプルなコードにする
- 変数名は意味のわかる名前にする
- 画像が必要な場合は絵文字・CSS・Canvas描画で代替する
- 不適切な内容は安全な代替案に置き換える

【ユーザー指示】
${prompt}`;
}

function extractHtml(raw) {
  return raw
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function checkSafety(html) {
  if (!html || html.length > MAX_HTML_LENGTH) {
    return { ok: false, errorCode: "TOO_LONG" };
  }
  if (!/^<!DOCTYPE html>/i.test(html.trim())) {
    return { ok: false, errorCode: "UNSAFE_CODE" };
  }

  const structure = checkStructure(html);
  if (!structure.ok) return structure;

  for (const { pattern, errorCode } of FORBIDDEN_PATTERNS) {
    if (pattern.test(html)) return { ok: false, errorCode };
  }

  const js = extractScript(html);
  for (const pattern of JS_DANGER_PATTERNS) {
    if (pattern.test(js)) return { ok: false, errorCode: "DANGEROUS_PATTERN" };
  }

  for (const match of js.matchAll(/setInterval\s*\([^,]+,\s*(\d+)/gi)) {
    if (Number.parseInt(match[1], 10) < 50) {
      return { ok: false, errorCode: "DANGEROUS_PATTERN" };
    }
  }

  return { ok: true };
}

function checkStructure(html) {
  const count = (re) => (html.match(re) || []).length;
  if (count(/<html[\s>]/gi) !== 1) return { ok: false, errorCode: "UNSAFE_CODE" };
  if (count(/<head[\s>]/gi) !== 1) return { ok: false, errorCode: "UNSAFE_CODE" };
  if (count(/<body[\s>]/gi) !== 1) return { ok: false, errorCode: "UNSAFE_CODE" };
  if (count(/<script[\s>]/gi) > 1) return { ok: false, errorCode: "UNSAFE_CODE" };
  if (count(/<style[\s>]/gi) > 1) return { ok: false, errorCode: "UNSAFE_CODE" };

  const script = extractScript(html);
  if (script && script.split("\n").length > 200) {
    return { ok: false, errorCode: "TOO_LONG" };
  }
  return { ok: true };
}

function extractScript(html) {
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return match ? match[1] : "";
}

function sendError(res, status, errorCode) {
  res.status(status).json({
    ok: false,
    errorCode,
    message: ERROR_MESSAGES[errorCode] || ERROR_MESSAGES.BAD_REQUEST
  });
}

async function verifySignedIn(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "ログインが必要です。" };
  }
  try {
    const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
    return { ok: true, decodedToken, uid: decodedToken.uid };
  } catch (err) {
    console.error("verifySignedIn failed", err.message);
    return { ok: false, status: 401, message: "ログイン状態を確認できませんでした。" };
  }
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value.toDate === "function") return value.toDate().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return "";
}

function workCreatedAtMs(work) {
  const raw = work?.createdAt || work?.updatedAt || "";
  if (typeof raw?.toDate === "function") return raw.toDate().getTime();
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

function isActiveContract(orgData) {
  if (!orgData || orgData.status !== "active") return false;
  const today = new Date().toISOString().slice(0, 10);
  const start = dateOnly(orgData.contractStartDate);
  const end = dateOnly(orgData.contractEndDate);
  if (start && today < start) return false;
  if (end && today > end) return false;
  return true;
}

async function verifyClassroomTicket(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "ログインが必要です。" };
  }

  try {
    const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));

    // 管理者は検証用に課金機能を使える（verifyAdmin と同じ判定）
    if (ADMIN_EMAILS.includes(decodedToken.email) || decodedToken.role === "admin") {
      return { ok: true, uid: decodedToken.uid, orgId: "admin", userData: {}, orgData: {}, isAdmin: true };
    }

    const userDoc = await db.collection("users").doc(decodedToken.uid).get();
    if (!userDoc.exists) {
      return { ok: false, status: 403, message: "ユーザー情報が見つかりません。" };
    }

    const userData = userDoc.data();
    if (userData.seatStatus === "inactive" || userData.isActive === false) {
      return { ok: false, status: 403, message: "このアカウントは利用停止中です。" };
    }

    const orgId = userData.organizationId || userData.orgId || userData.schoolId || decodedToken.orgId;
    if (!orgId) {
      return { ok: false, status: 403, message: "この機能をつかうには教室チケットが必要です" };
    }

    const orgDoc = await db.collection("organizations").doc(orgId).get();
    if (!orgDoc.exists || !isActiveContract(orgDoc.data())) {
      return { ok: false, status: 403, message: "この機能をつかうには教室チケットが必要です" };
    }

    return { ok: true, uid: decodedToken.uid, orgId, userData, orgData: orgDoc.data() };
  } catch (err) {
    console.error("verifyClassroomTicket failed", err);
    return { ok: false, status: 401, message: "ログイン状態を確認できませんでした。" };
  }
}

export const refine = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const currentCode = String(req.body?.currentCode || "").trim();
    const instruction = String(req.body?.instruction || "").trim();
    if (!currentCode || !instruction) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }
    const images = Array.isArray(req.body?.images) ? req.body.images : [];

    const selectedCode = String(req.body?.selectedCode || "");
    const promptHistory = req.body?.promptHistory || [];
    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const html = await refineHtml(currentCode, selectedCode, instruction, promptHistory, images, apiKey);
      const check = checkSafety(html);
      if (!check.ok) {
        res.status(422).json({
          ok: false,
          errorCode: check.errorCode,
          message: ERROR_MESSAGES[check.errorCode] || ERROR_MESSAGES.UNSAFE_CODE
        });
        return;
      }

      res.json({
        ok: true,
        html
      });
    } catch (error) {
      console.error("refine failed", error);
      sendError(res, 500, "GEMINI_ERROR");
    }
  }
);

export const commentSource = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const ticket = await verifyClassroomTicket(req);
    if (!ticket.ok) {
      res.status(ticket.status).json({ ok: false, message: ticket.message });
      return;
    }

    const currentCode = String(req.body?.currentCode || "").trim();
    if (!currentCode || currentCode.length > MAX_HTML_LENGTH) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const html = await commentHtml(currentCode, apiKey);
      const check = checkSafety(html);
      if (!check.ok) {
        res.status(422).json({
          ok: false,
          errorCode: check.errorCode,
          message: ERROR_MESSAGES[check.errorCode] || ERROR_MESSAGES.UNSAFE_CODE
        });
        return;
      }

      res.json({ ok: true, html });
    } catch (error) {
      console.error("commentSource failed", error);
      sendError(res, 500, "GEMINI_ERROR");
    }
  }
);

async function commentHtml(currentCode, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  let lastError;

  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: buildCommentPrompt(currentCode),
        config: {
          temperature: 0.2,
          maxOutputTokens: 8192
        }
      });

      return extractHtml(response.text || "");
    } catch (error) {
      lastError = error;
      if (![429, 503].includes(error?.status)) {
        throw error;
      }
      console.warn(`Gemini model ${model} unavailable, trying fallback`, error?.status);
    }
  }

  throw lastError;
}

function buildCommentPrompt(currentCode) {
  return `あなたは高校生向けプログラミング教材のコード解説者です。
提供されたHTMLコードに、学習用コメントを追加してください。

【既存のHTMLコード全体】
\`\`\`html
${currentCode}
\`\`\`

【絶対的な制約】
- 動作、見た目、構造、イベント処理を変えないでください
- 変数名、関数名、id、class、CSSセレクタを変更しないでください
- 新しい機能やUIを追加しないでください
- 外部スクリプト、外部API、外部画像、外部フォントは禁止
- fetch, XMLHttpRequest, WebSocket, eval, new Function は禁止
- Cookie, LocalStorage, SessionStorage, IndexedDB は禁止
- iframe, object, embed は禁止
- location の変更、window.open は禁止
- コメントは高校生が読める短い日本語にしてください
- HTMLコメント、CSSコメント、JavaScriptコメントを必要な場所にだけ追加してください
- コメントを入れすぎず、主要な処理が分かる程度にしてください

【出力形式】
- <!DOCTYPE html> から始まる完全なHTML 1ファイルのみを出力
- <script> タグは1つだけ、<style> タグは1つだけ
- JavaScript は200行以内
- コードブロック記号や説明文は出力しない`;
}

// 手動編集したコードのレビューAPI（課金者のみ）。AIは書き換えず、安全判定と内容アドバイスだけ返す。
export const reviewCode = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { sendError(res, 405, "BAD_REQUEST"); return; }

    const ticket = await verifyClassroomTicket(req);
    if (!ticket.ok) {
      res.status(ticket.status).json({ ok: false, message: ticket.message });
      return;
    }

    const currentCode = String(req.body?.currentCode || "").trim();
    if (!currentCode || currentCode.length > MAX_HTML_LENGTH) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    // 層①: 安全チェック（決定的）。危険コードや構造崩れはここで弾く。
    const safety = checkSafety(currentCode);
    if (!safety.ok) {
      res.json({
        ok: true,
        safe: false,
        errorCode: safety.errorCode,
        message: ERROR_MESSAGES[safety.errorCode] || ERROR_MESSAGES.UNSAFE_CODE
      });
      return;
    }

    // 層③: AI内容レビュー（補助）。不適切な内容や明らかな問題を日本語でアドバイス。
    const apiKey = getAiKey();
    if (!apiKey) {
      // AIレビュー不可でも安全チェックは通っているので、そのまま許可する
      res.json({ ok: true, safe: true, appropriate: true, advice: "" });
      return;
    }

    try {
      const review = await reviewCodeWithGemini(currentCode, apiKey);
      res.json({ ok: true, safe: true, appropriate: review.appropriate, advice: review.advice || "" });
    } catch (error) {
      console.error("reviewCode AI review failed", error);
      // AIレビューが落ちても安全チェックは通過済みなので許可（アドバイスなし）
      res.json({ ok: true, safe: true, appropriate: true, advice: "" });
    }
  }
);

async function reviewCodeWithGemini(currentCode, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `あなたは高校生向けプログラミング教室のコードレビュー担当AIです。
生徒が自分で手直ししたHTML/CSS/JavaScriptのコードを読み、(1)高校生の作品として公開して問題ない内容か、(2)明らかな不具合や書きかけ・壊れている箇所がないか、をチェックしてください。
あなたはコードを書き換えません。判定とアドバイスだけ返します。

【判定ルール】
- 不適切な内容（暴力・性的・差別・個人情報・他者への攻撃など）が含まれる場合は appropriate=false。
- 明らかに壊れている／未完成で動かなそうな場合も appropriate=false。
- 上記がなければ appropriate=true。
- advice は高校生に向けた短い日本語（1〜2文）。問題があれば「どこをどう直すか」を具体的に、問題なければ成果を認めつつ次の確認ポイントを示す。

【生徒のコード】
\`\`\`html
${currentCode}
\`\`\`

【出力フォーマット】
出力は必ず以下のJSON形式のみ。説明文やマークダウンの枠は出力しない。
{
  "appropriate": true または false,
  "advice": "高校生向けの短い日本語アドバイス"
}`;

  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature: 0.2, responseMimeType: "application/json" }
      });
      const raw = response.text || "";
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const obj = JSON.parse(cleaned);
      if (typeof obj.appropriate === "boolean") {
        return { appropriate: obj.appropriate, advice: String(obj.advice || "") };
      }
    } catch (error) {
      lastError = error;
      console.warn(`Model ${model} failed in reviewCodeWithGemini`, error?.status);
    }
  }
  throw lastError;
}

async function refineHtml(currentCode, selectedCode, instruction, promptHistory, images, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  let lastError;

  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: buildRefinePrompt(currentCode, selectedCode, instruction, promptHistory, images),
        config: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      });

      return extractHtml(response.text || "");
    } catch (error) {
      lastError = error;
      if (![429, 503].includes(error?.status)) {
        throw error;
      }
      console.warn(`Gemini model ${model} unavailable, trying fallback`, error?.status);
    }
  }

  throw lastError;
}

function buildRefinePrompt(currentCode, selectedCode, instruction, promptHistory, images) {
  let appPurpose = "";
  let pastHistoryText = "";
  let recentHistoryText = "";

  if (promptHistory && promptHistory.length > 0) {
    // 最初の要素を「アプリ全体の目的」とする
    const initial = promptHistory[0];
    appPurpose = `【アプリ全体の目的・初回プロンプト】\n${initial.text}\n`;

    // 最初の要素を除いた履歴
    const historyWithoutInitial = promptHistory.slice(1);
    
    // 直近3件（今回の指示を含めて最大3件とするため、履歴からは最大2件取得）
    const recentCount = 2; 
    const recentStart = Math.max(0, historyWithoutInitial.length - recentCount);
    
    const past = historyWithoutInitial.slice(0, recentStart);
    const recent = historyWithoutInitial.slice(recentStart);

    if (past.length > 0) {
      pastHistoryText = `【過去の修正履歴（古い順）】\n` + past.map((h, i) => `- 修正${i+1}: ${h.text}`).join('\n') + `\n`;
    }
    if (recent.length > 0) {
      recentHistoryText = `【直近の修正履歴（古い順）】\n` + recent.map((h, i) => `- 修正: ${h.text}`).join('\n') + `\n`;
    }
  }

  let imageInstructions = "";
  if (Array.isArray(images) && images.length > 0) {
    imageInstructions = `\n【使用可能な画像アセット】\nあなたは、以下の画像素材のみを <img src="img/ファイル名"> の形で使用できます。インターネット上の画像や、これら以外の画像パスは絶対に使用しないでください。\n` + images.map(img => `- img/${img}`).join('\n') + `\n`;
  }

  return `あなたは高校生向けの安全なWebアプリ生成AIです。
提供された既存 of HTMLコード全体を、ユーザーの修正指示に従って適切に修正・更新してください。

${appPurpose}
${pastHistoryText}
${recentHistoryText}
【今回の修正指示】
${instruction}

${selectedCode ? `【ユーザーが修正対象として選択したコード部分（参考）】\n\`\`\`html\n${selectedCode}\n\`\`\`\n` : ''}
【既存のHTMLコード全体】
\`\`\`html
${currentCode}
\`\`\`

【絶対的な制約】
- 既存 of HTMLコード全体の構造を崩さず、指示された目的の部分のみを修正してください。
- 「やっぱり黄色に戻して」などの指示がある場合、上記の履歴（特に直近の履歴やアプリ全体の目的）を考慮して適切な状態に修正してください。
- 外部スクリプト、外部API、外部画像、外部フォントは禁止
- fetch, XMLHttpRequest, WebSocket, eval, new Function は禁止
- Cookie, LocalStorage, SessionStorage, IndexedDB は禁止
- iframe, object, embed は禁止
- location の変更、window.open は禁止
- while(true) などの無限ループは禁止
- setInterval の間隔は 100ms 以上にする
${imageInstructions}

【出力形式】
- <!DOCTYPE html> から始まる完全なHTML 1ファイルのみを出力
- <script> タグは1つだけ、<style> タグは1つだけ
- JavaScript は200行以内
- コードブロック記号や説明文は出力しない
`;
}

export const save = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const authResult = await verifySignedIn(req);
    if (!authResult.ok) {
      res.status(authResult.status).json({ ok: false, message: authResult.message });
      return;
    }

    const uid = authResult.uid;
    const { html, title, author, classId, visibility, images, bgColor, bgImage, bgType, thumbnail, tags, level, editId } = req.body || {};
    if (!html || !title || !author) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    // サムネイル(dataURL)は大きすぎる場合は保存しない（Firestore 1MB制限の保護）
    const safeThumbnail = (typeof thumbnail === "string" && thumbnail.startsWith("data:image/") && thumbnail.length <= 300000)
      ? thumbnail
      : "";

    let orgId = req.body?.orgId || "";
    // orgId がない場合、認証済みユーザーの users ドキュメントから取得する
    if (!orgId) {
      try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (userDoc.exists) {
          orgId = userDoc.data().orgId || "";
        }
      } catch (err) {
        console.warn("Failed to fetch user orgId for saving work:", err);
      }
    }

    try {
      let docId = "dummy_" + Date.now();
      try {
        // 編集モード: 既存作品を更新（評価をリセットし、旧バージョンの記録をhistoryに残す）
        if (editId) {
          const editRef = db.collection("works").doc(String(editId));
          const editDoc = await editRef.get();
          // 所有者本人の作品だけ更新を許可
          if (editDoc.exists && editDoc.data().authorUid === uid) {
            const prev = editDoc.data();
            const prevVersion = prev.version || 1;
            const historyEntry = {
              v: prevVersion,
              play: prev.playCount || 0,
              like: prev.likeCount || 0,
              date: new Date().toISOString().slice(0, 10)
            };
            const prevHistory = Array.isArray(prev.history) ? prev.history : [];
            await editRef.update({
              html,
              title,
              author,
              orgId: orgId || prev.orgId || "",
              visibility: visibility || prev.visibility || "public",
              images: images || [],
              tags: Array.isArray(tags) ? tags : (prev.tags || []),
              level: level || prev.level || "",
              thumbnail: safeThumbnail || prev.thumbnail || "",
              bgColor: bgColor || "",
              bgImage: bgImage || "",
              bgType: bgType || "",
              // 編集時は評価をリセット
              playCount: 0,
              likeCount: 0,
              reactionCounts: { fun: 0, wow: 0, again: 0 },
              version: prevVersion + 1,
              history: [...prevHistory, historyEntry],
              deleted: false,
              updatedAt: new Date().toISOString()
            });
            res.json({ ok: true, id: editRef.id, edited: true });
            return;
          }
          // 所有者でない/存在しない場合は新規作成にフォールバック
        }

        const docRef = await db.collection("works").add({
          html,
          title,
          author,
          authorUid: uid,
          orgId: orgId || "",
          classId: classId || "",
          visibility: visibility || "public",
          images: images || [],
          tags: Array.isArray(tags) ? tags : [],
          level: level || "",
          thumbnail: safeThumbnail,
          bgColor: bgColor || "",
          bgImage: bgImage || "",
          bgType: bgType || "",
          createdAt: new Date().toISOString(),
          version: 1,
          history: [],
          deleted: false,
          playCount: 0,
          likeCount: 0,
          reactionCounts: { fun: 0, wow: 0, again: 0 }
        });
        docId = docRef.id;
      } catch (fsError) {
        console.warn("Firestore save failed, using dummy ID fallback:", fsError.message);
      }

      res.json({
        ok: true,
        id: docId
      });
    } catch (error) {
      console.error("save failed", error);
      sendError(res, 500, "GEMINI_ERROR");
    }
  }
);

export const myWorks = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, message: "ログインが必要です。" });
      return;
    }

    try {
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const snap = await db
        .collection("works")
        .where("authorUid", "==", decodedToken.uid)
        .get();
      const works = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.deleted === true) return;
        works.push({ id: docSnap.id, ...data });
      });
      works.sort((a, b) => workCreatedAtMs(b) - workCreatedAtMs(a));
      res.json({ ok: true, uid: decodedToken.uid, works });
    } catch (error) {
      console.error("myWorks failed", error);
      res.status(401).json({ ok: false, message: "ログイン状態を確認できませんでした。" });
    }
  }
);

export const checkText = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const text = String(req.body?.text || "").trim();
    if (!text) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const result = await verifyTextWithGemini(text, apiKey);
      res.json({
        ok: true,
        safe: result.safe,
        reason: result.reason || ""
      });
    } catch (error) {
      console.error("checkText failed", error);
      res.json({
        ok: true,
        safe: false,
        reason: "安全確認でエラーが発生しました。もう一度試してください。"
      });
    }
  }
);

async function verifyTextWithGemini(text, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
  あなたは高校生向けの教育プラットフォームの安全管理AIです。
  ユーザーが入力したテキスト（ニックネームまたは自己紹介文）を審査し、不適切な表現が含まれているかを判定してください。

  【インプット】
  - 審査するテキスト: "${text}"

  【判定基準】
  以下に該当する場合は「不適切 (safe: false)」と判定します：
  1. 卑猥な言葉、性的な表現、下品な言葉
  2. 暴力的な表現、攻撃的な表現、他者への悪口、いじめ、差別的な表現
  3. 自傷行為や犯罪を助長する表現、破壊的な表現
  4. 実名、電話番号、詳細な住所などの明らかな個人情報（「たろう」などの一般的なニックネームは安全とします）
  5. 不適切なURL

  【出力フォーマット】
  出力は必ず以下のJSON形式のみにしてください。説明文やマークダウンの枠（\`\`\`jsonなど）は一切出力しないでください。
  {
    "safe": true（安全な場合）または false（不適切な場合）,
    "reason": "不適切な場合の理由（日本語、1文で「卑猥な言葉が含まれています」のように簡潔に。safeがtrueの場合は空文字）"
  }
  `;

  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      });
      
      const rawText = response.text || "";
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      return JSON.parse(cleaned);
    } catch (error) {
      lastError = error;
      console.warn(`Gemini model ${model} checkText failed, trying fallback`, error?.status);
    }
  }
  throw lastError;
}

// 作品タグの正式リスト（クライアントの WORK_TAGS と一致させる）
const WORK_TAG_LIST = [
  "ゲーム・シミュレーター", "クイズ・検定", "適性診断・占い", "グラフィック・アート", "アニメーション・映像", "サウンド・音楽",
  "デジタルノベル・ストーリー", "図鑑・データベース", "プレゼンテーション・紹介", "実用ツール・ユーティリティ", "計算・アルゴリズム",
  "クロック・タイマー", "集計・カウンター", "データ分析・可視化", "デジタルメッセージ・カード",
  "アンケート・ランキング", "学習ツール・ドリル", "探究学習・リサーチ", "スクールライフ・イベント", "ユーモア・バラエティ",
  "社会課題・SDGs", "その他"
];

// AIが作品を分類してタグ候補を返すAPI（保存前のタグ提案に使用）
export const classifyTags = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { sendError(res, 405, "BAD_REQUEST"); return; }

    const html = String(req.body?.html || "").trim();
    const title = String(req.body?.title || "").trim();
    if (!html) { sendError(res, 400, "BAD_REQUEST"); return; }

    const apiKey = getAiKey();
    if (!apiKey) { res.json({ ok: true, tags: [] }); return; }

    try {
      const tags = await classifyTagsWithGemini(html.slice(0, MAX_HTML_LENGTH), title, apiKey);
      res.json({ ok: true, tags });
    } catch (error) {
      console.error("classifyTags failed", error);
      res.json({ ok: true, tags: [] }); // 失敗時は候補なし（ユーザーが手動で選ぶ）
    }
  }
);

async function classifyTagsWithGemini(html, title, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `あなたは高校生向け作品プラットフォームの分類AIです。
生徒が作ったHTML作品を読み、下のタグ一覧から「最もふさわしいタグ」を1〜3個えらんでください。

【タグ一覧（この中の文字列だけを使う）】
${WORK_TAG_LIST.map(t => `- ${t}`).join("\n")}

【判定のヒント】
- アプリの「種類・目的」で選ぶ（見た目ではなく何をするアプリか）。
- ぴったりが無ければ近いものを。どうしても無ければ "その他"。
- 多くても3個まで。一番ふさわしい順に並べる。

【作品名】
${title || "(なし)"}

【HTML】
\`\`\`html
${html}
\`\`\`

【出力フォーマット】
出力は必ず以下のJSON形式のみ。説明やマークダウン枠は出力しない。
{ "tags": ["タグ1", "タグ2"] }`;

  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature: 0.1, responseMimeType: "application/json" }
      });
      const raw = response.text || "";
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const obj = JSON.parse(cleaned);
      const allowed = new Set(WORK_TAG_LIST);
      const tags = Array.isArray(obj.tags)
        ? obj.tags.filter(t => allowed.has(t)).slice(0, 3)
        : [];
      return tags;
    } catch (error) {
      lastError = error;
      console.warn(`Model ${model} failed in classifyTagsWithGemini`, error?.status);
    }
  }
  throw lastError;
}

export const censorHobby = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const hobby = String(req.body?.hobby || "").trim();
    const famType = String(req.body?.famType || "tora").trim();
    const nickname = String(req.body?.nickname || "お友達").trim();

    if (!hobby) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const result = await processHobbyWithGemini(hobby, famType, nickname, apiKey);
      res.json({
        ok: true,
        safeHobby: result.safeHobby,
        introLine: result.introLine
      });
    } catch (error) {
      console.error("censorHobby failed", error);
      // フォールバック
      res.json({
        ok: true,
        safeHobby: hobby.slice(0, 12),
        introLine: `お友達の${nickname}は「${hobby.slice(0, 12)}」が好きなんだって！`
      });
    }
  }
);

async function processHobbyWithGemini(hobby, famType, nickname, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
  あなたは高校生向けの教育プラットフォームの安全管理AIです。
  ユーザーが入力した趣味のテキストを審査・クレンジングし、からくり人形（キャラクター）の口調で紹介するセリフを生成してください。

  【インプット】
  - ユーザーが入力した趣味: "${hobby}"
  - ユーザーのニックネーム: "${nickname}"
  - 紹介するからくり人形の種類: "${famType}"
    - "tora" (灯🏮): 落ち着いていて素直。
    - "robo" (算🧮): まじめで論理的。
    - "fairy" (結🎐): 明るく前向き。
    - "dragon" (武⚔️): 自信家で堂々としている。
    - "rabbit" (鈴🔔): やさしく親しみやすい。

  【処理ルール】
  1. 趣味のテキストの中に、個人情報（本名、住所、電話番号、学校名など）、不適切な言葉（悪口、暴力的な表現など）、URLが含まれていないか確認してください。
  2. 不適切な内容が含まれる場合、安全な一般的な表現に置き換えるか、どうしても危険な場合は「内緒のこと」などの表現に変えてください。安全な場合はそのまま使用します。趣味のテキスト自体は短く（12文字以内）要約した「safeHobby」にしてください。
  3. その趣味を他人に紹介するためのセリフ「introLine」を、指定された「紹介するからくり人形の種類」の口調とキャラクターに合わせて、語尾の癖は付けずに自然な日本語で作成してください。ニックネームを含めて紹介してください（例: 「${nickname}さんは〜〜が好きなんだって。」）。

  【出力フォーマット】
  出力は必ず以下のJSON形式のみにしてください。説明文やマークダウンの枠（\`\`\`jsonなど）は一切出力しないでください。
  {
    "safeHobby": "安全かつ12文字以内に要約された趣味テキスト",
    "introLine": "からくり人形の口調で書かれた紹介セリフ"
  }
  `;

  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.5,
          responseMimeType: "application/json"
        }
      });

      const text = response.text || "";
      const cleanJsonText = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const obj = JSON.parse(cleanJsonText);
      if (obj.safeHobby && obj.introLine) {
        return obj;
      }
    } catch (error) {
      lastError = error;
      console.warn(`Model ${model} failed in processHobbyWithGemini`, error);
    }
  }
  throw lastError;
}

export const generateQuest = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const genre = String(req.body?.genre || "").trim();
    const diff = String(req.body?.diff || "").trim();
    const reward = Number(req.body?.reward || 0);

    if (!genre || !diff) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const result = await processQuestWithGemini(genre, diff, reward, apiKey);
      res.json({
        ok: true,
        title: result.title,
        desc: result.desc
      });
    } catch (error) {
      console.error("generateQuest failed", error);
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "AIがクエストを生成できませんでした。"
      });
    }
  }
);

async function processQuestWithGemini(genre, diff, reward, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
  あなたは高校生向けの教育プラットフォーム「じさくや」の運営スタッフ支援AIです。
  指定された「ジャンル」「難易度」「報酬所持両」にマッチした、高校生がプログラミングや創作活動で挑戦したくなるような「ミッション」を1件考えて、タイトルと説明文を生成してください。

  【インプット】
  - ジャンル: "${genre}" (例: "Web制作", "文章", "画像素材")
  - 難易度: "${diff}" (例: "初級", "中級", "上級")
  - 報酬所持両: ${reward} (例: 30)

  【要件】
  1. タイトルは高校生がパッと見て何をすればいいかわかる、具体的で魅力的なもの（30文字以内）。
  2. 説明文は、具体的に何を作るべきか、どういう機能や内容が含まれているべきかを親しみやすく説明したもの（150文字程度）。
  3. 高校生が作成可能な難易度（初級＝ボタン1〜2個の機能、中級＝簡単なゲームや計算ツール、上級＝複数の状態を持つアプリやクイズなど）に合わせること。

  【出力フォーマット】
  出力は必ず以下のJSON形式のみにしてください。説明文やマークダウンの枠（\`\`\`jsonなど）は一切出力しないでください。
  {
    "title": "生成されたミッションタイトル",
    "desc": "生成されたミッションの説明文"
  }
  `;

  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.7,
          responseMimeType: "application/json"
        }
      });

      const text = response.text || "";
      const cleanJsonText = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const obj = JSON.parse(cleanJsonText);
      if (obj.title && obj.desc) {
        return obj;
      }
    } catch (error) {
      lastError = error;
      console.warn(`Model ${model} failed in processQuestWithGemini`, error);
    }
  }
  throw lastError;
}

export const verifyQuest = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const questId = String(req.body?.questId || "").trim();
    const questTitle = String(req.body?.questTitle || "").trim();
    const questDesc = String(req.body?.questDesc || "").trim();
    const workHtml = String(req.body?.workHtml || "").trim();

    if (!questId || !questTitle || !workHtml) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const result = await processQuestVerification(questTitle, questDesc, workHtml, apiKey);
      res.json({
        ok: true,
        passed: result.passed,
        feedback: result.feedback
      });
    } catch (error) {
      console.error("verifyQuest failed", error);
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "AIがコード審査を行えませんでした。"
      });
    }
  }
);

async function processQuestVerification(questTitle, questDesc, workHtml, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  
  const prompt = `
  あなたはプログラミング学習用プラットフォームのAI審査官です。
  提出されたHTMLコード（JavaScriptやCSSを含む）が、指定されたミッションの要件を合理的に満たしているかを自動判定してください。

  【ミッション内容】
  - タイトル: "${questTitle}"
  - 説明: "${questDesc}"

  【提出されたHTMLコード】
  \`\`\`html
  ${workHtml}
  \`\`\`

  【判定基準】
  1. ミッション内容に沿った要素や動作ロジック（JavaScriptなど）が最低限含まれていれば「合格（passed: true）」とします。
  2. デザインの美しさや複雑さは問わず、高校生が自力で作ったレベルのものであれば、教育的配慮から積極的に合格にしてください。
  3. 全く関係のない白紙のHTMLや、ミッション内容と一切無関係なコード（例：タイマーのミッションなのに自己紹介テキストだけ等）の場合は「不合格（passed: false）」とします。
  4. フィードバックには、合格時は「要件を満たしています。次は見た目や使いやすさも改善できます。」のように成果と次の視点を、不合格時は「○○という機能やボタンが不足しています。該当箇所を追加してください。」のように具体的な改善点を日本語で100文字程度で記述してください。

  【出力フォーマット】
  出力は必ず以下のJSON形式のみにしてください。説明文やマークダウンの枠（\`\`\`jsonなど）は一切出力しないでください。
  {
    "passed": trueまたはfalse,
    "feedback": "フィードバックメッセージ"
  }
  `;

  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      });

      const text = response.text || "";
      const cleanJsonText = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const obj = JSON.parse(cleanJsonText);
      if (typeof obj.passed === 'boolean' && obj.feedback) {
        return obj;
      }
    } catch (error) {
      lastError = error;
      console.warn(`Model ${model} failed in processQuestVerification`, error);
    }
  }
  throw lastError;
}

// =========================================================================
// ==================== 独自ID認証 ＆ 有料プラン管理 API ====================
// =========================================================================

// パスワードハッシュ化 (PBKDF2-SHA512: 1000回)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// 管理者IDトークンの検証
async function verifyAdmin(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.substring(7);
  try {
    const decodedToken = await authAdmin.verifyIdToken(token);
    return ADMIN_EMAILS.includes(decodedToken.email) || decodedToken.role === "admin";
  } catch (err) {
    console.error("verifyAdminToken failed", err.message);
    return false;
  }
}

// IPアドレスの取得
function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || "";
}

// 監査ログの書き込み
async function writeAuditLog(adminUid, action, targetOrgId, details, ipAddress) {
  try {
    await db.collection("logs").add({
      timestamp: new Date().toISOString(),
      adminUid: adminUid || "system",
      action,
      targetOrgId: targetOrgId || "",
      details: details || "",
      ipAddress: ipAddress || ""
    });
  } catch (e) {
    console.error("Failed to write audit log", e);
  }
}

async function updateUsersByOrgId(orgId, updateData) {
  const snap = await db.collection("users").where("orgId", "==", orgId).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((docSnap) => batch.update(docSnap.ref, updateData));
  await batch.commit();
  return snap.size;
}

async function deleteUsersByOrgId(orgId) {
  let total = 0;
  while (true) {
    const snap = await db.collection("users").where("orgId", "==", orgId).limit(450).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 450) break;
  }
  return total;
}

const CLASSROOM_TICKET_PLANS = {
  classroom_ticket_10: {
    planId: "classroom_ticket_10",
    planName: "教室チケット 10人プラン",
    seats: 10,
    durationDays: 30,
    stripePriceParam: stripePriceClassroom10,
    stripePriceParamName: "STRIPE_PRICE_CLASSROOM_10"
  },
  classroom_ticket_20: {
    planId: "classroom_ticket_20",
    planName: "教室チケット 20人プラン",
    seats: 20,
    durationDays: 30,
    stripePriceParam: stripePriceClassroom20,
    stripePriceParamName: "STRIPE_PRICE_CLASSROOM_20"
  },
  classroom_ticket_40: {
    planId: "classroom_ticket_40",
    planName: "教室チケット 40人プラン",
    seats: 40,
    durationDays: 30,
    stripePriceParam: stripePriceClassroom40,
    stripePriceParamName: "STRIPE_PRICE_CLASSROOM_40"
  }
};

function getStripeClient() {
  const key = stripeSecretKey.value() || process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  return new Stripe(key);
}

function getPlan(planId) {
  return CLASSROOM_TICKET_PLANS[planId] || null;
}

function getStripePriceId(plan) {
  return plan.stripePriceParam.value() || process.env[plan.stripePriceParamName] || "";
}

function addDaysDateOnly(dateOnly, days) {
  const base = dateOnly ? new Date(`${dateOnly}T00:00:00.000Z`) : new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}

function generateRandomOrgId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[crypto.randomInt(chars.length)];
  }
  return id;
}

async function makeUniqueOrgId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const orgId = generateRandomOrgId();
    const doc = await db.collection("organizations").doc(orgId).get();
    if (!doc.exists) {
      return orgId;
    }
  }
  throw new Error("一意な学校IDの生成に失敗しました。");
}

function makePassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars[crypto.randomInt(chars.length)];
  }
  return password;
}

function buildStudentAccount(orgId, index, contractEndDate) {
  const n = String(index + 1).padStart(2, "0"); // 2桁の連番に変更
  const loginId = n; // "student001" ではなく "01" にする
  const password = makePassword(); // 互換性のためランダムパスワードを生成
  const uid = crypto.randomUUID();
  // orgIdを "AAAA-BBBB" の形式に整形
  const formattedOrgId = orgId.substring(0, 4) + "-" + orgId.substring(4);
  const loginCode = `${formattedOrgId}-${n}`; // AAAA-BBBB-01

  return {
    uid,
    loginId,
    nickname: `生徒${n}`,
    password,
    loginCode,
    data: {
      uid,
      loginId,
      nickname: `生徒${n}`,
      passwordHash: hashPassword(password),
      orgId,
      organizationId: orgId,
      schoolId: orgId,
      loginCode,
      role: "student",
      authType: "school_id",
      licenseState: "paid",
      paidUntil: contractEndDate,
      seatStatus: "active",
      loginType: "password",
      coins: 150,
      slotsMax: 2,
      ownedImages: [],
      ownedFamTypes: ["tora", "robo", "fairy"],
      ownedMiscItems: [],
      famType: "tora",
      unlockedAchievements: [],
      bgType: "color",
      bgColor: "#FDFBF7",
      bgImage: "default",
      ownedBgImages: ["bg_stars.png"],
      loginAttempts: 0,
      lockUntil: null,
      createdAt: new Date().toISOString()
    }
  };
}

async function sendCredentialsEmail({ contactEmail, orgId, managerPassword, accounts }) {
  const subject = `【じさくや】教室用ライセンス発行完了のお知らせ [${orgId}]`;
  const formattedOrgId = orgId.substring(0, 4) + "-" + orgId.substring(4);
  const codeListStr = accounts.map(a => a.loginCode).join("\n");
  
  const text = `じさくやをご利用いただきありがとうございます。
教室用ライセンスの発行が完了しましたので、ログイン情報をお送りいたします。

■ 教室管理者用ログイン情報
学校/塾ID: ${orgId}
契約者パスワード: ${managerPassword}
教室管理者用ページ: https://${process.env.GCLOUD_PROJECT || "your-project-id"}.web.app/manager.html
※教室管理者ページでは、生徒が作成した作品の一覧を確認することができます。

■ 生徒用ログインコード一覧
契約人数: ${accounts.length}名分
生徒のログイン画面（https://${process.env.GCLOUD_PROJECT || "your-project-id"}.web.app/corder.html）で、以下のログインコードを1つずつ入力してログインしてください。
（パスワードの入力は不要です）

${codeListStr}

--------------------------------------------------
本メールに直接ご返信いただくことで、お問い合わせいただけます。ご不明な点がございましたら、このままご返信ください。
`;

  // 1. SMTPによる送信を試みる
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || `"じさくや" <admin@example.com>`;

  if (host && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: Number(port) === 465,
        auth: { user, pass }
      });
      await transporter.sendMail({
        from,
        to: contactEmail,
        subject,
        text
      });
      console.log(`Email successfully sent to ${contactEmail} via SMTP.`);
      return;
    } catch (smtpError) {
      console.error("SMTP send failed, falling back to Firestore mail collection:", smtpError);
    }
  } else {
    console.log("SMTP configuration missing. Falling back to Firestore mail collection.");
  }

  // 2. フォールバック: Firestore 'mail' コレクションに書き込み
  try {
    await db.collection("mail").add({
      to: contactEmail,
      message: {
        subject,
        text
      },
      createdAt: new Date().toISOString()
    });
    console.log(`Email document added to Firestore mail collection for ${contactEmail}.`);
  } catch (dbError) {
    console.error("Failed to write to Firestore mail collection:", dbError);
  }
}

async function issueClassroomTicket({
  orgName,
  contactEmail,
  plan,
  contractStartDate,
  contractEndDate,
  stripeData,
  billingType = "one_time_ticket",
  manualMemo = "",
  issuedByAdminUid = null
}) {
  const start = normalizeDateOnly(contractStartDate);
  const end = contractEndDate || addDaysDateOnly(start, plan.durationDays);
  const orgId = await makeUniqueOrgId();
  const managerPassword = makePassword(8);
  const managerPasswordHash = hashPassword(managerPassword);
  const accounts = Array.from({ length: plan.seats }, (_, i) => buildStudentAccount(orgId, i, end));
  const issuedAt = new Date().toISOString();

  await db.runTransaction(async (transaction) => {
    const orgRef = db.collection("organizations").doc(orgId);
    transaction.set(orgRef, {
      orgId,
      orgName,
      muniId: null,
      licenseCount: plan.seats,
      activeLicenseCount: plan.seats,
      contactEmail,
      contractStartDate: start,
      contractEndDate: end,
      status: "active",
      planName: plan.planId,
      planSeats: plan.seats,
      billingType,
      stripeCustomerId: stripeData?.customerId || null,
      stripeCheckoutSessionId: stripeData?.checkoutSessionId || null,
      stripePaymentIntentId: stripeData?.paymentIntentId || null,
      manualMemo: manualMemo || "",
      issuedByAdminUid: issuedByAdminUid || null,
      passwordHash: managerPasswordHash,
      ticketIssuedAt: issuedAt,
      updatedAt: issuedAt
    }, { merge: true });

    accounts.forEach((account) => {
      transaction.set(db.collection("users").doc(account.uid), account.data);
    });
  });

  await db.collection("ticket_issues").doc(orgId).set({
    orgId,
    orgName,
    contactEmail,
    planId: plan.planId,
    contractStartDate: start,
    contractEndDate: end,
    issuedAt,
    stripeCheckoutSessionId: stripeData?.checkoutSessionId || null,
    billingType,
    manualMemo: manualMemo || "",
    issuedByAdminUid: issuedByAdminUid || null,
    deliveryStatus: "pending_email",
    managerPassword,
    accounts: accounts.map(({ loginId, nickname, loginCode }) => ({ loginId, nickname, loginCode })),
    updatedAt: issuedAt
  });

  try {
    await sendCredentialsEmail({
      contactEmail,
      orgId,
      managerPassword,
      accounts: accounts.map(({ loginCode }) => ({ loginCode }))
    });
  } catch (mailErr) {
    console.error("sendCredentialsEmail failed during ticket issuance:", mailErr);
  }

  return {
    orgId,
    contractStartDate: start,
    contractEndDate: end,
    accounts: accounts.map(({ loginId, nickname, loginCode }) => ({ loginId, nickname, loginCode }))
  };
}

function getRequestOrigin(req) {
  const origin = req.headers.origin || "";
  if (origin) return origin;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : "https://example.com";
}

// 実績解除API（coins/unlockedAchievementsはFirestore rulesでクライアント直接更新不可のためAPIで処理）
export const unlockAchievement = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, message: "ログインが必要です。" });
      return;
    }

    const achievementId = String(req.body?.achievementId || "").trim();
    if (!ACHIEVEMENT_REWARDS[achievementId]) {
      res.status(400).json({ ok: false, message: "不明な実績IDです。" });
      return;
    }

    try {
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const uid = decodedToken.uid;
      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error("ユーザーが見つかりません。");

        const userData = userDoc.data();
        const existing = Array.isArray(userData.unlockedAchievements) ? userData.unlockedAchievements : [];

        if (existing.includes(achievementId)) {
          return { alreadyUnlocked: true, coins: userData.coins || 0, unlockedAchievements: existing };
        }

        const reward = ACHIEVEMENT_REWARDS[achievementId];
        const newUnlocks = [...existing, achievementId];
        const newCoins = (Number(userData.coins) || 0) + reward;

        transaction.update(userRef, { unlockedAchievements: newUnlocks, coins: newCoins });
        return { alreadyUnlocked: false, coins: newCoins, unlockedAchievements: newUnlocks };
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("unlockAchievement failed", err);
      res.status(500).json({ ok: false, message: "実績解除処理でエラーが発生しました。" });
    }
  }
);

// 作品枠(スロット)購入API（coins/slotsMaxはFirestore rulesでクライアント直接更新不可のためAPIで処理）
export const purchaseSlot = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, message: "ログインが必要です。" });
      return;
    }

    try {
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const uid = decodedToken.uid;
      const userRef = db.collection("users").doc(uid);

      const result = await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error("ユーザーが見つかりません。");

        const userData = userDoc.data();
        const currentSlots = Number(userData.slotsMax) || 2;
        const nextSlot = currentSlots + 1;

        if (nextSlot > SLOT_MAX) {
          return { ok: false, reason: "max", coins: Number(userData.coins) || 0, slotsMax: currentSlots };
        }
        const price = SLOT_PRICE_TABLE[nextSlot];
        if (!price) {
          return { ok: false, reason: "max", coins: Number(userData.coins) || 0, slotsMax: currentSlots };
        }
        const coins = Number(userData.coins) || 0;
        if (coins < price) {
          return { ok: false, reason: "insufficient", price, coins, slotsMax: currentSlots };
        }

        const newCoins = coins - price;
        transaction.update(userRef, { coins: newCoins, slotsMax: nextSlot });
        return { ok: true, price, coins: newCoins, slotsMax: nextSlot };
      });

      if (!result.ok) {
        const message = result.reason === "max"
          ? "これ以上、枠を増やせません。"
          : `両が足りません（必要: ${result.price}）。`;
        res.status(400).json({ ok: false, reason: result.reason, message, coins: result.coins, slotsMax: result.slotsMax });
        return;
      }
      res.json({ ok: true, coins: result.coins, slotsMax: result.slotsMax, price: result.price });
    } catch (err) {
      console.error("purchaseSlot failed", err);
      res.status(500).json({ ok: false, message: "枠の購入処理でエラーが発生しました。" });
    }
  }
);

// ショップ商品購入API（coins/ownedFamTypesはFirestore rulesでクライアント直接更新不可のためAPIで処理）
export const purchaseShopItem = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, message: "ログインが必要です。" });
      return;
    }

    const itemKey = String(req.body?.itemKey || "").trim();
    if (!itemKey || itemKey === "slot") {
      res.status(400).json({ ok: false, message: "商品が正しくありません。" });
      return;
    }

    try {
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const uid = decodedToken.uid;
      const userRef = db.collection("users").doc(uid);

      // 価格はサーバー側で決定（クライアント入力を信用しない）。
      // shop_items / images のどちらも管理画面から登録できるため、購入APIで所有権更新まで完結させる。
      let price = null;
      let itemKind = "misc";
      let imageFileName = "";
      let shopData = null;

      if (itemKey.startsWith("image:")) {
        itemKind = "image";
        imageFileName = itemKey.substring("image:".length);
        const imageDoc = await db.collection("images").doc(imageFileName).get();
        if (!imageDoc.exists || imageDoc.data().enabled === false) {
          res.status(400).json({ ok: false, message: "この画像素材は購入できません。" });
          return;
        }
        const imageData = imageDoc.data();
        imageFileName = imageData.fileName || imageFileName;
        if (typeof imageData.price === "number") {
          price = imageData.price;
        } else {
          price = IMAGE_PRICE_FALLBACK[imageData.category] || 20;
        }
      } else {
        const shopDoc = await db.collection("shop_items").doc(itemKey).get();
        if (shopDoc.exists) {
          shopData = shopDoc.data();
          if (shopData.enabled === false) {
            res.status(400).json({ ok: false, message: "この商品は現在購入できません。" });
            return;
          }
          if (typeof shopData.price === "number") price = shopData.price;
        }
      }

      if (price === null && typeof SHOP_ITEMS_FALLBACK[itemKey] === "number") {
        price = SHOP_ITEMS_FALLBACK[itemKey];
      }
      if (price === null || price < 0) {
        res.status(400).json({ ok: false, message: "この商品は購入できません。" });
        return;
      }

      const result = await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error("ユーザーが見つかりません。");
        const userData = userDoc.data();
        const coins = Number(userData.coins) || 0;

        const updates = {};
        let alreadyOwned = false;

        if (itemKind === "image") {
          const owned = Array.isArray(userData.ownedImages) ? userData.ownedImages : [];
          if (owned.includes(imageFileName)) {
            alreadyOwned = true;
          } else {
            updates.ownedImages = [...owned, imageFileName];
          }
        } else if (itemKey.startsWith("fam_")) {
          const famKey = itemKey.replace("fam_", "");
          const owned = Array.isArray(userData.ownedFamTypes) ? userData.ownedFamTypes : ["tora", "robo", "fairy"];
          if (owned.includes(famKey)) {
            alreadyOwned = true;
          } else {
            updates.ownedFamTypes = [...owned, famKey];
          }
        } else if (itemKey.startsWith("bg_")) {
          const bgFile = `${itemKey}.png`;
          const owned = Array.isArray(userData.ownedBgImages) ? userData.ownedBgImages : ["bg_stars.png"];
          if (owned.includes(bgFile)) {
            alreadyOwned = true;
          } else {
            updates.ownedBgImages = [...owned, bgFile];
          }
        } else {
          const repeatable = shopData?.repeatable === true;
          const owned = Array.isArray(userData.ownedMiscItems) ? userData.ownedMiscItems : [];
          if (!repeatable && owned.includes(itemKey)) {
            alreadyOwned = true;
          } else if (!repeatable) {
            updates.ownedMiscItems = [...owned, itemKey];
          }
        }

        if (alreadyOwned) {
          return {
            ok: false, reason: "owned", coins,
            ownedFamTypes: userData.ownedFamTypes || [],
            ownedBgImages: userData.ownedBgImages || [],
            ownedImages: userData.ownedImages || [],
            ownedMiscItems: userData.ownedMiscItems || []
          };
        }
        if (coins < price) {
          return {
            ok: false, reason: "insufficient", price, coins,
            ownedFamTypes: userData.ownedFamTypes || [],
            ownedBgImages: userData.ownedBgImages || [],
            ownedImages: userData.ownedImages || [],
            ownedMiscItems: userData.ownedMiscItems || []
          };
        }

        updates.coins = coins - price;
        transaction.update(userRef, updates);
        return {
          ok: true, price, coins: updates.coins,
          ownedFamTypes: updates.ownedFamTypes || userData.ownedFamTypes || [],
          ownedBgImages: updates.ownedBgImages || userData.ownedBgImages || [],
          ownedImages: updates.ownedImages || userData.ownedImages || [],
          ownedMiscItems: updates.ownedMiscItems || userData.ownedMiscItems || []
        };
      });

      if (!result.ok) {
        const message = result.reason === "owned"
          ? "すでに持っています。"
          : `両が足りません（必要: ${result.price}）。`;
        res.status(400).json({ ok: false, reason: result.reason, message, coins: result.coins, ownedFamTypes: result.ownedFamTypes, ownedBgImages: result.ownedBgImages, ownedImages: result.ownedImages, ownedMiscItems: result.ownedMiscItems });
        return;
      }
      res.json({ ok: true, coins: result.coins, ownedFamTypes: result.ownedFamTypes, ownedBgImages: result.ownedBgImages, ownedImages: result.ownedImages, ownedMiscItems: result.ownedMiscItems, price: result.price });
    } catch (err) {
      console.error("purchaseShopItem failed", err);
      res.status(500).json({ ok: false, message: "購入処理でエラーが発生しました。" });
    }
  }
);

// Stripe Checkout Session 作成API
export const createCheckoutSession = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [stripeSecretKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const orgName = String(req.body?.orgName || "").trim();
    const contactEmail = String(req.body?.contactEmail || "").trim();
    const planId = String(req.body?.planId || "").trim();
    const contractStartDate = normalizeDateOnly(req.body?.contractStartDate);
    const plan = getPlan(planId);

    if (!orgName || !contactEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail) || !plan) {
      res.status(400).json({ ok: false, message: "申込内容を確認してください。" });
      return;
    }

    const priceId = getStripePriceId(plan);
    if (!priceId) {
      res.status(500).json({ ok: false, message: `${plan.stripePriceParamName} が設定されていません。` });
      return;
    }

    try {
      const stripe = getStripeClient();
      const origin = getRequestOrigin(req);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: contactEmail,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/user_admin.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/user_admin.html?checkout=cancelled`,
        metadata: {
          productType: "classroom_ticket",
          planId: plan.planId,
          planSeats: String(plan.seats),
          durationDays: String(plan.durationDays),
          orgName,
          contactEmail,
          contractStartDate
        }
      });

      res.json({ ok: true, url: session.url, sessionId: session.id });
    } catch (err) {
      console.error("createCheckoutSession failed", err);
      res.status(500).json({ ok: false, message: "決済ページを作成できませんでした。" });
    }
  }
);

export const claimCheckoutSession = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const authResult = await verifySignedIn(req);
    if (!authResult.ok) {
      res.status(authResult.status).json({ ok: false, message: authResult.message });
      return;
    }

    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId || !sessionId.startsWith("cs_")) {
      res.status(400).json({ ok: false, message: "決済セッションを確認できません。" });
      return;
    }

    try {
      const sessionDoc = await db.collection("stripe_checkout_sessions").doc(sessionId).get();
      const sessionData = sessionDoc.exists ? sessionDoc.data() : null;
      if (!sessionData || sessionData.status !== "processed" || !sessionData.targetOrgId) {
        res.status(409).json({ ok: false, message: "決済処理がまだ完了していません。少し待って再読み込みしてください。" });
        return;
      }

      const orgId = sessionData.targetOrgId;
      const orgDoc = await db.collection("organizations").doc(orgId).get();
      if (!orgDoc.exists) {
        res.status(404).json({ ok: false, message: "教室情報が見つかりません。" });
        return;
      }

      const orgData = orgDoc.data();
      await db.collection("users").doc(authResult.uid).set({
        uid: authResult.uid,
        email: authResult.decodedToken.email || "",
        nickname: authResult.decodedToken.name || "教室管理者",
        role: "classroom_manager",
        authType: "google",
        licenseState: "paid",
        orgId,
        organizationId: orgId,
        schoolId: orgId,
        seatsMax: orgData.licenseCount || orgData.planSeats || 0,
        seatStatus: "active",
        paidUntil: orgData.contractEndDate || null,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      await authAdmin.setCustomUserClaims(authResult.uid, {
        role: "classroom_manager",
        orgId
      });

      res.json({
        ok: true,
        orgId,
        orgName: orgData.orgName || "",
        licenseCount: orgData.licenseCount || orgData.planSeats || 0,
        contractEndDate: orgData.contractEndDate || null
      });
    } catch (err) {
      console.error("claimCheckoutSession failed", err);
      res.status(500).json({ ok: false, message: "購入情報の反映に失敗しました。" });
    }
  }
);

// 管理者による教室チケット手動発行API
export const issueManualClassroomTicket = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    try {
      const authHeader = req.headers.authorization || "";
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const request = buildManualTicketIssueRequest(req.body || {});
      const issue = await issueClassroomTicket({
        orgName: request.orgName,
        contactEmail: request.contactEmail,
        plan: request.plan,
        contractStartDate: request.contractStartDate,
        contractEndDate: request.contractEndDate,
        billingType: request.billingType,
        manualMemo: request.manualMemo,
        issuedByAdminUid: decodedToken.uid
      });

      await writeAuditLog(
        decodedToken.uid,
        "issueManualClassroomTicket",
        issue.orgId,
        `Manually issued ${request.plan.seats} accounts for ${request.orgName}. Plan: ${request.plan.planId}.`,
        getClientIp(req)
      );

      res.json({
        ok: true,
        orgId: issue.orgId,
        contractStartDate: issue.contractStartDate,
        contractEndDate: issue.contractEndDate,
        accountCount: issue.accounts.length
      });
    } catch (err) {
      console.error("issueManualClassroomTicket failed", err);
      res.status(400).json({ ok: false, message: err.message || "手動発行に失敗しました。" });
    }
  }
);

// 管理者による教室チケット無効化API（復旧可能な停止）
export const cancelClassroomTicket = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    try {
      const authHeader = req.headers.authorization || "";
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const request = buildTicketLifecycleRequest(req.body || {});
      const now = new Date().toISOString();

      const userCount = await updateUsersByOrgId(request.orgId, {
        seatStatus: "inactive",
        isActive: false,
        updatedAt: now
      });

      await db.collection("organizations").doc(request.orgId).set({
        status: "cancelled",
        activeLicenseCount: 0,
        cancelledAt: now,
        cancelledByAdminUid: decodedToken.uid,
        cancelReason: request.reason,
        updatedAt: now
      }, { merge: true });

      await db.collection("ticket_issues").doc(request.orgId).set({
        deliveryStatus: "cancelled",
        cancelledAt: now,
        cancelledByAdminUid: decodedToken.uid,
        cancelReason: request.reason,
        accounts: [],
        updatedAt: now
      }, { merge: true });

      await writeAuditLog(
        decodedToken.uid,
        "cancelClassroomTicket",
        request.orgId,
        `Cancelled classroom ticket. Users disabled: ${userCount}. Reason: ${request.reason}`,
        getClientIp(req)
      );

      res.json({ ok: true, orgId: request.orgId, disabledUserCount: userCount });
    } catch (err) {
      console.error("cancelClassroomTicket failed", err);
      res.status(400).json({ ok: false, message: err.message || "チケットの無効化に失敗しました。" });
    }
  }
);

// 管理者による教室チケット完全削除API（復旧不可）
export const deleteClassroomTicketBundle = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    try {
      const authHeader = req.headers.authorization || "";
      const decodedToken = await authAdmin.verifyIdToken(authHeader.substring(7));
      const request = buildTicketLifecycleRequest(req.body || {}, { requireConfirmation: true });
      const deletedUserCount = await deleteUsersByOrgId(request.orgId);

      const batch = db.batch();
      batch.delete(db.collection("organizations").doc(request.orgId));
      batch.delete(db.collection("ticket_issues").doc(request.orgId));
      await batch.commit();

      await writeAuditLog(
        decodedToken.uid,
        "deleteClassroomTicketBundle",
        request.orgId,
        `Hard deleted classroom ticket bundle. Users deleted: ${deletedUserCount}. Reason: ${request.reason}`,
        getClientIp(req)
      );

      res.json({ ok: true, orgId: request.orgId, deletedUserCount });
    } catch (err) {
      console.error("deleteClassroomTicketBundle failed", err);
      res.status(400).json({ ok: false, message: err.message || "チケットの完全削除に失敗しました。" });
    }
  }
);

// Stripe Webhook 受信API
export const stripeWebhook = onRequest(
  {
    region: "asia-northeast1",
    cors: false,
    timeoutSeconds: 60,
    memory: "512MiB",
    secrets: [stripeSecretKey, stripeWebhookSecret]
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const webhookSecret = stripeWebhookSecret.value() || process.env.STRIPE_WEBHOOK_SECRET;
    const isSkipSignature = process.env.FUNCTIONS_EMULATOR === "true" && req.headers["x-skip-signature"] === "true";
    if (!webhookSecret && !isSkipSignature) {
      res.status(500).send("Webhook secret is not configured.");
      return;
    }

    const signature = req.headers["stripe-signature"];
    let event;

    try {
      if (isSkipSignature) {
        console.log("Skipping signature verification in emulator mode.");
        event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      } else {
        const stripe = getStripeClient();
        event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
      }
    } catch (err) {
      console.error("stripeWebhook signature verification failed", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    const eventRef = db.collection("stripe_events").doc(event.id);
    const existing = await eventRef.get();
    if (existing.exists) {
      res.json({ received: true, duplicate: true });
      return;
    }

    try {
      await eventRef.set({
        eventId: event.id,
        type: event.type,
        status: "processing",
        receivedAt: new Date().toISOString()
      });

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const metadata = session.metadata || {};
        if (metadata.productType === "classroom_ticket") {
          const plan = getPlan(metadata.planId);
          if (!plan) throw new Error(`Unknown planId: ${metadata.planId}`);

          const sessionRef = db.collection("stripe_checkout_sessions").doc(session.id);
          const sessionDoc = await sessionRef.get();
          if (sessionDoc.exists && sessionDoc.data()?.status === "processed") {
            await eventRef.set({
              status: "skipped",
              processedAt: new Date().toISOString(),
              stripeCheckoutSessionId: session.id,
              details: "Checkout session was already fulfilled."
            }, { merge: true });
            res.json({ received: true, duplicateSession: true });
            return;
          }

          await sessionRef.set({
            stripeCheckoutSessionId: session.id,
            status: "processing",
            createdAt: new Date().toISOString(),
            eventId: event.id
          });

          // Stripeのカスタムフィールド（利用開始日）の選択値を取得し、契約開始日・終了日を判定する
          const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const todayStr = nowJst.toISOString().slice(0, 10);

          let contractStartDate = metadata.contractStartDate;
          let contractEndDate = metadata.contractEndDate;

          if (!contractStartDate) {
            let hasSelectedStart = false;
            if (session.custom_fields && Array.isArray(session.custom_fields)) {
              let startField = session.custom_fields.find(f => {
                const label = f.label && f.label.custom;
                return label && (
                  label.includes("利用開始") || 
                  label.includes("開始") || 
                  label.includes("時期") || 
                  label.includes("いつから") || 
                  label.includes("日付") || 
                  label.includes("日程")
                );
              });
              
              // マッチするラベルがない場合のフォールバック: 最初のドロップダウンを使用
              if (!startField && session.custom_fields.length > 0) {
                startField = session.custom_fields.find(f => f.type === "dropdown");
              }

              if (startField && startField.type === "dropdown" && startField.dropdown && startField.dropdown.value) {
                const selectedValue = startField.dropdown.value;
                hasSelectedStart = true;
                if (
                  selectedValue.includes("翌月") || 
                  selectedValue.includes("来月") || 
                  selectedValue.includes("翌月から") || 
                  selectedValue.includes("来月から")
                ) {
                  // 翌月1日〜翌月末日
                  const nextMonthFirst = new Date(nowJst.getFullYear(), nowJst.getMonth() + 1, 1);
                  const startYear = nextMonthFirst.getFullYear();
                  const startMonth = String(nextMonthFirst.getMonth() + 1).padStart(2, '0');
                  contractStartDate = `${startYear}-${startMonth}-01`;

                  const nextMonthLast = new Date(nowJst.getFullYear(), nowJst.getMonth() + 2, 0);
                  const endYear = nextMonthLast.getFullYear();
                  const endMonth = String(nextMonthLast.getMonth() + 1).padStart(2, '0');
                  const endDay = String(nextMonthLast.getDate()).padStart(2, '0');
                  contractEndDate = `${endYear}-${endMonth}-${endDay}`;
                } else {
                  // 即時（本日〜30日後）
                  contractStartDate = todayStr;
                  contractEndDate = addDaysDateOnly(contractStartDate, plan.durationDays);
                }
              }
            }

            // カスタムフィールドが取得できなかった場合のデフォルトは即時開始（本日〜30日後）
            if (!hasSelectedStart) {
              contractStartDate = todayStr;
              contractEndDate = addDaysDateOnly(contractStartDate, plan.durationDays);
            }
          } else {
            // メタデータで開始日が直接指定されている場合
            if (!contractEndDate) {
              contractEndDate = addDaysDateOnly(contractStartDate, plan.durationDays);
            }
          }

          const issue = await issueClassroomTicket({
            orgName: metadata.orgName || "教室",
            contactEmail: metadata.contactEmail || session.customer_details?.email || session.customer_email || "",
            plan,
            contractStartDate: contractStartDate,
            contractEndDate: contractEndDate, // ここを追加して連動
            stripeData: {
              customerId: typeof session.customer === "string" ? session.customer : null,
              checkoutSessionId: session.id,
              paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null
            }
          });

          await eventRef.set({
            status: "processed",
            processedAt: new Date().toISOString(),
            stripeCheckoutSessionId: session.id,
            targetOrgId: issue.orgId,
            details: `Issued ${plan.seats} classroom accounts.`
          }, { merge: true });
          await sessionRef.set({
            status: "processed",
            processedAt: new Date().toISOString(),
            targetOrgId: issue.orgId
          }, { merge: true });
        } else {
          await eventRef.set({
            status: "skipped",
            processedAt: new Date().toISOString(),
            details: `Skipped productType=${metadata.productType || ""}`
          }, { merge: true });
        }
      } else {
        await eventRef.set({
          status: "skipped",
          processedAt: new Date().toISOString(),
          details: `Unhandled event type ${event.type}`
        }, { merge: true });
      }

      res.json({ received: true });
    } catch (err) {
      console.error("stripeWebhook processing failed", err);
      if (event?.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session?.id) {
          await db.collection("stripe_checkout_sessions").doc(session.id).set({
            status: "failed",
            failedAt: new Date().toISOString(),
            details: err.message || String(err)
          }, { merge: true });
        }
      }
      await eventRef.set({
        status: "failed",
        failedAt: new Date().toISOString(),
        details: err.message || String(err)
      }, { merge: true });
      res.status(500).send("Webhook processing failed.");
    }
  }
);

// 1. 独自IDログインAPI
export const loginWithPassword = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const { loginId, orgId, password, loginCode } = req.body || {};

    let targetOrgId = orgId;
    let targetLoginId = loginId;
    let isCodeLogin = false;

    if (loginCode) {
      const cleanCode = String(loginCode).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      if (cleanCode.length >= 10) {
        targetOrgId = cleanCode.substring(0, 8);
        targetLoginId = cleanCode.substring(8);
        isCodeLogin = true;
      } else {
        res.status(400).json({ ok: false, message: "ログインコードの形式がただしくないよ。AAAA-BBBB-01 のように入力してね。" });
        return;
      }
    } else {
      if (!loginId || !orgId || !password) {
        res.status(400).json({ ok: false, message: "がっこうID、ログインID、パスワードをすべて入力してね。" });
        return;
      }
    }

    try {
      // 複合クエリで生徒を検索
      const userQuery = await db.collection("users")
        .where("orgId", "==", targetOrgId)
        .where("loginId", "==", targetLoginId)
        .limit(1)
        .get();

      if (userQuery.empty) {
        res.status(401).json({ ok: false, message: isCodeLogin ? "ログインコードがちがうよ。" : "IDまたはパスワードがちがうよ。" });
        return;
      }

      const userDoc = userQuery.docs[0];
      const userData = userDoc.data();

      // アカウントロックの確認
      const now = Date.now();
      const lockUntil = userData.lockUntil ? new Date(userData.lockUntil).getTime() : 0;
      if (lockUntil > now) {
        const minutesLeft = Math.ceil((lockUntil - now) / 60000);
        res.status(403).json({ ok: false, message: `なんどもまちがえたため、あと ${minutesLeft} 分ロックされているよ。` });
        return;
      }

      // コードログインの場合はパスワード検証をスキップ
      if (!isCodeLogin) {
        // パスワードの検証
        const isMatch = verifyPassword(password, userData.passwordHash);
        if (!isMatch) {
          const attempts = (userData.loginAttempts || 0) + 1;
          const updateFields = { loginAttempts: attempts };
          
          if (attempts >= 5) {
            updateFields.lockUntil = new Date(now + 5 * 60 * 1000).toISOString(); // 5分ロック
            updateFields.loginAttempts = 0; // リセット
          }
          await userDoc.ref.update(updateFields);

          const left = 5 - (attempts % 5);
          res.status(401).json({ ok: false, message: attempts >= 5 ? "5回まちがえたため、5分間ロックしたよ。" : `IDまたはパスワードがちがうよ。（あと${left}回でロックされます）` });
          return;
        }
      }

      // 成功時はAttemptsをクリア
      await userDoc.ref.update({ loginAttempts: 0, lockUntil: null });

      // Custom Claimsに orgId と role を含めてカスタムトークンを生成
      const customToken = await authAdmin.createCustomToken(userDoc.id, {
        orgId: targetOrgId,
        role: userData.role || "student"
      });

      res.json({
        ok: true,
        customToken,
        orgId: targetOrgId,
        organizationId: targetOrgId,
        nickname: userData.nickname || targetLoginId,
        paidUntil: userData.paidUntil || null,
        seatStatus: userData.seatStatus || "active"
      });
    } catch (err) {
      console.error("loginWithPassword API error", err);
      res.status(500).json({ ok: false, message: "ログイン処理でエラーが発生したよ。" });
    }
  }
);

// 1.5 教室管理者ログインAPI
export const loginClassroomManager = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const { orgId, password } = req.body || {};
    if (!orgId || !password) {
      res.status(400).json({ ok: false, message: "学校/塾IDとパスワードを入力してね。" });
      return;
    }

    const cleanOrgId = String(orgId).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

    try {
      const orgDoc = await db.collection("organizations").doc(cleanOrgId).get();
      if (!orgDoc.exists) {
        res.status(401).json({ ok: false, message: "学校/塾IDまたはパスワードがちがうよ。" });
        return;
      }

      const orgData = orgDoc.data();
      if (!orgData.passwordHash) {
        res.status(400).json({ ok: false, message: "このアカウントには管理用パスワードが設定されていません。" });
        return;
      }

      const isMatch = verifyPassword(password, orgData.passwordHash);
      if (!isMatch) {
        res.status(401).json({ ok: false, message: "学校/塾IDまたはパスワードがちがうよ。" });
        return;
      }

      // 管理者用のカスタムトークンを発行
      const customToken = await authAdmin.createCustomToken(`manager_${cleanOrgId}`, {
        orgId: cleanOrgId,
        role: "classroom_manager"
      });

      res.json({
        ok: true,
        customToken,
        orgId: cleanOrgId,
        orgName: orgData.orgName || ""
      });
    } catch (err) {
      console.error("loginClassroomManager API error", err);
      res.status(500).json({ ok: false, message: "ログイン処理でエラーが発生したよ。" });
    }
  }
);

// 1.6 管理者向けログインコード一覧メール再送API
export const resendLoginCodes = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const { orgId, password } = req.body || {};
    if (!orgId || !password) {
      res.status(400).json({ ok: false, message: "学校/塾IDとパスワードを入力してね。" });
      return;
    }

    const cleanOrgId = String(orgId).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

    try {
      const orgDoc = await db.collection("organizations").doc(cleanOrgId).get();
      if (!orgDoc.exists) {
        res.status(401).json({ ok: false, message: "学校/塾IDまたはパスワードがちがうよ。" });
        return;
      }

      const orgData = orgDoc.data();
      if (!orgData.passwordHash) {
        res.status(400).json({ ok: false, message: "このアカウントには管理用パスワードが設定されていません。" });
        return;
      }

      const isMatch = verifyPassword(password, orgData.passwordHash);
      if (!isMatch) {
        res.status(401).json({ ok: false, message: "学校/塾IDまたはパスワードがちがうよ。" });
        return;
      }

      // ticket_issues から情報をロード
      const issueDoc = await db.collection("ticket_issues").doc(cleanOrgId).get();
      if (!issueDoc.exists) {
        res.status(404).json({ ok: false, message: "該当するチケット発行履歴が見つかりません。" });
        return;
      }

      const issueData = issueDoc.data();
      const { managerPassword } = issueData;
      const contactEmail = orgData.contactEmail || issueData.contactEmail;

      if (!contactEmail) {
        res.status(400).json({ ok: false, message: "登録されている連絡先メールアドレスが見つかりません。" });
        return;
      }

      // ユーザー一覧からログインコードを取得、または ticket_issues から
      let accounts = issueData.accounts || [];
      if (accounts.length === 0) {
        // バックアップとして users からクエリ
        const userQuery = await db.collection("users")
          .where("orgId", "==", cleanOrgId)
          .where("role", "==", "student")
          .get();
        
        accounts = userQuery.docs.map(doc => {
          const u = doc.data();
          return {
            loginId: u.loginId,
            nickname: u.nickname,
            loginCode: u.loginCode || `${cleanOrgId.substring(0, 4)}-${cleanOrgId.substring(4)}-${u.loginId}`
          };
        });
      }

      if (accounts.length === 0) {
        res.status(400).json({ ok: false, message: "このクラスに生徒アカウントが登録されていません。" });
        return;
      }

      // メール再送
      await sendCredentialsEmail({
        contactEmail,
        orgId: cleanOrgId,
        managerPassword,
        accounts
      });

      res.json({ ok: true, message: `${contactEmail} 宛てにメールを再送しました。` });
    } catch (err) {
      console.error("resendLoginCodes API error", err);
      res.status(500).json({ ok: false, message: "メールの再送処理に失敗しました。" });
    }
  }
);

// 2. 生徒個別作成API
export const createStudent = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    const { orgId, loginId, nickname, password } = req.body || {};
    if (!orgId || !loginId || !nickname || !password) {
      res.status(400).json({ ok: false, message: "必要なパラメータが不足しています。" });
      return;
    }

    try {
      const result = await db.runTransaction(async (transaction) => {
        // 1. 組織のライセンス空き状況確認
        const orgRef = db.collection("organizations").doc(orgId);
        const orgDoc = await transaction.get(orgRef);
        if (!orgDoc.exists) throw new Error("組織が見つかりません。");

        const orgData = orgDoc.data();
        const limit = orgData.licenseCount || 0;
        const currentActive = orgData.activeLicenseCount || 0;
        if (currentActive >= limit) throw new Error("契約枠の上限を超えています。");

        // 2. 重複チェック
        const duplicateQuery = db.collection("users")
          .where("orgId", "==", orgId)
          .where("loginId", "==", loginId);
        const duplicateSnap = await transaction.get(duplicateQuery);
        if (!duplicateSnap.empty) throw new Error("同じ組織内に同一ログインIDが既に登録されています。");

        // 3. 生徒ドキュメント作成 (UIDはランダムUUID)
        const studentUid = crypto.randomUUID();
        const studentRef = db.collection("users").doc(studentUid);
        const passwordHash = hashPassword(password);

        transaction.set(studentRef, {
          uid: studentUid,
          loginId,
          nickname,
          passwordHash,
          orgId,
          organizationId: orgId,
          schoolId: orgId,
          role: "student",
          authType: "school_id",
          licenseState: "paid",
          paidUntil: orgData.contractEndDate || null,
          seatStatus: "active",
          loginType: "password",
          coins: 150,
          slotsMax: 2,
          ownedImages: [],
          ownedFamTypes: ["tora", "robo", "fairy"],
          ownedMiscItems: [],
          famType: "tora",
          unlockedAchievements: [],
          bgType: "color",
          bgColor: "#FDFBF7",
          bgImage: "default",
          ownedBgImages: ["bg_stars.png"],
          createdAt: new Date().toISOString()
        });

        // 4. カウントインクリメント
        transaction.update(orgRef, { activeLicenseCount: currentActive + 1 });

        return { studentUid };
      });

      const decodedToken = await authAdmin.verifyIdToken(req.headers.authorization.substring(7));
      await writeAuditLog(decodedToken.uid, "createStudent", orgId, `Created student ${loginId} (${nickname}).`, getClientIp(req));

      res.json({ ok: true, uid: result.studentUid });
    } catch (err) {
      console.error("createStudent failed", err);
      res.status(400).json({ ok: false, message: err.message });
    }
  }
);

// 3. 生徒一括作成API
export const bulkCreateStudents = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    const { orgId, students } = req.body || {};
    if (!orgId || !Array.isArray(students) || students.length === 0) {
      res.status(400).json({ ok: false, message: "パラメータが不正です。" });
      return;
    }

    try {
      const results = [];
      const errors = [];

      for (let i = 0; i < students.length; i++) {
        const s = students[i];
        const cleanLoginId = String(s.loginId || "").replace(/\s/g, "");
        const cleanNickname = String(s.nickname || "").trim();
        const password = String(s.password || "").trim();

        if (!cleanLoginId || !cleanNickname || !password || password.length < 6) {
          errors.push({ index: i, line: i + 1, message: "ID/ニックネームが空、またはパスワードが短すぎます（6文字以上）。" });
          continue;
        }

        try {
          const uid = await db.runTransaction(async (transaction) => {
            const orgRef = db.collection("organizations").doc(orgId);
            const orgDoc = await transaction.get(orgRef);
            if (!orgDoc.exists) throw new Error("組織が見つかりません。");

            const orgData = orgDoc.data();
            const limit = orgData.licenseCount || 0;
            const currentActive = orgData.activeLicenseCount || 0;
            if (currentActive >= limit) throw new Error("契約枠の上限を超えています。");

            const duplicateQuery = db.collection("users")
              .where("orgId", "==", orgId)
              .where("loginId", "==", cleanLoginId);
            const duplicateSnap = await transaction.get(duplicateQuery);
            if (!duplicateSnap.empty) throw new Error(`ログインID 「${cleanLoginId}」 は既に登録されています。`);

            const studentUid = crypto.randomUUID();
            const studentRef = db.collection("users").doc(studentUid);
            const passwordHash = hashPassword(password);

            transaction.set(studentRef, {
              uid: studentUid,
              loginId: cleanLoginId,
              nickname: cleanNickname,
              passwordHash,
              orgId,
              organizationId: orgId,
              schoolId: orgId,
              role: "student",
              authType: "school_id",
              licenseState: "paid",
              paidUntil: orgData.contractEndDate || null,
              seatStatus: "active",
              loginType: "password",
              coins: 150,
              slotsMax: 2,
              ownedImages: [],
              ownedFamTypes: ["tora", "robo", "fairy"],
              ownedMiscItems: [],
              famType: "tora",
              unlockedAchievements: [],
              bgType: "color",
              bgColor: "#FDFBF7",
              bgImage: "default",
              ownedBgImages: ["bg_stars.png"],
              createdAt: new Date().toISOString()
            });

            transaction.update(orgRef, { activeLicenseCount: currentActive + 1 });
            return studentUid;
          });
          results.push({ loginId: cleanLoginId, uid });
        } catch (itemErr) {
          errors.push({ index: i, line: i + 1, loginId: cleanLoginId, message: itemErr.message });
        }
      }

      const decodedToken = await authAdmin.verifyIdToken(req.headers.authorization.substring(7));
      await writeAuditLog(decodedToken.uid, "bulkCreateStudents", orgId, `Bulk created ${results.length} students. Errors: ${errors.length}`, getClientIp(req));

      res.json({ ok: true, createdCount: results.length, results, errors });
    } catch (err) {
      console.error("bulkCreateStudents failed", err);
      res.status(500).json({ ok: false, message: "一括作成中にエラーが発生しました。" });
    }
  }
);

// 4. 生徒転校（所属変更）API
export const transferStudent = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    const { studentUid, newOrgId } = req.body || {};
    if (!studentUid || !newOrgId) {
      res.status(400).json({ ok: false, message: "必要なパラメータが不足しています。" });
      return;
    }

    try {
      await db.runTransaction(async (transaction) => {
        const studentRef = db.collection("users").doc(studentUid);
        const studentDoc = await transaction.get(studentRef);
        if (!studentDoc.exists) throw new Error("生徒情報が見つかりません。");

        const studentData = studentDoc.data();
        const oldOrgId = studentData.orgId;
        if (oldOrgId === newOrgId) return;

        // 転入先（新校）の上限チェックとインクリメント
        const newOrgRef = db.collection("organizations").doc(newOrgId);
        const newOrgDoc = await transaction.get(newOrgRef);
        if (!newOrgDoc.exists) throw new Error("転入先の学校・組織が見つかりません。");

        const newOrgData = newOrgDoc.data();
        const newLimit = newOrgData.licenseCount || 0;
        const newActive = newOrgData.activeLicenseCount || 0;
        if (newActive >= newLimit) throw new Error("転入先の学校・組織の契約上限に達しています。");

        transaction.update(newOrgRef, { activeLicenseCount: newActive + 1 });

        // 転出元（旧校）のデクリメント
        if (oldOrgId) {
          const oldOrgRef = db.collection("organizations").doc(oldOrgId);
          const oldOrgDoc = await transaction.get(oldOrgRef);
          if (oldOrgDoc.exists) {
            const oldActive = oldOrgDoc.data().activeLicenseCount || 0;
            transaction.update(oldOrgRef, { activeLicenseCount: Math.max(0, oldActive - 1) });
          }
        }

        // 生徒所属の更新
        transaction.update(studentRef, { orgId: newOrgId });
      });

      const decodedToken = await authAdmin.verifyIdToken(req.headers.authorization.substring(7));
      await writeAuditLog(decodedToken.uid, "transferStudent", newOrgId, `Transferred user ${studentUid} to ${newOrgId}.`, getClientIp(req));

      res.json({ ok: true });
    } catch (err) {
      console.error("transferStudent failed", err);
      res.status(400).json({ ok: false, message: err.message });
    }
  }
);

// 5. 組織契約一括更新API
export const updateOrganizationContract = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    const { orgIds, contractStartDate, contractEndDate, status } = req.body || {};
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      res.status(400).json({ ok: false, message: "対象の組織ID(orgIds)がありません。" });
      return;
    }

    try {
      const batch = db.batch();
      const updateData = {};
      if (contractStartDate) updateData.contractStartDate = contractStartDate;
      if (contractEndDate) updateData.contractEndDate = contractEndDate;
      if (status) updateData.status = status;
      updateData.updatedAt = new Date().toISOString();

      orgIds.forEach(orgId => {
        const ref = db.collection("organizations").doc(orgId);
        batch.set(ref, updateData, { merge: true });
      });

      await batch.commit();

      const decodedToken = await authAdmin.verifyIdToken(req.headers.authorization.substring(7));
      await writeAuditLog(decodedToken.uid, "updateContract", "", `Bulk updated contract for orgs: ${orgIds.join(", ")}`, getClientIp(req));

      res.json({ ok: true });
    } catch (err) {
      console.error("updateOrganizationContract failed", err);
      res.status(500).json({ ok: false, message: err.message });
    }
  }
);

// 6. 生徒一覧取得API (ページネーション＆簡易検索)
export const listStudents = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    const { orgId, searchWord, limit = 50, startAfterId } = req.body || {};
    if (!orgId) {
      res.status(400).json({ ok: false, message: "がっこうIDが指定されていません。" });
      return;
    }

    try {
      let q = db.collection("users")
        .where("orgId", "==", orgId)
        .orderBy("loginId", "asc");

      if (startAfterId) {
        const startAfterDoc = await db.collection("users").doc(startAfterId).get();
        if (startAfterDoc.exists) {
          q = q.startAfter(startAfterDoc);
        }
      }

      const snap = await q.limit(limit).get();
      let usersList = [];
      snap.forEach(d => {
        const u = d.data();
        usersList.push({
          uid: u.uid,
          loginId: u.loginId,
          nickname: u.nickname,
          role: u.role,
          createdAt: u.createdAt,
          loginAttempts: u.loginAttempts || 0,
          lockUntil: u.lockUntil || null
        });
      });

      if (searchWord) {
        const sw = searchWord.toLowerCase().trim();
        usersList = usersList.filter(u => 
          (u.loginId || "").toLowerCase().includes(sw) || 
          (u.nickname || "").toLowerCase().includes(sw)
        );
      }

      res.json({ ok: true, users: usersList });
    } catch (err) {
      console.error("listStudents failed", err);
      res.status(500).json({ ok: false, message: err.message });
    }
  }
);

// 7. 管理者による生徒パスワードリセットAPI
export const resetStudentPassword = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, message: "Method Not Allowed" }); return; }

    const isAdminAuth = await verifyAdmin(req);
    if (!isAdminAuth) { res.status(403).json({ ok: false, message: "Forbidden" }); return; }

    const { studentUid, newPassword } = req.body || {};
    if (!studentUid || !newPassword || newPassword.length < 6) {
      res.status(400).json({ ok: false, message: "パラメータ不足、またはパスワードが短すぎます。" });
      return;
    }

    try {
      const userRef = db.collection("users").doc(studentUid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) throw new Error("生徒が見つかりません。");

      const passwordHash = hashPassword(newPassword);
      await userRef.update({
        passwordHash,
        loginAttempts: 0,
        lockUntil: null
      });

      const decodedToken = await authAdmin.verifyIdToken(req.headers.authorization.substring(7));
      await writeAuditLog(decodedToken.uid, "resetPassword", userDoc.data().orgId || "", `Reset password for user ${studentUid}.`, getClientIp(req));

      res.json({ ok: true });
    } catch (err) {
      console.error("resetPassword failed", err);
      res.status(400).json({ ok: false, message: err.message });
    }
  }
);

// 8. 公開作品一覧API
export const listWorks = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const rawLimit = Number(req.query?.limit || 100);
    const maxCount = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 100);

    try {
      const snap = await db
        .collection("works")
        .where("visibility", "==", "public")
        .limit(maxCount)
        .get();
      const works = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.deleted === true || data.blocked === true) return;
        works.push({ id: docSnap.id, ...data });
      });
      works.sort((a, b) => workCreatedAtMs(b) - workCreatedAtMs(a));
      res.json({ ok: true, works });
    } catch (error) {
      console.error("listWorks failed", error);
      res.status(500).json({ ok: false, message: "作品一覧を取得できませんでした。" });
    }
  }
);

// 9. 作品プレイ回数API
export const playWork = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const path = req.originalUrl || req.path || "";
    const match = path.match(/\/api\/works\/([a-zA-Z0-9_-]+)\/play/);
    if (!match) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    try {
      const docRef = db.collection("works").doc(match[1]);
      const existingDoc = await docRef.get();
      if (!existingDoc.exists) {
        res.status(404).json({ ok: false, message: "作品が見つかりません。" });
        return;
      }
      await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(docRef);
        const data = docSnap.data();
        transaction.update(docRef, {
          playCount: Math.max(0, Number(data.playCount) || 0) + 1,
          weekPlays: Math.max(0, Number(data.weekPlays) || 0) + 1,
          updatedAt: new Date().toISOString()
        });
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("playWork failed", error);
      res.status(500).json({ ok: false, message: "プレイ回数を記録できませんでした。" });
    }
  }
);

// 10. 作品いいねAPI
export const likeWork = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (!["PUT", "DELETE"].includes(req.method)) {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const path = req.originalUrl || req.path || "";
    const match = path.match(/\/api\/works\/([a-zA-Z0-9_-]+)\/like/);
    if (!match) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    try {
      const delta = req.method === "PUT" ? 1 : -1;
      const docRef = db.collection("works").doc(match[1]);
      const existingDoc = await docRef.get();
      if (!existingDoc.exists) {
        res.status(404).json({ ok: false, message: "作品が見つかりません。" });
        return;
      }
      await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(docRef);
        const data = docSnap.data();
        transaction.update(docRef, {
          likeCount: Math.max(0, (Number(data.likeCount) || 0) + delta),
          updatedAt: new Date().toISOString()
        });
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("likeWork failed", error);
      res.status(500).json({ ok: false, message: "いいねを記録できませんでした。" });
    }
  }
);

// 11. 作品リアクションAPI
export const react = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const path = req.originalUrl || req.path || "";
    const match = path.match(/\/api\/works\/([a-zA-Z0-9_-]+)\/react/);
    if (!match) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }
    const id = match[1];
    const { type } = req.body || {};
    if (!type || !["fun", "wow", "again"].includes(type)) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }

    try {
      const docRef = db.collection("works").doc(id);
      const existingDoc = await docRef.get();
      if (!existingDoc.exists) {
        res.status(404).json({ ok: false, message: "作品が見つかりません。" });
        return;
      }
      await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(docRef);
        const data = docSnap.data();
        const reactionCounts = data.reactionCounts || { fun: 0, wow: 0, again: 0 };
        reactionCounts[type] = (reactionCounts[type] || 0) + 1;
        transaction.update(docRef, { reactionCounts });
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("react failed", error);
      res.status(500).json({ ok: false, message: "リアクションを記録できませんでした。" });
    }
  }
);

export const apiHealth = onRequest(
  {
    region: "us-central1",
    cors: true,
    invoker: "public"
  },
  (req, res) => {
    res.status(200).json({
      ok: true,
      service: "firebase-foundation",
      timestamp: new Date().toISOString()
    });
  }
);

// =========================================================================
// ==================== Pro版コーダー（複数ファイル生成） ==================
// =========================================================================
// 無料版（generate / refine / checkSafety）には一切触れない。
// ここから下は corderpro.html 専用の追加エンドポイント。

// 外部API許可リスト（キー不要・CORS対応・安全なもののみ）。
// 配列を書き換えるだけで増減できる。AIプロンプトにもこのリストを埋め込む。
const ALLOWED_API_HOSTS_INFO = [
  { host: "api.open-meteo.com", desc: "天気予報" },
  { host: "geocoding-api.open-meteo.com", desc: "地名→緯度経度" },
  { host: "pokeapi.co", desc: "ポケモン図鑑" },
  { host: "zipcloud.ibsnet.co.jp", desc: "郵便番号→住所" },
  { host: "restcountries.com", desc: "世界の国データ" },
  { host: "api.dictionaryapi.dev", desc: "英英辞書" },
  { host: "ja.wikipedia.org", desc: "Wikipedia検索" }
];
const ALLOWED_API_HOSTS = ALLOWED_API_HOSTS_INFO.map((h) => h.host);

// Pro版バリデーション用の定数
const PRO_ALLOWED_EXT = ["html", "css", "js", "json", "md", "txt"];
const PRO_PATH_REGEX = /^[a-zA-Z0-9_\-]+(\/[a-zA-Z0-9_\-]+)*\.(html|css|js|json|md|txt)$/;
const PRO_MAX_DEPTH = 2;          // パスのセグメント数（例: css/style.css = 2）まで
const PRO_MAX_FILES = 20;
const PRO_MAX_FILE_BYTES = 200 * 1024; // 1ファイル 200KB（UTF-8バイト長）

// Pro版で禁止し続けるパターン（無料版 FORBIDDEN_PATTERNS の流用改変はしない・独立定義）。
// fetch / XMLHttpRequest / localStorage は Pro版では許可するため含めない。
const PRO_FORBIDDEN_PATTERNS = [
  { pattern: /\beval\s*\(/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /new\s+Function\s*\(/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /WebSocket/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /<iframe/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /<object/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /<embed/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /window\.open\s*\(/i, errorCode: "DANGEROUS_PATTERN" },
  { pattern: /location\s*\.\s*(href|replace|assign)/i, errorCode: "DANGEROUS_PATTERN" }
];

const PRO_JS_DANGER_PATTERNS = [
  /while\s*\(\s*true\s*\)/i,
  /while\s*\(\s*1\s*\)/i,
  /for\s*\(\s*;\s*;\s*\)/i
];

// Pro版で追加する日本語エラーメッセージ（無料版 ERROR_MESSAGES は無変更で流用）。
const PRO_ERROR_MESSAGES = {
  PRO_NO_FILES: "ファイルが作られなかったみたい。もう一度指示してみよう",
  PRO_TOO_MANY_FILES: "ファイルが多すぎるよ（最大20個まで）。もう少しまとめてみよう",
  PRO_BAD_PATH: "使えないファイル名かフォルダの深さがあるよ。シンプルな構成にしてみよう",
  PRO_FILE_TOO_LARGE: "1つのファイルが大きすぎるよ（200KBまで）。分けるか短くしてみよう",
  PRO_NO_INDEX: "index.html が見つからないよ。トップページを作るよう指示してみよう"
};

function proErrorMessage(code) {
  return PRO_ERROR_MESSAGES[code] || ERROR_MESSAGES[code] || ERROR_MESSAGES.UNSAFE_CODE;
}

// 1ファイル分の中身から、AIが付けがちなコードブロック記号(```)を取り除く。
function stripProContentFences(content) {
  let c = String(content ?? "").replace(/^﻿/, "").trim();
  c = c.replace(/^```[a-zA-Z0-9]*[ \t]*\r?\n?/, "");
  c = c.replace(/\r?\n?```[ \t]*$/, "");
  return c.trim();
}

// 区切り形式のテキストを [{path, content}] と削除パス一覧にパースする。
//   ===FILE: path===
//   （内容）
//   ===DELETE: path===
//   ===END===
// マーカー行より前の前置き文や ===END=== より後ろは無視する。
function parseProFiles(raw) {
  const text = String(raw ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const files = [];
  const deleted = [];
  let current = null;

  const flush = () => {
    if (current) {
      files.push({ path: current.path, content: stripProContentFences(current.lines.join("\n")) });
      current = null;
    }
  };

  for (const line of lines) {
    const fileMatch = line.match(/^===FILE:\s*(.+?)\s*===\s*$/);
    const delMatch = line.match(/^===DELETE:\s*(.+?)\s*===\s*$/);
    const endMatch = /^===END===\s*$/.test(line);
    if (fileMatch) {
      flush();
      current = { path: fileMatch[1].trim(), lines: [] };
    } else if (delMatch) {
      flush();
      deleted.push(delMatch[1].trim());
    } else if (endMatch) {
      flush();
      break;
    } else if (current) {
      current.lines.push(line);
    }
    // マーカー前の行（前置き）は無視
  }
  flush();
  return { files, deleted };
}

// コード中の http/https URL リテラルからホスト名を抽出する。
function extractUrlHosts(text) {
  const hosts = [];
  const re = /https?:\/\/([a-zA-Z0-9.\-]+)/gi;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    hosts.push(m[1].toLowerCase());
  }
  return hosts;
}

// リクエストの files に変更・削除をマージした結果を返す（順序は元→新規追加）。
function mergeProFiles(baseFiles, changedFiles, deletedPaths) {
  const map = new Map();
  for (const f of baseFiles) {
    map.set(f.path, { path: f.path, content: String(f.content ?? "") });
  }
  for (const f of changedFiles) {
    map.set(f.path, { path: f.path, content: String(f.content ?? "") });
  }
  for (const p of deletedPaths) {
    map.delete(p);
  }
  return Array.from(map.values());
}

// Pro版の安全チェック（設計書 5-3）。ok:false のとき errorCode を添えて返す。
function checkSafetyPro(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, errorCode: "PRO_NO_FILES" };
  }
  if (files.length > PRO_MAX_FILES) {
    return { ok: false, errorCode: "PRO_TOO_MANY_FILES" };
  }

  let hasIndex = false;
  for (const f of files) {
    const filePath = String(f?.path || "");
    const content = String(f?.content ?? "");

    // パス検証（拡張子6種・使用可能文字・.. や先頭 / を禁止）
    if (!PRO_PATH_REGEX.test(filePath)) {
      return { ok: false, errorCode: "PRO_BAD_PATH" };
    }
    // フォルダ深さ（セグメント数）2階層まで
    if (filePath.split("/").length > PRO_MAX_DEPTH) {
      return { ok: false, errorCode: "PRO_BAD_PATH" };
    }
    // 1ファイル 200KB（UTF-8バイト長）
    if (Buffer.byteLength(content, "utf8") > PRO_MAX_FILE_BYTES) {
      return { ok: false, errorCode: "PRO_FILE_TOO_LARGE" };
    }
    if (filePath === "index.html") hasIndex = true;

    // 危険パターン（eval / new Function / WebSocket / iframe など）
    for (const { pattern, errorCode } of PRO_FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) return { ok: false, errorCode };
    }
    // 無限ループ
    for (const pattern of PRO_JS_DANGER_PATTERNS) {
      if (pattern.test(content)) return { ok: false, errorCode: "DANGEROUS_PATTERN" };
    }
    // setInterval の間隔 50ms 未満は禁止
    for (const match of content.matchAll(/setInterval\s*\([^,]+,\s*(\d+)/gi)) {
      if (Number.parseInt(match[1], 10) < 50) {
        return { ok: false, errorCode: "DANGEROUS_PATTERN" };
      }
    }
    // 外部URLは許可リストのホストのみ（fetch/XHRは許可だが宛先を制限）
    for (const host of extractUrlHosts(content)) {
      if (!ALLOWED_API_HOSTS.includes(host)) {
        return { ok: false, errorCode: "EXTERNAL_ACCESS" };
      }
    }
  }

  if (!hasIndex) {
    return { ok: false, errorCode: "PRO_NO_INDEX" };
  }
  return { ok: true };
}

function proImageInstructions(images) {
  if (!Array.isArray(images) || images.length === 0) return "";
  return `\n【使用可能な画像アセット】\n以下の画像素材のみを <img src="img/ファイル名"> の形で使用できます。インターネット上の画像や、これら以外の画像パスは絶対に使用しないでください。\n` +
    images.map((img) => `- img/${img}`).join("\n") + `\n`;
}

function proCommonRules() {
  const apiList = ALLOWED_API_HOSTS_INFO
    .map((h) => `  - https://${h.host}（${h.desc}）`)
    .join("\n");
  return `【作れるファイルの種類】
- 拡張子は .html .css .js .json .md .txt の6種類のみ。画像などのバイナリは作れません。
- ファイルは最大20個まで。フォルダの深さは2階層まで（例: css/style.css、js/app.js）。
- index.html は必ず含めてください（トップページ・必須）。

【外部通信のルール】
- fetch / XMLHttpRequest は使えますが、通信先は次のAPIのホストだけに限られます。これ以外のURLは書かないでください。
${apiList}
- localStorage は使ってかまいません。

【禁止事項（守らないと差し戻されます）】
- eval, new Function, WebSocket は禁止
- iframe, object, embed は禁止
- window.open, location の変更（location.href/replace/assign）は禁止
- while(true) などの無限ループは禁止。setInterval の間隔は 50ms 以上にする`;
}

function proOutputFormatRules() {
  return `【出力形式（厳守）】
- 各ファイルを次の区切り形式で出力してください。ファイルの中身以外の説明文やコードブロック記号(\`\`\`)は書かないでください。

===FILE: index.html===
（index.html の中身）
===FILE: css/style.css===
（css/style.css の中身）
===END===

- 1行目の ===FILE: ... === と最後の ===END=== は必ず付けてください。`;
}

function buildProGeneratePrompt(prompt, images) {
  return `あなたは高校生向けの安全なWebアプリ生成AIです。
指示に従って、疑似フォルダ構成を持つ複数ファイルのミニWebアプリを作ってください。

${proCommonRules()}
${proImageInstructions(images)}
【教育的配慮】
- 高校生が読んで理解できるシンプルなコードにする。
- 変数名は意味のわかる名前にする。
- 不適切な内容は安全な代替案に置き換える。

${proOutputFormatRules()}

【ユーザー指示】
${prompt}`;
}

function buildProRefinePrompt(files, instruction, promptHistory) {
  let appPurpose = "";
  let historyText = "";
  if (Array.isArray(promptHistory) && promptHistory.length > 0) {
    const initial = promptHistory[0];
    const initialText = typeof initial === "string" ? initial : (initial?.text || "");
    if (initialText) appPurpose = `【アプリ全体の目的・初回指示】\n${initialText}\n`;
    const rest = promptHistory.slice(1);
    if (rest.length > 0) {
      historyText = `【これまでの修正指示（古い順）】\n` +
        rest.map((h, i) => `- 修正${i + 1}: ${typeof h === "string" ? h : (h?.text || "")}`).join("\n") + `\n`;
    }
  }

  const filesBlock = files
    .map((f) => `===FILE: ${f.path}===\n${String(f.content ?? "")}`)
    .join("\n") + "\n===END===";

  return `あなたは高校生向けの安全なWebアプリ生成AIです。
既存の複数ファイルのミニWebアプリを、修正指示に従って更新してください。

${appPurpose}${historyText}【今回の修正指示】
${instruction}

${proCommonRules()}

【現在の全ファイル】
${filesBlock}

【出力形式（厳守）】
- 変更したファイルだけを ===FILE: パス=== 形式で返してください（変更のないファイルは出力しない）。
- ファイルを削除する場合は ===DELETE: パス=== の行で示してください。
- 最後に必ず ===END=== を付けてください。
- ファイルの中身以外の説明文やコードブロック記号(\`\`\`)は書かないでください。`;
}

async function generateProFilesRaw(prompt, images, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: buildProGeneratePrompt(prompt, images),
        config: {
          temperature: 0.7,
          maxOutputTokens: 32768
        }
      });
      return response.text || "";
    } catch (error) {
      lastError = error;
      if (![429, 503].includes(error?.status)) {
        throw error;
      }
      console.warn(`Gemini model ${model} unavailable (generatePro), trying fallback`, error?.status);
    }
  }
  throw lastError;
}

async function refineProFilesRaw(files, instruction, promptHistory, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: buildProRefinePrompt(files, instruction, promptHistory),
        config: {
          temperature: 0.7,
          maxOutputTokens: 32768
        }
      });
      return response.text || "";
    } catch (error) {
      lastError = error;
      if (![429, 503].includes(error?.status)) {
        throw error;
      }
      console.warn(`Gemini model ${model} unavailable (refinePro), trying fallback`, error?.status);
    }
  }
  throw lastError;
}

export const generatePro = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }
    const images = Array.isArray(req.body?.images) ? req.body.images : [];

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const raw = await generateProFilesRaw(prompt, images, apiKey);
      const { files } = parseProFiles(raw);

      const check = checkSafetyPro(files);
      if (!check.ok) {
        res.status(422).json({
          ok: false,
          errorCode: check.errorCode,
          message: proErrorMessage(check.errorCode)
        });
        return;
      }

      res.json({
        ok: true,
        files,
        generationId: crypto.randomUUID()
      });
    } catch (error) {
      console.error("generatePro failed", error);
      sendError(res, 500, "GEMINI_ERROR");
    }
  }
);

export const refinePro = onRequest(
  {
    region: "asia-northeast1",
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [geminiApiKey]
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "BAD_REQUEST");
      return;
    }

    const rawFiles = Array.isArray(req.body?.files) ? req.body.files : null;
    const instruction = String(req.body?.instruction || "").trim();
    if (!rawFiles || rawFiles.length === 0 || !instruction) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }
    // 入力ファイルの形を整える
    const baseFiles = rawFiles
      .filter((f) => f && typeof f.path === "string")
      .map((f) => ({ path: f.path, content: String(f.content ?? "") }));
    if (baseFiles.length === 0) {
      sendError(res, 400, "BAD_REQUEST");
      return;
    }
    const promptHistory = Array.isArray(req.body?.promptHistory) ? req.body.promptHistory : [];

    const apiKey = getAiKey();
    if (!apiKey) {
      res.status(500).json({
        ok: false,
        errorCode: "GEMINI_ERROR",
        message: "GEMINI_API_KEY が設定されていません"
      });
      return;
    }

    try {
      const raw = await refineProFilesRaw(baseFiles, instruction, promptHistory, apiKey);
      const { files: changed, deleted } = parseProFiles(raw);

      // リクエストの files に変更をマージした結果全体を検証する
      const merged = mergeProFiles(baseFiles, changed, deleted);
      const check = checkSafetyPro(merged);
      if (!check.ok) {
        res.status(422).json({
          ok: false,
          errorCode: check.errorCode,
          message: proErrorMessage(check.errorCode)
        });
        return;
      }

      res.json({
        ok: true,
        files: merged,
        deleted
      });
    } catch (error) {
      console.error("refinePro failed", error);
      sendError(res, 500, "GEMINI_ERROR");
    }
  }
);
