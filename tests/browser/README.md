# Browser contracts

## Two-client sitting and occupancy

The sitting test launches exactly two isolated Chrome contexts and verifies:

- simultaneous contention never produces an overlapping seated frame;
- one stable owner and the same remote seated pose are visible to both clients;
- Stand releases the seat and uses the nearest non-seat fallback waypoint;
- the loser can reclaim the released seat;
- an abrupt disconnect clears inherited occupancy within 2.5 seconds;
- every seat in the target scene has `Disable motion`, `Can be occupied` and `Clickable`.

There is deliberately no default target. Prefer a disposable staging room with
the production scene contract:

```bash
cd tests/browser
npm ci
SITTING_TEST_URL=https://staging.example/<room-id> npm run test:sitting
```

Running against the live main room is an explicit, two-client-only diagnostic.
Ensure the room is empty and use the production opt-in:

```bash
SITTING_TEST_URL=https://meta-hubs.org/VJopCY3/inicio \
BROWSER_ALLOW_PRODUCTION=1 \
npm run test:sitting
```

The test does not enable microphone or video, create content, change Spoke, or
write application storage. It always attempts to clear any seat state owned by
its surviving client through the authoritative reservation channel during
teardown. Production runs still create normal guest
session metadata, so use the project checkpoint/approval rules before treating
this as a production acceptance step.

The attached observer screenshot is evidence for visual review. The automated
position tolerance detects gross floating/teleport regressions, but table,
chair, clothing and body-mesh penetration still require review of that image.

## Cold desktop and mobile acceptance

The cold-load contract runs one desktop Chrome and one Pixel 7-sized Chrome
context. It enters the room and requires `APP`, `AFRAME`, the entered scene,
the waypoint-reservation protocol and the exact expected number of visible bot
entities with both `bot-info` and `bot-path` initialized. Both tests fail on
any browser console warning/error, uncaught page error, failed request or HTTP
response at or above 400.

```bash
COLD_LOAD_TEST_URL=https://staging.example/<room-id> \
BROWSER_EXPECTED_BOTS=2 \
npm run test:cold
```

Remote non-production targets require HTTPS and an explicit
`staging|test|qa|preview|sandbox|dev` hostname marker. Production and all of its
subdomains require `BROWSER_ALLOW_PRODUCTION=1`. Cross-origin redirects and
credentials embedded in URLs are always rejected.
