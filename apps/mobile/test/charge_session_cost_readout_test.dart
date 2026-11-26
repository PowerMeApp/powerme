import 'package:driver_app/features/profile/domain/driver_profile.dart';
import 'package:driver_app/core/l10n/app_copy.dart';
import 'package:driver_app/features/charging/domain/charge_session.dart';
import 'package:driver_app/features/charging/domain/charging.dart';
import 'package:driver_app/features/charging/presentation/charge_flow_visuals.dart';
import 'package:driver_app/features/charging/presentation/charge_session_readout.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final origin in [
    SessionOrigin.appQr,
    SessionOrigin.rfid,
    SessionOrigin.hmiPassword,
    SessionOrigin.freeVend,
  ]) {
    for (final language in AppLanguage.values) {
      testWidgets(
        'cost mode readout and summaries preserve estimate capability: $origin $language',
        (tester) async {
          final copy = AppCopy(language);
          final snapshot = ChargeProgress(
            origin: origin,
            paymentMode: PaymentMode.csmsBilled,
            serverCanStop: origin == SessionOrigin.appQr,
            status: SessionState.active,
            settlement: SettlementState.pending,
            connection: ConnectionState.online,
            quality: DataQuality.observed,
            updatedAt: DateTime.utc(2026, 11, 24),
            billingMode: ChargingMode.cost,
            limitValue: 100000,
            costEstimateVnd: 45000,
            costQuality: ChargeCostQuality.exact,
            consumedWh: 1200,
            meterStopWh: null,
            energyWh: null,
            estimatedCostVnd: 60000,
            billingReviewRequired: false,
          );
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: SingleChildScrollView(
                  child: Column(
                    children: [
                      ChargeSessionReadout(
                        copy: copy,
                        progress: snapshot,
                        waitingForStop: false,
                        hasStopRequest: false,
                      ),
                      ChargeSessionMetrics(
                        copy: copy,
                        progress: snapshot,
                        includeEnergy: true,
                      ),
                      ChargeSessionMetrics(
                        copy: copy,
                        progress: snapshot,
                        includeEnergy: true,
                        summary: true,
                      ),
                      ChargeProgressCard(progress: snapshot, copy: copy),
                    ],
                  ),
                ),
              ),
            ),
          );
          final ring = tester.widget<ChargeRing>(find.byType(ChargeRing));
          if (origin == SessionOrigin.appQr) {
            expect(ring.fraction, 0.45);
            expect(
              ring.energy,
              contains(
                language == AppLanguage.vietnamese ? '45.000' : '45,000',
              ),
            );
            expect(
              find.textContaining(
                language == AppLanguage.vietnamese ? '60.000' : '60,000',
              ),
              findsWidgets,
            );
          } else {
            expect(ring.fraction, isNull);
            expect(
              ring.energy,
              copy.text('Chưa có tạm tính', 'Estimate unavailable'),
            );
            expect(
              find.textContaining(RegExp(r'45[.,]000|60[.,]000')),
              findsNothing,
            );
            expect(
              find.text(copy.text('Chưa có tạm tính', 'Estimate unavailable')),
              findsWidgets,
            );
            expect(snapshot.canStop, isFalse);
          }
          expect(find.text('Không tính qua app'), findsNothing);
          expect(find.text('Not billed in app'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}
