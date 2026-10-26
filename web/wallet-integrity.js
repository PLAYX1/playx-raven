/* This same-origin bootstrap detects mismatched/corrupt bundles, not a compromised
 * server able to replace HTML, this verifier and the manifest together. */
async function verifyWalletAssets(manifest, required, fetcher = fetch) {
  if (manifest?.version !== 1 || !manifest.assets || !required.length || new Set(required).size !== required.length || Object.keys(manifest.assets).length !== required.length) throw Error('manifest');
  for (const path of required) {
    const expected = manifest.assets[path];
    if (!/^\/[a-z0-9.-]+\.js$/.test(path) || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(expected || '')) throw Error('asset');
    const response = await fetcher(path, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw Error('fetch');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
    const actual = 'sha256-' + btoa(String.fromCharCode(...digest));
    if (actual !== expected) throw Error('integrity');
  }
}
function walletIntegrityFailure() {
  window.dispatchEvent(new Event('wallet-integrity-failed'));
  const warning = document.createElement('p');
  warning.setAttribute('role', 'alert');
  warning.textContent = '지갑 파일의 무결성을 확인하지 못해 잠갔습니다. 다시 열어도 같은 문제가 나면 사용을 멈추고 대표에게 확인해 주세요. 저장된 금고는 삭제하지 않았습니다.';
  document.body.replaceChildren(warning);
}
async function startVerifiedWallet() {
  try {
    const tags = [...document.querySelectorAll('script[data-wallet-src]')];
    const required = tags.map(tag => tag.getAttribute('data-wallet-src'));
    const response = await fetch('/wallet-integrity.json', { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw Error('manifest');
    const manifest = await response.json();
    await verifyWalletAssets(manifest, required);
    for (const path of required) {
      // SRI checks the executed response as well, avoiding fetch/execute races.
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = path; script.integrity = manifest.assets[path]; script.crossOrigin = 'anonymous';
        script.onload = resolve; script.onerror = reject;
        document.body.append(script);
      });
    }
    let checking = false, failed = false;
    const recheck = async () => {
      if (checking || failed) return;
      checking = true;
      try { await verifyWalletAssets(manifest, required); }
      catch { failed = true; walletIntegrityFailure(); }
      finally { checking = false; }
    };
    setInterval(recheck, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void recheck(); });
  } catch { walletIntegrityFailure(); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startVerifiedWallet, { once: true });
else void startVerifiedWallet();
