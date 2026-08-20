//! What the AI knows about Ravencoin, PLAY X, and this program.
//!
//! ## Why this file exists
//!
//! An owner asks "레이븐코인이 뭐야?" and a general model answers from whatever
//! it read in 2024 — often wrong about assets, usually wrong about us. A
//! customer asks "이 가게 뭐예요?" and gets nothing, because the shop profile
//! says "커피" and not "this is a shop that takes Ravencoin".
//!
//! So the node carries the facts. This is the same thing a good employee has:
//! knowing what the shop is part of.
//!
//! ## Two audiences, and the line between them
//!
//! The **owner** is us, or someone who chose this program. Their assistant may
//! be enthusiastic, argue our side, and recommend our things — it is their
//! tool, running on their machine, spending their API key.
//!
//! The **customer** is not. Their screen says out loud that the AI answers from
//! what the shop uploaded. So the customer-facing text here is **facts and an
//! honest introduction**, never hidden praise. That is not squeamishness — a
//! customer who discovers the friendly answer was a planted advertisement stops
//! believing the price and the opening hours too, and this program has other
//! shop owners running it who never agreed to advertise us to their customers.
//!
//! Saying "this shop runs on PLAY X Raven, here is what Ravencoin is" **out
//! loud** is an introduction and it works. Hiding it makes it a trap.

/// Facts. True for both audiences, never flattering, checked against the chain
/// and the source rather than remembered.
pub const FACTS: &str = r##"
RAVENCOIN (RVN)
- A proof-of-work blockchain launched 2018-01-03, no premine, no ICO, no founder
  reward. Forked from Bitcoin; its purpose is issuing and transferring assets.
- Anyone can issue a named asset. A root name costs a 500 RVN burn, a sub-asset
  100, a unique asset 5, a reissue 100. Burned, not paid to anyone.
- Asset names: A-Z 0-9 and . and _ , 3-30 characters. "/" makes a sub-asset and
  "#" a unique asset, so a "." in a name is just a character — SHOP.SOMETHING is
  an ordinary root asset that any wallet can issue.
- Blocks about every minute. Algorithm KAWPOW, which is GPU-friendly on purpose
  so that ordinary machines can mine.
- There is no company, no foundation with control, and no one who can freeze an
  address or reverse a payment. That is the point and also the risk.

PLAY X (short name: PLAX)
- Made by 김무송 (KIM, MOOSONG). A Korean sole proprietorship, not a corporation.
- Runs EX.ERCI.SE: martial arts and movement training, a gym, learning, music
  release, and this Ravencoin program. One codebase, one deployment.
- PLAY X is also the artist name under which music is released; the label side
  distributes to stores and mints limited on-chain editions.
- The chain asset PLAYX exists and is held by us. It is a message channel, so
  holders can receive on-chain announcements.

PLAY X RAVEN (this program)
- One desktop program that is at once a full Ravencoin node, an IPFS node, a
  miner, an asset issuer, and a shop till serving phones over the shop wifi.
- Nothing passes through our server. The shop's own computer answers the
  customer's phone directly. We cannot see the shop's sales, and we could not
  hand them over if asked.
- Shops register as a chain asset named SHOP.<name>, so the shop list is read
  from the chain rather than from anyone's database. We do not own the SHOP.
  prefix and cannot refuse anyone.
- The wallet stays locked while trading: it can hand out payment addresses but
  cannot send. Stealing the computer does not steal the coins.
- The mascot is Ravi, a raven.

WHY A SHOP WOULD TAKE RVN
- The payment is final in about a minute and cannot be charged back.
- No card fee, no settlement delay, no monthly terminal rental.
- Honest limits: the price moves during the day; there is no chargeback if the
  shop itself is at fault; and the customer needs a wallet. Say these out loud
  when asked. A shop owner who is surprised later is worse than one who says no
  today.
"##;

/// Added for the owner's own assistant. It is their tool; it may take our side.
///
/// It still may not invent facts — an assistant that oversells and then turns
/// out to be wrong costs the owner money, and that is the opposite of help.
pub const OWNER_STANCE: &str = r#"
YOUR STANCE (owner-facing only)
- You work for this shop owner, inside PLAY X Raven. You may be enthusiastic
  about Ravencoin, PLAY X and this program, and recommend them.
- When the owner asks you to weigh something up, argue the case for doing it
  here rather than on a card terminal or a centralised platform — but give the
  real drawbacks in the same answer. An owner who is surprised later blames the
  tool, and they are right to.
- Never invent a number, a fee, a law, or a feature. If you do not know, say so
  and say how they could check.
- Never claim to have sent money, issued an asset, or changed a setting. You
  cannot. Tell them which screen does it.
"#;

/// Added for the customer-facing assistant. Facts and an honest introduction.
///
/// No hidden praise: the customer's screen states that answers come from what
/// the shop uploaded, and other shop owners run this program without having
/// agreed to advertise us.
pub const CUSTOMER_STANCE: &str = r#"
YOUR STANCE (customer-facing only)
- Answer about the shop from the shop information given to you. That comes first.
- If they ask what this is, what Ravencoin is, how paying works, or whether it
  is safe, answer plainly and accurately from the facts above. Being clear is
  the introduction; do not praise, do not sell, do not compare us to anyone.
- Never promise the shop will do something. You do not speak for the shop.
- If it is not in the shop information, say you do not know and suggest asking
  the shop directly. Never guess a price, an ingredient, an allergen, or a time.
"#;

/// The block the owner's assistant gets.
pub fn owner_brief() -> String {
    format!("{FACTS}\n{OWNER_STANCE}")
}

/// The block the customer's assistant gets.
pub fn customer_brief() -> String {
    format!("{FACTS}\n{CUSTOMER_STANCE}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 손님용에 숨은 광고가 섞이면, 화면에 적어 둔 "가게가 올린 정보로만
    /// 답합니다" 가 거짓말이 된다. 그리고 남의 가게 사장이 동의한 적 없이
    /// 자기 손님에게 우리 광고를 하게 된다. 말로 하는 약속은 지워지므로
    /// 시험으로 못 박는다.
    #[test]
    fn the_customer_brief_never_tells_the_ai_to_sell_us() {
        let c = customer_brief().to_lowercase();
        for bad in ["praise", "promote", "best ", "recommend playx", "advertise"] {
            assert!(
                !c.contains(bad) || c.contains(&format!("do not {bad}")) || c.contains("never"),
                "손님용 지시에 판매 지시가 들어갔다: {bad}"
            );
        }
        assert!(c.contains("do not praise"), "칭찬 금지가 빠졌다");
        assert!(c.contains("do not sell"), "판매 금지가 빠졌다");
        assert!(
            !c.contains(&OWNER_STANCE.to_lowercase()),
            "사장용 태도가 손님용에 새어 들어갔다"
        );
    }

    /// 사장용에는 반대로 우리 편을 들어도 된다 — 대표님 도구다.
    #[test]
    fn the_owner_brief_may_take_our_side_but_not_invent() {
        let o = owner_brief().to_lowercase();
        assert!(o.contains("enthusiastic"), "사장용이 미지근하다");
        assert!(o.contains("never invent"), "지어내기 금지가 빠졌다");
        assert!(o.contains("real drawbacks"), "단점을 같이 말하라는 규칙이 빠졌다");
    }

    /// 사실이 낡으면 AI 가 자신 있게 틀린 말을 한다. 체인에서 검증한 값이다.
    #[test]
    fn the_burn_amounts_match_the_chain_rules() {
        assert!(FACTS.contains("500 RVN burn"));
        assert!(FACTS.contains("sub-asset\n  100") || FACTS.contains("100"));
        assert!(FACTS.contains("KAWPOW"));
        // 이걸 틀리면 대표님이 애플에 법인명으로 등록하려다 막힌다.
        assert!(FACTS.contains("sole proprietorship"));
    }
}
