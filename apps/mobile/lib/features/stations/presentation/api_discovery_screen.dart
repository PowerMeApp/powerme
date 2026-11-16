import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/theme/powerme_theme.dart';
import '../../profile/application/profile_controller.dart';
import '../application/station_discovery_controller.dart';
import '../domain/station_discovery.dart';
import 'api_discovery_components.dart';
import 'discovery_origin_panel.dart';
import 'inline_station_road.dart';

class ApiDiscoveryScreen extends ConsumerWidget {
  const ApiDiscoveryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vehicle = ref.watch(discoveryVehicleProvider);
    final copy = ref.watch(discoveryCopyProvider);
    if (vehicle.isNotEmpty) return _StationSearch(key: ValueKey(vehicle));
    return DiscoveryPage(
      title: copy.home,
      copy: copy,
      backLocation: null,
      children: const [DiscoveryVehicleRequired()],
    );
  }
}

class _StationSearch extends ConsumerStatefulWidget {
  const _StationSearch({super.key});

  @override
  ConsumerState<_StationSearch> createState() => _StationSearchState();
}

class _StationSearchState extends ConsumerState<_StationSearch> {
  final _text = TextEditingController();
  String _query = '';
  int _page = 1;
  SearchAvailability _availability = SearchAvailability.all;
  bool _showMap = true;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(profileControllerProvider).profile;
    final copy = ref.watch(discoveryCopyProvider);
    final discovery = ref.watch(discoveryContextProvider);
    ref.listen(discoveryContextProvider, (_, _) => setState(() => _page = 1));
    final DiscoverySearch input = (
      session: ref.watch(discoverySessionProvider),
      query: (
        text: _query,
        page: _page,
        availability: _availability,
        includeVinFastOnly: discovery.includeVinFastOnly,
      ),
      origin: discovery.origin,
      smart: null,
      consentToRoute: false,
    );
    final results = ref.watch(discoverySearchProvider(input));
    final hits = results.isLoading
        ? const <StationSearchHit>[]
        : results.value?.items ?? const <StationSearchHit>[];
    void submit({bool refresh = true}) {
      FocusScope.of(context).unfocus();
      final query = _text.text.trim();
      if (refresh && query == _query && _page == 1) {
        ref.invalidate(discoverySearchProvider(input));
      }
      setState(() {
        _query = query;
        _page = 1;
      });
    }

    return DiscoveryPage(
      title: copy.text('Tìm trạm sạc', 'Find stations'),
      copy: copy,
      backLocation: null,
      branded: _showMap,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('station-search-query'),
                controller: _text,
                textInputAction: TextInputAction.search,
                maxLength: 120,
                decoration: InputDecoration(
                  labelText: copy.text(
                    'Tên trạm hoặc địa chỉ',
                    'Station or address',
                  ),
                  counterText: '',
                  suffixIcon: ValueListenableBuilder(
                    valueListenable: _text,
                    builder: (context, value, _) => value.text.isEmpty
                        ? const SizedBox.shrink()
                        : IconButton(
                            key: const Key('clear-station-search'),
                            tooltip: copy.text('Xóa từ khóa', 'Clear search'),
                            onPressed: () {
                              _text.clear();
                              submit(refresh: false);
                            },
                            icon: const Icon(Icons.close_rounded),
                          ),
                  ),
                ),
                onSubmitted: (_) => submit(),
              ),
            ),
            const SizedBox(width: 8),
            SizedBox.square(
              dimension: 48,
              child: IconButton.filledTonal(
                key: const Key('submit-station-search'),
                tooltip: copy.text('Tìm trạm', 'Find stations'),
                icon: const Icon(Icons.search_rounded),
                onPressed: submit,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final option in SearchAvailability.values)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    key: ValueKey('station-availability-${option.apiValue}'),
                    label: Text(_availabilityText(option, copy)),
                    selected: option == _availability,
                    selectedColor: PowerMeColors.gold,
                    checkmarkColor: PowerMeColors.black,
                    labelStyle: Theme.of(context).textTheme.labelLarge
                        ?.copyWith(
                          color: option == _availability
                              ? PowerMeColors.black
                              : PowerMeColors.text,
                        ),
                    materialTapTargetSize: MaterialTapTargetSize.padded,
                    onSelected: (_) => setState(() {
                      _availability = option;
                      _page = 1;
                    }),
                    shape: const StadiumBorder(),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        LayoutBuilder(
          builder: (context, constraints) {
            final suggest = FilledButton.tonalIcon(
              key: const Key('open-suggestions'),
              onPressed: () => context.push('/suggestions'),
              style: FilledButton.styleFrom(
                visualDensity: VisualDensity.standard,
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              icon: const Icon(Icons.auto_awesome_outlined),
              label: Text(copy.text('Gợi ý trạm', 'Suggestions')),
            );
            final toggle = OutlinedButton.icon(
              key: const Key('toggle-station-map'),
              onPressed: () => setState(() => _showMap = !_showMap),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(48, 52),
                visualDensity: VisualDensity.standard,
                padding: const EdgeInsets.symmetric(horizontal: 12),
              ),
              icon: Icon(
                _showMap ? Icons.view_list_outlined : Icons.map_outlined,
              ),
              label: Text(
                _showMap
                    ? copy.text('Xem danh sách', 'Show list')
                    : copy.text('Xem bản đồ', 'Show map'),
              ),
            );
            final textScale = MediaQuery.textScalerOf(context).scale(14) / 14;
            if (constraints.maxWidth >= 320 * textScale) {
              return Row(
                children: [
                  Expanded(child: suggest),
                  const SizedBox(width: 8),
                  Expanded(child: toggle),
                ],
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [suggest, const SizedBox(height: 8), toggle],
            );
          },
        ),
        const SizedBox(height: 12),
        if (_showMap) ...[
          DiscoveryMap(
            stations: hits.map((hit) => hit.station).toList(growable: false),
            origin: discovery.origin?.location,
            onSelect: (id) {
              final hit = hits.where((hit) => hit.station.id == id).firstOrNull;
              if (hit != null) openStation(context, ref, hit.station);
            },
          ),
          const SizedBox(height: 8),
        ],
        ExpansionTile(
          leading: const Icon(Icons.tune_rounded, color: PowerMeColors.gold),
          tilePadding: const EdgeInsets.symmetric(horizontal: 8),
          title: Text(
            copy.text('Điểm đi và bộ lọc', 'Starting point and filters'),
          ),
          subtitle: Text(discovery.origin?.address ?? profile.vehicle),
          maintainState: true,
          children: [
            const DiscoveryOriginPanel(),
            if (!profile.isVinFast)
              SwitchListTile(
                key: const Key('include-vinfast-only'),
                contentPadding: EdgeInsets.zero,
                title: Text(
                  copy.text(
                    'Hiện cả trạm chỉ dành cho VinFast',
                    'Include VinFast-only stations',
                  ),
                ),
                value: discovery.includeVinFastOnly,
                onChanged: ref
                    .read(discoveryContextProvider.notifier)
                    .includeVinFastOnly,
              ),
          ],
        ),
        const SizedBox(height: 16),
        ...results.when(
          skipLoadingOnRefresh: false,
          skipLoadingOnReload: false,
          loading: () => const <Widget>[LinearProgressIndicator()],
          error: (_, _) => <Widget>[
            DiscoveryRetry(
              message: copy.text(
                'Không tải được danh sách trạm.',
                'Could not load the station list.',
              ),
              copy: copy,
              retry: () => ref.invalidate(discoverySearchProvider(input)),
            ),
          ],
          data: (page) {
            final content = <Widget>[
              DiscoveryHeading(
                copy.text(
                  '${page.total} trạm phù hợp',
                  '${page.total} matching stations',
                ),
                Icons.ev_station_outlined,
              ),
              if (page.items.isEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  copy.text(
                    'Không tìm thấy trạm trên trang này. Hãy đổi từ khóa hoặc bộ lọc.',
                    'No stations on this page. Try a different search or filter.',
                  ),
                ),
              ],
              for (final hit in page.items)
                _StationResult(
                  key: ValueKey(hit.station.id),
                  hit: hit,
                  copy: copy,
                  onTap: () => openStation(context, ref, hit.station),
                ),
            ];
            return [
              if (_showMap)
                Column(
                  key: const Key('station-map-results'),
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: content,
                )
              else
                ...content,
              if (page.hasNext || _page > 1)
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: _page > 1
                          ? () => setState(() => _page--)
                          : null,
                      child: Text(copy.text('Trang trước', 'Previous')),
                    ),
                    Text(copy.text('Trang $_page', 'Page $_page')),
                    OutlinedButton(
                      key: const Key('next-station-page'),
                      onPressed: page.hasNext
                          ? () => setState(() => _page++)
                          : null,
                      child: Text(copy.text('Trang sau', 'Next')),
                    ),
                  ],
                ),
            ];
          },
        ),
      ],
    );
  }
}

class _StationResult extends StatelessWidget {
  const _StationResult({
    super.key,
    required this.hit,
    required this.copy,
    required this.onTap,
  });

  final StationSearchHit hit;
  final AppCopy copy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final station = hit.station;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              key: ValueKey('station-result-${hit.station.id}'),
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: DiscoveryStationTitle(
                  station: station,
                  copy: copy,
                  metadata: AvailablePortsBadge(station, copy),
                  trailing: const Icon(
                    Icons.chevron_right_rounded,
                    size: 20,
                    color: PowerMeColors.gold,
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: InlineStationRoad(station: station, copy: copy),
            ),
          ],
        ),
      ),
    );
  }
}

String _availabilityText(SearchAvailability value, AppCopy copy) =>
    switch (value) {
      SearchAvailability.all => copy.text('Tất cả', 'All statuses'),
      SearchAvailability.available => copy.text('Có thể sạc', 'Available'),
      SearchAvailability.inUse => copy.text('Đang sử dụng', 'In use'),
      SearchAvailability.freeingSoon => copy.text('Sắp trống', 'Freeing soon'),
      SearchAvailability.unavailable => copy.text(
        'Không khả dụng',
        'Unavailable',
      ),
      SearchAvailability.offline => copy.text('Mất kết nối', 'Offline'),
    };
