import Flutter
import MapKit
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let channel = FlutterMethodChannel(
      name: "powerme/station_maps",
      binaryMessenger: engineBridge.applicationRegistrar.messenger())
    channel.setMethodCallHandler { call, result in
      guard call.method == "openDestination" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let args = call.arguments as? [String: Any],
        let latitude = args["latitude"] as? Double, latitude.isFinite,
        let longitude = args["longitude"] as? Double, longitude.isFinite
      else {
        result(false)
        return
      }
      let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
      guard CLLocationCoordinate2DIsValid(coordinate) else {
        result(false)
        return
      }
      let destination = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
      result(destination.openInMaps(launchOptions: [
        MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving
      ]))
    }
    let checkout = FlutterMethodChannel(
      name: "powerme/vnpay_checkout",
      binaryMessenger: engineBridge.applicationRegistrar.messenger())
    checkout.setMethodCallHandler { call, result in
      guard call.method == "openCheckout" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let raw = call.arguments as? String, let url = URL(string: raw),
        url.scheme == "https", url.host == "sandbox.vnpayment.vn",
        url.user == nil, url.password == nil, url.port == nil || url.port == 443,
        url.path == "/paymentv2/vpcpay.html", let query = url.query, !query.isEmpty,
        url.fragment == nil
      else {
        result(false)
        return
      }
      UIApplication.shared.open(url, options: [:]) { opened in result(opened) }
    }
  }
}
