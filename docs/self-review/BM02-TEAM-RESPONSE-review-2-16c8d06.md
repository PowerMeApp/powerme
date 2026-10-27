# BM02 — Team response, run 2 (tag `review-2` = `16c8d06`)

**DRAFT 26/10/2026 (WP1).** Responses to the raw report `BM02-SELF-REVIEW-review-2-16c8d06.md`. The raw report is not edited; all responses are in this file.

How this draft was made:
- Where a finding matches a run 1 finding (`BM02-TEAM-RESPONSE.md`), the run 1 response, owner and date are carried over. The "Run 1" column gives the old ID.
- New findings are `Planned (owner?, due?)`. **Each member confirms or corrects their rows** before submission.
- "After the tag" means the fix is on `main` or in an open PR, but not in `16c8d06`.

| ID | Sev. | Run 1 | Response | Owner | Due | Reason / action / commit |
|---|---|---|---|---|---|---|
| F01 | Medium | — | Fixed in part + Planned (v1.3 submitted at Review 2, awaiting approval) | Ân | before submission | `docs/requirements/registration-form-v1.3.md` is on `main` (PR #57, stacked into #55, [136ecf6](https://github.com/PowerMeApp/powerme/commit/136ecf6)) but is a **proposal**: the council has not approved it yet, so the scope change stays open until it does. The proposed final form v1.3 (26/10/2026) lists UC-ADM-08 as the Admin part of FR-07 and the account-closure request (UC-ACC-02) under FR-01/FR-02, recorded in BM03 rows 1-2; no FR is added. Repo copy and README: T76. The SRS, SDD and Design Brief §1/6/7 must match v1.3. |
| F02 | Low | — | Planned | Ân? | 31/10? | Tag the BR-P43, BR-P30 and FCM references in the SRS with their real priority, and label "system health" as Should (FR-19). |
| F03 | Medium | — | Planned | Ân? | 31/10? | SRS §1 says SteVe is Should, but form RQ1 and NFR-REC-01 commit it. Fix §1 to match the form. |
| F04 | Low | — | Planned | Ân? | 07/11? | Add measurable NFR rows for the Vietnamese/VND UI, operator data scoping, the out-of-date connector indicator and the demo acceptance script. |
| F05 | Medium | F01, F03 | Planned | Ân? | 07/11? | The FR → UC table is in `docs/requirements/README.md` (PR #34). Add an FR-01..FR-21 list with priority and use cases to the SRS itself. |
| F06 | **High** | (F03) | Planned | Ân? | 07/11? | Run 1 F03 was marked Fixed for actors only. The acceptance criteria (Requirements Analysis §2) are not in the repo. Add them, or a test-scenario table per Must UC linked to the Report 5 test cases. |
| F07 | Medium | F04 | Planned | Ân + Trí + Khang | 20/11 | Fix the thresholds in the SRS (NFR-OCPP-05, REC-02, AV-01, US-02, RES-01/02) and name a measurement method for each. Known Gap G15. |
| F08 | Medium | F04 | Planned (Caddy after the tag) | Trí + Khang | 20/11 | prom-client and k6 come in Iteration 2 (G15). `infra/staging/Caddyfile` was added by #48 (652e2c7, after the tag). |
| F09 | Low | — | Planned | Ân? | 31/10? | Fix the editorial errors in SRS Tables 7, 8 and 10. |
| F10 | Low | — | Planned | Ân? | 14/11? | Add the four Should relationships to LERD-2, or mark them "Should, not in Iteration 2". |
| F11 | Medium | — | Fixed in part after the tag + Planned | Khang + Trí | ? | Fixed after the tag in [6e456bb](https://github.com/PowerMeApp/powerme/commit/6e456bb) (#60, T73): migration `0003_billing-wf02` adds every listed CreditAccount, TopUp and EInvoice attribute (`diagrams/README.md` row 3, `docs/NHAT-KY-MIGRATION-0003.md`). Still missing: `ReconciliationRecord.MessageLogRef` (Trí decides: add the column, or drop it from the ERD). |
| F12 | Medium | — | Planned | Ân + Trí + Khang? | 07/11? | Align the domain values: tariff bands (4 vs 3), origin, payment mode, reconciliation types, and `reservation_fee`. Loyalty is already decided (26/10: DB values plus `restore`). |
| F13 | Low | — | Planned | Ân? | 14/11? | Add `charge_point_connections`, the partitions and the extra columns to LERD-2, or list them as physical-only in `diagrams/README.md`. |
| F14 | Low | F06 | Planned | Trí | 31/10 | Rounding policy for Wh (ADR-0009, convention 3). The missing UNIQUE constraint on partitions is documented in the SQL. |
| F15 | Low | — | Planned | Nghĩa? | ? | Decide on a fault report category and note (SRS) vs `description` only (DB), as part of WF-04. |
| F16 | **High** | F18, F19 | Planned | Trí | 07/11, 14/11 | Operator resolve (OPERATOR_RESOLVED), RemoteStart/Stop, start timeout, 24 h hard cap. Known Gap G2. |
| F17 | Medium | F43 | Planned | Trí | 07/11 | The console's RemoteStop must emit STOP_REQUESTED / REMOTE_STOP_REJECTED. |
| F18 | Low | — | Kept + Planned | Trí (Kept), Ân (AD-2) | 31/10? | Kept: the Postgres enum value `offline` cannot be dropped safely; it is legacy and never written (#44, `diagrams/README.md` row 2). Planned: remove "ChargingPillar [offline]" from AD-2. |
| F19 | Low | (F21) | Planned | Ân (WP1), Trí reviews | 14/11 | DISABLE/ENABLE is the disable flow already Planned in run 1 F21. Link it to a UC (UC-OPS-01 or a new one) and FR-09. |
| F20 | Low | F23 | Planned | Trí | 31/10 | Check the connector transition table against OCPP 1.6 §4.9. Add `Reserved` to STM-2. |
| F21 | Medium | — | Planned | Trí? (RemoteCommand) | 14/11? | Add an STM for RemoteCommand (Must, FR-11). Reservation and MaintenanceTicket are Should. |
| F22 | **High** | F26, F27, F28 | Planned | Sơn (AD-1), Khang (AD-3), Nghĩa (AD-5, AD-7), Trí (RemoteStart) | 21/11 | The main flows are Iteration 2 work. Known Gap G17. WF-01 app code is on branch `wp3/mb-04-t31-luong-sac-wf01` (PR #49 closed, rework T72). |
| F23 | Medium | (F21, F45) | Planned | Ân (endpoint), Trí (TLS, GetConfiguration) | 14/11 | HTTP endpoint waits for the `users` module and RolesGuard. TLS: Caddy is in #48 (after the tag), not deployed. The capability read is run 1 F45. |
| F24 | Medium | F05, F38 | Fixed in part after the tag + Planned | Ân (AD-2), Trí, Nghĩa (900 s watchdog, G19) | 14/11 | Fixed after the tag in [34ec95a](https://github.com/PowerMeApp/powerme/commit/34ec95a) (#59): code default `DEFAULT_OFFLINE_GRACE_S` = 120 s, as decided 26/10 (ADR-0016). Planned: update AD-2 for the grace period. Post-reconciliation steps belong to F22. |
| F25 | Low | F40 | Planned | Trí | 31/10 | Decide on free vend = `unattributed` (ADR-0012 decision 3) vs `free` (schema). Run 1 F40 left this open. |
| F26 | Medium | F32, F35 | Fixed in part after the tag + Planned | Trí | 31/10 (port: when REST lands) | Fixed after the tag in [c4019a2](https://github.com/PowerMeApp/powerme/commit/c4019a2e4ecf7ecf6fbbf79d93a2a5777206a4d2) (#56): ARCH-1 adds the operator console, the D1 HMI simulator and the demo runner; ARCH-2 is redrawn from `infra/staging`. Planned: the SteVe stack is not drawn yet; moving the console off port 3000 is deferred until the REST API exists, because port 3000 is used in about 25 places, including untested staging config and the rehearsed demo (run 1 F35). |
| F27 | **High** | F31 | Planned (part after the tag) | Trí + team | 14/11 | Dockerfile, Caddy and deploy scripts were added in #48 (after the tag, not deployed). The other "target" parts need a "built / target" legend in ARCH/PKG. Known Gaps G1, G16, G17. |
| F28 | Medium | — | Fixed after the tag (ADR, ARCH-1) + Planned | Ân | 31/10? | ADR-0013..0016 are in `docs/adr` since [c92d391](https://github.com/PowerMeApp/powerme/commit/c92d391) (#52). ARCH-1 `suggestions (Nghĩa)` since [136ecf6](https://github.com/PowerMeApp/powerme/commit/136ecf6) (#55). Ownership decided 26/10/2026 (late): the suggestion service stays with **Nghĩa (WP4)**, as form §3.2g says; ARCH-1 said WP3 and is fixed to Nghĩa (T76, in #55). Connector status and time-left estimation move to **Trí (WP2)**; this goes into the proposed final form v1.3 (BM03 row 3). PKG-1 has no suggestions module yet. Add FCM to ARCH-1, or drop it (ADR-0016: FCM is outside Review 2 scope). |
| F29 | **High** | F22, F40 | Fixed in part after the tag + Planned | Trí | 31/10 (card status, done); 07/11 (linked driver, credit) | Fixed after the tag in [c4019a2](https://github.com/PowerMeApp/powerme/commit/c4019a2e4ecf7ecf6fbbf79d93a2a5777206a4d2) (#56): `authorize` returns Accepted only for an `active` card (`blocked` → Blocked, `unlinked` → Invalid); a StartTransaction that already happened with a non-active card is still recorded, as `unattributed` with an `unknown_id_tag` record (BR-P06); tests added, including a `free_vend` card. Planned: an online card must have a linked driver (BR-P23) and enough credit (BR-P18), with WF-01; the free vend value (`free` vs `unattributed`) is decided under F25. Still open, so it stays in Known Gaps. |
| F30 | **High** | F34 | Planned | Trí | 14/11 | Reconciliation on/off switch for the RQ1 baseline. Known Gap G14. |
| F31 | **High** | F37, F44 | Fixed in part + Planned | Trí (TLS, RolesGuard), Ân (rate limit) | 14/11 | Basic Auth per pillar is done; credential-less pillars are rejected by default ([baf03a5](https://github.com/PowerMeApp/powerme/commit/baf03a5), #33, which includes the stacked PR #35). TLS via Caddy is in #48 (after the tag, not deployed). Rate limit on failed logins: fixed after the tag in [ddfe5a8](https://github.com/PowerMeApp/powerme/commit/ddfe5a8) (#54, T74, closes #40); staging sets `OCPP_TRUST_PROXY: 'true'` so the limit counts per pillar IP behind Caddy (restored in the follow-up PR after #54). RolesGuard: run 1 F44. Known Gap G16. |
| F32 | Medium | F33 | Fixed after the tag | Trí | — | [c4019a2](https://github.com/PowerMeApp/powerme/commit/c4019a2e4ecf7ecf6fbbf79d93a2a5777206a4d2) (#56): rules 1, 2, 3 and 10 of `docs/PACKAGE-DIAGRAM-CSMS.md` and `diagrams/team/PKG-1_csms.puml` rewritten from the real module imports (gateway imports SessionsModule), with a table of actual dependencies. No code refactor. |
| F33 | Medium | F27, F45 | Planned | Trí | 14/11 | GetConfiguration/ChangeConfiguration at boot, SupportedFeatureProfiles, `reports_soc` / `supports_reservation`. |
| F34 | Low | — | Planned | Ân? | 31/10? | Update SRS UC-OPS-01 and Table 5 #19 to the two-step flow (Admin registers, operator onboards), as in AD-8 v2.0 and CD-5. |

## Statistics (draft)

- Total: **34** findings.
  - Fixed after the tag: 1 (F32).
  - Fixed in part or after the tag, plus Planned: 9 (F01, F08, F11, F24, F26, F27, F28, F29, F31).
  - Kept + Planned: 1 (F18).
  - Planned: 23.
- Matched to run 1: 20 findings. New: 14.
- **High** findings (7): F06, F16, F22, F27, F29, F30, F31. None is fully closed (F29 and F31 are fixed only in part), so all seven must be listed in Design Brief §5 (Known Gaps):
  - F16 → G2
  - F22, F27 → G17 (F27 also G1, G16)
  - F30 → G14
  - F31 → G16
  - **F06 and F29 have no Known Gap yet**; new rows are needed.
