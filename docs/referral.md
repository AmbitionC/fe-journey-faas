# 邀请裂变（各产品共用）

Agent Journey、Invest Journey、栗栗学英语（little-circle）共用一套手机号账户，邀请能力也只有一套：
规则在 `src/mcp/referral.ts`，奖励数值在 `REFERRAL_PROGRAMS`（Agent Journey 的数值真源是
`src/mcp/billing.ts` 的 `REFERRAL_REWARD` / `REFERRAL_DAYS`）。

## 规则（2026-11-05）

| 产品 | 好友注册：被邀请人 | 好友注册：邀请人 | 好友开会员：邀请人 |
|---|---|---|---|
| agent | 3 天会员 + 30 点 | 3 天会员 + 30 点 | 7 天会员 + 100 点 |
| invest | 30 点 | 30 点 | 100 点 |
| kids | 只记关系 | 只记关系 | — |

- owner 要求克制：邀请人靠「好友注册」拿的会员天数每月 ≤ 15 天、终身 ≤ 30 天；每月最多 10 位好友计奖。
  好友付费返的天数有真实收入对应，不计上限。
- 会员天数写 `member_entitlement`（source=referral），从当前会员到期日顺延；目前只有 Agent Journey 的会员判定认这张表，
  所以其他产品先配 0 天。
- 防刷：短信验证、自邀 / 互邀不认、同一邀请人 24 小时内同 IP 第二个注册冻结（记关系不发注册奖励）、月度 / 终身上限、
  非会员邀请人得的点记体验点（14 天到期）。
- 一个账户只有一个邀请人（`referral.invitee_id` 主键），`product` 记从哪个产品邀请来。

## 接入（新产品照这个做）

1. 进站时把地址里的 `?invite=<code>` 存下来（Agent Journey 存 localStorage 30 天，见前端 `src/utils/invite.ts`）。
2. 注册时带上：
   - 密码注册 `POST /user/create`：`inviteCode`、`referralProduct`
   - 短信登录自动建号 `POST /auth/sms/login`：`inviteCode`、`referralProduct`
   - 返回 `data.referral`：`{ status: 'rewarded' | 'held' | 'ignored', inviteeDays, inviteePoints, ... }`
3. 注册后 7 天内补填：`POST /referral/bind { code, product }`（需登录；失败时 message 是给用户看的话）。
4. 我的邀请：`GET /referral/me?product=`（邀请码、人数、得点、得天数、本月进度、`canBind`）。
5. 落地页：`GET /referral/program?product=&code=`（免登录；规则 + 邀请码是否有效 + 邀请人脱敏昵称）。
6. 新产品要加一个 `ReferralProduct` 值和一份 `REFERRAL_PROGRAMS` 配置；要送会员天数，先让该产品的会员判定认 `member_entitlement`。

埋点：`referral_signup`（props.via = signup / sms / bind）、`referral_member`。
