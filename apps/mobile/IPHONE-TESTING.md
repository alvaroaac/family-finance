# iPhone validation with Expo

Use the `development` EAS profile for a physical iPhone. It includes the Expo development client, so edits can still reload from Metro after the app is installed. No cloud build, project registration, certificate creation, device registration or upload has been started.

## Account-dependent setup

An Expo account and iOS signing are required for a cloud-built install on a physical iPhone. Confirm the Apple Developer membership and Expo account before selecting the signing workflow. A local Xcode build is another path; Xcode is not currently installed on this Mac.

From `apps/mobile`, after the accounts and the exact build/upload action are approved:

```sh
pnpm dlx eas-cli login
pnpm dlx eas-cli device:create
pnpm dlx eas-cli build --platform ios --profile development
```

Use the installation link on the registered iPhone. Run Metro with `pnpm exec expo start --dev-client --lan` and keep the phone and Mac on the same network. Use the Mac's LAN address for local API/Supabase connections: `127.0.0.1` on an iPhone refers to the phone itself. Configure public app URLs for the intended test environment before starting Metro. Never put service-role or AI keys in the app.

Google sign-in needs an enabled provider and the `casa://auth/callback` redirect in the chosen Supabase test environment. The isolated database used for web E2E has a synthetic password user; it does not currently have Google OAuth configured. Do not treat its test sign-in as Google callback validation.

## Device checks

1. Cold launch, Google sign-in, return to Casa, foreground/background session renewal, sign out and relaunch.
2. Add text transaction; review autofilled category, subcategory, payment, value and date. Confirm one saved record.
3. Edit the date: button displays `DD/MM/AAAA`, picker uses Portuguese locale, record retains the selected calendar day.
4. Open keyboard on amount/description; all inputs and the fixed save action remain reachable. Close/reopen retains draft; sign-out clears it.
5. Record a short synthetic financial description, stop, explicitly transcribe, review and save. Reject microphone permission and verify recovery too.
6. Navigate reports, search/edit transaction, card installments, commitments/payment, and disposable simulation. Verify responsive scrolling, safe areas and large text.
7. Interrupt connection during save; retry the same draft and verify one record only. Restore the network and refresh.

Imports are excluded from required E2E coverage by the user's instruction. Expo bundle exports and browser-rendered React Native tests do not replace the checks above.

References: https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/ and https://docs.expo.dev/develop/development-builds/faq/
