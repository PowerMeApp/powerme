import 'package:flutter/services.dart';

import '../../../core/api/vnpay_checkout_url.dart';

const _channel = MethodChannel('powerme/vnpay_checkout');

Future<bool> openVnpayCheckout(String url) async {
  if (validatedVnpayCheckoutUrl(url) == null) return false;
  try {
    return await _channel.invokeMethod<bool>('openCheckout', url) == true;
  } on MissingPluginException {
    return false;
  } on PlatformException {
    return false;
  }
}
