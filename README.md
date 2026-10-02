# PC Remote Controller - Official Website

**Live Website:** [https://www.pcremotecontroller.com/](https://www.pcremotecontroller.com/)

## Central Versioning

This repository hosts the central `version.json` file. This file is used by the apps to check for application updates and ensure compatibility between the mobile client and the desktop server.

The URL `https://raw.githubusercontent.com/DimitriosChloros/pc-remote-controller/main/version.json`
is hardcoded in every shipped app: **never move or rename this file.**

### Before editing `version.json`

```
node scripts/validate-manifest.mjs version.json --check-urls
```

CI runs the same check, plus its tests, on every push that touches the file. It fails when
`critical_below_version` is above `latest_version`, a version is not `X.Y.Z`, a key is missing or a
store link does not answer — and **warns** when `critical_below_version` equals `latest_version`,
because that blocks every user not on exactly the latest version.

Update `latest_version` only once the store can actually serve that version to everyone (not
during a staged rollout).
