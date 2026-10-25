import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/formatters.dart';
import '../../../core/theme/app_theme.dart';
import '../../../ui/core/app_scaffold.dart';
import '../../../ui/core/status_pill.dart';
import '../data/fake_station_repository.dart';
import '../domain/station_models.dart';

class DiscoveryScreen extends ConsumerStatefulWidget {
  const DiscoveryScreen({super.key});

  @override
  ConsumerState<DiscoveryScreen> createState() => _DiscoveryScreenState();
}

class _DiscoveryScreenState extends ConsumerState<DiscoveryScreen> {
  final _searchController = TextEditingController();
  bool _onlyAvailable = false;
  bool _locationDenied = false;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final stations = ref.watch(stationsProvider).where((station) {
      final query = _searchController.text.trim().toLowerCase();
      final matchesQuery =
          query.isEmpty ||
          station.name.toLowerCase().contains(query) ||
          station.address.toLowerCase().contains(query);
      return matchesQuery && (!_onlyAvailable || station.hasAvailableConnector);
    }).toList();
    return AppScaffold(
      title: 'Khám phá',
      actions: [
        IconButton(
          onPressed: () => context.push('/scan'),
          icon: const Icon(Icons.qr_code_scanner),
          tooltip: 'Quét mã trụ',
        ),
      ],
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          Text(
            'Chào bạn, Minh',
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          const Text(
            'Tìm nguồn năng lượng tiếp theo cho hành trình của bạn.',
            style: TextStyle(color: BrandColors.muted),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _searchController,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              hintText: 'Tìm theo tên hoặc địa chỉ',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _searchController.text.isEmpty
                  ? null
                  : IconButton(
                      onPressed: () {
                        _searchController.clear();
                        setState(() {});
                      },
                      icon: const Icon(Icons.clear),
                    ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              FilterChip(
                label: const Text('Còn đầu trống'),
                selected: _onlyAvailable,
                onSelected: (value) => setState(() => _onlyAvailable = value),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: () =>
                    setState(() => _locationDenied = !_locationDenied),
                icon: Icon(
                  _locationDenied
                      ? Icons.location_off_outlined
                      : Icons.near_me_outlined,
                  size: 17,
                ),
                label: Text(_locationDenied ? 'Nhập khu vực' : 'Gần tôi'),
              ),
            ],
          ),
          if (_locationDenied) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: BrandColors.warning.withValues(alpha: .12),
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.location_off_outlined, color: BrandColors.warning),
                  SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Bạn đã từ chối vị trí. Danh sách vẫn dùng được; hãy nhập địa điểm thủ công khi nối API thật.',
                      style: TextStyle(
                        color: BrandColors.warning,
                        height: 1.35,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 22),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Trạm đề xuất',
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              Text(
                '${stations.length} trạm',
                style: const TextStyle(color: BrandColors.muted),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (stations.isEmpty)
            _EmptyState(
              onReset: () => setState(() {
                _onlyAvailable = false;
                _searchController.clear();
              }),
            ),
          for (final station in stations) ...[
            _StationCard(
              station: station,
              onTap: () => context.push('/discover/station/${station.id}'),
            ),
            const SizedBox(height: 12),
          ],
        ],
      ),
    );
  }
}

class _StationCard extends StatelessWidget {
  const _StationCard({required this.station, required this.onTap});

  final Station station;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final available = station.connectors
        .where((connector) => connector.isUsable)
        .length;
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      color: BrandColors.teal.withValues(alpha: .12),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(
                      Icons.ev_station_outlined,
                      color: BrandColors.teal,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          station.name,
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 16,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          station.address,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: BrandColors.muted,
                            height: 1.3,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Text(
                    '${station.distanceKm.toStringAsFixed(1)} km',
                    style: const TextStyle(
                      color: BrandColors.gold,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  availabilityPill(
                    available > 0 ? '$available đầu trống' : 'Đang bận',
                    available > 0,
                  ),
                  const Spacer(),
                  Text(
                    'Cập nhật ${AppFormatters.clock(station.updatedAt)}',
                    style: const TextStyle(
                      color: BrandColors.muted,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onReset});

  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            const Icon(Icons.search_off, color: BrandColors.muted, size: 40),
            const SizedBox(height: 10),
            const Text('Không tìm thấy trạm phù hợp.'),
            const SizedBox(height: 12),
            TextButton(onPressed: onReset, child: const Text('Xóa bộ lọc')),
          ],
        ),
      ),
    );
  }
}
