import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

enum BrandMarkVariant { compact, wordmark, lockup, charging }

abstract final class BrandAssetConfig {
  static const useOfficialAssets = false;

  static String pathFor(BrandMarkVariant variant) {
    switch (variant) {
      case BrandMarkVariant.compact:
        return 'assets/brand/powerme-master-icon.png';
      case BrandMarkVariant.wordmark:
        return 'assets/brand/powerme-wordmark.png';
      case BrandMarkVariant.lockup:
        return 'assets/brand/powerme-master-lockup.png';
      case BrandMarkVariant.charging:
        return 'assets/brand/powerme-secondary-icon.png';
    }
  }
}

class BrandMark extends StatelessWidget {
  const BrandMark({this.variant = BrandMarkVariant.wordmark, super.key});

  final BrandMarkVariant variant;

  @override
  Widget build(BuildContext context) {
    if (BrandAssetConfig.useOfficialAssets) {
      return Semantics(
        label: 'Logo PowerMe',
        image: true,
        child: Image.asset(
          BrandAssetConfig.pathFor(variant),
          fit: BoxFit.contain,
        ),
      );
    }
    final isCompact =
        variant == BrandMarkVariant.compact ||
        variant == BrandMarkVariant.charging;
    final icon = variant == BrandMarkVariant.charging
        ? Icons.ev_station_outlined
        : Icons.bolt;
    return Semantics(
      label: variant == BrandMarkVariant.charging
          ? 'Biểu tượng sạc PowerMe'
          : 'Logo PowerMe tạm thời',
      image: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: isCompact ? 34 : 30,
            height: isCompact ? 34 : 30,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: BrandColors.gold),
            ),
            child: Icon(
              icon,
              color: BrandColors.gold,
              size: isCompact ? 20 : 17,
            ),
          ),
          if (!isCompact) ...[
            const SizedBox(width: 9),
            const Text(
              'POWER',
              style: TextStyle(
                color: BrandColors.gold,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.8,
              ),
            ),
            const Text(
              'ME',
              style: TextStyle(
                color: BrandColors.teal,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.8,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
