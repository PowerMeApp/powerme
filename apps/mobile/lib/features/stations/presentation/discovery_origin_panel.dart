import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../application/station_discovery_controller.dart';
import '../domain/station_discovery.dart';
import 'api_discovery_components.dart';

class DiscoveryOriginPanel extends ConsumerStatefulWidget {
  const DiscoveryOriginPanel({super.key, this.closeAfterSelection = false});

  final bool closeAfterSelection;

  @override
  ConsumerState<DiscoveryOriginPanel> createState() =>
      _DiscoveryOriginPanelState();
}

class _DiscoveryOriginPanelState extends ConsumerState<DiscoveryOriginPanel> {
  final _address = TextEditingController();
  bool _addressConsent = false;
  bool _busy = false;
  String? _addressQuery;
  String? _error;

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _updateOrigin(
    AppCopy copy,
    Future<bool> Function() update, {
    bool locating = false,
  }) async {
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
        _addressConsent = false;
        _addressQuery = null;
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
      if (_addressQuery == value) {
        ref.invalidate(
          addressSearchProvider((
            session: ref.read(discoverySessionProvider),
            query: value,
          )),
        );
      }
      _addressQuery = value;
    });
  }

  Future<void> _confirmAddress(AddressCandidate address, AppCopy copy) async {
    final session = ref.read(discoverySessionProvider);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          copy.text(
            'Dùng địa chỉ này làm điểm đi?',
            'Use this address as the starting point?',
          ),
        ),
        content: Text(address.display),
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
        !_addressConsent ||
        session != ref.read(discoverySessionProvider)) {
      return;
    }
    await _updateOrigin(
      copy,
      () => ref.read(discoveryContextProvider.notifier).selectAddress(address),
    );
  }

  @override
  Widget build(BuildContext context) {
    final copy = ref.watch(discoveryCopyProvider);
    final origin = ref.watch(discoveryContextProvider).origin;
    final session = ref.watch(discoverySessionProvider);
    final input = _addressQuery == null || !_addressConsent
        ? null
        : (session: session, query: _addressQuery!);
    final results = input == null
        ? null
        : ref.watch(addressSearchProvider(input));
    return InfoCard(
      children: [
        Text(
          origin?.address ??
              (origin == null
                  ? copy.text('Chưa chọn điểm đi', 'No starting point selected')
                  : copy.text('Vị trí hiện tại', 'Current location')),
        ),
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
                      () =>
                          ref.read(discoveryContextProvider.notifier).locate(),
                      locating: true,
                    ),
              icon: const Icon(Icons.my_location_outlined),
              label: Text(copy.text('Dùng vị trí của tôi', 'Use my location')),
            ),
            if (!_addressConsent)
              OutlinedButton.icon(
                key: const Key('discovery-address-consent'),
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _addressConsent = true;
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
        if (_addressConsent) ...[
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
              _addressQuery = null;
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
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _addressConsent = false;
                        _addressQuery = null;
                        _error = null;
                        _address.clear();
                      }),
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
