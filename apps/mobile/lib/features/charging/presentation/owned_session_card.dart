import 'package:flutter/material.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../../core/widgets/flow_page.dart';
import '../domain/owned_sessions.dart';
import '../domain/charging.dart';
import 'charge_energy_label.dart';
import 'charging_screens.dart';

String sessionOriginLabel(SessionOrigin origin, AppCopy copy) =>
    switch (origin) {
      SessionOrigin.appQr => copy.text('Ứng dụng / QR', 'App / QR'),
      SessionOrigin.rfid => 'RFID',
      SessionOrigin.hmiPassword => copy.text(
        'Mật khẩu tại trụ',
        'Charger password',
      ),
      SessionOrigin.freeVend => copy.text('Sạc tại trụ', 'Charger session'),
      SessionOrigin.unknown => copy.text('Chưa rõ nguồn', 'Unknown source'),
    };

class OwnedSessionCard extends StatelessWidget {
  const OwnedSessionCard({
    super.key,
    required this.item,
    required this.copy,
    required this.onProgress,
    this.onStatement,
    this.compact = false,
  });
  final OwnedSessionSummary item;
  final AppCopy copy;
  final VoidCallback? onProgress;
  final VoidCallback? onStatement;
  final bool compact;
  @override
  Widget build(BuildContext context) => compact
      ? _compact(context)
      : InfoCard(
          spacing: 12,
          children: [
            Text(
              item.siteName ?? copy.text('Chưa rõ trạm', 'Unknown station'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                StatusBadge(
                  item.status == SessionState.closed
                      ? copy.text('Đã dừng', 'Stopped')
                      : sessionLabel(item.status, copy),
                ),
                StatusBadge(sessionOriginLabel(item.origin, copy)),
              ],
            ),
            if (!compact)
              ValueLine(copy.text('Mã phiên sạc', 'Session ID'), item.id),
            ValueLine(
              copy.text('Bắt đầu', 'Started'),
              ictDateTime(item.startedAt),
            ),
            if (!compact && item.stoppedAt != null)
              ValueLine(
                copy.text('Kết thúc', 'Stopped'),
                ictDateTime(item.stoppedAt!),
              ),
            if (!compact)
              ValueLine(
                copy.text('Cổng', 'Connector'),
                '${item.displayCode ?? '—'} / ${item.connectorNo}',
              ),
            ValueLine(
              copy.text('Xe', 'Vehicle'),
              item.vehicleLabel ?? copy.text('Chưa rõ xe', 'Unknown vehicle'),
            ),
            ValueLine(
              copy.text('Điện năng khi dừng', 'Final energy'),
              item.energyWh == null
                  ? copy.text('Chưa có số đo', 'No reading yet')
                  : chargeEnergyLabel(item.energyWh!, copy),
            ),
            ValueLine(
              copy.text('Số tiền bảng kê', 'Statement amount'),
              item.amountVnd == null
                  ? copy.text('Chưa có', 'Not available')
                  : vnd(item.amountVnd, copy: copy),
            ),
            if (!item.statementAvailable)
              Text(
                copy.text(
                  'Bảng kê chưa có.',
                  'The statement is not available yet.',
                ),
              ),
            if (onProgress == null) Text(_blocked),
            OutlinedButton(
              key: Key('open-owned-session-${item.id}'),
              onPressed: onProgress,
              child: Text(copy.text('Theo dõi phiên', 'View session')),
            ),
            if (item.statementEligible && onStatement != null)
              FilledButton.tonal(
                onPressed: onStatement,
                child: Text(copy.text('Xem bảng kê', 'View statement')),
              ),
          ],
        );
  String get _blocked => copy.text(
    'Hoàn tất yêu cầu sạc hiện tại trước khi đổi phiên.',
    'Resolve the current charging request before switching sessions.',
  );
  Widget _compact(BuildContext context) => InfoCard(
    spacing: 12,
    children: [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.ev_station_rounded,
            color: PowerMeColors.teal,
            size: 24,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              item.siteName ?? copy.text('Chưa rõ trạm', 'Unknown station'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
        ],
      ),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          StatusBadge(
            item.status == SessionState.closed
                ? copy.text('Đã dừng', 'Stopped')
                : sessionLabel(item.status, copy),
          ),
          StatusBadge(sessionOriginLabel(item.origin, copy)),
        ],
      ),
      Text(
        ictDateTime(item.startedAt),
        style: Theme.of(context).textTheme.bodySmall,
      ),
      Wrap(
        spacing: 16,
        runSpacing: 8,
        children: [
          Text(
            item.energyWh == null
                ? copy.text('Chưa có số đo', 'No reading yet')
                : chargeEnergyLabel(item.energyWh!, copy),
          ),
          Text(
            item.amountVnd == null
                ? copy.text(
                    'Chưa có số tiền bảng kê',
                    'Statement amount unavailable',
                  )
                : vnd(item.amountVnd, copy: copy),
          ),
        ],
      ),
      if (!item.statementAvailable)
        Text(
          copy.text('Bảng kê chưa có.', 'The statement is not available yet.'),
        ),
      if (onProgress == null) Text(_blocked),
      Wrap(
        spacing: 12,
        runSpacing: 8,
        children: [
          OutlinedButton(
            key: Key('open-owned-session-${item.id}'),
            onPressed: onProgress,
            child: Text(copy.text('Theo dõi phiên', 'View session')),
          ),
          if (item.statementEligible && onStatement != null)
            FilledButton.tonal(
              onPressed: onStatement,
              child: Text(copy.text('Xem bảng kê', 'View statement')),
            ),
        ],
      ),
    ],
  );
}
