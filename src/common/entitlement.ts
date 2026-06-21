/**
 * 权益网关（PRD-01 F1-4 / PRD-05 占位）。
 * 第一期：深度个性化建议(personalized_feedback)等同会员权益。
 * 待 PRD-05 落地后在此扩展为按 feature 的细粒度权益判定。
 */
export type EntitlementFeature = 'personalized_feedback';

export function isEntitled(
  feature: EntitlementFeature,
  ctx: { isMember: boolean }
): boolean {
  switch (feature) {
    case 'personalized_feedback':
      return !!ctx.isMember;
    default:
      return false;
  }
}
