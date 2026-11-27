package com.example.driver_app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.math.BigDecimal

class MainActivity : FlutterActivity() {
    private var stationMapsChannel: MethodChannel? = null
    private var vnpayCheckoutChannel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        stationMapsChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "powerme/station_maps",
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method != "openDestination") {
                    result.notImplemented()
                } else {
                    val args = call.arguments as? Map<*, *>
                    val latitude = args?.get("latitude") as? Double
                    val longitude = args?.get("longitude") as? Double
                    result.success(openStationMap(latitude, longitude))
                }
            }
        }
        vnpayCheckoutChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "powerme/vnpay_checkout",
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method == "openCheckout") {
                    result.success(openVnpayCheckout(call.arguments as? String))
                } else {
                    result.notImplemented()
                }
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        stationMapsChannel?.setMethodCallHandler(null)
        stationMapsChannel = null
        vnpayCheckoutChannel?.setMethodCallHandler(null)
        vnpayCheckoutChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    private fun openVnpayCheckout(url: String?): Boolean {
        if (url == null) return false
        val uri = Uri.parse(url)
        if (uri.scheme != "https" || uri.host != "sandbox.vnpayment.vn" ||
            uri.userInfo != null || uri.port !in listOf(-1, 443) ||
            uri.encodedPath != "/paymentv2/vpcpay.html" || uri.query.isNullOrEmpty() ||
            uri.fragment != null
        ) return false

        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    private fun openStationMap(latitude: Double?, longitude: Double?): Boolean {
        if (latitude == null || !latitude.isFinite() || latitude !in -90.0..90.0 ||
            longitude == null || !longitude.isFinite() || longitude !in -180.0..180.0
        ) return false

        val lat = BigDecimal.valueOf(latitude).toPlainString()
        val lng = BigDecimal.valueOf(longitude).toPlainString()
        val destination = Uri.Builder()
            .scheme("https")
            .authority("www.google.com")
            .path("/maps/dir/")
            .appendQueryParameter("api", "1")
            .appendQueryParameter("destination", "$lat,$lng")
            .appendQueryParameter("travelmode", "driving")
            .build()
        val intent = Intent(Intent.ACTION_VIEW, destination).addCategory(Intent.CATEGORY_BROWSABLE)
        return try {
            try {
                startActivity(intent.setPackage("com.google.android.apps.maps"))
            } catch (_: ActivityNotFoundException) {
                startActivity(intent.setPackage(null))
            }
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }
}
