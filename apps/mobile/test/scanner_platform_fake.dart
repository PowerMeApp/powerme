import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class ScannerPlatformFake extends MobileScannerPlatform {
  final _codes = StreamController<BarcodeCapture>.broadcast();
  int starts = 0;
  int stops = 0;
  bool deny = false;
  void emit(String raw) =>
      _codes.add(BarcodeCapture(barcodes: [Barcode(rawValue: raw)]));
  @override
  Stream<BarcodeCapture?> get barcodesStream => _codes.stream;
  @override
  Stream<TorchState> get torchStateStream =>
      Stream.value(TorchState.unavailable);
  @override
  Stream<double> get zoomScaleStateStream => Stream.value(1);
  @override
  Future<MobileScannerViewAttributes> start(StartOptions options) async {
    starts++;
    if (deny) {
      throw const MobileScannerException(
        errorCode: MobileScannerErrorCode.permissionDenied,
      );
    }
    return const MobileScannerViewAttributes(
      cameraDirection: CameraFacing.back,
      currentTorchMode: TorchState.unavailable,
      size: Size(320, 280),
      numberOfCameras: 1,
    );
  }

  @override
  Widget buildCameraView() => const ColoredBox(color: Colors.black);
  @override
  Future<void> stop() async {
    stops++;
  }

  @override
  Future<void> dispose() async {}
}
