import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../profile/application/profile_controller.dart';
import '../application/station_discovery_controller.dart';
import '../domain/station_discovery.dart';
import 'api_discovery_components.dart';

Future<void> showDiscoveryOriginPicker(BuildContext context) =>
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (context) => SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          20,
          20,
          20,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: const DiscoveryOriginPanel(closeAfterSelection: true),
      ),
    );

class DiscoveryOriginSelector extends ConsumerWidget {
  const DiscoveryOriginSelector({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final copy = ref.watch(discoveryCopyProvider);
    final origin = ref.watch(discoveryContextProvider).origin;
    return Row(
      children: [
        Expanded(
          child: OutlinedButton.icon(
            key: const Key('open-discovery-origin'),
            onPressed: () => showDiscoveryOriginPicker(context),
            icon: Icon(
              origin?.address == null
                  ? Icons.my_location_outlined
                  : Icons.place_outlined,
            ),
            label: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                origin == null
                    ? copy.text('Chọn điểm đi', 'Choose starting point')
                    : origin.address == null
                    ? copy.text('Điểm đi · GPS', 'Starting point · GPS')
                    : copy.text(
                        'Điểm đi · ${origin.address}',
                        'Starting point · ${origin.address}',
                      ),
              ),
            ),
          ),
        ),
        if (origin != null)
          IconButton(
            key: const Key('clear-discovery-origin'),
            tooltip: copy.text('Bỏ điểm đi', 'Clear starting point'),
            onPressed: ref.read(discoveryContextProvider.notifier).clearOrigin,
            icon: const Icon(Icons.close_rounded),
          ),
      ],
    );
  }
}

class DiscoveryVinFastOverride extends ConsumerWidget {
  const DiscoveryVinFastOverride({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(profileControllerProvider).profile.isVinFast) {
      return const SizedBox.shrink();
    }
    final copy = ref.watch(discoveryCopyProvider);
    return SwitchListTile(
      key: const Key('include-vinfast-only'),
      contentPadding: EdgeInsets.zero,
      title: Text(
        copy.text('Hiện thêm trạm VinFast', 'Show VinFast stations too'),
      ),
      value: ref.watch(discoveryContextProvider).includeVinFastOnly,
      onChanged: ref.read(discoveryContextProvider.notifier).includeVinFastOnly,
    );
  }
}

class DiscoveryOriginPanel extends ConsumerStatefulWidget {
  const DiscoveryOriginPanel({super.key, this.closeAfterSelection = false});

  final bool closeAfterSelection;

  @override
  ConsumerState<DiscoveryOriginPanel> createState() =>
      _DiscoveryOriginPanelState();
}

class _DiscoveryOriginPanelState extends ConsumerState<DiscoveryOriginPanel> {
  final _address = TextEditingController();
  bool _showAddressSearch = false;
  bool _busy = false;
  AddressSearch? _submittedAddress;
  String? _error;
  DiscoveryContext? _originController;

  @override
  void dispose() {
    if (_busy) _originController?.cancelOriginUpdate();
    _address.dispose();
    super.dispose();
  }

  Future<void> _updateOrigin(
    AppCopy copy,
    Future<bool> Function() update, {
    bool locating = false,
  }) async {
    _originController = ref.read(discoveryContextProvider.notifier);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final updated = await update();
      if (!mounted || !updated) return;
      if (widget.closeAfterSelection) {
        Navigator.of(context).pop();
        return;
      }
      setState(() {
        _showAddressSearch = false;
        _submittedAddress = null;
        _address.clear();
      });
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = locating
              ? locationError(error, copy)
              : roadError(error, copy),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _submitAddress(AppCopy copy) {
    if (!_showAddressSearch) return;
    final value = _address.text.trim();
    setState(() {
      if (value.length < 2 || value.length > 120) {
        _error = copy.text(
          'Nhập từ 2 đến 120 ký tự.',
          'Enter 2 to 120 characters.',
        );
        return;
      }
      _error = null;
      final input = (
        session: ref.read(discoverySessionProvider),
        query: value,
        consentToVietmap: _showAddressSearch,
      );
      if (_submittedAddress == input) {
        final error = ref.read(addressSearchProvider(input)).error;
        if (canRetryDiscovery(error)) {
          ref.invalidate(addressSearchProvider(input));
        }
      }
      _submittedAddress = input;
    });
  }

  Future<void> _confirmAddress(AddressCandidate address, AppCopy copy) async {
    final submitted = _submittedAddress;
    final session = ref.read(discoverySessionProvider);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text(
          copy.text(
            'Dùng địa chỉ này làm điểm đi?',
            'Use this address as the starting point?',
          ),
        ),
        content: Text(
          '${address.display}\n\n'
          '${copy.text('PowerMe gửi mã địa chỉ đến Vietmap để lấy tọa độ.', 'PowerMe sends the address reference to Vietmap to retrieve its coordinates.')}\n\n'
          '${originSharingDisclosure(copy)}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(copy.text('Hủy', 'Cancel')),
          ),
          FilledButton(
            key: const Key('confirm-discovery-address'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(copy.text('Dùng địa chỉ', 'Use address')),
          ),
        ],
      ),
    );
    if (!mounted ||
        confirmed != true ||
        !_showAddressSearch ||
        submitted != _submittedAddress ||
        session != ref.read(discoverySessionProvider)) {
      return;
    }
    await _updateOrigin(
      copy,
      () => ref
          .read(discoveryContextProvider.notifier)
          .selectAddress(
            address,
            consentToVietmap: confirmed == true,
            shareOriginWithPowerMe: confirmed == true,
          ),
    );
  }

  void _resetAddressSearch() {
    setState(() {
      _showAddressSearch = false;
      _submittedAddress = null;
      _error = null;
      _address.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final copy = ref.watch(discoveryCopyProvider);
    final origin = ref.watch(discoveryContextProvider).origin;
    final session = ref.watch(discoverySessionProvider);
    ref.listen(discoverySessionProvider, (previous, next) {
      if (previous != next) _resetAddressSearch();
    });
    ref.listen(discoveryContextProvider.select((value) => value.origin), (
      previous,
      next,
    ) {
      if (previous != next) _resetAddressSearch();
    });
    final input = _submittedAddress?.session == session
        ? _submittedAddress
        : null;
    final results = input == null
        ? null
        : ref.watch(addressSearchProvider(input));
    return InfoCard(
      children: [
        Text(
          origin?.address ??
              (origin == null
                  ? copy.text('Chưa chọn điểm đi', 'No starting point selected')
                  : copy.text(
                      'Vị trí hiện tại · GPS',
                      'Current location · GPS',
                    )),
        ),
        Text(originSharingDisclosure(copy)),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton.icon(
              key: const Key('discovery-use-location'),
              onPressed: _busy
                  ? null
                  : () => _updateOrigin(
                      copy,
                      () => ref
                          .read(discoveryContextProvider.notifier)
                          .locate(shareOriginWithPowerMe: true),
                      locating: true,
                    ),
              icon: const Icon(Icons.my_location_outlined),
              label: Text(copy.text('Dùng vị trí của tôi', 'Use my location')),
            ),
            if (!_showAddressSearch)
              OutlinedButton.icon(
                key: const Key('discovery-address-consent'),
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _showAddressSearch = true;
                        _error = null;
                      }),
                icon: const Icon(Icons.place_outlined),
                label: Text(copy.text('Chọn địa chỉ', 'Choose address')),
              ),
            if (origin != null)
              TextButton(
                onPressed: _busy
                    ? null
                    : ref.read(discoveryContextProvider.notifier).clearOrigin,
                child: Text(copy.text('Bỏ điểm đi', 'Clear starting point')),
              ),
          ],
        ),
        if (_showAddressSearch) ...[
          Text(
            copy.text(
              'Từ khóa địa chỉ được gửi đến Vietmap qua PowerMe khi bạn bấm Tìm địa chỉ.',
              'Your address search is sent to Vietmap through PowerMe when you select Find address.',
            ),
          ),
          TextField(
            key: const Key('discovery-address-query'),
            controller: _address,
            enabled: !_busy,
            maxLength: 120,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              labelText: copy.text('Địa chỉ điểm đi', 'Starting address'),
              counterText: '',
            ),
            onChanged: (_) => setState(() {
              _submittedAddress = null;
              _error = null;
            }),
            onSubmitted: (_) => _submitAddress(copy),
          ),
          Wrap(
            spacing: 8,
            children: [
              FilledButton(
                key: const Key('submit-discovery-address'),
                onPressed: _busy ? null : () => _submitAddress(copy),
                child: Text(copy.text('Tìm địa chỉ', 'Find address')),
              ),
              TextButton(
                onPressed: _busy ? null : _resetAddressSearch,
                child: Text(
                  copy.text('Hủy tìm địa chỉ', 'Cancel address search'),
                ),
              ),
            ],
          ),
          if (results != null)
            ...results.when(
              skipLoadingOnRefresh: false,
              loading: () => const <Widget>[LinearProgressIndicator()],
              error: (error, _) => <Widget>[
                FailureNotice(roadError(error, copy)),
                if (canRetryDiscovery(error))
                  TextButton(
                    onPressed: () =>
                        ref.invalidate(addressSearchProvider(input!)),
                    child: Text(copy.text('Thử lại', 'Retry')),
                  ),
              ],
              data: (items) => <Widget>[
                if (items.isEmpty)
                  Text(
                    copy.text(
                      'Không tìm thấy địa chỉ.',
                      'No matching addresses.',
                    ),
                  ),
                for (final item in items)
                  OutlinedButton(
                    onPressed: _busy ? null : () => _confirmAddress(item, copy),
                    child: Text(item.display),
                  ),
              ],
            ),
        ],
        if (_busy) const LinearProgressIndicator(),
        if (_error != null) FailureNotice(_error),
      ],
    );
  }
}
