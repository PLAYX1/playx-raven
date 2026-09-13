# RavenVault Windows installer identity

The visible product/window name is **RavenVault Desktop**. Existing installation identity remains **PLAY X Raven**, publisher `erci`, bundle ID `se.erci.ex.playx.raven`. The updater public key, executable name and user data paths stay unchanged.

Both templates are vendored from the official **Tauri CLI 2.11.4** tag under the included MIT license:

- [NSIS original](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), SHA-256 `20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079`.
- [WiX original](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/msi/main.wxs), SHA-256 `e371a01628a06730828f9bd24111feacb8bec53c250ccec4b46df756fe0a0198`.

Configuration paths (relative to `src-tauri`):

```json
{
  "bundle": {
    "windows": {
      "nsis": { "template": "installer/nsis-ravenvault.nsi" },
      "wix": { "template": "installer/wix-ravenvault.wxs" }
    }
  }
}
```

The separately pinned `wix.upgradeCode` must remain the original PLAY X Raven GUID. Preserve all existing icon/language options when adding these properties.

NSIS changes are limited to the legacy uninstall/location registry keys, MSI discovery by either old or new display name with the same publisher, and shortcut migration. The existing location lookup, user/machine context, installer/uninstaller flow and data deletion opt-in remain upstream. Existing NSIS custom paths are restored; a new installation keeps the new product's default directory.

Shortcut migration operates only on the three upstream Start Menu/desktop locations and requires an exact target under this installation. It also recognizes the previously recorded main executable name. It never recreates a shortcut the user removed or overwrites a different application's same-named shortcut. If the new name is occupied by a different target, both existing links remain untouched. Pinned shortcuts and Windows shell caching require real Windows validation.

WiX changes are exactly six registry `Key` attributes, keeping the original `Software\\erci\\PLAY X Raven` search/storage location. This preserves custom MSI paths and upstream search precedence (MSI `InstallDir` after NSIS default value), while keeping RavenVault display names and the configured upgrade GUID.

MSI → NSIS uses upstream detection and uninstall flow: MSI uninstall precedes the `/UPDATE` fast path; cancellation/failure must stop migration. NSIS → MSI automatic uninstall is **not** added or promised. Existing users should use the app's updater, and cross-family manual installs need explicit guidance. Full upgrade testing still requires Windows fixtures for old NSIS/MSI installs, both default/custom directories, uninstall cancellation and app-data preservation. Never perform those tests against a real wallet.

For macOS, [updater 2.10.1](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.10.1/plugins/updater/src/updater.rs) extracts the new archive without its top directory and replaces the currently running `.app` path. Thus in-app updating can keep `/Applications/PLAY X Raven.app` while its contents/display name become RavenVault. A manual DMG copy uses the new `.app` filename and may coexist with the old app; that is not automatic migration. No macOS production patch is included here.

Checks:

```sh
node scripts/desktop-installer-identity.test.mjs
node scripts/desktop-installer-identity.test.mjs --compile
node scripts/desktop-installer-identity.test.mjs --mutant-registry
node scripts/desktop-installer-identity.test.mjs --mutant-shortcut
```

The last two must fail. Semantic tests execute a strict subset of the actual NSIS compatibility instructions against synthetic registry/shortcut maps. The optional compile check uses local `makensis` to compile the modified code with fixture helper macros, then removes the resulting PE **without executing it**. Neither check substitutes for installing/updating on Windows. Hash reconstruction checks that every other byte still matches upstream; review and update these templates deliberately when the CLI version changes.
