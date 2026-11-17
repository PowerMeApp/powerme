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
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        stationMapsChannel?.setMethodCallHandler(null)
        stationMapsChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    private fun openStationMap(latitude: Double?, longitude: Double?): Boolean {
        if (latitude == null || !latitude.isFinite() || latitude !in -90.0..90.0 ||
            longitude == null || !longitude.isFinite() || longitude !in -180.0..180.0
        ) return false

        val lat = BigDecimal.valueOf(latitude).toPlainString()
        val lng = BigDecimal.valueOf(longitude).toPlainString()
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lng")))
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }
}
