import '../domain/station_route.dart';

const roadMapScene = RoadMapScene(
  origin: MapPoint(.16, .77),
  roads: [
    MapRoad('Điện Biên Phủ', [
      MapPoint(.08, .18),
      MapPoint(.43, .18),
      MapPoint(.43, .48),
      MapPoint(.82, .48),
    ], major: true),
    MapRoad('Nguyễn Hữu Cảnh', [
      MapPoint(.43, .48),
      MapPoint(.65, .48),
      MapPoint(.65, .72),
    ], major: true),
    MapRoad('Nguyễn Huệ', [
      MapPoint(.16, .9),
      MapPoint(.16, .72),
      MapPoint(.65, .72),
      MapPoint(.9, .72),
    ], major: true),
    MapRoad('Võ Nguyên Giáp', [
      MapPoint(.82, .12),
      MapPoint(.82, .35),
      MapPoint(.82, .9),
    ], major: true),
    MapRoad('Trường Sơn', [
      MapPoint(.22, .05),
      MapPoint(.22, .18),
      MapPoint(.22, .48),
    ]),
    MapRoad('Lê Duẩn', [
      MapPoint(.05, .57),
      MapPoint(.43, .57),
      MapPoint(.43, .48),
      MapPoint(.43, .9),
    ]),
    MapRoad('Hai Bà Trưng', [
      MapPoint(.05, .32),
      MapPoint(.65, .32),
      MapPoint(.65, .72),
    ]),
    MapRoad('Tôn Đức Thắng', [
      MapPoint(.05, .86),
      MapPoint(.65, .86),
      MapPoint(.65, .72),
    ]),
  ],
);

class RoadRouteFixture {
  const RoadRouteFixture(
    this.points,
    this.distanceM,
    this.seconds,
    this.delay,
    this.batteryUse,
    this.via, {
    this.slow = const [],
  });
  final List<MapPoint> points;
  final List<List<MapPoint>> slow;
  final int distanceM;
  final int seconds;
  final int delay;
  final int batteryUse;
  final String via;
}

const roadRouteFixtures = <String, RoadRouteFixture>{
  'station-powerme-center': RoadRouteFixture(
    [
      MapPoint(.16, .77),
      MapPoint(.16, .72),
      MapPoint(.43, .72),
      MapPoint(.65, .72),
    ],
    3500,
    660,
    180,
    2,
    'Nguyễn Huệ · Nguyễn Hữu Cảnh',
    slow: [
      [MapPoint(.43, .72), MapPoint(.65, .72)],
    ],
  ),
  'station-evercharge-bach-dang': RoadRouteFixture(
    [
      MapPoint(.16, .77),
      MapPoint(.16, .72),
      MapPoint(.43, .72),
      MapPoint(.43, .57),
      MapPoint(.43, .48),
    ],
    5000,
    840,
    240,
    3,
    'Nguyễn Huệ · Lê Duẩn · Điện Biên Phủ',
    slow: [
      [MapPoint(.43, .57), MapPoint(.43, .48)],
    ],
  ),
  'station-evone-thao-dien': RoadRouteFixture(
    [
      MapPoint(.16, .77),
      MapPoint(.16, .72),
      MapPoint(.43, .72),
      MapPoint(.43, .57),
      MapPoint(.43, .48),
      MapPoint(.65, .48),
      MapPoint(.82, .48),
      MapPoint(.82, .35),
    ],
    8500,
    1440,
    480,
    5,
    'Điện Biên Phủ · Võ Nguyên Giáp',
    slow: [
      [MapPoint(.43, .48), MapPoint(.65, .48), MapPoint(.82, .48)],
    ],
  ),
  'station-powerme-airport': RoadRouteFixture(
    [
      MapPoint(.16, .77),
      MapPoint(.16, .72),
      MapPoint(.43, .72),
      MapPoint(.43, .57),
      MapPoint(.43, .48),
      MapPoint(.43, .18),
      MapPoint(.22, .18),
    ],
    11200,
    1920,
    600,
    7,
    'Điện Biên Phủ · Trường Sơn',
    slow: [
      [MapPoint(.43, .48), MapPoint(.43, .18)],
    ],
  ),
};
