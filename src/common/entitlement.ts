/**
 * 权益网关（PRD-05）。集中管理「功能 → 是否需要会员」，便于后续接订单/分级。
 */
export type EntitlementFeature =
  | 'personalized_feedback' // 深度个性化学习建议（PRD-01 F1-4）
  | 'mock_interview' // AI 模拟面试（PRD-05 P2）
  | 'unlimited_ai'; // AI 无限问答

/** 是否为会员专享功能。 */
const MEMBER_ONLY: Record<EntitlementFeature, boolean> = {
  personalized_feedback: true,
  mock_interview: true,
  unlimited_ai: true,
};

export function isEntitled(
  feature: EntitlementFeature,
  ctx: { isMember: boolean }
): boolean {
  if (!MEMBER_ONLY[feature]) return true;
  return !!ctx.isMember;
}

/** 全部权益清单（供前端会员权益页/付费点展示）。 */
export const ENTITLEMENTS: { feature: EntitlementFeature; label: string }[] = [
  { feature: 'personalized_feedback', label: '测验后的个性化学习建议（站内复习推荐 + 针对练习）' },
  { feature: 'mock_interview', label: 'AI 模拟面试：真实追问与点评' },
  { feature: 'unlimited_ai', label: 'AI 问答无限次' },
];
