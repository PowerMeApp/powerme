# ADR-0017 — MB03 Driver discovery JWT and provider boundary

Date: 2026-11-06; updated 2026-11-09. Status: MB03 implementation decision; local verification snapshot 2026-11-09. GitHub status is tracked by branch/commit.

## Context and decision

FR-03/UC-CHG-01 needs real authenticated station discovery. Existing `DriverChargingService`
already filters by owned vehicle, connector compatibility, BR-P03 visibility and BR-P38/39
freshness. Reuse it through an isolated raw HTTP handler on the existing console port.
Implemented GET routes include `/api/driver/v1/me`, `/stations`, connector resolution,
`/places/autocomplete`, `/places/resolve` and `/stations/{site_id}/route`.
Station suggestions are additive `sort=smart` fields on `/stations` under the user-prioritized
[brief 07/11](../requirements/smart-station-search-brief-20261107.md).
Charging and standalone time-left HTTP paths remain explicitly planned.

Pin `jose` **6.2.15** (MIT) for HS256 signature and claims verification. Require a backend-only
base64 key of at least 32 random bytes, configured issuer/audience, JWT type, numeric issue/expiry,
maximum 900-second life, driver role and a positive PostgreSQL bigint subject. Every request
checks active Driver role/subtype in DB. Neither query identity nor a token vehicle claim grants
ownership. Preserve bigint strings through discovery, including values above MAX_SAFE_INTEGER.
Optional dev headers require both explicit local/test environment and an explicit flag, off
by default. An invalid bearer never falls back. Local synthetic token issuance is not OTP/login.

**Update 2026-11-09 (BE-21):** email + password login now exists: `POST /api/driver/v1/auth/register`,
`/auth/login` and `/auth/refresh` issue access tokens that pass the verification above unchanged
(HS256, `typ: JWT`, `role: driver`, 900 s). Refresh tokens use the same key but `typ: refresh+jwt`,
`token_use: refresh` and no `role`, so neither token type is accepted in place of the other. They
live `DRIVER_API_REFRESH_TTL_S` (default 30 days) and are not rotated or stored: no per-token
revocation, logout means the app deletes its tokens, and a locked account (`account_status` not
`active`) is refused at once because refresh and every request re-check the database. Passwords
reuse the scrypt format of ADR-0011. The synthetic local token script stays for seeded test data.
OTP, Google and Firebase sign-in are **out of scope** until after Defense 1.1; the intended
direction is a route that exchanges a verified Firebase ID token for a CSMS JWT of the same shape.

**Update 2026-11-12 (BE-30):** `/auth/login` also accepts `{phone_number, password}` instead of
`{email, password}` (exactly one identifier; both or neither → 400 `invalid_input`). Phone numbers
are normalized to E.164 by one shared function (`src/driver/phone-number.ts`: Vietnamese `0…`,
`84…`, `+84…` forms → `+84` + 9–10 digit national number; other `+` numbers kept if 7–15 digits) on
register and login, and migration 0017 normalizes stored numbers the same way and makes
`users.phone_number` UNIQUE (NULLs allowed; it refuses to run and lists user ids if two users share
a number). Register with a number already in use → 409 `phone_taken`. Every BE-21 guarantee holds
on both paths: one 401 `invalid_credentials` for unknown identifier or wrong password with a dummy
scrypt when no user matches, 403 `account_locked` only after a correct password, and failed-login
limits keyed by the normalized identifier + IP. The phone number is only a login identifier: there
is no OTP/SMS proof of ownership. **OTP/SMS and Google/Firebase sign-in remain out of scope until
after Defense 1.1**, unchanged from the BE-21 note above.

The shared listener refuses all hosts except `127.0.0.1` and `::1`, including a configured
wildcard. Driver JWT does not authenticate the existing admin console. This intentionally
blocks a deployment configuration that tries to expose the shared unauthenticated console;
remote/mobile LAN access needs a separately reviewed transport/auth boundary first.

## Source review and alternatives

Actual source and tests were read, not just README files:

| Source | Fit, dependencies, security, license and tradeoff |
| --- | --- |
| [panva/jose at f931aa5](https://github.com/panva/jose/tree/f931aa5a01d3689887b4370068660daca5e049e3) | Reviewed `src/jwt/verify.ts`, `src/lib/jwt_claims_set.ts`, `test/jwt/verify.test.ts`, package metadata and MIT license. Maintained release 6.2.15, TypeScript, WebCrypto, no runtime dependencies; fits Node 24 and the existing ESM-capable Jest wrapper. Explicit required claims and algorithm allowlist fit fail-closed policy. Larger JOSE API than this slice needs. Selected library usage; no source copied. Installed package retains its license. |
| [auth0/node-jsonwebtoken at b924272](https://github.com/auth0/node-jsonwebtoken/tree/b924272f29192e12926b5414546f7c5bfcc9579d) | Reviewed `verify.js`, `test/verify.tests.js`, package metadata (9.0.3) and MIT license. Maintained, established CommonJS alternative with issuer/audience/algorithm checks; depends on jws and several utilities and needs separate typing. Required expiry presence still needs application policy. No source copied or dependency added. |
| [Vietmap Flutter navigation example, dev at 6f1d792](https://github.com/vietmap-company/flutter-navigation-example/tree/6f1d792dd48c97a3d7fabec8c44f384b48a088dd) | Reviewed `lib/features/map_screen/maps_screen.dart`, `bloc/map_bloc.dart`, data repository interface, domain repository implementation, `lib/di/app_context.dart`, `test/widget_test.dart` and MIT license (Vietmap Application Co., Ltd, 2023). Map/bloc/use-case/repository separation is useful, but it is a navigation demo, not a station-inventory/ranking implementation. Its repository uses v3 search and a debug certificate bypass; neither is adopted. DI reads one client key for multiple concerns; PowerMe keeps Search server-side and Tile mobile configuration untouched. The only Flutter test is a starter counter test, not provider evidence. No Flutter source copied or packages installed. |

## Vietmap capability and semantics

Use native Node fetch against a fixed HTTPS origin, server Search key only, redirects disabled,
5-second timeout, bounded 512-KiB body, validated outputs and sanitized errors. No automatic
retries or fabricated route on network/auth/quota/invalid/no-route errors. Adapter errors carry
`provider_unavailable` plus a safe reason, not a provider response, URL, key or fetch cause.
Address/routing HTTP access requires an owned vehicle and explicit per-request location consent.

Official docs reviewed on 2026-11-06:

- [Autocomplete v4](https://maps.vietmap.vn/docs/map-api/autocomplete-version/autocomplete-v4/)
  returns address candidates/ref IDs, then [Place v4](https://maps.vietmap.vn/docs/map-api/place-v4/)
  resolves coordinates. The old example's v3 flow is not the current integration target.
- [Route v4](https://maps.vietmap.vn/docs/map-api/route-version/route-v4/): repeated latitude,
  longitude points; route time is milliseconds, converted to integer seconds.
- [Matrix v4](https://maps.vietmap.vn/docs/map-api/matrix-version/matrix-v4/): source/destination
  indexes and duration in seconds. It does not provide route geometry.

The initially supplied documentation paths omitted `/map-api/`; corrected official paths above
were retrieved. Minimum live probe: one Autocomplete, one selected Place, one Route, one 1×1
Matrix request with synthetic public Đông Hòa points (10.888,106.8) and (10.889,106.801).
Search key rights were measured: all four succeeded at 2026-11-06T12:11:20Z. Autocomplete returned
3 addresses; Route 137.4 m / 50 s, Matrix 49 s. This proves capabilities at that instant, not an
ongoing entitlement/availability promise. No real GPS or key-bearing URL/body was retained.

## Limits and follow-up

`stations?sort=distance` uses existing haversine **straight-line** distance, not road travel
or FR-21 ranking. Freshness, connection and raw OCPP status remain separate; null is unknown.
Connector resolution returns canonical `connector_id` independently of site ID/connector number;
Flutter's stationId/number-derived getter must be replaced in its later slice, not here.

The user subsequently prioritized **brief 07/11 over SRS §3.7/AD-5** for this MVP. Use its
single range factor, road factor, fixed reserve/waits, capped vehicle DC power, average charging
efficiency and current maximum operator tariff. Choose the compatible connector with minimum
total completion time. Rank reach, total, distance and stable ID before pagination. Unknown
timing sorts last. Assumptions use bounded environment configuration; no migration/config table.
The prior advanced `/stations/suggestions` experiment and its schemas were retired, not shipped
alongside a second policy. Existing GitHub source/license research above remains applicable;
no external ranking code was copied. Full source brief and narrow SRS differences are linked above.

Smart search is a disclosed haversine-based estimate independent of provider availability.
No hard range exclusion: an empty implicit radius gets a bounded nearest-risky fallback,
prioritizing usable candidates. An explicitly requested radius is never expanded. Sort name/
distance keeps its legacy order; missing inputs return null and a reason. Target >80 is invalid
under B5/B6. No live traffic, true wait, reliability score or final billing is claimed.

Vietmap remains for addresses and the selected station's actual road geometry; provider failure
returns unavailable without fabricated geometry. Cache is principal-scoped and bounded, ownership
and compatibility are rechecked on hits, and one caller's cancellation cannot poison shared work.
Single authorized unencoded Route check 2026-11-07 succeeded: LineString, 4 vertices, 137.4 m / 50 s;
no key/URL/raw response retained. No new chargeable probe was made on 09/11.

Edge-case review 09/11 used [OWASP API1](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)
for owned-resource/cache checks, [OWASP API4](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
for time/body/request bounds and [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html) for JWT
algorithm/claims validation. These sources inform tests, not a security certification. Route v4
docs were rechecked for units and coordinate order. [Named test matrix](../api/MB03-EDGE-CASE-MATRIX.md)
records actual results. The runner/CI create a new DB per suite and never reset existing databases.
OTP/revocation, sessions, charge commands, mobile integration, staging and deployment
are also outside this slice (email/password login and refresh: see the BE-21 update above). No migrations, real payments or charge commands were added.
