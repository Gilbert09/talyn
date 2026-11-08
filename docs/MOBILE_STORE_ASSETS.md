# Mobile store metadata and assets

The metadata template is `apps/mobile/release/store-metadata.json`.
Null fields are unresolved release gates. They are not approved store answers.
Keep review credentials in restricted store fields. The template must contain no passwords or personal data.
Recheck current store asset requirements at release freeze. Store Consoles can change supported device slots.

| Item | Requirement and preparation |
| --- | --- |
| Brand source | Reuse `apps/desktop/assets/icons/1024x1024.png` for the Expo icon. The owl vector sources remain in `apps/desktop/assets`. |
| Apple icon | 1024 × 1024 PNG. Verify no transparency, manual corner mask, misleading badges, or debug mark. Inspect generated asset catalogs. |
| Android launcher | Inspect generated legacy and adaptive icons at all densities. Keep the owl inside adaptive safe areas. Supply a separate monochrome asset if approved. |
| Play listing icon | 512 × 512, 32-bit PNG, within the current Console file limit. Export from the approved brand source. |
| Play feature graphic | 1024 × 500 PNG or JPEG. Use accurate current app content and approved brand treatment. |
| Apple screenshots | Capture each required iPhone and iPad display class shown by App Store Connect for the supported devices. Do not stretch phone images into tablet images. |
| Play screenshots | Supply at least two accurate phone images. Add supported tablet/foldable images and meet current Console dimension and ratio limits. |
| Screenshot content | Show sign-in, workspace choice, Sessions, Threads, Attention, and Settings. Include useful detail and accessibility at normal text size. |
| Capture safety | Use synthetic repositories, accounts, transcripts, and PRs. Hide emails, user IDs, tokens, organization names, notifications, and private code. |
| Optional video | Apple previews and Play video are optional. Approve rights, accuracy, localization, captions, and store format before use. |
| Splash and notification art | Verify the generated splash and Android notification small icon on both themes. Do not reuse a colored square as a notification mask without device inspection. |
| Name | Apple and Google: at most 30 characters. Reserve the final name through the store owner. |
| Short text | Apple subtitle: 30 characters. Apple keywords: 100 characters. Google short description: 80 characters. |
| Main text | Apple and Google descriptions: 4000 characters. State current behavior. Do not claim unimplemented terminal, billing, or PR mutation features. |
| Release notes | Apple: 4000 characters. Google: 500 characters per language. Describe this release in plain language. |
| Categories and ratings | Product chooses accurate categories, content declarations, target audience, and age rating answers. No default attestation is supplied. |
| Legal and contact | Supply approved copyright, support contact, public support URL, privacy URL, deletion URL, and applicable license notices. |
| Review access | Supply safe test data, OAuth instructions, reviewer access, push limitations, paying-admin deletion restrictions, and supported account scope. |
| Regions and languages | Choose countries, languages, legal availability, and a localization owner. Keep screenshots and metadata consistent per locale. |
| Privacy | Review `apps/mobile/release/privacy-inventory.json`, processor contracts, Apple App Privacy, SDK manifests, and Google Data safety. |
| Compliance | Owners must decide encryption/export answers, login policy, payment scope, generated-content safeguards, and organization verification. |

Do not enlarge favicon files for store icons. Do not invent production screenshots or legal claims.
The reused brand icon does not complete the screenshot, feature graphic, adaptive mask, or listing requirements.
The store owner must record approved filenames, dimensions, locale, SHA-256, rights, and capture build number.
Keep final store artwork in `apps/mobile` or approved monorepo release storage.
Use restricted storage for review material. Do not add a separate mobile repository or publication system.
