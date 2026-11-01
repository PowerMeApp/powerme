import 'package:flutter/material.dart';
import '../theme/powerme_theme.dart';

class BrandMark extends StatelessWidget {
  const BrandMark({
    super.key,
    this.hero = false,
    this.backgroundColor = PowerMeColors.black,
  });
  final bool hero;
  final Color backgroundColor;
  @override
  Widget build(BuildContext context) => Semantics(
    label: 'PowerMe',
    image: true,
    child: ExcludeSemantics(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: hero
            ? _BrandImage(
                'assets/brand/powerme-master-lockup.png',
                width: 240,
                height: 140,
                backgroundColor: backgroundColor,
              )
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _BrandImage(
                    'assets/brand/powerme-master-icon.png',
                    width: 42,
                    height: 41,
                    backgroundColor: backgroundColor,
                  ),
                  const SizedBox(width: 10),
                  _BrandImage(
                    'assets/brand/powerme-wordmark.png',
                    width: 126,
                    height: 24,
                    backgroundColor: backgroundColor,
                  ),
                ],
              ),
      ),
    ),
  );
}

class ChargingMark extends StatelessWidget {
  const ChargingMark({
    super.key,
    this.size = 80,
    this.backgroundColor = PowerMeColors.black,
  });
  final double size;
  final Color backgroundColor;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Biểu tượng dịch vụ sạc PowerMe',
    image: true,
    child: ExcludeSemantics(
      child: _BrandImage(
        'assets/brand/powerme-secondary-icon.png',
        width: size,
        height: size * 203 / 198,
        backgroundColor: backgroundColor,
      ),
    ),
  );
}

class _BrandImage extends StatelessWidget {
  const _BrandImage(
    this.path, {
    required this.width,
    required this.height,
    required this.backgroundColor,
  });
  final String path;
  final double width;
  final double height;
  final Color backgroundColor;

  @override
  Widget build(BuildContext context) => Image.asset(
    path,
    width: width,
    height: height,
    fit: BoxFit.contain,
    // Screen maps the crop's black backing to this explicit surface color.
    color: backgroundColor,
    colorBlendMode: BlendMode.screen,
  );
}
