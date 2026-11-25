import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../core/l10n/app_copy.dart';
import '../../../core/widgets/flow_page.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../../profile/application/profile_controller.dart';
import '../../stations/application/connector_lookup_controller.dart';
import '../application/charge_session_controller.dart';
import '../application/charge_start_controller.dart';
import '../application/owned_sessions_controller.dart';
import '../domain/owned_sessions.dart';
import 'owned_session_card.dart';

class ActiveSessionDiscovery extends ConsumerWidget {
  const ActiveSessionDiscovery({
    super.key,
    required this.child,
    required this.editToken,
    required this.canAdopt,
  });
  final Widget child;
  final Object Function() editToken;
  final bool Function() canAdopt;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = ref.watch(authScopeProvider);
    if (scope == signedOutScope) return child;
    return _DiscoveryView(
      key: ValueKey(scope),
      scope: scope,
      editToken: editToken,
      canAdopt: canAdopt,
      child: child,
    );
  }
}

class _DiscoveryView extends ConsumerStatefulWidget {
  const _DiscoveryView({
    super.key,
    required this.scope,
    required this.editToken,
    required this.canAdopt,
    required this.child,
  });
  final AuthScope scope;
  final Object Function() editToken;
  final bool Function() canAdopt;
  final Widget child;
  @override
  ConsumerState<_DiscoveryView> createState() => _DiscoveryViewState();
}

class _DiscoveryViewState extends ConsumerState<_DiscoveryView>
    with WidgetsBindingObserver {
  late final ActiveSessionsController _controller;
  GoRouter? _router;
  bool _foreground = true;
  bool _browsingQr = false;
  bool _scheduled = false;
  Object get _contextToken => (
    widget.editToken(),
    ref.read(chargeStartProvider),
    ref.read(connectorLookupProvider),
    ref.read(selectedChargeSessionProvider),
  );
  bool get _visible =>
      _foreground &&
      mounted &&
      _router?.routeInformationProvider.value.uri.path == '/scan' &&
      ModalRoute.of(context)?.isCurrent == true &&
      ref.read(authScopeProvider) == widget.scope;
  bool get _freeToAdopt {
    final lookup = ref.read(connectorLookupProvider);
    return !_browsingQr &&
        ref.read(chargeStartProvider) == null &&
        !lookup.busy &&
        lookup.connector == null &&
        lookup.failure == null &&
        ref.read(selectedChargeSessionProvider) == null &&
        widget.canAdopt();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _controller = ActiveSessionsController(
      ref.read(ownedSessionRepositoryProvider),
      widget.scope,
      contextToken: () => _contextToken,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final router = GoRouter.of(context);
    if (_router != router) {
      _router?.routerDelegate.removeListener(_sync);
      _router = router;
      router.routerDelegate.addListener(_sync);
    }
    _sync();
  }

  void _sync() {
    if (!_visible) {
      _controller.setVisible(false);
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.setVisible(_visible);
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _sync();
  }

  void _select(OwnedSessionSummary item, {bool automatic = false}) {
    if (!_visible ||
        (automatic &&
            (!_freeToAdopt ||
                _controller.loadedContext != _contextToken ||
                _controller.reading ||
                _controller.failed))) {
      return;
    }
    if (ref
        .read(selectedChargeSessionProvider.notifier)
        .select(
          item,
          target: (scope: widget.scope, id: item.id),
          automatic: automatic,
        )) {
      _controller.setVisible(false);
      context.go('/charge-session');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _router?.routerDelegate.removeListener(_sync);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final copy = AppCopy(ref.watch(profileControllerProvider).profile.language);
    ref.watch(selectedChargeSessionProvider);
    final start = ref.watch(chargeStartProvider);
    final lookup = ref.watch(connectorLookupProvider);
    return ListenableBuilder(
      listenable: _controller,
      builder: (context, _) {
        final page = _controller.page;
        if (page?.total == 1 &&
            page!.items.length == 1 &&
            _freeToAdopt &&
            _controller.loadedContext == _contextToken &&
            !_controller.failed &&
            !_controller.reading &&
            !_scheduled &&
            !ref
                .read(selectedChargeSessionProvider.notifier)
                .wasDismissed(page.items.single.id)) {
          _scheduled = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _scheduled = false;
            if (mounted) _select(page.items.single, automatic: true);
          });
          WidgetsBinding.instance.ensureVisualUpdate();
        }
        final selection = ref.watch(selectedChargeSessionProvider);
        if (start == null &&
            !_browsingQr &&
            !lookup.busy &&
            lookup.connector == null &&
            widget.canAdopt() &&
            (selection != null ||
                (page != null && (page.total > 1 || page.page > 1)) ||
                (page?.items.any(
                      (item) => !ref
                          .read(selectedChargeSessionProvider.notifier)
                          .wasDismissed(item.id),
                    ) ??
                    false))) {
          return FlowPage(
            title: copy.charging,
            showBack: false,
            children: [
              Text(
                copy.text('Phiên sạc của bạn', 'Your charging sessions'),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              if (_controller.failed)
                Text(
                  copy.text(
                    'Chưa cập nhật được danh sách.',
                    'Could not update sessions.',
                  ),
                ),
              if (selection != null)
                OwnedSessionCard(
                  item: selection.summary,
                  copy: copy,
                  onProgress: () => context.go('/charge-session'),
                )
              else
                for (final item in page!.items)
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: OwnedSessionCard(
                      item: item,
                      copy: copy,
                      onProgress: () => _select(item),
                    ),
                  ),
              if (page != null && (page.hasNext || page.page > 1))
                Wrap(
                  spacing: 12,
                  runSpacing: 8,
                  children: [
                    OutlinedButton(
                      onPressed: page.page > 1 && !_controller.reading
                          ? () => _controller.changePage(page.page - 1)
                          : null,
                      child: Text(copy.text('Trang trước', 'Previous page')),
                    ),
                    OutlinedButton(
                      onPressed: page.hasNext && !_controller.reading
                          ? () => _controller.changePage(page.page + 1)
                          : null,
                      child: Text(copy.text('Trang sau', 'Next page')),
                    ),
                  ],
                ),
              OutlinedButton(
                onPressed: _controller.reading ? null : _controller.refresh,
                child: Text(copy.text('Tải lại phiên', 'Refresh sessions')),
              ),
              TextButton(
                onPressed: () => setState(() => _browsingQr = true),
                child: Text(copy.text('Quét mã khác', 'Scan another code')),
              ),
            ],
          );
        }
        return Column(
          children: [
            if (_controller.failed)
              SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        copy.text(
                          'Chưa tải được phiên đang sạc.',
                          'Active sessions unavailable.',
                        ),
                      ),
                      TextButton(
                        onPressed: _controller.reading
                            ? null
                            : _controller.refresh,
                        child: Text(
                          copy.text('Tải lại phiên', 'Retry sessions'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (_controller.reading && page == null)
              Text(
                copy.text(
                  'Đang tìm phiên sạc…',
                  'Looking for charging sessions…',
                ),
              ),
            Expanded(child: widget.child),
          ],
        );
      },
    );
  }
}
