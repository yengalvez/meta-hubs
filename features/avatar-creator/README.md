# Integrated avatar creator

### Rig adaptation, current corrective candidate

Hubs commit `8c74e8c22` adapts shared rotation clips only for creator Hips nodes
marked `yenhubsCreatorRig=makehuman-mixamo-v1`. It captures animation-only glTF
Object3D references, compensates bind orientations and aligns arm A/T reference
directions. Unmarked avatars keep their existing path; no Sitting protocol,
schema, backend or upstream release change. Runtime changes are isolated to
fullbody-locomotion and shared clip loading plus a utility. Rollback is the prior
Hubs image/commit; new creator avatars require this adapter for correct poses.
Local evidence: 131 tests and TypeScript, both bases with three sit/stand cycles,
representative clothing and private-save simulation. In-room IK/network and real
private persistence are still required before accepting deployment.

### Local hair-colour correction (2026-09-05)

After `build-business-avatar-assets.py` and `normalize-business-avatar.mjs`, run
`node scripts/prepare-creator-hair.cjs INPUT.glb OUTPUT.glb` from Hubs for each
body. This offline-only step requires Sharp 0.35.4 available to Node (the local
workspace runtime supplied it via NODE_PATH); there is no browser dependency.
Use the original normalized input, not an already prepared output: the script
rejects a second application. It creates neutral light hair textures while
verifying pixel-for-pixel alpha preservation. Meshes, nodes, skins and accessors
were compared against the prior Git assets and are unchanged. Five materials
per body are processed. The compositor prunes unused original texture data.
The original colour picker remains; four named tone shortcuts were added.
Blond was inspected in the real local editor; no production acceptance claimed.

Status: MakeHuman implementation locally verified; not deployed.
Visual requirement clarified 2026-09-05: adult RPM/Avaturn-like characters with
business clothing (shirt, jacket/tie), not anime/chibi/cosplay/fantasy. The current
Quaternius tunic/ranger assets were a technical prototype only and MUST NOT ship.
Reuse the proven controls/private-save logic while replacing the asset set or
provider. The initial asset decision below is superseded on visual suitability.
Required wardrobe minimum: five genuinely different business/casual tops,
five different trousers and five hairstyles, independently combinable. Recolours
do not count as different garments; fixed complete outfits are insufficient.
Inventory the actual licensed pieces before continuing integration.

### Wardrobe evidence, 2026-09-05

Inspected the official Quaternius Ultimate Modular Men Humanoid Rig Blender
sources, not the legacy PolyPizza export. Rendered Suit, Casual, Casual2, Worker
and Adventurer in rest pose with Blender 4.4.1 and downloaded-script execution
disabled. Suit provides a jacket/tie; Casual is a hoodie with shorts; Casual2 a
T-shirt with jeans; Worker includes a hi-vis vest; Adventurer has expedition gear.
This selection does NOT establish five suitable business/casual tops and five
trousers. Do not integrate it merely to fill the count. Its faceted heads also
do not establish the requested RPM-like visual quality.

Render/source evidence remains private in
`/Users/yengalvez/.yenhubs-private/avatar-creator-20260904/` (five
`*-wardrobe.png` renders and `*-humanoid.blend` sources).
Official source: https://quaternius.com/packs/ultimatemodularcharacters.html

Next bounded candidate: MakeHuman's curated CC0 asset packs, which explicitly
include formal suits, shirts, trousers and hairstyles. Inspect individual assets
and prove rendering/rig/export before replacing the existing creator templates.
Do not bundle its application into the client or infer every community asset is
CC0: the official catalog separates CC0 and CC-BY packs.
Source: https://static.makehumancommunity.org/assets/assetpacks.html

MakeHuman follow-up: downloaded suits01_cc0, shirts01_cc0 and pants02_ccby
archives from the official catalog. Viewed their supplied thumbnails: jacket/tie,
double-breasted jacket, polo, fisherman sweater and basic T-shirt are plausible
five distinct tops. Candidate bottoms: Mindfront male trousers 1/2, Elvaerwyn
male trouser/straight-leg jeans and punkduck classic jeans. These are not yet
accepted garments: suits must be separated into independently selectable pieces,
and fit, deformation and final rendering still need verification. Embedded
MHCLO headers confirm CC0 for the polo and jacket/tie; Mindfront trousers state
CC BY 4.0. Preserve per-piece author, license and modification notices in the
UI and exported glTF metadata before including CC-BY assets.

MPFB v2.0.17 source (80919fa) was loaded offline in a private Blender process,
without saving user preferences or installing globally. Its native API created
a human with the built-in 52-bone Mixamo rig and fitted the polo (2,189 vertices,
14 weight groups). This proves a shared-body fitting route exists, not final
Hubs acceptance. Evidence: `makehuman-probe.blend` and `probe-makehuman.py` in the
private evidence directory above. An initial standalone registration error was
resolved by creating the process-local addon preference entry; no application
or production code was changed. Next: complete the fifteen-piece inventory,
render combined garments and export one fully dressed GLB through the existing
validator before changing shipped assets.

Complete sample proof: `makehuman-materials.glb` is 8,613,840 bytes, 52 bones,
11 skinned mesh primitives, nine decoded textures and finite bounds
0.993 x 1.571 x 0.429 m. The unchanged Hubs header/skeleton/material helpers
and installed Three.js loader accepted it in the internal browser. Screenshot
inspection confirms the polo, trousers, shoes and short hair render together.
This remains a local viewer proof, not AvatarEditor saving or room acceptance.

Causal export finding: MakeSkin emitted BLEND for every material, causing skin
to draw over clothes and hair in Three.js. Freezing shape keys/masks did not
change that symptom. Inspecting exported materials identified global BLEND;
setting opaque surfaces to OPAQUE and hair/eyebrow cards to MASK corrected the
same geometry in the internal viewer and reduced draw calls from 22 to 11.
Private reproducible converter: `fix-makehuman-materials.mjs`. Carry this policy
into the eventual asset builder, not into global Hubs material behavior.
The system archive also contains ten CC0 hairstyles, so the remaining inventory
work is selection/fit, not finding a hair source. Full five-by-five wardrobe
composition, attribution and room behavior remain unverified.

Scope requested 2026-09-04: free in-room customization with included assets,
direct private saving, existing avatar selection retained. No selfie requirement.

## Current decision

MakeHuman templates now replace the fantasy prototype. Five independently
selectable tops, five trousers and five hairstyles (plus bald) on two body bases
provide 300 combinations. CC0 and CC BY 4.0 attribution is itemized in
wardrobe.json and the asset LICENSE, displayed in the editor and embedded in
every export. The portable offline builder is build-business-avatar-assets.py;
normalize-business-avatar.mjs preserves the runtime material/metadata contract.
The earlier exploratory evidence above is historical, not unfinished inventory.

Local evidence: 126 unit tests, TypeScript, 300 compositor combinations,
production webpack build, both body previews, desktop and 390x844 private-save
simulation. Selected exports prune unused wardrobe resources to about 4.3 MB.
Real account persistence and in-room/remote acceptance remain deployment gates.

## Superseded prototype decision (historical)

Native controls reuse the existing private AvatarEditor and AvatarPreview.
Two curated, same-origin CC0 GLB templates provide male/female characters,
five hairstyles plus bald, hair colour, and two fantasy outfits (tunic/ranger).
This is a stylized customizable character creator, not a photoreal selfie service.
No external account, API, iframe, upload to a provider, subscription, backend,
new dependency or infrastructure. Assets are loaded only when the creator opens.

Current alternatives verified from primary sources:

- Avaturn basic embedding/export exists, but free embedding alone does not establish
  commercial third-party integration rights; terms put such integrations under
  Enterprise. Not selected for a free client-facing service.
  https://docs.avaturn.me/docs/integration/web/html/
  https://avaturn.dev/pricing/
  https://docs.google.com/document/d/e/2PACX-1vT5_TR6-MNs29LqI-LLKHvIKHVE0iluuapOpHODGRVDaqyfuCsEgaiE3ZIliI1-FN_-9rxJZ3iVo_jJ/pub
- MetaPerson integration/export has paid-plan limitations; not selected.
  https://docs.metaperson.avatarsdk.com/web_integration/
- Mozilla Hackweek has a real creator, MPL code and CC BY-SA assets, but legacy
  upper-body-only rig fails the current private full-chain validation. Its full
  catalog is about 459 MB. Viable alternative with additional licensing and rig
  work, not rejected as impossible.
  https://github.com/mozilla/hackweek-avatar-maker
- M3 CharacterStudio code is MIT, but required loot-assets lack a clear license;
  current export and VRM naming need repair, with a large Web3 dependency surface.
  https://github.com/M3-org/CharacterStudio
  https://github.com/M3-org/loot-assets
- Quaternius Standard: explicit CC0 inside both downloaded archives. Actual free
  subset inspected; paid Source extras excluded. A composed prototype already
  passes the unchanged skeleton validator (65 bones, full body), texture decode
  and local rendering. Selected after that proof, despite initially requiring
  more assembly than Hackweek. No weakening of the private validator is needed.
  https://quaternius.itch.io/universal-base-characters
  https://quaternius.itch.io/modular-character-outfits-fantasy

One independent review examined license, cost, rig, export and ownership risks.
Its initial Hackweek recommendation was conditional; the Quaternius prototype
subsequently resolves the extra rig/composition unknown while avoiding ShareAlike
semantics for private avatars. No recursive review required.

## Contracts and acceptance

Upstream Hubs baseline stays prod-2026-03-11. Changes isolated to creator utilities,
controls, curated assets and AvatarEditor; one hub event routes Create avatar to
mode creator. Existing upload/editor modes and selection remain available.
No backend schema or API change. POST /api/v1/avatars and existing media promotion
are reused, with allow_promotion=false and allow_remixing=false.

Selection updates invalidate the prior file before async work; obsolete fetches
abort, failed generation cannot save the last selection, closing cancels work.
There is no write until Save. Existing preview skeleton validation and header/
size validation remain mandatory. All template URIs are embedded, selection IDs
and colours are allowlisted. No untrusted postMessage or arbitrary URL accepted.

Acceptance remaining: official image; checkpoint and guarded
rollout; cold-room usage, persistence, private ownership and remote pose.
Do not re-run H5/restore or unrelated closed suites.

Source and asset provenance: hubs/src/assets/models/avatar-creator/LICENSE.md.
Rollback: previous approved Hubs image digest via tracked generator/guarded apply;
private GLBs use the pre-existing persisted contract and need no data rollback.
