//! 동기 함수에서 async 를 기다리는 **하나뿐인** 길.
//!
//! 🔴 `tauri::async_runtime::block_on` 을 tokio 런타임 위(= async 명령·서버 처리기·spawn 된 일)에서
//!    부르면 **"Cannot start a runtime from within a runtime"** 로 그 일꾼 스레드가 죽는다.
//!    `npm run tauri dev` 로 켤 때마다 두 번씩 찍히던 그 패닉이다(2026-09-30 대표님 터미널).
//!    어느 동기 함수가 어디서 불릴지는 호출하는 쪽이 정하므로, 함수 안에서 막는다.
//!
//! 런타임 위에 있으면 **다른 OS 스레드**에서 기다린다(그 스레드는 런타임 밖이라 안전하다).
//! 런타임 밖이면 예전 그대로 `tauri::async_runtime::block_on`.

use std::future::Future;

pub fn block<F>(fut: F) -> F::Output
where
    F: Future + Send,
    F::Output: Send,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::scope(|s| {
            s.spawn(move || tauri::async_runtime::block_on(fut))
                .join()
                .expect("기다리던 일이 도중에 멈췄습니다")
        })
    } else {
        tauri::async_runtime::block_on(fut)
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test(flavor = "multi_thread")]
    async fn 런타임_위에서_불러도_안_죽는다_여러_일꾼() {
        assert_eq!(super::block(async { 1 + 1 }), 2);
    }

    #[tokio::test]
    async fn 런타임_위에서_불러도_안_죽는다_한_일꾼() {
        assert_eq!(super::block(async { 40 + 2 }), 42);
    }

    #[test]
    fn 런타임_밖에서도_된다() {
        assert_eq!(super::block(async { 7 }), 7);
    }
}
