import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_scope.dart';
import '../domain/owned_sessions.dart';

final ownedSessionRepositoryProvider = Provider<OwnedSessionRepository>(
  (ref) => throw StateError('Configure owned sessions in ApiApp.'),
);

final ownedSessionPageProvider = FutureProvider.autoDispose
    .family<OwnedSessionPage, int>((ref, page) async {
      final scope = ref.watch(authScopeProvider);
      if (scope == signedOutScope) throw StateError('Authentication required');
      final request = ref
          .watch(ownedSessionRepositoryProvider)
          .list(scope, view: OwnedSessionView.all, page: page);
      ref.onDispose(request.cancel);
      final result = await request.result;
      if (!ref.mounted || ref.read(authScopeProvider) != scope) {
        throw StateError('Session changed');
      }
      return result;
    }, retry: (_, _) => null);

class ActiveSessionsController extends ChangeNotifier {
  ActiveSessionsController(
    this.repository,
    this.scope, {
    required this.contextToken,
  });
  final OwnedSessionRepository repository;
  final AuthScope scope;
  final Object? Function() contextToken;
  OwnedSessionPage? page;
  Object? loadedContext;
  bool failed = false;
  bool reading = false;
  int _page = 1;
  int _generation = 0;
  bool _visible = false;
  Timer? _timer;
  void Function()? _cancel;
  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    _generation++;
    loadedContext = null;
    _timer?.cancel();
    _cancel?.call();
    _cancel = null;
    reading = false;
    if (visible) unawaited(refresh());
  }

  void changePage(int value) {
    if (reading || value < 1 || value > 100000) return;
    _page = value;
    unawaited(refresh());
  }

  Future<void> refresh() async {
    if (!_visible || reading) return;
    _timer?.cancel();
    final generation = _generation;
    final token = contextToken();
    final request = repository.list(
      scope,
      view: OwnedSessionView.active,
      page: _page,
    );
    _cancel = request.cancel;
    reading = true;
    notifyListeners();
    try {
      final next = await request.result;
      if (!_visible || generation != _generation) return;
      page = next;
      loadedContext = token;
      failed = false;
    } catch (_) {
      if (!_visible || generation != _generation) return;
      failed = true;
    } finally {
      if (generation == _generation && _visible) {
        reading = false;
        _cancel = null;
        _timer = Timer(const Duration(seconds: 5), () => unawaited(refresh()));
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    setVisible(false);
    super.dispose();
  }
}
