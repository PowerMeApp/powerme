import 'dart:async';

import 'package:dio/dio.dart';

import '../../../core/api/driver_api_exception.dart';
import '../../../core/api/driver_api_session.dart';
import '../domain/map_location.dart';
import '../domain/station.dart';
import '../domain/station_discovery.dart';
import '../domain/station_repository.dart';

class ApiStationRepository
    implements StationRepository, StationDiscoveryRepository {
  ApiStationRepository(this._session, this._vehicleId);

  final DriverApiSession _session;
  final String _vehicleId;
  List<StationSearchHit> _found = const [];
  List<StationSearchHit> _suggested = const [];
  int _searchRequest = 0;
  int _smartRequest = 0;
  bool _disposed = false;

  void dispose() {
    _disposed = true;
    _found = _suggested = const [];
  }

  @override
  Future<List<StationOption>> find(String vehicleId, String query) async {
    final page = await search(vehicleId, (
      text: query,
      page: 1,
      availability: SearchAvailability.all,
      includeVinFastOnly: false,
    ));
    return [
      for (final hit in page.items)
        for (final connector in hit.station.connectors)
          _option(hit.station, connector),
    ];
  }

  @override
  Future<List<StationOption>> suggest(String vehicleId) async {
    final page = await search(
      vehicleId,
      initialStationSearch,
      smart: (soc: null, target: smartSearchTargetSoc),
    );
    return [
      for (final hit in page.items)
        if (hit.bestConnector case final connector?)
          _option(hit.station, connector),
    ];
  }

  StationOption _option(Station station, StationConnector connector) =>
      StationOption(
        station: station,
        connectorId: connector.id!,
        status: connector.status,
        updatedAt: connector.updatedAt,
      );

  @override
  Station? getById(String id) => [
    ..._found,
    ..._suggested,
  ].where((hit) => hit.station.id == id).firstOrNull?.station;

  @override
  Future<StationSearchPage> search(
    String vehicleId,
    StationSearchQuery query, {
    DiscoveryOrigin? origin,
    bool shareOriginWithPowerMe = false,
    SmartSearchInput? smart,
    bool consentToRoute = false,
    Future<void>? cancelled,
  }) async {
    _requireVehicle(vehicleId);
    if (smart != null && !validSmartSearch(smart)) throw _invalid;
    final sharedOrigin = shareOriginWithPowerMe ? origin : null;
    final request = smart == null ? ++_searchRequest : ++_smartRequest;
    if (smart == null) {
      _found = const [];
    } else {
      _suggested = const [];
    }
    final pageSize = smart == null ? 20 : 3;
    final json = await _read('stations', vehicleId, {
      'q': query.text.trim(),
      'page': query.page,
      'page_size': pageSize,
      'availability': query.availability.apiValue,
      'include_vinfast_only': query.includeVinFastOnly,
      if (sharedOrigin != null) ..._coordinates(sharedOrigin.location),
      if (smart != null) ...{
        'sort': 'smart',
        if (sharedOrigin != null && consentToRoute)
          'location_consent': consentToRoute,
        if (smart.soc case final soc?) 'soc_percent': _decimal(soc),
        'target_soc_percent': _decimal(smart.target),
      },
    }, cancelled: cancelled);
    final raw = json['items'];
    final total = _requiredInt(json['total']);
    if (json['page'] != query.page ||
        json['page_size'] != pageSize ||
        raw is! List ||
        raw.length > pageSize ||
        raw.length > total) {
      throw _malformed;
    }
    final sites = <String>{};
    final connectors = <String>{};
    final hits = List<StationSearchHit>.unmodifiable(
      raw.map((item) {
        final hit = _station(_object(item), connectors);
        if (!sites.add(hit.station.id)) throw _malformed;
        return hit;
      }),
    );
    final estimate = json['estimate'];
    final page = StationSearchPage(
      items: hits,
      total: total,
      page: query.page,
      pageSize: pageSize,
      rangeKm: estimate == null
          ? null
          : _number(_object(estimate)['est_range_km']) ?? (throw _malformed),
      smartUnavailable: switch (json['smart_unavailable_reason']) {
        'no_soc' => SmartUnavailable.noSoc,
        'no_location' => SmartUnavailable.noLocation,
        'missing_vehicle_specs' => SmartUnavailable.missingVehicleSpecs,
        _ => null,
      },
      rankingSource: switch (json['ranking_source']) {
        'vietmap_route' => StationRankingSource.vietmapRoute,
        'brief' => StationRankingSource.brief,
        _ => null,
      },
    );
    if (smart == null && request == _searchRequest) _found = hits;
    if (smart != null && request == _smartRequest) _suggested = hits;
    return page;
  }

  @override
  Future<List<AddressCandidate>> autocomplete(
    String vehicleId,
    String text, {
    required bool consentToVietmap,
    Future<void>? cancelled,
  }) async {
    _requireVietmapConsent(consentToVietmap);
    final json = await _read('places/autocomplete', vehicleId, {
      'q': text.trim(),
      'location_consent': consentToVietmap,
    }, cancelled: cancelled);
    final value = json['value'];
    if (value is! List || value.length > 10) throw _malformed;
    return List.unmodifiable(
      value.map((item) {
        final candidate = _object(item);
        final id = _requiredText(candidate['ref_id']);
        if (!_placeReference.hasMatch(id)) throw _malformed;
        return AddressCandidate(id, _requiredText(candidate['display']));
      }),
    );
  }

  @override
  Future<DiscoveryOrigin> resolve(
    String vehicleId,
    AddressCandidate candidate, {
    required bool consentToVietmap,
    Future<void>? cancelled,
  }) async {
    _requireVietmapConsent(consentToVietmap);
    if (!_placeReference.hasMatch(candidate.refId)) throw _invalid;
    final json = await _read('places/resolve', vehicleId, {
      'ref_id': candidate.refId,
      'location_consent': consentToVietmap,
    }, cancelled: cancelled);
    final place = _object(json['value']);
    if (place['ref_id'] != candidate.refId) throw _malformed;
    return DiscoveryOrigin.place(
      _location(place['latitude'], place['longitude']) ?? (throw _malformed),
      _requiredText(place['display']),
    );
  }

  @override
  Future<StationRoadRoute> roadRoute(
    String vehicleId,
    String stationId,
    DiscoveryOrigin origin, {
    required bool includeVinFastOnly,
    required bool consentToVietmap,
    Future<void>? cancelled,
  }) async {
    _requireVietmapConsent(consentToVietmap);
    final json = await _read(
      'stations/${Uri.encodeComponent(stationId)}/route',
      vehicleId,
      {
        ..._coordinates(origin.location),
        'location_consent': consentToVietmap,
        'include_vinfast_only': includeVinFastOnly,
      },
      cancelled: cancelled,
    );
    final geometry = _object(json['geometry']);
    final coordinates = geometry['coordinates'];
    if (json['site_id'] != stationId ||
        json['quality'] != 'provider_estimate' ||
        json['traffic_quality'] != 'unknown' ||
        geometry['type'] != 'LineString' ||
        coordinates is! List ||
        coordinates.length < 2 ||
        coordinates.length > 10000) {
      throw _malformed;
    }
    final distance = _number(json['distance_m']) ?? (throw _malformed);
    return StationRoadRoute(
      stationId: stationId,
      distanceM: distance,
      durationSeconds: _requiredInt(json['duration_s']),
      computedAt: _time(json['computed_at']) ?? (throw _malformed),
      instructions: _routeInstructions(
        json['instructions'],
        coordinates.length,
      ),
      trafficSegments: _routeTraffic(
        json['traffic_segments'],
        coordinates.length,
      ),
      congestedDistanceM: _congestedDistance(
        json['congested_distance_m'],
        distance,
      ),
      points: List.unmodifiable(
        coordinates.map((point) {
          if (point is! List || point.length != 2) throw _malformed;
          return _location(point[1], point[0]) ?? (throw _malformed);
        }),
      ),
    );
  }

  Future<Map<String, dynamic>> _read(
    String path,
    String vehicleId,
    Map<String, Object?> query, {
    Future<void>? cancelled,
  }) async {
    _requireVehicle(vehicleId);
    final cancel = cancelled == null ? null : CancelToken();
    if (cancelled != null) unawaited(cancelled.then((_) => cancel!.cancel()));
    final json = await _session.readForVehicle(
      path,
      vehicleId,
      query,
      cancel: cancel,
    );
    _requireVehicle(vehicleId);
    return json;
  }

  void _requireVietmapConsent(bool granted) {
    if (!granted) {
      throw const DriverApiException(
        DriverApiProblem.http,
        status: 400,
        code: 'location_consent_required',
      );
    }
  }

  void _requireVehicle(String vehicleId) {
    if (_disposed || vehicleId.isEmpty || vehicleId != _vehicleId) {
      throw const DriverApiException(DriverApiProblem.ended);
    }
  }
}

StationSearchHit _station(Map<String, dynamic> json, Set<String> ids) {
  final raw = json['connectors'];
  if (raw is! List || raw.isEmpty) throw _malformed;
  final connectors = List<StationConnector>.unmodifiable(
    raw.map((item) {
      final c = _object(item);
      final id = _requiredText(c['connector_id']);
      if (!ids.add(id)) throw _malformed;
      final powerKw =
          _number(c['max_power_kw']) ?? _number(c['rated_power_kw']);
      return StationConnector(
        id: id,
        chargePointId: _requiredText(c['charge_point_id']),
        displayCode: _text(c['display_code']),
        number: _requiredInt(c['connector_no']),
        type: switch (c['connector_type']) {
          'ccs2' => 'CCS2',
          'chademo' => 'CHAdeMO',
          'gbt' => 'GB/T',
          'type2' => 'Type 2',
          _ => throw _malformed,
        },
        powerW: powerKw == null ? null : (powerKw * 1000).round(),
        status: switch (c['driver_status']) {
          'available' => StationStatus.available,
          'in_use' => StationStatus.inUse,
          'freeing_soon' => StationStatus.freeingSoon,
          'unavailable' => StationStatus.unavailable,
          'offline' => StationStatus.offline,
          _ => StationStatus.unknown,
        },
        updatedAt: _time(c['status_updated_at']),
        quality: switch (c['status_quality']) {
          'fresh' => DataQuality.observed,
          'stale' => DataQuality.stale,
          _ => DataQuality.unknown,
        },
        availableNow: c['available_now'] is bool
            ? c['available_now'] as bool
            : null,
      );
    }),
  );
  final bestId = _text(json['best_connector_id']);
  final best = connectors.where((c) => c.id == bestId).firstOrNull;
  if (bestId != null && best == null) throw _malformed;
  final available = connectors.where((c) => c.availableNow == true).length;
  return StationSearchHit(
    station: Station(
      id: _requiredText(json['site_id']),
      name: _requiredText(json['site_name']),
      operatorName: _requiredText(json['operator_name']),
      address: _text(json['address']),
      status: available > 0 ? StationStatus.available : StationStatus.unknown,
      quality: DataQuality.unknown,
      updatedAt: null,
      availableCount: available,
      connectors: connectors,
      vinfastOnly: json['vinfast_only'] == true,
      location: _location(json['latitude'], json['longitude']),
    ),
    bestConnector: best,
    waitMinutes: _number(json['est_wait_min']),
    chargeMinutes: _number(json['est_charge_min']),
    maxCostVnd: _integer(json['est_cost_vnd_max']),
    roadEstimate: _roadEstimate(json['road_estimate']),
  );
}

StationRoadEstimate? _roadEstimate(Object? value) {
  if (value is! Map<String, dynamic>) return null;
  final distance = _number(value['distance_m']);
  final duration = _integer(value['duration_s']);
  final computedAt = _time(value['computed_at']);
  if (distance == null || duration == null || computedAt == null) return null;
  return (
    distanceM: distance,
    durationSeconds: duration,
    computedAt: computedAt,
    congestedDistanceM: _congestedDistance(
      value['congested_distance_m'],
      distance,
    ),
  );
}

double? _congestedDistance(Object? value, double routeDistance) {
  final distance = _number(value);
  return distance != null && distance <= routeDistance ? distance : null;
}

List<RouteInstruction> _routeInstructions(Object? value, int pointCount) {
  if (value is! List || value.length > 10000) return const [];
  final steps = <RouteInstruction>[];
  var previousEnd = 0;
  for (final item in value) {
    if (item is! Map<String, dynamic>) return const [];
    final start = _integer(item['start_index']);
    final end = _integer(item['end_index']);
    final sign = item['sign'];
    if (start == null ||
        end == null ||
        sign is! int ||
        start < previousEnd ||
        end < start ||
        end >= pointCount) {
      return const [];
    }
    previousEnd = end;
    steps.add((
      startIndex: start,
      endIndex: end,
      sign: sign,
      text: _text(item['text'])?.trim(),
      streetName: _text(item['street_name'])?.trim(),
      distanceM: _number(item['distance_m']),
    ));
  }
  return List.unmodifiable(steps);
}

List<RouteTrafficSegment> _routeTraffic(Object? value, int pointCount) {
  if (value is! List || value.length >= pointCount) return const [];
  final segments = <RouteTrafficSegment>[];
  for (final item in value) {
    if (item is! Map<String, dynamic>) return const [];
    final start = _integer(item['start_index']);
    final end = _integer(item['end_index']);
    if (start == null || end == null || start >= end || end >= pointCount) {
      return const [];
    }
    final level = switch (item['level']) {
      'low' => RouteTraffic.low,
      'moderate' => RouteTraffic.moderate,
      'heavy' => RouteTraffic.heavy,
      'severe' => RouteTraffic.severe,
      _ => RouteTraffic.unknown,
    };
    segments.add((start: start, end: end, level: level));
  }
  segments.sort((a, b) => a.start.compareTo(b.start));
  for (var i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) return const [];
  }
  return List.unmodifiable(segments);
}

Map<String, Object> _coordinates(MapLocation location) {
  if (!location.valid) throw _invalid;
  return {
    'latitude': _decimal(location.latitude),
    'longitude': _decimal(location.longitude),
  };
}

// CSMS accepts decimal query values without exponents.
String _decimal(double value) {
  final text = value.toString();
  return text.contains('e') ? value.toStringAsFixed(16) : text;
}

MapLocation? _location(Object? lat, Object? lng) {
  if (lat is! num || lng is! num) return null;
  final location = MapLocation(lat.toDouble(), lng.toDouble());
  return location.valid ? location : null;
}

Map<String, dynamic> _object(Object? value) =>
    value is Map<String, dynamic> ? value : throw _malformed;
String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;
String _requiredText(Object? value) => _text(value) ?? (throw _malformed);
int? _integer(Object? value) => value is int && value >= 0 ? value : null;
int _requiredInt(Object? value) => _integer(value) ?? (throw _malformed);
double? _number(Object? value) =>
    value is num && value.isFinite && value >= 0 ? value.toDouble() : null;
DateTime? _time(Object? value) =>
    value is String ? DateTime.tryParse(value)?.toUtc() : null;

final _placeReference = RegExp(r'^(auto|geocode):[A-Za-z0-9_-]{1,2048}$');
const _malformed = DriverApiException(DriverApiProblem.malformed);
const _invalid = DriverApiException(DriverApiProblem.http, status: 400);
