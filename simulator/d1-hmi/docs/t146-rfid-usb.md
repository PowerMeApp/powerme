# T146 — USB RFID reader: first hardware slice

Status (24/11/2026): scoped HMI capture and simulator OCPP implementation. **Physical reader capture remains untested until a user retest on the laptop.** No real charger, mobile end-to-end flow, registration, settlement or billing claim is made.

## Device profile and operation

The supplied [13.56 MHz USB reader](https://icdayroi.com/dau-doc-the-rfid-13-56mhz-usb) was confirmed by the user in Notepad to emit ten decimal digits followed by Enter. Treat that output as an **opaque identifier**, not necessarily the raw RF UID and not a proven Ruihua identifier format. The actual user card number is absent from source, tests, logs and this note; fixtures are invented.

1. Run the existing HMI locally, bound to `127.0.0.1`, against an explicitly authorized local CSMS. This HMI has no HTTP authentication; do not expose its port globally.
2. Select the target gun by using its panel. Plug it in and wait for `Preparing` and an online CSMS.
3. Click that gun's **Đầu đọc RFID USB** field, then swipe. Only this focused field handles Enter. There is no global keyboard hook, automatic focus, PC/SC/NFC SDK, timing classifier or extra receiver process.
4. The field accepts exactly ten ASCII decimal characters plus the Enter event. It clears its buffer and disables while pending. Switching focus, losing SSE, or changing gun/network state clears partial input. Invalid frames require a fresh swipe; they are never trimmed, padded or truncated.
5. The local reader route sends `{connector: integer, idTag: string}`. Only these two fields are allowed; arrays, numeric identifiers, whitespace/control characters and mixed fixture/reader sources are rejected. Leading zeros remain intact. There is no decimal/hex conversion, byte reversal or fixture-card mapping. Since QA-03 the HMI is the per-station page `/tru/<cpId>` (formerly `public/index.html`) and each gun field posts to `POST /api/<cpId>/swipeReader` with the same loopback/origin/fetch-metadata/JSON/512-byte checks; unknown `cpId` → 404. The legacy `POST /api/swipeReader` remains and targets the first station.
6. The simulator sends real OCPP `Authorize` with the exact string, with buffering disabled. Only `Accepted`, followed by a current safe connector/network check, may call the existing `startTx(c, idTag, 'rfid')`. Unknown cards and offline readers never use the fixture allowlist.

The browser cannot attest that keystrokes came from a reader rather than a person. This identifier is not a secret or proof of possession. Admin must later register the **exact observed string** through an authorized Admin process. This slice neither creates/links cards nor assumes an Admin registry API is available. Driver app card management is outside T146.

## Concurrency, transport and privacy

A connector is locked synchronously before waiting for `Authorize`; another connector remains independent. The lock is released on every exit. Connector generation and network epoch checks invalidate an old acceptance after unplug/replug, status changes, another start, fault/availability changes or reconnection. The responsible `startTx` layer also refuses an already claimed connector, covering a `RemoteStart` callback scheduled before RFID claims it.

The new route alone requires JSON, limits the body to 512 bytes, checks loopback peer/Host and same origin, and rejects cross-site/same-site fetch metadata. An absent Origin is allowed for local CLI tests. Other routes and the existing default loopback binding retain their behavior.

The exact identifier exists transiently in the input/request and in existing in-memory transaction/OCPP state because the protocol needs it. It is not persisted in localStorage, printed to console or returned as plaintext in HMI snapshots/logs. Presentation masking targets ten-digit `idTag`/`parentIdTag` fields; numeric transaction IDs, meter readings and timestamps remain unchanged. Reader CALLERROR descriptions are suppressed to avoid echoing a submitted identifier. OCPP payloads remain exact; an authorized receiving CSMS can still record them.

Messages distinguish a CSMS rejection, an absent Authorize response (no Start sent), and an uncertain Start result. If Start has already been sent and its response is lost, the UI says to inspect gun/CSMS state rather than claiming charging success or definite failure. Existing simulator transaction/buffering semantics remain; do not retry blindly. Fixture card selection and its documented offline demo behavior remain available separately under **Thẻ RFID mẫu**.

## Research and choice recorded before implementation

The primary agent completed the source/test/license review below before handing off implementation. This note records that supplied research; the implementation worker did not independently repeat it. No external source code was copied and no packages were installed or changed.

| Source, pin and license | Reviewed source/tests | Fit, maintenance and tradeoffs |
|---|---|---|
| [axenox/onscan.js](https://github.com/axenox/onscan.js/tree/ab57958f96b5720b5fd1bf9b60152f7cd5b01ce6), `ab57958f96b5720b5fd1bf9b60152f7cd5b01ce6`, MIT | [onscan.js](https://github.com/axenox/onscan.js/blob/ab57958f96b5720b5fd1bf9b60152f7cd5b01ce6/onscan.js), package and license; no automated tests in the reviewed tree | Generic global DOM capture with prefix/suffix and timing (`minLength` 6, average 30 ms/character, suffix 9/13). Last push reported 01/11/2024. Adds a dependency and captures outside the chosen field; timing cannot prove hardware. Not adopted because this device already supplies Enter. |
| [SAP simulator](https://github.com/SAP/e-mobility-charging-stations-simulator/tree/0cead7a1488fbffa711a8022365f70082e3fa18f), `0cead7a1488fbffa711a8022365f70082e3fa18f`, Apache-2.0 | [OCPP16RequestService.ts](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/0cead7a1488fbffa711a8022365f70082e3fa18f/src/charging-station/ocpp/1.6/OCPP16RequestService.ts), [payload tests](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/0cead7a1488fbffa711a8022365f70082e3fa18f/tests/charging-station/ocpp/1.6/OCPP16RequestService-Payloads.test.ts), [call-chain tests](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/0cead7a1488fbffa711a8022365f70082e3fa18f/tests/charging-station/ocpp/1.6/OCPP16RequestService-CallChain.test.ts) | Maintained OCPP simulator with explicit tag override and Preparing connector coverage. Retain PowerMe's existing Authorize → Start sequence and tag pass-through idea; never adopt a default-tag fallback. Importing the entire simulator would add unrelated architecture/dependencies. Pattern comparison only; no copied implementation. |
| [Node v24.11.1](https://github.com/nodejs/node/tree/v24.11.1), MIT primary project | [readline interface](https://github.com/nodejs/node/blob/v24.11.1/lib/internal/readline/interface.js), [CR chunk test](https://github.com/nodejs/node/blob/v24.11.1/test/parallel/test-readline-carriage-return-between-chunks.js), [separator tests](https://github.com/nodejs/node/blob/v24.11.1/test/parallel/test-readline-line-separators.js) | Official, maintained line-input handling supports CR/LF. A CLI receiver would add another focus window/process and integration boundary. Not selected; no code adapted. |

Chosen architecture: a dependency-free focused browser field plus the existing local HMI action/OCPP pipeline. It fits the confirmed Enter profile, limits capture to the selected gun, and keeps authorization on the CSMS. Validation and asynchronous tests are PowerMe-specific. Source licenses remain linked above for provenance; no third-party code or license headers were imported.

## Phase boundaries and upstream dependencies

Primary audit supplied on 24/11/2026 (checkout base `834fcb6`; main audit `3138f85`):

- T146 card administration belongs to Admin. Admin v1 card registry is planned in `OPERATOR-ADMIN-API-HOP-DONG.md` §3, not confirmed available (Driver API §3 concerns stations). No authorization to populate a registry was given here.
- T148 is not complete: settlement's G5 query still selects app QR + intent or operator-assigned sessions and excludes RFID. This change must not bill cards or imply RFID debits work.
- Driver `charges.http.ts` matches only `/sessions/{id}/(progress|stop|statement)`; there is no GET list/active endpoint. Progress lacks `origin` and `can_stop`.
- Backend `progress(driver,id)` uses a LEFT JOIN to intent, so owned RFID progress can work **if the session ID is already known**. This does not make RFID sessions discoverable.
- `confirmedChargeSessionProvider` in `application/charge_session_controller.dart` derives solely from `chargeStartProvider.sessionTarget`. Current history uses `session_debit` ledger entries; without T148 an RFID session is not discoverable there either. Driver app should eventually observe external sessions through the proper backend contract.

No backend, Flutter/mobile, authentication, session settlement, payment or branding changes are included. The user has approved a subsequent API/Flutter phase, but it is not implemented in this slice and awaits the primary agent's bounded plan and research. T148 remains deferred.

## Checks and physical retest

Use the existing Node >=24 runtime and installed `ocpp-rpc`; no install is required:

```bash
node --test simulator/d1-hmi/rfid-reader.test.mjs simulator/d1-hmi/rfid-loopback.test.mjs simulator/d1-hmi/rfid-ui.test.mjs
node simulator/d1-hmi/smoke.mjs
```

The tests cover exact strings/leading zeros, malformed and ambiguous frames, rejected/absent authorization, no offline fallback, unsafe connectors, pending duplicates, independent guns, stale acceptance after unplug/replug or network change, retry release, scoped browser events/SSE state, field-aware masking, actual loopback OCPP ordering and response loss, the scheduled RemoteStart race, and the bounded same-origin HTTP route. They use fresh local stubs and random ports, no live database, staging API or billing commands. Browser event tests use Node VM stubs, not a physical reader or native browser proof.

Before calling capture verified: use the real USB reader in the running local HMI; confirm each gun receives one scan only when its field has focus, exact format including any leading zeros, Enter completion, rejection of incomplete/repeated input, no capture in other fields, pending lock, rejection/online messaging, and safe behavior during unplug/replug or network loss. Verify through an authorized CSMS with an Admin-known identifier; do not register a card automatically or publish its identifier in evidence.

Final verification: Node v24.22.3; 50/50 RFID tests and 40/40 unchanged smoke assertions passed, both exit 0. Prettier and `git diff --check` passed, exit 0. All 1,110 protected tracked files outside `simulator/d1-hmi/` matched their baseline SHA-256 hashes; branch/HEAD stayed `wp3/t146-doc-the-rfid-usb` / `834fcb64a04392f389ffb9b47e405ef22208753a`. Per-file SHA-256 values and check exits are recorded in `E:/Project/PowerMe/.review/t146-rfid-usb-20261124/final-handoff.json`.

## Subsequent API/Flutter status — 24/11 (historical, before local acceptance)

The reader-only findings and phase-1 hashes/checks above are historical evidence for that slice. They are superseded only for current API/mobile readiness by [T146 phase 2/3 handoff](../../../docs/tasks/t146-driver-session-discovery.md) and [Flutter local integration/checks](../../../apps/mobile/README.md#t146--owned-session-discovery-and-rfid-observation-2411): owned-session API 0.15 and local Flutter discovery/progress/history are now implemented and fixture-verified. The earlier absence of an API list/mobile integration no longer describes this checkout. Reader/HMI source remains unchanged by phase 3.

This does not deploy API 0.15, register a card, implement T148 settlement, or verify physical capture on HMI/phone. Preserve the physical retest and authorized Admin-known card prerequisites above; Notepad is the only real-reader evidence so far. No actual card identifier belongs in source, screenshots or test evidence.

## Chấp nhận local — 24/11

 người dùng báo quẹt đầu đọc vật lý trong HMI và kết nối app thành công. Đây là xác nhận giới hạn, không phải bộ bằng chứng phần cứng đầy đủ hoặc kiểm thử billing/dừng vật lý. Liên kết thẻ được thực hiện trực tiếp chỉ trong DB local riêng theo yêu cầu; không triển khai Admin UI/API. Không công bố mã thẻ và không suy ra T148 đã có ghi nợ. Các hash/giới hạn phase 1 ở trên giữ nguyên như lịch sử.
