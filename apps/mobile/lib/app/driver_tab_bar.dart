import 'package:flutter/material.dart';

import '../core/l10n/app_copy.dart';
import '../core/theme/powerme_theme.dart';

enum DriverTab {
  discover('nav-discovery'),
  history('nav-history'),
  charging('nav-charging'),
  credit('nav-credit'),
  account('nav-account');

  const DriverTab(this.key);
  final String key;
}

class DriverTabBar extends StatelessWidget {
  const DriverTabBar({
    super.key,
    required this.copy,
    required this.selected,
    required this.hasSession,
    required this.onSelect,
  });

  final AppCopy copy;
  final DriverTab selected;
  final bool hasSession;
  final ValueChanged<DriverTab> onSelect;

  @override
  Widget build(BuildContext context) {
    final largeLabels = MediaQuery.textScalerOf(context).scale(11.5) > 17;
    return Material(
      color: PowerMeColors.graphite,
      shape: const Border(top: BorderSide(color: PowerMeColors.hairline)),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(child: _destination(context, DriverTab.discover)),
              Expanded(child: _destination(context, DriverTab.history)),
              SizedBox(
                width: 64,
                child: _destination(context, DriverTab.charging),
              ),
              Expanded(
                flex: 2,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      flex: largeLabels ? 7 : 1,
                      child: _destination(context, DriverTab.credit),
                    ),
                    Expanded(
                      flex: largeLabels ? 9 : 1,
                      child: _destination(context, DriverTab.account),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _destination(BuildContext context, DriverTab tab) {
    final active = selected == tab;
    final primary = tab == DriverTab.charging;
    final (label, icon) = switch (tab) {
      DriverTab.discover => (
        copy.home,
        active ? Icons.explore : Icons.explore_outlined,
      ),
      DriverTab.history => (
        copy.text('Lịch sử', 'History'),
        Icons.receipt_long,
      ),
      DriverTab.charging => (
        copy.text('Sạc', 'Charge'),
        hasSession ? Icons.bolt_rounded : Icons.qr_code_scanner_rounded,
      ),
      DriverTab.credit => (
        copy.text('Tín dụng', 'Credit'),
        active
            ? Icons.account_balance_wallet
            : Icons.account_balance_wallet_outlined,
      ),
      DriverTab.account => (
        copy.profile,
        active ? Icons.person_rounded : Icons.person_outline_rounded,
      ),
    };
    final foreground = active ? PowerMeColors.teal : PowerMeColors.muted;
    void select() => onSelect(tab);

    return Semantics(
      key: Key(tab.key),
      label: label,
      container: true,
      button: true,
      selected: active,
      onTap: select,
      excludeSemantics: true,
      child: InkWell(
        onTap: select,
        borderRadius: BorderRadius.circular(16),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Center(
            heightFactor: 1,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  key: primary ? const Key('nav-charging-highlight') : null,
                  width: primary ? 64 : 44,
                  height: primary ? 60 : 28,
                  decoration: BoxDecoration(
                    color: primary
                        ? (active ? PowerMeColors.gold : PowerMeColors.teal)
                        : (active
                              ? PowerMeColors.teal.withValues(alpha: .14)
                              : null),
                    borderRadius: BorderRadius.circular(primary ? 16 : 14),
                  ),
                  alignment: Alignment.center,
                  child: Icon(
                    icon,
                    size: primary ? 29 : 22,
                    color: primary ? PowerMeColors.black : foreground,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  label,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: foreground,
                    fontSize: 11.5,
                    height: 1.12,
                    fontWeight: active || primary
                        ? FontWeight.w700
                        : FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
