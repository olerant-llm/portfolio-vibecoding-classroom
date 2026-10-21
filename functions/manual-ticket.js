/**
 * 手動発行リクエストを構築・検証する
 * @param {any} body 
 * @returns 
 */
export function buildManualTicketIssueRequest(body) {
  const {
    orgName,
    contactEmail,
    plan,
    contractStartDate,
    contractEndDate,
    billingType,
    manualMemo
  } = body || {};

  if (!orgName || typeof orgName !== 'string' || !orgName.trim()) {
    throw new Error("組織名は必須です。");
  }
  if (!contactEmail || typeof contactEmail !== 'string' || !contactEmail.includes('@')) {
    throw new Error("有効な連絡先メールアドレスが必要です。");
  }
  if (!plan || typeof plan !== 'object') {
    throw new Error("プラン情報は必須です。");
  }
  if (!plan.planId || typeof plan.planId !== 'string') {
    throw new Error("プランIDは必須です。");
  }
  const seats = Number(plan.seats);
  if (isNaN(seats) || seats <= 0) {
    throw new Error("アカウント数は1以上の数値で指定してください。");
  }

  return {
    orgName: orgName.trim(),
    contactEmail: contactEmail.trim(),
    plan: {
      planId: plan.planId,
      seats: seats
    },
    contractStartDate: contractStartDate || new Date().toISOString().slice(0, 10),
    contractEndDate: contractEndDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    billingType: billingType || "manual",
    manualMemo: manualMemo || ""
  };
}

/**
 * ライフサイクルリクエストを構築・検証する
 * @param {any} body 
 * @param {any} options 
 * @returns 
 */
export function buildTicketLifecycleRequest(body, options = {}) {
  const { orgId, reason, confirm } = body || {};

  if (!orgId || typeof orgId !== 'string' || !orgId.trim()) {
    throw new Error("組織IDは必須です。");
  }

  if (options.requireConfirmation) {
    if (confirm !== true && body.confirmation !== true) {
      throw new Error("実行確認が必要です。");
    }
  }

  return {
    orgId: orgId.trim(),
    reason: reason || "No reason provided",
    confirm: !!confirm
  };
}
