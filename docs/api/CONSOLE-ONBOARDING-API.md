# Operator/Admin console API — Charge Point onboarding (interim)

> **Interim** console routes, to be removed when these routes move to `/api/admin/v1/charge-points` and `/api/operator/v1/charge-points` with the dashboard JWT (D-D, 12/11). The final routes are in the T98 contract
> ([OPERATOR-ADMIN-API-HOP-DONG.md](OPERATOR-ADMIN-API-HOP-DONG.md) §3.2): `POST /admin/v1/charge-points` and
> `POST /operator/v1/charge-points`, with JWT. These console routes already use the contract's body and
> result shape (snake_case, `RegisterDeviceRequest` / `OnboardRequest` / `OnboardResult`); only ids stay
> numbers, as everywhere in the console (contract §5). Served by the plain console listener
> (`apps/csms/src/console/`), loopback only, no login.

Two routes put WF-05 behind HTTP (SD-5a, DS-09/DS-10). The body is read with the same
`readJsonBody` as the BE-24 console routes. They call `ChargePointOnboardingService` unchanged, so the service keeps doing every business check
(serial format, 1–2 connectors, role, operator scoping, lifecycle).

| Route | Actor | Use case | STM-3 |
| --- | --- | --- | --- |
| `POST /api/admin/charge-points` | Admin (`CONSOLE_ACTOR_ADMIN_ID`) | UC-ADM-03 register a serial in the Charge Point Registry | #1 `[*] → registered` |
| `POST /api/operator/charge-points/onboard` | Operator staff (`CONSOLE_ACTOR_STAFF_ID`) | UC-OPS-01 onboard onto one of the operator's sites (Screen 19) | #2 `registered → awaiting_connection` |

## Who is acting

The console has no login yet. The acting user id comes from configuration, **never from the
request**: `CONSOLE_ACTOR_ADMIN_ID` and `CONSOLE_ACTOR_STAFF_ID` (positive integers, no default).
If the matching value is not set, the route answers `503 {"error": "actor_not_configured"}`.
The service still checks that the configured user is an active Admin / active operator staff
(`403 forbidden_role` otherwise). `npm run demo` sets both from the users in `demo/seed.sql`.

Two interim actor patterns exist side by side: the BE-24 console routes (unattributed / review
queues) take the actor from the request body (`operator_user_id`), these T119 routes take it from
`CONSOLE_ACTOR_*`. Both are removed when these routes move to `/api/admin/v1/charge-points` and `/api/operator/v1/charge-points` with the dashboard JWT (D-D, 12/11).

## `POST /api/admin/charge-points`

Request (`Content-Type: application/json`, at most 8 KB; unknown fields → 400):

```json
{ "serial_number": "SIM-0005", "model": "D1-120", "rated_power_kw": 120 }
```

`serial_number` matches `^[A-Za-z0-9._-]{3,48}$`; `model` at most 20 characters.

`201 Created`:

```json
{ "charge_point_id": 172, "serial_number": "SIM-0005", "lifecycle": "registered" }
```

## `POST /api/operator/charge-points/onboard`

Request:

```json
{
  "serial_number": "SIM-0005",
  "site_id": 1,
  "connectors": [{ "connector_no": 1 }, { "connector_no": 2, "connector_type": "ccs2", "max_power_kw": 60 }]
}
```

`connector_type` ∈ `ccs2` (default) · `chademo` · `gbt` · `type2`. `max_power_kw` optional.

`201 Created`, header `Cache-Control: no-store`. The password is returned **once**; only its
scrypt hash is stored.

```json
{
  "charge_point_id": 171,
  "display_code": "PM-D1-HCM-0002",
  "lifecycle": "awaiting_connection",
  "ocpp_url": "ws://localhost:9000/ocpp/SIM-0005",
  "identity": "SIM-0005",
  "password": "****************"
}
```

The charge point then connects to `ocpp_url` with HTTP Basic auth `identity:password`
(STM-3 #3 `awaiting_connection → in_service` on the first accepted connection).

## Errors

Every error is `{"error": <code>, "detail": <text>}`.

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | body is not valid JSON or not a JSON object |
| 400 | `invalid_input` | malformed `serial_number`, wrong field type, unknown field (console check), or the service's own input rules |
| 413 | `payload_too_large` | body larger than 8 KB |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json` |
| 403 | `forbidden_origin` | POST with an `Origin` that is not localhost (same check as the fault actions) |
| 403 | `forbidden_role` | configured actor is not an active Admin / operator staff |
| 403 | `site_of_other_operator` | the site belongs to another operator |
| 404 | `site_not_found` | unknown `siteId` |
| 405 | `method_not_allowed` | any method other than POST (`Allow: POST`) |
| 409 | `serial_already_registered` | register: serial already in the registry |
| 409 | `serial_not_registered` | onboard: serial not in the registry |
| 409 | `already_onboarded` | onboard: charge point is not `registered` any more |
| 500 | `internal_error` | unexpected; the log line keeps only the error class (no message, no body) |
| 503 | `actor_not_configured` | `CONSOLE_ACTOR_*` not set |

## Logging

Request and response bodies of these routes are never logged. The service logs the serial, the
display code and the acting user id; the gateway logs a rejected connection as
`từ chối <serial> từ <ip>: 401 Invalid credential`.
